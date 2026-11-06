import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { S3Client, s3ClientForProfile } from './client';
import { parseStoredHeaders } from './customHeaders';
import { profileConfig } from '../db/objects';
import type { ConnectionRow } from '../db/client';

/**
 * Proves custom headers actually reach the wire *inside the signature*.
 *
 * "The header arrived" is not enough. A header appended after signing is sent
 * unsigned: some gateways ignore it, S3 rejects the request. The only assertion
 * that carries information is that an independent SigV4 verifier, sharing no code
 * with `lib/aws4fetch`, accepts the request — and that it *rejects* the same
 * request with the custom header removed. Both directions are checked, because a
 * verifier that accepts anything would make the first assertion worthless.
 */

const ACCESS_KEY = 'AKIACUSTOMHDR00000';
const SECRET_KEY = 'custom-header-verify-secret';
const REGION = 'us-east-1';
const BUCKET = 'example-bucket';
const CUSTOM = { 'x-tenant-id': 'acme', 'x-request-id': 'fixed-42' };

const encoder = new TextEncoder();

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key instanceof Uint8Array ? (key as Uint8Array<ArrayBuffer>) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

/** RFC 3986 encoding as SigV4 defines it: encodeURIComponent plus !'()* */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

interface VerifyInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Drop these before verifying, to prove the signature really covers them. */
  omit?: string[];
}

