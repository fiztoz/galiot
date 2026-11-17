import { timingSafeEqual } from 'node:crypto';
import { AwsClient } from '../lib/aws4fetch';
import { parseStoredHeaders } from '../s3/customHeaders';
import { presignGetUrl, presignPutBucketCors, presignPutUrl } from '../s3/presign';
import { buildS3Url } from '../s3/url';
import { S3RequestError, type CorsConfiguration, type PartInfo, type ProbeResult } from '../s3/client';
import { xmlBlocks, xmlFirst } from '../s3/xml';
import { clientForSession } from './engine';
import {
  S3_ACCESS_TOKEN_HEADER,
  S3_API_PREFIX,
  S3_HEALTH_PATH,
  S3_PROXY_TOKEN_HEADER,
} from './protocol';
import { SessionStore, type SessionView } from './sessions';
import { BlockedProxyTargetError, resolveProxyAddresses, type ProxyLookup } from './target';
import { checkProxyTarget } from './proxy';
import { forwardRequest } from './upstream';

const JSON_LIMIT = 1_000_000;
const TEXT_LIMIT = 2 * 1024 * 1024;
/** AWS CopyObject limit; above it the copy must go through UploadPartCopy. */
const COPY_SINGLE_LIMIT = 5 * 1024 ** 3;
const COPY_PART_SIZE = 512 * 1024 ** 2;
const MAX_TREE_ENTRIES = 10_000;
const SHARE_MIN_SECONDS = 60;
const SHARE_MAX_SECONDS = 7 * 24 * 3600;

export interface AppApiOptions {
  expectedToken: string | null;
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

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length');
  if (declared && (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > JSON_LIMIT)) {
    throw new Error('Request body is too large.');
  }
  const text = await request.text();
  if (text.length > JSON_LIMIT) throw new Error('Request body is too large.');
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  return asRecord(parsed);
}

function uploadLength(request: Request): { ok: true; length: string } | { ok: false; status: 411 | 400 } {
  const length = request.headers.get('content-length');
  if (length === null) return { ok: false, status: 411 };
  if (!/^(0|[1-9]\d*)$/.test(length) || !Number.isSafeInteger(Number(length))) return { ok: false, status: 400 };
  return { ok: true, length };
}

function relay(upstream: Response, method: string): Response {
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === 'connection' || lower === 'transfer-encoding' || lower === 'keep-alive') return;
    if (lower.startsWith('access-control-')) return;
    headers.set(name, value);
  });
  headers.set('cache-control', 'no-store');
  headers.delete('cdn-cache-control');
  headers.delete('surrogate-control');
  const empty = method === 'HEAD' || upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  return new Response(empty ? null : upstream.body, { status: upstream.status, headers });
}

