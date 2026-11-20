import type { CredentialPlaintext, S3ProfileConfig } from '../vault/protocol';
import type { BucketSearchResult, CorsConfiguration, ListObjectsResult, ObjectMeta, ProbeResult, VersionListResult } from './client';
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

export class RemoteS3 {
  constructor(
    private readonly sessionId: string,
    private readonly token: string | undefined,
  ) {}

  private async call<T>(operation: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`/api/s3/sessions/${this.sessionId}/call`, {
        method: 'POST',
        headers: gateHeaders(this.token, true),
        body: JSON.stringify({ op: operation, ...body }),
        cache: 'no-store',
      });
    } catch (error) {
      throw serverDown(error);
    }
    return readCall<T>(response, operation);
  }

  listObjects(
    prefix?: string,
    options?: { delimiter?: string; maxKeys?: number; continuationToken?: string },
  ): Promise<ListObjectsResult> {
    return this.call('list', { prefix, ...options });
  }

  getObject(key: string): Promise<Response> {
    return fetch(sessionObjectPath(this.sessionId, key), {
      headers: gateHeaders(this.token),
      cache: 'no-store',
    }).catch((error: unknown) => {
      throw serverDown(error);
    });
  }

  putObject(key: string, body: string, contentType?: string): Promise<{ eTag: string }> {
    return this.call('putText', { key, body, contentType });
  }

  deleteObjects(keys: string[]): Promise<{ deleted: string[]; errors: { key: string; code: string; message: string }[] }> {
    return this.call('delete', { keys });
  }

  getBucketCors(): Promise<CorsConfiguration> {
    return this.call('corsGet', {});
  }

  putBucketCors(config: CorsConfiguration): Promise<void> {
    return this.call('corsPut', { config });
  }

  deleteBucketCors(): Promise<void> {
    return this.call('corsDelete', {});
  }

  presignGet(key: string, expiresIn: number): Promise<{ url: string }> {
    return this.call('presignGet', { key, expiresIn });
  }

  presignPut(key: string, contentType: string | undefined, expiresIn: number): Promise<{ url: string }> {
    return this.call('presignPut', { key, contentType, expiresIn });
  }

  presignCors(expiresIn: number): Promise<{ url: string }> {
    return this.call('corsPresign', { expiresIn });
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
