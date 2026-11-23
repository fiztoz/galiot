import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { readBoundedText } from '../lib/boundedBody.ts';
import { assertConnectionEndpoint } from '../s3/endpoint.ts';
import { AwsClient } from '../lib/aws4fetch.ts';
import { parseStoredHeaders } from '../s3/customHeaders.ts';
import { presignGetUrl, presignPutUrl } from '../s3/presign.ts';
import { assertSafeObjectKey, buildS3Url } from '../s3/url.ts';
import { S3RequestError, type PartInfo, type ProbeResult } from '../s3/client.ts';
import { isStrongETag } from '../s3/clientHeaders.ts';
import { xmlBlocks, xmlFirst } from '../s3/xml.ts';
import { clientForSession } from './engine.ts';
import { probeEditorWrites } from './editorWriteProbe.ts';
import {
  S3_ACCESS_TOKEN_HEADER,
  S3_API_PREFIX,
  S3_HEALTH_PATH,
  S3_PROXY_TOKEN_HEADER,
} from './protocol.ts';
import { SessionStore, type SessionView } from './sessions.ts';
import { BlockedProxyTargetError, resolveProxyAddresses, type ProxyLookup } from './target.ts';
import { checkProxyTarget, isLoopbackHost } from './proxy.ts';
import { forwardRequest } from './upstream.ts';

const JSON_LIMIT = 1_000_000;
const TEXT_LIMIT = 2 * 1024 * 1024;
/** AWS CopyObject limit; above it the copy must go through UploadPartCopy. */
const COPY_SINGLE_LIMIT = 5 * 1024 ** 3;
const COPY_PART_SIZE = 512 * 1024 ** 2;
const MAX_TREE_ENTRIES = 10_000;
const SHARE_MIN_SECONDS = 60;
const SHARE_MAX_SECONDS = 7 * 24 * 3600;
const UPLOAD_CAP_DEFAULT = 100 * 1024 * 1024;
const UPLOAD_CAP_MAX = 1024 * 1024 * 1024;

export interface AppApiOptions {
  expectedToken: string | null;
  open?: boolean;
  listenerPort?: number;
  listenerHost?: string;
  publicOrigins?: readonly string[];
  lookup?: ProxyLookup;
  forward?: typeof forwardRequest;
  sessions?: SessionStore;
}

function storeOf(options: AppApiOptions): SessionStore {
  return options.sessions ?? defaultStore;
}

const defaultStore = new SessionStore();

/** Caller mistake, not an upstream failure. Surfaced as 400, not 502. */
class BadRequestError extends Error {}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function presentedToken(request: Request): string | null {
  return request.headers.get(S3_ACCESS_TOKEN_HEADER) ?? request.headers.get(S3_PROXY_TOKEN_HEADER);
}

function tokenMatches(presented: string | null, expected: string | null): boolean {
  if (!expected) return true;
  if (!presented) return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function authorized(request: Request, expected: string | null): boolean {
  return tokenMatches(presentedToken(request), expected);
}

/** Browser control calls without a gate must originate at this listener. */
function trustedControlRequest(request: Request, options: AppApiOptions): boolean {
  if (options.expectedToken) return authorized(request, options.expectedToken);
  const url = new URL(request.url);
  const host = request.headers.get('host');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (host !== null && host.toLowerCase() !== url.host && host.toLowerCase() !== url.hostname + ':' + port) {
    return false;
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = request.headers.get('origin');
  // A TLS-terminating proxy must preserve Host. Forwarded headers cannot add
  // an authority to this operator-configured list.
  const publicMatch = options.publicOrigins?.some(allowed => {
    const external = new URL(allowed);
    return (external.host === url.host || external.host === host?.toLowerCase()) &&
      (origin === null || origin === allowed);
  });
  if (publicMatch) return true;
  const literal = isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0;
  const onListener = !options.listenerPort || options.listenerPort === Number(port);
  const knownHost = isLoopbackHost(url.hostname) ||
    (options.open && (literal || url.hostname === options.listenerHost?.toLowerCase()));
  return Boolean(knownHost && (onListener || (options.open && literal)) && (origin === null || origin === url.origin));
}

/**
 * Failure answer for a share or upload link. Its holder is anyone the link
 * reached, so the upstream error (endpoint addresses, DNS names) stays in the
 * server log.
 */
function linkFailure(err: unknown): Response {
  console.error('Share link request failed:', err);
  return json({ ok: false, error: 'The storage server could not be reached. Try again later.' }, 502);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown, max = 2048): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length > max) return undefined;
  return value;
}

function requireString(value: unknown, name: string, max = 2048): string {
  const text = asString(value, max);
  if (!text) throw new BadRequestError(`${name} is required.`);
  return text;
}