function client(session: SessionView, options: AppApiOptions) {
  return clientForSession(session, options.lookup, options.forward ?? forwardRequest);
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
  try {
    switch (op) {
      case 'list':
        return json({
          ok: true,
          result: await s3.listObjects(asString(body.prefix, 1024), {
            delimiter: asString(body.delimiter, 8),
            maxKeys: typeof body.maxKeys === 'number' ? body.maxKeys : undefined,
            continuationToken: asString(body.continuationToken, 4096),
          }),
        }, 200);
      case 'delete': {
        const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === 'string' && key.length <= 1024).slice(0, 1000) : [];
        return json({ ok: true, result: await s3.deleteObjects(keys) }, 200);
      }
      case 'putText': {
        const key = requireString(body.key, 'key', 1024);
        const text = requireString(body.body, 'body', TEXT_LIMIT);
        return json({ ok: true, result: await s3.putObject(key, text, asString(body.contentType, 256)) }, 200);
      }
      case 'createMultipart':
        return json({
          ok: true,
          result: { uploadId: await s3.createMultipartUpload(requireString(body.key, 'key', 1024), asString(body.contentType, 256)) },
        }, 200);
      case 'completeMultipart': {
        const parts = Array.isArray(body.parts) ? body.parts.flatMap((part): PartInfo[] => {
          const row = asRecord(part);
          const partNumber = row.PartNumber ?? row.partNumber;
          const eTag = row.ETag ?? row.eTag;
          if (typeof partNumber !== 'number' || typeof eTag !== 'string') return [];
          return [{ PartNumber: partNumber, ETag: eTag }];
        }) : [];
        await s3.completeMultipartUpload(requireString(body.key, 'key', 1024), requireString(body.uploadId, 'uploadId'), parts);
        return json({ ok: true, result: { completed: true } }, 200);
      }
      case 'abortMultipart':
        await s3.abortMultipartUpload(requireString(body.key, 'key', 1024), requireString(body.uploadId, 'uploadId'));
        return json({ ok: true, result: { aborted: true } }, 200);
      case 'listParts': {
        const key = requireString(body.key, 'key', 1024);
        const uploadId = requireString(body.uploadId, 'uploadId');
        const res = await s3.send(s3.objectUrl(key, { uploadId }));
        if (!res.ok) {
          const text = await res.text();
          return json({ ok: false, error: text || res.statusText, status: res.status, code: xmlFirst(text, 'Code') ?? `HTTP ${res.status}` }, 200);
        }
        const text = await res.text();
        const parts = xmlBlocks(text, 'Part').map((block) => ({
          partNumber: parseInt(xmlFirst(block, 'PartNumber') ?? '0', 10),
          eTag: xmlFirst(block, 'ETag') ?? '',
          size: parseInt(xmlFirst(block, 'Size') ?? '0', 10),
        }));
        return json({ ok: true, result: { parts } }, 200);
      }
      case 'head':
        return json({ ok: true, result: await s3.headObject(requireString(body.key, 'key', 1024)) }, 200);
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
        await s3.restoreObject(requireString(body.key, 'key', 1024), numberOr(body.days, 1));
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
        return json({ ok: true, result: { copied: result.count } }, 200);
      }
      case 'rename': {
        const sourceKey = requireString(body.sourceKey, 'sourceKey', 1024);
        const destKey = requireString(body.destKey, 'destKey', 1024);
        if (sourceKey === destKey) throw new BadRequestError('Source and destination are the same.');
        if (destKey.startsWith(sourceKey) && sourceKey.endsWith('/')) {
          throw new BadRequestError('A folder cannot be moved inside itself.');
        }
        const result = await copyTree(s3, sourceKey, destKey);
        await deleteInBatches(s3, result.keys);
        return json({ ok: true, result: { moved: result.count } }, 200);
      }
      case 'share': {
        const key = requireString(body.key, 'key', 1024);
        const expiresIn = Math.min(SHARE_MAX_SECONDS, Math.max(SHARE_MIN_SECONDS, numberOr(body.expiresIn, 3600)));
        const token = sessions.mintMedia(sessionId, key, expiresIn * 1000);
        if (!token) return json({ ok: false, error: 'S3 session expired or unknown.' }, 404);
        return json({ ok: true, result: { url: `/api/s3/media/${token}`, expiresIn } }, 200);
      }
      case 'presignGet':
        return json({
          ok: true,
          result: {
            url: await presignGetUrl(signer(session), targetOf(session), requireString(body.key, 'key', 1024), numberOr(body.expiresIn, 3600)),
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
              asString(body.contentType, 256),
              numberOr(body.expiresIn, 3600),
            ),
          },
        }, 200);
      case 'corsGet':
        return json({ ok: true, result: await s3.getBucketCors() }, 200);
      case 'corsPut': {
        if (!body.config || typeof body.config !== 'object') throw new Error('CORS configuration is required.');
        await s3.putBucketCors(body.config as CorsConfiguration);
        return json({ ok: true, result: { applied: true } }, 200);
      }
      case 'corsDelete':
        await s3.deleteBucketCors();
        return json({ ok: true, result: { deleted: true } }, 200);
      case 'corsPresign':
        return json({
          ok: true,
          result: { url: await presignPutBucketCors(signer(session), targetOf(session), 'application/xml', numberOr(body.expiresIn, 3600)) },
        }, 200);
      case 'media': {
        const key = requireString(body.key, 'key', 1024);
        const token = sessions.mintMedia(sessionId, key, undefined, asString(body.versionId, 1024));
        if (!token) return json({ ok: false, error: 'S3 session expired or unknown.' }, 404);
        return json({ ok: true, result: { url: `/api/s3/media/${token}` } }, 200);
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

/** Every object under a prefix, capped so one walk cannot run away on a huge bucket. */
async function listTreeObjects(
  s3: ReturnType<typeof client>,
  prefix: string,
): Promise<{ key: string; size: number; storageClass: string | null }[]> {
  const objects: { key: string; size: number; storageClass: string | null }[] = [];
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
  } while (continuationToken);
  return objects;
}

