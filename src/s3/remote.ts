import type { CredentialPlaintext, S3ProfileConfig } from '../vault/protocol';
import type { BucketSearchResult, DeleteResult, ListObjectsResult, ObjectMeta, ProbeResult, VersionListResult } from './client';
import { isStrongETag } from './clientHeaders';
import { S3_ACCESS_TOKEN_HEADER, S3_PROXY_TOKEN_HEADER } from '../server/protocol';
import { BRAND } from '../branding';

/**
 * Browser-side client for the self-hosted S3 API.
 *
 * This file must not sign requests or import the server transport. The server
 * holds the session and is the only process that calls S3.
 */

export class RemoteS3Error extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${operation} failed: ${code} (${status}) — ${message}`);
    this.name = 'RemoteS3Error';
  }

  get unsupported(): boolean {
    return this.status === 501 || this.code === 'NotImplemented';
  }
}

interface CallFailure {
  ok: false;
  error: string;
  status?: number;
  code?: string;
  unsupported?: boolean;
}

function gateHeaders(token: string | undefined, json = false): Headers {
  const headers = new Headers();
  if (json) headers.set('content-type', 'application/json');
  if (token) {
    headers.set(S3_ACCESS_TOKEN_HEADER, token);
    headers.set(S3_PROXY_TOKEN_HEADER, token);
  }
  return headers;
}

function serverDown(error: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') return error;
  return new Error(
    `Cannot reach the ${BRAND.name} server. Run it with \`bun run dev\` or \`bun run server\`. S3 is called from that process, so the machine running ${BRAND.name} must be able to reach the bucket.`,
    { cause: error },
  );
}

export const MAX_EDITOR_BYTES = 2 * 1024 * 1024;

/** Keep the UTF-8 BOM, and refuse invalid text instead of persisting replacement characters. */
export async function readEditorText(response: Response, maxBytes: number) {
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.min(maxBytes, MAX_EDITOR_BYTES)) : MAX_EDITOR_BYTES;
  const contentType = response.headers.get('x-galiot-object-type') ?? response.headers.get('content-type');
  const charset = /(?:^|;)\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? '')?.[1];
  const encoding = response.headers.get('content-encoding');
  if ((charset && !/^utf-?8$/i.test(charset)) || (encoding && encoding.toLowerCase() !== 'identity')) {
    void response.body?.cancel().catch(() => {});
    throw new Error('This encoding cannot be edited losslessly. Use Download instead.');
  }
  const reader = response.body?.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const chunks: string[] = [];
  let size = 0;
  try {
    if (reader) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('File is too large for the editor. Use Download instead.');
        chunks.push(decoder.decode(value, { stream: true }));
      }
    }
    chunks.push(decoder.decode());
  } catch (error) {
    void reader?.cancel().catch(() => {});
    if (error instanceof TypeError) throw new Error('Could not read this object as UTF-8 text. Use Download instead.', { cause: error });
    throw error;
  } finally {
    reader?.releaseLock();
  }
  return { text: chunks.join(''), size, contentType, eTag: response.headers.get('etag') };
}

async function readCall<T>(response: Response, operation: string): Promise<T> {
  let body: { ok?: boolean; result?: T; error?: string; status?: number; code?: string } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    body = {};
  }
  if (!response.ok || body.ok === false) {
    const message = body.error || response.statusText || `The ${BRAND.name} server rejected the request.`;
    if (typeof body.status === 'number') {
      throw new RemoteS3Error(operation, body.status, body.code || `HTTP ${body.status}`, message);
    }
    throw new Error(message);
  }
  return body.result as T;
}

export async function openServerSession(
  profile: S3ProfileConfig,
  creds: CredentialPlaintext,
  token: string | undefined,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/api/s3/sessions', {
      method: 'POST',
      headers: gateHeaders(token, true),
      body: JSON.stringify({
        endpoint: profile.endpoint,
        region: profile.region,
        bucket: profile.bucket,
        pathStyle: profile.pathStyle,
        headers: profile.headers,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      }),
      cache: 'no-store',
    });
  } catch (error) {
    throw serverDown(error);
  }
  const result = await readCall<{ sessionId: string }>(response, 'OpenSession');
  if (!result?.sessionId) throw new Error(`The ${BRAND.name} server did not open an S3 session.`);
  return result.sessionId;
}