function grantKey(value: unknown): string {
  const key = requireString(value, 'key', 1024);
  try {
    assertSafeObjectKey(key);
  } catch {
    throw new BadRequestError('This object key cannot be represented exactly by the S3 transport.');
  }
  return key;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new BadRequestError('Control requests require application/json.');
  }
  const text = await readBoundedText(request, JSON_LIMIT);
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  return asRecord(parsed);
}

/**
 * Counts streamed bytes against a write grant's cap. A declared Content-Length
 * is checked up front; this is the defence against a body that lies about it.
 */
function countedBody(
  body: ReadableStream<Uint8Array>,
  max: number,
): { body: ReadableStream<Uint8Array>; exceeded: () => boolean } {
  let total = 0;
  let over = false;
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > max) {
        over = true;
        controller.error(new Error('Upload exceeds the grant cap.'));
        await reader.cancel().catch(() => undefined);
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      return reader.cancel();
    },
  });
  return { body: stream, exceeded: () => over };
}

/** A client-supplied Content-MD5 is forwarded so S3 checks the bytes it receives. */
function contentMd5Header(request: Request): Record<string, string> {
  const digest = request.headers.get('content-md5');
  return digest && /^[A-Za-z0-9+/]{22}==$/.test(digest) ? { 'content-md5': digest } : {};
}

function uploadLength(request: Request): { ok: true; length: string } | { ok: false; status: 411 | 400 } {
  const length = request.headers.get('content-length');
  if (length === null) return { ok: false, status: 411 };
  if (!/^(0|[1-9]\d*)$/.test(length) || !Number.isSafeInteger(Number(length))) return { ok: false, status: 400 };
  return { ok: true, length };
}

function relay(upstream: Response, method: string, key?: string, destination?: string | null, raw = false): Response {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-security-policy': "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  for (const name of ['accept-ranges', 'content-range', 'content-length', 'content-encoding', 'etag', 'last-modified', 'x-amz-version-id']) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const originalType = upstream.headers.get('content-type') || 'application/octet-stream';
  const mime = originalType.split(';')[0]?.trim().toLowerCase() ?? '';
  const inline = !raw && (INLINE_TYPES.has(mime) || (mime === 'image/svg+xml' && destination === 'image'));
  if (raw) headers.delete('content-encoding');
  headers.set('x-galiot-object-type', originalType);
  headers.set('content-type', inline ? mime : 'application/octet-stream');
  if (!inline || upstream.headers.get('content-disposition')?.toLowerCase().startsWith('attachment')) {
    const filename = key?.split('/').pop();
    const encoded = filename && encodeURIComponent(filename).replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16));
    headers.set('content-disposition', encoded ? "attachment; filename*=UTF-8''" + encoded : 'attachment');
  }
  const empty = method === 'HEAD' || upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  return new Response(empty ? null : upstream.body, { status: upstream.status, headers });
}

const INLINE_TYPES = new Set([
  'application/pdf', 'text/plain', 'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'image/avif', 'image/bmp', 'image/x-icon', 'audio/mpeg', 'audio/mp4', 'audio/wav',
  'audio/ogg', 'audio/flac', 'audio/aac', 'audio/webm', 'video/mp4', 'video/webm',
  'video/ogg', 'video/quicktime',
]);

function client(session: SessionView, options: AppApiOptions, allowConditionalPut = false) {
  return clientForSession(session, options.lookup, options.forward ?? forwardRequest, allowConditionalPut);
}

function signer(session: SessionView): AwsClient {
  return new AwsClient({
    accessKeyId: session.accessKeyId,
    secretAccessKey: session.secretAccessKey,
    sessionToken: session.sessionToken,
    region: session.region,
    service: 's3',
  });
}

function targetOf(session: SessionView) {
  return { endpoint: session.endpoint, bucket: session.bucket, pathStyle: session.pathStyle };
}

