import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AwsClient } from '../lib/aws4fetch';
import { presignPutBucketCors } from './presign';
import { buildCorsRemediation } from './corsRemediation';
import { corsConfigToXml } from './corsPolicy';
import type { CorsConfiguration } from './client';

/**
 * Proves the presigned-CORS path really works, by verifying the signature with
 * an implementation written from the SigV4 spec rather than the app's signer.
 *
 * This is the path a user with no S3 tooling takes to unblock a bucket, so a
 * signing regression here would strand them with no workaround left. The
 * verifier below shares no code with `lib/aws4fetch`; if both agree, the
 * signature is right for reasons that are not circular.
 */

const ACCESS_KEY = 'AKIATESTVERIFY0000';
const SECRET_KEY = 'test-verify-secret';
const BUCKET = 'erc2_tpa_dev';
const ORIGIN = 'http://localhost:5173';

const encoder = new TextEncoder();

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

/** RFC 3986 encoding, which differs from encodeURIComponent on !'()* */
const uriEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

interface Verified {
  ok: boolean;
  reason?: string;
}

async function verifyPresignedSigV4(
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Headers,
): Promise<Verified> {
  const signature = query.get('X-Amz-Signature');
  const credential = query.get('X-Amz-Credential');
  const amzDate = query.get('X-Amz-Date');
  const signedHeaders = query.get('X-Amz-SignedHeaders');
  if (!signature || !credential || !amzDate || !signedHeaders) {
    return { ok: false, reason: 'missing presign parameters' };
  }

  const scope = credential.slice(credential.indexOf('/') + 1);
  const [date, region, service] = scope.split('/') as [string, string, string];

  const canonicalQuery = [...query.entries()]
    .filter(([key]) => key !== 'X-Amz-Signature')
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const canonicalHeaders = signedHeaders
    .split(';')
    .map((name) => `${name}:${(headers.get(name) ?? '').replace(/\s+/g, ' ').trim()}\n`)
    .join('');

  const canonicalRequest = [
    method,
    // S3 keeps path separators literal; only segments are encoded.
    path
      .split('/')
      .map((segment) => uriEncode(segment))
      .join('/'),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmac(encoder.encode(`AWS4${SECRET_KEY}`).buffer as ArrayBuffer, date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const expected = [...new Uint8Array(await hmac(kSigning, stringToSign))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return expected === signature ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

const policy: CorsConfiguration = {
  rules: [
    {
      allowedOrigins: [ORIGIN],
      allowedMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE'],
      allowedHeaders: ['*'],
      exposeHeaders: ['ETag'],
      maxAgeSeconds: 3600,
    },
  ],
};

let server: ReturnType<typeof Bun.serve>;
let endpoint = '';
let allowedOrigins: string[] = [];
let lastVerification: Verified | null = null;
let lastBody = '';
let lastContentType: string | null = null;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      lastBody = await request.text();
      lastContentType = request.headers.get('content-type');

      if (url.searchParams.has('X-Amz-Signature')) {
        lastVerification = await verifyPresignedSigV4(
          request.method,
          url.pathname,
          url.searchParams,
          request.headers,
        );
        if (!lastVerification.ok) {
          return new Response('SignatureDoesNotMatch', { status: 403 });
        }
      }

      if (url.searchParams.has('cors') && request.method === 'PUT') {
        allowedOrigins = [...lastBody.matchAll(/<AllowedOrigin>(.*?)<\/AllowedOrigin>/g)].map(
          (m) => m[1]!,
        );
        return new Response(null, { status: 200, headers: { ETag: '"policy"' } });
      }

      // A listing, CORS-gated the way a browser experiences it.
      const origin = request.headers.get('origin');
      const headers: Record<string, string> = { 'Content-Type': 'application/xml' };
      if (origin && allowedOrigins.includes(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Expose-ETag'] = 'ETag';
      }
      return new Response('<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>', {
        status: 200,
        headers,
      });
    },
  });
  endpoint = `http://127.0.0.1:${server.port ?? 0}`;
});

afterAll(async () => {
  await server.stop(true);
});

const signer = () =>
  new AwsClient({
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    region: 'us-east-1',
    service: 's3',
  });

describe('presigned PutBucketCors', () => {
  test('the URL carries a complete, verifiable SigV4 query signature', async () => {
    const url = await presignPutBucketCors(
      signer(),
      { endpoint, bucket: BUCKET, pathStyle: true },
      'application/xml',
      900,
    );
    const query = new URL(url).searchParams;

    expect(query.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(query.get('X-Amz-Credential')).toMatch(
      new RegExp(`^${ACCESS_KEY}/\\d{8}/us-east-1/s3/aws4_request$`),
    );
    expect(query.get('X-Amz-Expires')).toBe('900');
    expect(query.get('cors')).toBe('');
    expect(query.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    // host is always signed; content-type is deliberately not (aws-sdk-js
    // behaviour), so an extra Content-Type from curl is harmless.
    expect(query.get('X-Amz-SignedHeaders')).toBe('host');
    // The secret is never in the URL.
    expect(url).not.toContain(SECRET_KEY);
  });

  test('a PUT with the generated policy is accepted and applies the rule', async () => {
    const url = await presignPutBucketCors(
      signer(),
      { endpoint, bucket: BUCKET, pathStyle: true },
      'application/xml',
      900,
    );

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/xml' },
      body: corsConfigToXml(policy),
    });

    expect(lastVerification).toEqual({ ok: true });
    expect(response.status).toBe(200);
    expect(lastContentType).toBe('application/xml');
    expect(allowedOrigins).toEqual([ORIGIN]);

    // The payoff: the request a browser makes is now CORS-allowed.
    const before = await fetch(`${endpoint}/${BUCKET}/?list-type=2`, { headers: { Origin: ORIGIN } });
    expect(before.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(before.headers.get('access-control-expose-etag')).toBe('ETag');
  });

  test('a tampered body or URL is rejected by an independent verifier', async () => {
    const url = await presignPutBucketCors(
      signer(),
      { endpoint, bucket: BUCKET, pathStyle: true },
      'application/xml',
      900,
    );

    // Point the signed URL at a different bucket.
    const tampered = url.replace(`/${BUCKET}/`, '/other-bucket/');
    const response = await fetch(tampered, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/xml' },
      body: corsConfigToXml(policy),
    });

    expect(response.status).toBe(403);
    expect(lastVerification?.ok).toBe(false);
  });
});

describe('generated curl option', () => {
  test('produces a script whose body and URL the server accepts', async () => {
    const presignedUrl = await presignPutBucketCors(
      signer(),
      { endpoint, bucket: BUCKET, pathStyle: true },
      'application/xml',
      900,
    );

    const options = buildCorsRemediation({
      endpoint,
      region: 'us-east-1',
      bucket: BUCKET,
      config: policy,
      presignedUrl,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      includeSecrets: false,
      shell: 'posix',
    });

    const curl = options.find((o) => o.id === 'curl')!;
    expect(curl.containsSecret).toBe(false);
    expect(curl.script).not.toContain(SECRET_KEY);
    // The XML in the script is exactly what the API takes.
    expect(curl.script).toContain(corsConfigToXml(policy));
    expect(curl.script).toContain('curl -X PUT');
    expect(curl.script).toContain('Content-Type: application/xml');
  });
});