async function listTreeKeys(s3: ReturnType<typeof client>, prefix: string): Promise<string[]> {
  return (await listTreeObjects(s3, prefix)).map((object) => object.key);
}

/** One object, copied inside S3. Large objects use multipart copy, never the browser. */
async function copyOne(s3: ReturnType<typeof client>, sourceKey: string, destKey: string): Promise<void> {
  const meta = await s3.headObject(sourceKey);
  if (meta.contentLength <= COPY_SINGLE_LIMIT) {
    await s3.copyObject(sourceKey, destKey);
    return;
  }
  const uploadId = await s3.createMultipartUpload(destKey, meta.contentType);
  const parts: PartInfo[] = [];
  let partNumber = 1;
  for (let start = 0; start < meta.contentLength; start += COPY_PART_SIZE) {
    const end = Math.min(start + COPY_PART_SIZE, meta.contentLength) - 1;
    const eTag = await s3.copyPart(sourceKey, destKey, uploadId, partNumber, start, end);
    parts.push({ PartNumber: partNumber, ETag: eTag });
    partNumber += 1;
  }
  await s3.completeMultipartUpload(destKey, uploadId, parts);
}

async function copyTree(
  s3: ReturnType<typeof client>,
  sourceKey: string,
  destKey: string,
): Promise<{ count: number; keys: string[] }> {
  if (!sourceKey.endsWith('/')) {
    await copyOne(s3, sourceKey, destKey);
    return { count: 1, keys: [sourceKey] };
  }
  const keys = await listTreeKeys(s3, sourceKey);
  for (const key of keys) {
    await copyOne(s3, key, destKey + key.slice(sourceKey.length));
  }
  return { count: keys.length, keys };
}

async function deleteInBatches(s3: ReturnType<typeof client>, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await s3.deleteObjects(keys.slice(i, i + 1000));
  }
}

function sessionMaterial(body: Record<string, unknown>): { ok: true; material: Parameters<SessionStore['create']>[0] } | { ok: false; detail: string } {
  const endpoint = asString(body.endpoint, 2048);
  if (!endpoint) return { ok: false, detail: 'Endpoint is required.' };
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
): Promise<Response> {
  const s3 = client(session, options);
  const headers: Record<string, string> = {};
  const range = request.headers.get('range');
  if (range && /^bytes=\d+-\d*$/.test(range)) headers.range = range;
  const url = s3.objectUrl(key, versionId ? { versionId } : undefined);
  const upstream = await s3.send(url, { method: request.method, headers, signal: request.signal });
  return relay(upstream, request.method);
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
      if (!authorized(request, options.expectedToken)) {
        return json({ ok: false, error: 'Missing or incorrect server access token.', reason: 'bad-token' }, 403);
      }
      return json({ ok: true, result: { revoked: sessions.revokeMedia(token) } }, 200);
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const grant = sessions.useMedia(token);
      if (!grant) return json({ ok: false, error: 'This link expired or was revoked.' }, 404);
      try {
        return await streamObject(request, grant.session, grant.key, options, grant.versionId);
      } catch (err) {
        if (err instanceof BlockedProxyTargetError) return json({ ok: false, error: err.message, reason: 'bad-target' }, 400);
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
      }
    }
  }

  if (!authorized(request, options.expectedToken)) {
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
        };
        const type = request.headers.get('content-type');
        if (type) headers['content-type'] = type;
        const s3 = client(session, options);
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
      return await streamObject(request, session, key, options, versionId);
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
        headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-length': length.length },
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