async function reach(
  endpoint: string,
  bucket: string,
  pathStyle: boolean,
  options: AppApiOptions,
): Promise<{ reachable: boolean; url: string; error?: string }> {
  const url = buildS3Url({ endpoint, bucket, pathStyle });
  try {
    const addresses = await resolveProxyAddresses(url, options.lookup);
    const request = new Request(url, { method: 'GET' });
    const response = await (options.forward ?? forwardRequest)(url, addresses, request, request.headers);
    await response.body?.cancel().catch(() => undefined);
    return { reachable: true, url: url.toString() };
  } catch (err) {
    if (err instanceof BlockedProxyTargetError) throw err;
    return {
      reachable: false,
      url: url.toString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probe(endpoint: string, bucket: string, pathStyle: boolean, options: AppApiOptions): Promise<ProbeResult> {
  const current = await reach(endpoint, bucket, pathStyle, options);
  const alternateUrl = buildS3Url({ endpoint, bucket, pathStyle: !pathStyle }).toString();
  if (current.reachable) return { ...current, alternateReachable: false, alternateUrl };
  const alternate = await reach(endpoint, bucket, !pathStyle, options);
  return { ...current, alternateReachable: alternate.reachable, alternateUrl };
}

function s3Failure(err: unknown, operation: string): Response | null {
  if (!(err instanceof S3RequestError)) return null;
  return json({
    ok: false,
    error: err.message,
    status: err.status,
    code: err.code,
    unsupported: err.unsupported,
    operation,
  }, 200);
}

async function handleCall(
  session: SessionView,
  body: Record<string, unknown>,
  options: AppApiOptions,
  sessions: SessionStore,
  sessionId: string,
): Promise<Response> {
  const op = asString(body.op, 64);
  const s3 = client(session, options);
  const verify = () => sessions.startEditorWriteCheck(sessionId, (signal) => {
    if (Object.keys(session.headers).length) {
      return Promise.resolve({ verified: false, issue: 'Automatic verification is unavailable for connections with custom request headers.' });
    }
    // Only the isolated probe may send an unverified If-Match. It generates
    // its own key and never receives a caller-supplied object key.
    return probeEditorWrites(client(session, options, true), signal);
  });
  try {
    switch (op) {
      case 'list': {
        const result = await s3.listObjects(asString(body.prefix, 1024), {
          delimiter: asString(body.delimiter, 8),
          maxKeys: typeof body.maxKeys === 'number' ? body.maxKeys : undefined,
          continuationToken: asString(body.continuationToken, 4096),
        });
        if (!s3.supportsCondition('put')) void verify();
        return json({ ok: true, result }, 200);
      }
      case 'delete': {
        const keys = body.keys;
        if (!Array.isArray(keys) || !keys.every((key): key is string =>
          typeof key === 'string' && key.length > 0 && new TextEncoder().encode(key).length <= 1024)) {
          throw new BadRequestError('Every delete entry must be a valid object key.');
        }
        return json({ ok: true, result: await s3.deleteObjects(keys) }, 200);
      }
      case 'putText': {
        const key = requireString(body.key, 'key', 1024);
        const text = asString(body.body, TEXT_LIMIT);
        if (text === undefined || new TextEncoder().encode(text).byteLength > TEXT_LIMIT) {
          throw new BadRequestError('Text must be at most 2 MiB in UTF-8.');
        }
        return json({ ok: true, result: await s3.putObject(key, text, asString(body.contentType, 256)) }, 200);
      }
      case 'createMultipart':
        return json({
          ok: true,
          result: { uploadId: await s3.createMultipartUpload(requireString(body.key, 'key', 1024), asString(body.contentType, 256)) },
        }, 200);
      case 'completeMultipart': {
        // A dropped entry would complete a silently truncated object, so any
        // malformed part rejects the whole request.
        if (!Array.isArray(body.parts) || body.parts.length === 0 || body.parts.length > 10_000) {
          throw new BadRequestError('Multipart completion needs 1–10000 parts.');
        }
        const parts = body.parts.map((part): PartInfo => {
          const row = asRecord(part);
          const partNumber = row.PartNumber ?? row.partNumber;
          const eTag = row.ETag ?? row.eTag;
          if (!Number.isInteger(partNumber) || (partNumber as number) < 1 || (partNumber as number) > 10_000 ||
              typeof eTag !== 'string' || !eTag || eTag.length > 1024) {
            throw new BadRequestError('Every multipart part needs a part number and an ETag.');
          }
          return { PartNumber: partNumber as number, ETag: eTag };
        });
        await s3.completeMultipartUpload(requireString(body.key, 'key', 1024), requireString(body.uploadId, 'uploadId'), parts);
        return json({ ok: true, result: { completed: true } }, 200);
      }
      case 'abortMultipart':
        await s3.abortMultipartUpload(requireString(body.key, 'key', 1024), requireString(body.uploadId, 'uploadId'));
        return json({ ok: true, result: { aborted: true } }, 200);
      case 'listParts': {
        const key = requireString(body.key, 'key', 1024);
        const uploadId = requireString(body.uploadId, 'uploadId');
        // ListParts returns at most 1000 parts per page; an upload may have 10000.
        const parts: { partNumber: number; eTag: string; size: number }[] = [];
        let marker: string | undefined;
        for (let page = 0; page < 10; page++) {
          const res = await s3.send(s3.objectUrl(key, marker ? { uploadId, 'part-number-marker': marker } : { uploadId }));
          if (!res.ok) {
            const text = await readBoundedText(res, 64 * 1024);
            return json({ ok: false, error: text || res.statusText, status: res.status, code: xmlFirst(text, 'Code') ?? `HTTP ${res.status}` }, 200);
          }
          const text = await readBoundedText(res, 8 * 1024 * 1024);
          for (const block of xmlBlocks(text, 'Part')) {
            parts.push({
              partNumber: parseInt(xmlFirst(block, 'PartNumber') ?? '0', 10),
              eTag: xmlFirst(block, 'ETag') ?? '',
              size: parseInt(xmlFirst(block, 'Size') ?? '0', 10),
            });
          }
          const next = xmlFirst(text, 'NextPartNumberMarker') ?? undefined;
          if (xmlFirst(text, 'IsTruncated') !== 'true' || !next || next === marker) break;
          marker = next;
        }
        return json({ ok: true, result: { parts } }, 200);
      }
      case 'head':
        return json({ ok: true, result: await s3.headObject(requireString(body.key, 'key', 1024)) }, 200);
      case 'editorWriteSupport': {
        const check = s3.supportsCondition('put') ? { verified: true } : await verify();
        return json({ ok: true, result: { conditionalPut: check?.verified === true, issue: check?.issue } }, 200);
      }
      case 'listVersions':
        return json({ ok: true, result: await s3.listVersions(requireString(body.key, 'key', 1024)) }, 200);
      case 'deleteVersion':
        await s3.deleteVersion(requireString(body.key, 'key', 1024), requireString(body.versionId, 'versionId', 1024));
        return json({ ok: true, result: { deleted: true } }, 200);
      case 'restoreVersion': {
        // Restoring is a server-side copy of the old version onto the same key:
        // it becomes the new latest version, and nothing is overwritten lossily.
        const key = requireString(body.key, 'key', 1024);
        await s3.copyObject(key, key, requireString(body.versionId, 'versionId', 1024));
        return json({ ok: true, result: { restored: true } }, 200);
      }
      case 'listTree':
        return json({
          ok: true,
          result: { objects: await listTreeObjects(s3, asString(body.prefix, 1024) ?? '') },
        }, 200);
      case 'restore':
        await s3.restoreObject(requireString(body.key, 'key', 1024), Math.max(1, Math.trunc(numberOr(body.days, 1))));
        return json({ ok: true, result: { requested: true } }, 200);
      case 'search': {
        const needle = requireString(body.query, 'query', 256);
        return json({
          ok: true,
          result: await s3.searchKeys(needle, { prefix: asString(body.prefix, 1024) }),
        }, 200);
      }
      case 'createFolder': {
        const key = requireString(body.key, 'key', 1024);
        if (!key.endsWith('/')) throw new BadRequestError('A folder key must end with /.');
        await s3.putObject(key, '');
        return json({ ok: true, result: { created: true } }, 200);
      }
      case 'copy': {
        const result = await copyTree(
          s3,
          requireString(body.sourceKey, 'sourceKey', 1024),
          requireString(body.destKey, 'destKey', 1024),
        );
        return json({ ok: true, result: { copied: result.length } }, 200);
      }
      case 'rename': {
        const sourceKey = requireString(body.sourceKey, 'sourceKey', 1024);
        const destKey = requireString(body.destKey, 'destKey', 1024);
        const copied = await copyTree(s3, sourceKey, destKey, true);
        if (copied.some(source => source.versioned)) {
          return json({ ok: false, error: `Copied ${copied.length} objects. All sources were retained. ` +
            'A versioned source can acquire a newer version with the same ETag. Review its version history before removing it.' }, 200);
        }
        const failures: string[] = [];
        for (const { key, eTag } of copied) {
          try {
            await s3.deleteObject(key, eTag);
          } catch (error) {
            const message = (error instanceof Error ? error.message : String(error)).slice(0, 512);
            failures.push(`${key}: ${message}`);
          }
        }
        const moved = copied.length - failures.length;
        if (failures.length) return json({ ok: false, error:
          `Copied ${copied.length} objects. Confirmed removal of ${moved} sources. Unconfirmed: ${failures.join('; ')}` }, 200);
        return json({ ok: true, result: { moved } }, 200);
      }
      case 'share': {
        const key = grantKey(body.key);
        const expiresIn = Math.min(SHARE_MAX_SECONDS, Math.max(SHARE_MIN_SECONDS, numberOr(body.expiresIn, 3600)));
        const token = sessions.mintMedia(sessionId, key, { ttlMs: expiresIn * 1000 });
        if (!token) return json({ ok: false, error: 'S3 session expired or unknown.' }, 404);
        return json({ ok: true, result: { url: `/api/s3/media/${token}`, expiresIn } }, 200);
      }
      case 'shareWrite': {
        const key = grantKey(body.key);
        const expiresIn = Math.min(SHARE_MAX_SECONDS, Math.max(SHARE_MIN_SECONDS, numberOr(body.expiresIn, 3600)));
        const maxBytes = Math.min(UPLOAD_CAP_MAX, Math.max(1, numberOr(body.maxBytes, UPLOAD_CAP_DEFAULT)));
        const token = sessions.mintMedia(sessionId, key, { ttlMs: expiresIn * 1000, kind: 'write', maxBytes });
        if (!token) return json({ ok: false, error: 'S3 session expired or unknown.' }, 404);
        return json({ ok: true, result: { url: `/api/s3/upload/${token}`, expiresIn, maxBytes } }, 200);
      }
      case 'presignGet':
        return json({
          ok: true,
          result: {
            url: await presignGetUrl(signer(session), targetOf(session), requireString(body.key, 'key', 1024), presignExpiry(body.expiresIn)),
          },
        }, 200);
      case 'presignPut':
        return json({
          ok: true,
          result: {
            url: await presignPutUrl(
              signer(session),
              targetOf(session),
              requireString(body.key, 'key', 1024),
              body.contentType === undefined ? undefined : requireString(body.contentType, 'contentType', 256),
              presignExpiry(body.expiresIn),
            ),
          },
        }, 200);
      case 'media': {
        const key = grantKey(body.key);
        // Preview grants are session-bound: they die with the session and can
        // be handed back early by the preview itself (op mediaRevoke).
        const token = sessions.mintMedia(sessionId, key, { versionId: asString(body.versionId, 1024), bound: true });
        if (!token) return json({ ok: false, error: 'S3 session expired or unknown.' }, 404);
        return json({ ok: true, result: { url: `/api/s3/media/${token}` } }, 200);
      }
      case 'mediaRevoke': {
        const token = requireString(body.token, 'token', 128);
        return json({ ok: true, result: { revoked: sessions.revokeMediaForSession(sessionId, token) } }, 200);
      }
      case 'probe':
        return json({ ok: true, result: await probe(session.endpoint, session.bucket, session.pathStyle, options) }, 200);
      default:
        return json({ ok: false, error: 'Unknown S3 operation.' }, 400);
    }
  } catch (err) {
    const failed = s3Failure(err, op ?? 's3');
    if (failed) return failed;
    throw err;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** SigV4 presigned URLs accept 1 second to 7 days, in whole seconds. */
function presignExpiry(value: unknown): number {
  return Math.min(SHARE_MAX_SECONDS, Math.max(1, Math.trunc(numberOr(value, 3600))));
}

/** Every object under a prefix, capped so one walk cannot run away on a huge bucket. */
async function listTreeObjects(
  s3: ReturnType<typeof client>,
  prefix: string,
): Promise<{ key: string; size: number; storageClass: string | null }[]> {
  const objects: { key: string; size: number; storageClass: string | null }[] = [];
  const seenTokens = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const page = await s3.listObjects(prefix, { maxKeys: 1000, continuationToken });
    for (const object of page.objects) {
      objects.push({ key: object.key, size: object.size, storageClass: object.storageClass });
      if (objects.length > MAX_TREE_ENTRIES) {
        throw new BadRequestError(`This folder has more than ${MAX_TREE_ENTRIES} objects. Work on it in smaller parts.`);
      }
    }
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    if (page.isTruncated) {
      if (!continuationToken || seenTokens.has(continuationToken) || seenTokens.size >= MAX_TREE_ENTRIES) {
        throw new BadRequestError('The provider did not return a complete folder listing.');
      }
      seenTokens.add(continuationToken);
    }
  } while (continuationToken);
  return objects;
}

/** One object, copied inside S3. Large objects use multipart copy, never the browser. */
async function copyOne(s3: ReturnType<typeof client>, sourceKey: string, destKey: string, moving: boolean) {
  const meta = await s3.headObject(sourceKey);
  const eTag = isStrongETag(meta.eTag) ? meta.eTag : undefined;
  const versionId = meta.versionId || undefined;
  const source = { key: sourceKey, eTag: meta.eTag, versioned: meta.versionId !== null };
  const immutableVersion = versionId !== undefined && versionId !== 'null';
  if (!Number.isSafeInteger(meta.contentLength) || meta.contentLength < 0 || meta.contentLength > 10000 * COPY_SINGLE_LIMIT) {
    throw new BadRequestError('Invalid object size for S3 copy.');
  }
  const multipart = meta.contentLength > COPY_SINGLE_LIMIT;
  if (!eTag && (moving || (multipart && !immutableVersion))) {
    throw new BadRequestError(`Cannot safely copy ${sourceKey}: the provider did not return a strong ETag.`);
  }
  if (!multipart) {
    await s3.copyObject(sourceKey, destKey, versionId, eTag);
    return source;
  }
  if (!immutableVersion && !s3.supportsCondition('copy')) {
    throw new BadRequestError('A multipart copy requires a pinned version or verified copy-source preconditions.');
  }
  const uploadId = await s3.createMultipartUpload(destKey, meta.contentType);
  const parts: PartInfo[] = [];
  try {
    const partSize = Math.max(COPY_PART_SIZE, Math.ceil(meta.contentLength / 10000));
    for (let start = 0; start < meta.contentLength; start += partSize) {
      const end = Math.min(start + partSize, meta.contentLength) - 1;
      const partNumber = parts.length + 1;
      const partTag = await s3.copyPart(sourceKey, destKey, uploadId, partNumber, start, end, eTag, versionId);
      parts.push({ PartNumber: partNumber, ETag: partTag });
    }
    await s3.completeMultipartUpload(destKey, uploadId, parts);
  } catch (error) {
    await s3.abortMultipartUpload(destKey, uploadId).catch(() => {});
    throw error;
  }
  return source;
}

async function copyTree(
  s3: ReturnType<typeof client>,
  sourceKey: string,
  destKey: string,
  moving = false,
): Promise<{ key: string; eTag: string; versioned: boolean }[]> {
  const folder = sourceKey.endsWith('/');
  if (sourceKey === destKey || (folder && destKey.startsWith(sourceKey))) {
    throw new BadRequestError('Source and destination overlap.');
  }
  if (moving && !s3.supportsCondition('move')) {
    throw new BadRequestError('Conditional moves have not been verified for this bucket. Use Copy to retain the source.');
  }
  const keys = folder ? (await listTreeObjects(s3, sourceKey)).map(row => row.key) : [sourceKey];
  const sources = new Set(keys);
  const mapping = keys.map(key => {
    if (!key.startsWith(sourceKey)) throw new BadRequestError('The provider listed a key outside the source prefix.');
    const destination = destKey + key.slice(sourceKey.length);
    if (sources.has(destination)) throw new BadRequestError('Source and destination object keys overlap.');
    // Validate every request path before the first mutation.
    s3.objectUrl(key);
    s3.objectUrl(destination);
    return { key, destination };
  });
  const copied = [];
  for (const { key, destination } of mapping) {
    copied.push(await copyOne(s3, key, destination, moving));
  }
  return copied;
}

function sessionMaterial(body: Record<string, unknown>): { ok: true; material: Parameters<SessionStore['create']>[0] } | { ok: false; detail: string } {
  const endpoint = asString(body.endpoint, 2048);
  if (!endpoint) return { ok: false, detail: 'Endpoint is required.' };
  try {
    assertConnectionEndpoint(endpoint);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'Invalid endpoint.' };
  }
  const checked = checkProxyTarget(endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
  if (!checked.ok) return checked;
  const bucket = asString(body.bucket, 255);
  const region = asString(body.region, 64);
  const accessKeyId = asString(body.accessKeyId, 256);
  const secretAccessKey = asString(body.secretAccessKey, 256);
  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    return { ok: false, detail: 'Region, bucket, and credentials are required.' };
  }
  return {
    ok: true,
    material: {
      endpoint: endpoint.replace(/\/+$/, ''),
      region,
      bucket,
      pathStyle: body.pathStyle === true,
      verifyEditorWrites: body.verifyEditorWrites === true,
      headers: parseStoredHeaders(body.headers),
      accessKeyId,
      secretAccessKey,
      sessionToken: asString(body.sessionToken, 4096),
    },
  };
}

async function streamObject(
  request: Request,
  session: SessionView,
  key: string,
  options: AppApiOptions,
  versionId?: string,
  raw = false,
): Promise<Response> {
  const s3 = client(session, options);
  const headers: Record<string, string> = {};
  const range = request.headers.get('range');
  if (range && /^bytes=\d+-\d*$/.test(range)) headers.range = range;
  const url = s3.objectUrl(key, versionId ? { versionId } : undefined);
  const upstream = await s3.send(url, { method: request.method, headers, signal: request.signal });
  return relay(upstream, request.method, key, request.headers.get('sec-fetch-dest'), raw);
}

/**
 * Same-origin API. The browser names an operation; this process signs it and
 * calls S3. There is no client-supplied upstream URL.
 */
export async function handleAppRequest(request: Request, options: AppApiOptions): Promise<Response> {
  const url = new URL(request.url);
  const sessions = storeOf(options);

  if (url.pathname === S3_HEALTH_PATH && (request.method === 'GET' || request.method === 'HEAD')) {
    const body = JSON.stringify({
      ok: true,
      tokenRequired: options.expectedToken !== null,
      tokenAccepted: options.expectedToken === null || tokenMatches(presentedToken(request), options.expectedToken),
    });
    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  const media = /^\/api\/s3\/media\/([A-Za-z0-9_-]{32,128})$/.exec(url.pathname);
  if (media) {
    const token = media[1] ?? '';
    // Revoking needs the operator gate, not the bearer token: anyone holding
    // the link can read it, but only the operator can cut it off early.
    if (request.method === 'DELETE') {
      if (!trustedControlRequest(request, options)) {
        return json({ ok: false, error: 'Missing or incorrect server access token.', reason: 'bad-token' }, 403);
      }
      return json({ ok: true, result: { revoked: sessions.revokeMedia(token) } }, 200);
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const grant = sessions.useMedia(token);
      if (!grant || grant.kind !== 'read') return json({ ok: false, error: 'This link expired or was revoked.' }, 404);
      try {
        return await streamObject(request, grant.session, grant.key, options, grant.versionId);
      } catch (err) {
        return linkFailure(err);
      }
    }
    return json({ ok: false, error: 'Read links accept GET only.' }, 405);
  }

  const upload = /^\/api\/s3\/upload\/([A-Za-z0-9_-]{32,128})$/.exec(url.pathname);
  if (upload) {
    const token = upload[1] ?? '';
    if (request.method === 'DELETE') {
      if (!trustedControlRequest(request, options)) {
        return json({ ok: false, error: 'Missing or incorrect server access token.', reason: 'bad-token' }, 403);
      }
      return json({ ok: true, result: { revoked: sessions.revokeMedia(token) } }, 200);
    }
    if (request.method !== 'PUT') {
      return json({ ok: false, error: 'Upload links accept PUT only.' }, 405);
    }
    const grant = sessions.useMedia(token);
    if (!grant || grant.kind !== 'write') return json({ ok: false, error: 'This link expired or was revoked.' }, 404);
    const length = uploadLength(request);
    if (!length.ok) {
      return json(
        { ok: false, error: length.status === 411 ? 'Uploads require Content-Length.' : 'Invalid Content-Length.', reason: 'length-required' },
        length.status,
      );
    }
    const cap = grant.maxBytes ?? UPLOAD_CAP_DEFAULT;
    if (Number(length.length) > cap) {
      return json({ ok: false, error: `This link accepts at most ${cap} bytes.` }, 413);
    }
    if (!request.body && length.length !== '0') return json({ ok: false, error: 'Upload body is empty.' }, 400);
    // All local checks passed. Claim synchronously before dispatch: the outcome
    // of a disconnected PUT cannot safely be retried with the same authority.
    sessions.revokeMedia(token);
    const counted = request.body ? countedBody(request.body, cap) : null;
    const headers: Record<string, string> = {
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      'content-length': length.length,
    };
    const type = request.headers.get('content-type');
    if (type) headers['content-type'] = type;
    try {
      const s3 = client(grant.session, options);
      const upstream = await s3.send(s3.objectUrl(grant.key), {
        method: 'PUT',
        headers,
        body: counted?.body,
        signal: request.signal,
        duplex: 'half',
      } as RequestInit);
      return relay(upstream, 'PUT');
    } catch (err) {
      if (counted?.exceeded()) return json({ ok: false, error: `This link accepts at most ${cap} bytes.` }, 413);
      return linkFailure(err);
    }
  }

  if (!trustedControlRequest(request, options)) {
    return json({ ok: false, error: 'Missing or incorrect server access token.', reason: 'bad-token' }, 403);
  }

  try {
    if (url.pathname === '/api/s3/list-buckets' && request.method === 'POST') {
      const body = await readJson(request);
      const endpoint = asString(body.endpoint, 2048);
      const region = asString(body.region, 64);
      const accessKeyId = asString(body.accessKeyId, 256);
      const secretAccessKey = asString(body.secretAccessKey, 256);
      if (!endpoint || !region || !accessKeyId || !secretAccessKey) {
        return json({ ok: false, error: 'Endpoint, region, and credentials are required.' }, 400);
      }
      try {
        assertConnectionEndpoint(endpoint);
      } catch {
        return json({ ok: false, error: 'Invalid S3 endpoint.', reason: 'bad-target' }, 400);
      }
      const checked = checkProxyTarget(endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
      if (!checked.ok) return json({ ok: false, error: checked.detail, reason: 'bad-target' }, 400);
      const view: SessionView = {
        endpoint: endpoint.replace(/\/+$/, ''),
        region,
        bucket: '',
        pathStyle: true,
        headers: {},
        accessKeyId,
        secretAccessKey,
        sessionToken: asString(body.sessionToken, 4096),
      };
      try {
        const names = await client(view, options).listBuckets();
        return json({ ok: true, result: { buckets: names } }, 200);
      } catch (err) {
        const failed = s3Failure(err, 'ListBuckets');
        if (failed) return failed;
        throw err;
      }
    }

    if (url.pathname === '/api/s3/probe' && request.method === 'POST') {
      const body = await readJson(request);
      const built = sessionMaterial({ ...body, region: 'us-east-1', accessKeyId: 'probe', secretAccessKey: 'probe' });
      if (!built.ok) return json({ ok: false, error: built.detail, reason: 'bad-target' }, 400);
      return json({ ok: true, result: await probe(built.material.endpoint, built.material.bucket, built.material.pathStyle, options) }, 200);
    }

    if (url.pathname === `${S3_API_PREFIX}/sessions` && request.method === 'POST') {
      const built = sessionMaterial(await readJson(request));
      if (!built.ok) return json({ ok: false, error: built.detail, reason: 'bad-target' }, 400);
      await resolveProxyAddresses(new URL(built.material.endpoint), options.lookup);
      const id = sessions.create(built.material);
      return json({ ok: true, result: { sessionId: id } }, 200);
    }

    const sessionMatch = /^\/api\/s3\/sessions\/([A-Za-z0-9_-]{32,128})(\/.*)?$/.exec(url.pathname);
    if (!sessionMatch) return json({ ok: false, error: 'not found' }, 404);
    const sessionId = sessionMatch[1] ?? '';
    const rest = sessionMatch[2] ?? '';
    if (request.method === 'DELETE' && rest === '') {
      sessions.destroy(sessionId);
      return json({ ok: true, result: { closed: true } }, 200);
    }
    const session = sessions.use(sessionId);
    if (!session) return json({ ok: false, error: 'S3 session expired or unknown.' }, 404);

    if (rest === '/call' && request.method === 'POST') {
      return await handleCall(session, await readJson(request), options, sessions, sessionId);
    }
    if (rest === '/object' && (request.method === 'GET' || request.method === 'HEAD' || request.method === 'PUT')) {
      const key = url.searchParams.get('key');
      if (!key) return json({ ok: false, error: 'Object key is required.' }, 400);
      if (request.method === 'PUT') {
        const length = uploadLength(request);
        if (!length.ok) {
          return json(
            { ok: false, error: length.status === 411 ? 'S3 uploads require Content-Length.' : 'Invalid Content-Length.', reason: 'length-required' },
            length.status,
          );
        }
        const headers: Record<string, string> = {
          'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
          'content-length': length.length,
          ...contentMd5Header(request),
        };
        const type = request.headers.get('content-type');
        if (type) headers['content-type'] = type;
        const s3 = client(session, options, sessions.editorWriteCheck(sessionId)?.verified === true);
        const ifMatch = request.headers.get('if-match');
        if (ifMatch !== null) {
          if (!isStrongETag(ifMatch)) return json({ ok: false, error: 'A single strong ETag is required.' }, 400);
          if (!s3.supportsCondition('put')) return json({ ok: false, error: 'Conditional writes are unverified for this bucket.' }, 501);
          headers['if-match'] = ifMatch;
        }
        const upstream = await s3.send(s3.objectUrl(key), {
          method: 'PUT',
          headers,
          body: request.body,
          signal: request.signal,
          duplex: 'half',
        } as RequestInit);
        return relay(upstream, 'PUT');
      }
      const versionId = url.searchParams.get('versionId') ?? undefined;
      return await streamObject(request, session, key, options, versionId, url.searchParams.get('raw') === '1');
    }
    if (rest === '/part' && request.method === 'PUT') {
      const key = url.searchParams.get('key');
      const uploadId = url.searchParams.get('uploadId');
      const partNumber = url.searchParams.get('partNumber');
      if (!key || !uploadId || !partNumber) return json({ ok: false, error: 'Part upload is missing key, uploadId, or partNumber.' }, 400);
      const length = uploadLength(request);
      if (!length.ok) {
        return json(
          { ok: false, error: length.status === 411 ? 'S3 uploads require Content-Length.' : 'Invalid Content-Length.', reason: 'length-required' },
          length.status,
        );
      }
      const s3 = client(session, options);
      const upstream = await s3.send(s3.objectUrl(key, { uploadId, partNumber }), {
        method: 'PUT',
        headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-length': length.length, ...contentMd5Header(request) },
        body: request.body,
        signal: request.signal,
        duplex: 'half',
      } as RequestInit);
      return relay(upstream, 'PUT');
    }
    return json({ ok: false, error: 'not found' }, 404);
  } catch (err) {
    if (err instanceof BlockedProxyTargetError) return json({ ok: false, error: err.message, reason: 'bad-target' }, 400);
    if (err instanceof SyntaxError) return json({ ok: false, error: 'Request body is not JSON.' }, 400);
    if (err instanceof BadRequestError) return json({ ok: false, error: err.message }, 400);
    const message = err instanceof Error ? err.message : String(err);
    const status = /too large/i.test(message) ? 413 : 502;
    return json({ ok: false, error: status === 502 ? `The Galiot server could not reach the S3 endpoint (502): ${message}` : message }, status);
  }
}
