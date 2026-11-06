import { describe, expect, test } from 'bun:test';
import {
  assertBindAllowed,
  checkProxyTarget,
  handleS3Proxy,
  isBlockedProxyHost,
  S3_PROXY_PATH,
  S3_PROXY_TARGET_HEADER,
  S3_PROXY_TOKEN_HEADER,
} from './proxy';

const SAMPLE_GATE = 'alpha-gate';
const SIGNED = 'AWS4-HMAC-SHA256';

function signed(target: string, method = 'GET', gate?: string): Request {
  const headers = new Headers({
    authorization: SIGNED,
    [S3_PROXY_TARGET_HEADER]: target,
  });
  if (gate) headers.set(S3_PROXY_TOKEN_HEADER, gate);
  return new Request(`http://127.0.0.1${S3_PROXY_PATH}`, { method, headers });
}

describe('proxy target policy', () => {
  test('allows an https endpoint and a private LAN address', () => {
    expect(checkProxyTarget('https://s3.example.com/bucket').ok).toBe(true);
    expect(checkProxyTarget('http://10.0.0.5:9000/bucket').ok).toBe(true);
    expect(checkProxyTarget('http://127.0.0.1:9000/bucket').ok).toBe(true);
  });

  test('rejects a non-http scheme', () => {
    expect(checkProxyTarget('file:///tmp/notes').ok).toBe(false);
  });

  test('blocks the link-local range used by cloud metadata services', () => {
    expect(isBlockedProxyHost('169.254.169.254')).toBe(true);
    expect(isBlockedProxyHost('0.0.0.0')).toBe(true);
    expect(checkProxyTarget('http://169.254.1.1/latest').ok).toBe(false);
  });

  test('a public bind without a gate is refused unless explicitly opened', () => {
    expect(() => assertBindAllowed('0.0.0.0', null, false)).toThrow(/PROXY/);
    expect(() => assertBindAllowed('127.0.0.1', null, false)).not.toThrow();
    expect(() => assertBindAllowed('0.0.0.0', 'alpha-gate', false)).not.toThrow();
    expect(() => assertBindAllowed('0.0.0.0', null, true)).not.toThrow();
  });
});

describe('handleS3Proxy', () => {
  test('health does not call upstream', async () => {
    let called = false;
    const response = await handleS3Proxy(new Request(`http://127.0.0.1${S3_PROXY_PATH}`), {
      expectedToken: SAMPLE_GATE,
      forward: (() => {
        called = true;
        return Promise.resolve(new Response('nope'));
      }),
    });
    expect(called).toBe(false);
    const body = (await response.json()) as { ok: boolean; tokenRequired: boolean; tokenAccepted: boolean };
    expect(body).toEqual({ ok: true, tokenRequired: true, tokenAccepted: false });
  });

  test('forwards a signed request and does not follow redirects or relay CORS', async () => {
    const calls: { url: string; address: string; authorization: string | null }[] = [];
    const response = await handleS3Proxy(signed('https://s3.example.com/example-bucket/?list-type=2', 'GET', SAMPLE_GATE), {
      expectedToken: SAMPLE_GATE,
      lookup: async () => [{ address: '10.0.0.5', family: 4 }],
      forward: ((url, addresses, _request, headers) => {
        calls.push({
          url: url.toString(),
          address: addresses[0]!.address,
          authorization: headers.get('authorization'),
        });
        return Promise.resolve(
          new Response('<ListBucketResult></ListBucketResult>', {
            status: 200,
            headers: {
              'content-type': 'application/xml',
              etag: '"abc"',
              'access-control-allow-origin': '*',
              'cache-control': 'public, max-age=3600',
              'cdn-cache-control': 'public, max-age=3600',
            },
          }),
        );
      }),
    });

    expect(calls).toEqual([
      {
        url: 'https://s3.example.com/example-bucket/?list-type=2',
        address: '10.0.0.5',
        authorization: SIGNED,
      },
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"abc"');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('cdn-cache-control')).toBeNull();
  });

  test('rejects blocked DNS results before opening an upstream connection', async () => {
    let forwarded = false;
    for (const addresses of [
      [{ address: '169.254.169.254', family: 4 }],
      [{ address: '::ffff:a9fe:a9fe', family: 6 }],
      [{ address: '10.0.0.5', family: 4 }, { address: 'fe90::1', family: 6 }],
      [{ address: 'not-an-address', family: 4 }],
    ]) {
      const response = await handleS3Proxy(signed('https://s3.example.com/example-bucket'), {
        expectedToken: null,
        lookup: async () => addresses,
        forward: async () => { forwarded = true; return new Response('unexpected'); },
      });
      expect(response.status).toBe(400);
      expect(forwarded).toBe(false);
    }
  });

  test('rejects unknown and invalid upload lengths before forwarding', async () => {
    for (const length of [null, '-1', '5, 5', '9007199254740992']) {
      const request = signed('http://127.0.0.1:9000/example-bucket/key', 'PUT');
      if (length !== null) request.headers.set('content-length', length);
      const response = await handleS3Proxy(new Request(request, { body: 'hello' }), {
        expectedToken: null,
        forward: async () => { throw new Error('must not forward'); },
      });
      expect(response.status).toBe(length === null ? 411 : 400);
    }
  });

  test('rejects unsigned, a wrong gate, and a blocked target', async () => {
    const unsigned = new Request(`http://127.0.0.1${S3_PROXY_PATH}`, {
      method: 'PUT',
      headers: { [S3_PROXY_TARGET_HEADER]: 'https://s3.example.com/bucket' },
    });
    expect((await handleS3Proxy(unsigned, { expectedToken: null })).status).toBe(403);

    const wrongGate = signed('https://s3.example.com/bucket', 'GET', 'beta-gate');
    expect((await handleS3Proxy(wrongGate, { expectedToken: SAMPLE_GATE })).status).toBe(403);

    const metadata = signed('http://169.254.169.254/latest', 'GET');
    expect((await handleS3Proxy(metadata, { expectedToken: null })).status).toBe(400);
  });
});