export async function closeServerSession(sessionId: string, token: string | undefined): Promise<void> {
  try {
    await fetch(`/api/s3/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: gateHeaders(token),
      cache: 'no-store',
    });
  } catch {
    // Locking must succeed even if the server is already gone.
  }
}

export async function probeFromServer(
  profile: S3ProfileConfig,
  token: string | undefined,
): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetch('/api/s3/probe', {
      method: 'POST',
      headers: gateHeaders(token, true),
      body: JSON.stringify({
        endpoint: profile.endpoint,
        bucket: profile.bucket,
        pathStyle: profile.pathStyle,
      }),
      cache: 'no-store',
    });
  } catch (error) {
    throw serverDown(error);
  }
  return readCall<ProbeResult>(response, 'Probe');
}

/** Buckets the key can see, asked before a bucket is chosen. No session needed. */
export async function listBucketsFromServer(
  target: { endpoint: string; region: string },
  creds: CredentialPlaintext,
  token: string | undefined,
): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch('/api/s3/list-buckets', {
      method: 'POST',
      headers: gateHeaders(token, true),
      body: JSON.stringify({
        endpoint: target.endpoint,
        region: target.region,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      }),
      cache: 'no-store',
    });
  } catch (error) {
    throw serverDown(error);
  }
  const result = await readCall<{ buckets: string[] }>(response, 'ListBuckets');
  return result.buckets ?? [];
}

export function sessionObjectPath(sessionId: string, key: string): string {
  return `/api/s3/sessions/${sessionId}/object?key=${encodeURIComponent(key)}`;
}

export function sessionPartPath(sessionId: string, key: string, uploadId: string, partNumber: number): string {
  const query = new URLSearchParams({ key, uploadId, partNumber: String(partNumber) });
  return `/api/s3/sessions/${sessionId}/part?${query}`;
}

/** True only for the server's own JSON answer; an S3 NoSuchKey 404 is XML. */
async function sessionExpired(response: Response): Promise<boolean> {
  if (response.status !== 404 || !response.headers.get('content-type')?.includes('application/json')) return false;
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    return typeof body.error === 'string' && /session expired/i.test(body.error);
  } catch {
    return false;
  }
}

export class RemoteS3 {
  constructor(
    private sessionId: string,
    private readonly token: string | undefined,
    /** Opens a replacement when the server forgot `stale` (idle expiry, eviction, restart). */
    private readonly reopen?: (stale: string) => Promise<string>,
  ) {}

  /**
   * One request against the session, retried once on a fresh session. The
   * server answers "session expired" before touching S3, so a retry cannot
   * repeat a mutation.
   */
  private async sessionFetch(path: (sessionId: string) => string, init: RequestInit): Promise<Response> {
    const send = (sessionId: string) => fetch(path(sessionId), init).catch((error: unknown) => {
      throw serverDown(error);
    });
    const response = await send(this.sessionId);
    if (!this.reopen || !(await sessionExpired(response))) return response;
    void response.body?.cancel().catch(() => {});
    this.sessionId = await this.reopen(this.sessionId);
    return send(this.sessionId);
  }

  private async call<T>(operation: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.sessionFetch(sessionId => `/api/s3/sessions/${sessionId}/call`, {
      method: 'POST',
      headers: gateHeaders(this.token, true),
      body: JSON.stringify({ op: operation, ...body }),
      cache: 'no-store',
    });
    return readCall<T>(response, operation);
  }

  listObjects(
    prefix?: string,
    options?: { delimiter?: string; maxKeys?: number; continuationToken?: string },
  ): Promise<ListObjectsResult> {
    return this.call('list', { prefix, ...options });
  }

  getObject(key: string): Promise<Response> {
    return this.sessionFetch(sessionId => sessionObjectPath(sessionId, key), {
      headers: gateHeaders(this.token),
      cache: 'no-store',
    });
  }

  editorWriteSupport(): Promise<{ conditionalPut: boolean }> {
    return this.call('editorWriteSupport', {});
  }

  async putTextIfMatch(key: string, text: string, contentType: string | null, eTag: string): Promise<{ eTag: string }> {
    if (!isStrongETag(eTag)) throw new Error('A strong ETag is required to save changes safely.');
    if (/[\uD800-\uDFFF]/u.test(text)) throw new Error('The edited text contains an incomplete Unicode character.');
    const body = new Blob([text]);
    if (body.size > MAX_EDITOR_BYTES) throw new Error('Edited text exceeds the 2 MiB limit.');
    const headers = gateHeaders(this.token);
    headers.set('if-match', eTag);
    headers.set('content-type', contentType ?? 'application/octet-stream');
    const res = await this.sessionFetch(sessionId => sessionObjectPath(sessionId, key), {
      method: 'PUT', headers, body, cache: 'no-store', redirect: 'error',
    });
    if (res.status === 409 || res.status === 412) throw new Error('The remote object changed. Compare your draft with its latest version.');
    if (!res.ok) throw new Error(`Save failed (HTTP ${res.status}). Your draft is still open.`);
    return { eTag: res.headers.get('etag') ?? '' };
  }

  async deleteObjects(keys: string[]): Promise<DeleteResult> {
    const result: DeleteResult = { deleted: [], errors: [] };
    // Even fully JSON-escaped 1024-byte keys fit the 1 MB control-request limit.
    for (let i = 0; i < keys.length; i += 128) {
      try {
        const reply = await this.call<DeleteResult>('delete', { keys: keys.slice(i, i + 128) });
        result.deleted.push(...reply.deleted);
        result.errors.push(...reply.errors);
      } catch (error) {
        for (const key of keys.slice(i)) result.errors.push({ key, code: 'UnconfirmedDelete',
          message: error instanceof Error ? error.message : String(error) });
        break;
      }
    }
    return result;
  }

  presignGet(key: string, expiresIn: number): Promise<{ url: string }> {
    return this.call('presignGet', { key, expiresIn });
  }

  presignPut(key: string, contentType: string | undefined, expiresIn: number): Promise<{ url: string }> {
    return this.call('presignPut', { key, contentType, expiresIn });
  }

  mediaUrl(key: string, versionId?: string): Promise<{ url: string }> {
    return this.call('media', { key, versionId });
  }

  head(key: string): Promise<ObjectMeta> {
    return this.call('head', { key });
  }

  listVersions(key: string): Promise<VersionListResult> {
    return this.call('listVersions', { key });
  }

  deleteVersion(key: string, versionId: string): Promise<{ deleted: boolean }> {
    return this.call('deleteVersion', { key, versionId });
  }

  restoreVersion(key: string, versionId: string): Promise<{ restored: boolean }> {
    return this.call('restoreVersion', { key, versionId });
  }

  search(query: string, prefix?: string): Promise<BucketSearchResult> {
    return this.call('search', { query, prefix });
  }

  listTree(prefix: string): Promise<{ objects: { key: string; size: number; storageClass: string | null }[] }> {
    return this.call('listTree', { prefix });
  }

  restore(key: string, days: number): Promise<{ requested: boolean }> {
    return this.call('restore', { key, days });
  }

  /** An upload S3 no longer knows (already completed or aborted) counts as aborted. */
  async abortMultipart(key: string, uploadId: string): Promise<{ aborted: boolean }> {
    try {
      return await this.call<{ aborted: boolean }>('abortMultipart', { key, uploadId });
    } catch (error) {
      if (error instanceof RemoteS3Error && error.code === 'NoSuchUpload') return { aborted: true };
      throw error;
    }
  }


  createFolder(key: string): Promise<{ created: boolean }> {
    return this.call('createFolder', { key });
  }

  copy(sourceKey: string, destKey: string): Promise<{ copied: number }> {
    return this.call('copy', { sourceKey, destKey });
  }

  rename(sourceKey: string, destKey: string): Promise<{ moved: number }> {
    return this.call('rename', { sourceKey, destKey });
  }

  /** Short-lived link that streams from this server, not from S3. */
  shareLink(key: string, expiresIn: number): Promise<{ url: string; expiresIn: number }> {
    return this.call('share', { key, expiresIn });
  }

  /** Bounded upload link: one key, one byte cap, expiring, revocable. */
  shareWrite(key: string, expiresIn: number, maxBytes: number): Promise<{ url: string; expiresIn: number; maxBytes: number }> {
    return this.call('shareWrite', { key, expiresIn, maxBytes });
  }

  probe(): Promise<ProbeResult> {
    return this.call('probe', {});
  }
}

export function isRemoteFailure(body: unknown): body is CallFailure {
  return typeof body === 'object' && body !== null && (body as CallFailure).ok === false;
}