/** Recomputes the signature from the spec and compares it to the one sent. */
async function verifySignature({ method, url, headers, omit = [] }: VerifyInput): Promise<boolean> {
  const parsed = new URL(url);
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (omit.includes(name.toLowerCase())) continue;
    lower[name.toLowerCase()] = value;
  }

  const auth = lower['authorization'] ?? '';
  const signedHeadersMatch = /SignedHeaders=([^,]+)/.exec(auth);
  const signatureMatch = /Signature=([0-9a-f]{64})/.exec(auth);
  const credentialMatch = /Credential=[^/]+\/(\d{8})\/([^/]+)\/([^/]+)\//.exec(auth);
  if (!signedHeadersMatch || !signatureMatch || !credentialMatch) return false;

  const signedHeaders = signedHeadersMatch[1]!.split(';');
  const [date, region, service] = [
    credentialMatch[1]!,
    credentialMatch[2]!,
    credentialMatch[3]!,
  ] as const;

  const canonicalHeaders =
    signedHeaders.map((name) => `${name}:${(lower[name] ?? '').replace(/\s+/g, ' ').trim()}\n`).join('');

  const queryParams: [string, string][] = [];
  parsed.searchParams.forEach((value, key) => {
    queryParams.push([rfc3986(key), rfc3986(value)]);
  });
  queryParams.sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1));
  const canonicalQuery = queryParams.map(([k, v]) => `${k}=${v}`).join('&');

  // The path arrives already percent-encoded once; SigV4 wants it encoded once,
  // so decode and re-encode each segment.
  const canonicalUri = decodeURIComponent(parsed.pathname)
    .split('/')
    .map((segment) => rfc3986(segment))
    .join('/');

  const payloadHash = lower['x-amz-content-sha256'] ?? (await sha256Hex(''));
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders.join(';')}\n${payloadHash}`;

  const datetime = lower['x-amz-date'] ?? '';
  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${datetime}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

  const kDate = await hmac(encoder.encode(`AWS4${SECRET_KEY}`), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const expected = [...new Uint8Array(await hmac(kSigning, stringToSign))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return expected === signatureMatch[1];
}

/* ------------------------------------------------------------------ */

interface Seen {
  method: string;
  search: string;
  headers: Record<string, string>;
  url: string;
}

const seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;
let endpoint = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const url = new URL(req.url);
      seen.push({ method: req.method, search: url.search, headers, url: req.url });

      const body = await req.text();
      if (body.length > 0) {
        // Re-verify against the actual body hash the client declared.
        seen[seen.length - 1]!.headers['x-amz-content-sha256'] =
          headers['x-amz-content-sha256'] ?? (await sha256Hex(body));
      }

      const query = url.search;
      if (query.includes('list-type=2')) {
        return new Response(
          '<?xml version="1.0"?><ListBucketResult><Name>example-bucket</Name>' +
            '<Contents><Key>a.txt</Key><Size>3</Size><ETag>&quot;x&quot;</ETag>' +
            '<LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>' +
            '<IsTruncated>false</IsTruncated></ListBucketResult>',
          { status: 200, headers: { 'content-type': 'application/xml' } },
        );
      }
      if (req.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-length': '3', 'content-type': 'text/plain', etag: '"abc"' },
        });
      }
      if (req.method === 'PUT') {
        return new Response('', { status: 200, headers: { etag: '"abc123"' } });
      }
      if (req.method === 'DELETE') {
        return new Response(query.includes('delete=') ? '<?xml version="1.0"?><DeleteResult></DeleteResult>' : '', {
          status: query.includes('delete=') ? 200 : 204,
        });
      }
      if (query.includes('uploads')) {
        return new Response(
          '<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>',
          { status: 200, headers: { 'content-type': 'application/xml' } },
        );
      }
      return new Response('body', { status: 200, headers: { 'content-type': 'text/plain' } });
    },
  });
  endpoint = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

function client(headers?: Record<string, string>): S3Client {
  return new S3Client({
    endpoint,
    region: REGION,
    bucket: BUCKET,
    pathStyle: true,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    headers,
    direct: true,
  });
}

/** The recorded request whose query/method matches, from the end of the log. */
function lastRequest(predicate: (s: Seen) => boolean): Seen {
  for (let i = seen.length - 1; i >= 0; i--) {
    if (predicate(seen[i]!)) return seen[i]!;
  }
  throw new Error('no matching request was recorded');
}

describe('custom headers on the wire', () => {
  test('every operation carries them, and the signature covers them', async () => {
    const withHeaders = client(CUSTOM);

    await withHeaders.listObjects();
    const list = lastRequest((s) => s.search.includes('list-type=2'));
    expect(list.headers['x-tenant-id']).toBe('acme');
    expect(list.headers['x-request-id']).toBe('fixed-42');
    expect(list.headers['authorization']).toContain('x-tenant-id');
    expect(list.headers['authorization']).toContain('x-request-id');
    expect(await verifySignature({ method: 'GET', url: list.url, headers: list.headers })).toBe(true);

    await withHeaders.headObject('a.txt');
    const head = lastRequest((s) => s.method === 'HEAD');
    expect(head.headers['x-tenant-id']).toBe('acme');
    expect(await verifySignature({ method: 'HEAD', url: head.url, headers: head.headers })).toBe(true);

    await withHeaders.putObject('a.txt', 'abc', 'text/plain');
    const put = lastRequest((s) => s.method === 'PUT' && !s.search.includes('uploadId'));
    expect(put.headers['x-tenant-id']).toBe('acme');
    expect(await verifySignature({ method: 'PUT', url: put.url, headers: put.headers })).toBe(true);

    await withHeaders.getObject('a.txt');
    const get = lastRequest((s) => s.method === 'GET' && !s.search.includes('list-type'));
    expect(get.headers['x-tenant-id']).toBe('acme');
    expect(await verifySignature({ method: 'GET', url: get.url, headers: get.headers })).toBe(true);

    await withHeaders.deleteObject('a.txt');
    const del = lastRequest((s) => s.method === 'DELETE');
    expect(del.headers['x-tenant-id']).toBe('acme');
    expect(await verifySignature({ method: 'DELETE', url: del.url, headers: del.headers })).toBe(true);
  });

  test('the signature is bound to the header value, not merely its presence', async () => {
    // A verifier that accepts anything would make every assertion above empty.
    // Removing a signed header after the fact must invalidate the signature —
    // which is exactly what a proxy that strips it would cause in production.
    await client(CUSTOM).listObjects('');
    const req = lastRequest((s) => s.search.includes('list-type=2'));

    expect(await verifySignature({ method: 'GET', url: req.url, headers: req.headers })).toBe(true);
    expect(
      await verifySignature({
        method: 'GET',
        url: req.url,
        headers: req.headers,
        omit: ['x-tenant-id'],
      }),
    ).toBe(false);
  });

  test('a tampered header value fails verification', async () => {
    await client(CUSTOM).listObjects('');
    const req = lastRequest((s) => s.search.includes('list-type=2'));

    const tampered = { ...req.headers, 'x-tenant-id': 'someone-else' };
    expect(await verifySignature({ method: 'GET', url: req.url, headers: tampered })).toBe(false);
  });

  test('no custom headers leaves the request exactly as before', async () => {
    const before = seen.length;
    await client().listObjects();
    const req = seen[before]!;
    expect(req.headers['x-tenant-id']).toBeUndefined();
    expect(req.headers['authorization']).not.toContain('x-tenant-id');
    expect(await verifySignature({ method: 'GET', url: req.url, headers: req.headers })).toBe(true);
  });

  test('call-specific headers are not displaced by stored ones', async () => {
    // putObject sets its own content-type; a stored header of the same name is
    // refused by policy, and `withCustomHeaders` keeps the call's value anyway.
    const c = client({ 'x-tenant-id': 'acme' });
    await c.putObject('a.txt', 'abc', 'application/json');
    const put = lastRequest((s) => s.method === 'PUT' && !s.search.includes('uploadId'));
    expect(put.headers['content-type']).toBe('application/json');
    expect(put.headers['x-tenant-id']).toBe('acme');
  });

  test('headers read back from the database are screened again', () => {
    // The column is cleartext and outlives upgrades, so the request path cannot
    // trust what it finds there.
    expect(parseStoredHeaders({ 'x-tenant-id': 'acme', 'x-api-key': 'nope' })).toEqual({
      'x-tenant-id': 'acme',
    });
  });
});

/**
 * The two seams the feature depends on. `S3Client` honouring `headers` is proven
 * above; these cover getting the headers *to* it — a mapping that silently drops
 * them would leave every test above green while the feature does nothing.
 */
describe('custom headers reach the client', () => {
  const row: ConnectionRow = {
    id: '66666666-6666-4666-8666-666666666666',
    name: 'headers',
    protocol: 's3',
    endpoint: 'https://s3.example.com',
    region: REGION,
    bucket: 'example-bucket',
    path_style: true,
    network: 'user',
    storage_class: null,
    custom_headers: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  test('profileConfig maps and screens the stored column', () => {
    expect(
      profileConfig({ ...row, custom_headers: { 'x-tenant-id': 'acme', 'x-api-key': 'nope' } })
        .headers,
    ).toEqual({ 'x-tenant-id': 'acme' });

    // JSONB may come back parsed or as text; both must read the same.
    expect(profileConfig({ ...row, custom_headers: '{"x-a":"1"}' }).headers).toEqual({
      'x-a': '1',
    });
    expect(profileConfig({ ...row, custom_headers: null }).headers).toEqual({});
  });

  test('s3ClientForProfile carries them through to a real request', async () => {
    const c = s3ClientForProfile(
      {
        endpoint,
        region: REGION,
        bucket: BUCKET,
        pathStyle: true,
        headers: { 'x-tenant-id': 'acme' },
      },
      { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      { direct: true },
    );

    await c.listObjects();
    const req = lastRequest((s) => s.search.includes('list-type=2'));
    expect(req.headers['x-tenant-id']).toBe('acme');
    expect(await verifySignature({ method: 'GET', url: req.url, headers: req.headers })).toBe(true);
  });

  test('a profile with no headers produces a client that sends none', async () => {
    const c = s3ClientForProfile(
      profileConfig({ ...row, endpoint, region: REGION, bucket: BUCKET }),
      { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      { direct: true },
    );

    await c.listObjects();
    const req = lastRequest((s) => s.search.includes('list-type=2'));
    expect(req.headers['x-tenant-id']).toBeUndefined();
    expect(await verifySignature({ method: 'GET', url: req.url, headers: req.headers })).toBe(true);
  });
});
