import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { createServer, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { PreviewServer, ViteDevServer } from 'vite';
import { AwsClient } from '../lib/aws4fetch';
import { handleS3Proxy, S3_PROXY_PATH, S3_PROXY_TARGET_HEADER } from './proxy';
import { s3ProxyPlugin } from './vite';

const payload = 'example payload '.repeat(8192);
const compressed = gzipSync(payload);
const calls: { url: string; host: string | null; length: string | null; encoding: string | null; body: string; authorization: string | null }[] = [];
let upstream: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.serve>;
let lookups = 0;

beforeAll(() => {
  upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/compressed')) return new Response(request.method === 'HEAD' ? null : compressed, {
      headers: { 'content-encoding': 'gzip', 'content-length': String(compressed.length), 'cache-control': 'public, max-age=3600' },
    });
    if (path.endsWith('/redirect')) return new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/latest' } });
    if (path.endsWith('/reset')) return new Response(null, { status: 205 });
    calls.push({
      url: request.url, host: request.headers.get('host'), length: request.headers.get('content-length'),
      encoding: request.headers.get('transfer-encoding'), body: await request.text(),
      authorization: request.headers.get('authorization'),
    });
    if (request.method === 'PUT' && !request.headers.has('content-length')) return new Response('MissingContentLength', { status: 411 });
    return new Response(path, { headers: { etag: '"abc"', 'cache-control': 'public, max-age=3600' } });
  } });
  proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => handleS3Proxy(request, {
    expectedToken: null,
    lookup: async (hostname) => {
      expect(hostname).toBe('s3.example.com');
      lookups += 1;
      return [{ address: '127.0.0.1', family: 4 }];
    },
  }) });
});

afterAll(async () => {
  await proxy?.stop(true);
  await upstream?.stop(true);
});

async function signedHeaders(target: string, method = 'GET', body?: string): Promise<Headers> {
  const signer = new AwsClient({ accessKeyId: 'review-key', secretAccessKey: 'review-secret', service: 's3', region: 'us-east-1' });
  const signed = await signer.sign(target, { method, ...(body !== undefined ? { body } : {}), headers: { 'x-tenant-id': 'example' } });
  const headers = new Headers(signed.headers);
  headers.delete('host');
  headers.set(S3_PROXY_TARGET_HEADER, target);
  return headers;
}

describe('real proxy transport', () => {
  test('falls back within the validated DNS set when the first address refuses connections', async () => {
    const target = `http://s3.example.com:${upstream.port}/example-bucket/fallback`;
    let resolutions = 0;
    const response = await handleS3Proxy(new Request('http://localhost/api/s3-proxy', {
      headers: await signedHeaders(target),
    }), {
      expectedToken: null,
      lookup: async () => {
        resolutions += 1;
        return [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }];
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('/example-bucket/fallback');
    expect(resolutions).toBe(1);
  });

  test('pins DNS while retaining the signed Host, query, path, and authorization', async () => {
    const target = `http://s3.example.com:${upstream.port}/example-bucket/Q3%20report.txt?partNumber=1&uploadId=a%2Bb`;
    const headers = await signedHeaders(target);
    const before = lookups;
    const response = await fetch(`http://127.0.0.1:${proxy.port}${S3_PROXY_PATH}`, { headers });
    expect(response.status).toBe(200);
    await response.text();
    const call = calls.at(-1)!;
    expect(call.url).toBe(target);
    expect(call.host).toBe(`s3.example.com:${upstream.port}`);
    expect(call.authorization).toBe(headers.get('authorization'));
    expect(lookups - before).toBe(1);
  });

  test('single PUT and multipart-sized bodies keep their exact length and bytes', async () => {
    for (const body of ['', 'hello', payload]) {
      const target = `http://127.0.0.1:${upstream.port}/example-bucket/key?uploadId=example&partNumber=1`;
      const response = await fetch(`http://127.0.0.1:${proxy.port}${S3_PROXY_PATH}`, {
        method: 'PUT', headers: await signedHeaders(target, 'PUT', body), body: new Blob([body]),
      });
      expect(response.status).toBe(200);
      await response.text();
      const call = calls.at(-1)!;
      expect(call.length).toBe(String(Buffer.byteLength(body)));
      expect(call.encoding).toBeNull();
      expect(call.body).toBe(body);
    }
  });

  test('compressed GET and HEAD preserve wire bytes, encoding, length, and no-store', async () => {
    const headers = await signedHeaders(`http://127.0.0.1:${upstream.port}/example-bucket/compressed`);
    const url = `http://127.0.0.1:${proxy.port}${S3_PROXY_PATH}`;
    const response = await fetch(url, { headers, decompress: false });
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('content-length')).toBe(String(compressed.length));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(compressed);
    expect(await (await fetch(url, { headers })).text()).toBe(payload);
    const head = await fetch(url, { headers, method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe(String(compressed.length));
    expect(await head.text()).toBe('');
  });

  test('upstream redirects never make a second request', async () => {
    const response = await fetch(`http://127.0.0.1:${proxy.port}${S3_PROXY_PATH}`, {
      headers: await signedHeaders(`http://127.0.0.1:${upstream.port}/example-bucket/redirect`), redirect: 'manual',
    });
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://169.254.169.254/latest');
  });

  test('handles empty 205 responses and returns 502 for invalid upstream statuses', async () => {
    const url = `http://127.0.0.1:${proxy.port}${S3_PROXY_PATH}`;
    const reset = await fetch(url, { headers: await signedHeaders(`http://127.0.0.1:${upstream.port}/reset`) });
    expect(reset.status).toBe(205);
    expect(await reset.text()).toBe('');

    const invalid = createTcpServer((socket) => {
      socket.once('data', () => socket.end('HTTP/1.1 600 Invalid\r\nContent-Length: 3\r\nConnection: close\r\n\r\nbad'));
    });
    await new Promise<void>((resolve) => invalid.listen(0, '127.0.0.1', resolve));
    try {
      const address = invalid.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const response = await fetch(url, { headers: await signedHeaders(`http://127.0.0.1:${address.port}/`) });
      expect(response.status).toBe(502);
      expect((await response.json() as { ok: boolean }).ok).toBe(false);
    } finally {
      await new Promise<void>((resolve) => invalid.close(() => resolve()));
    }
  });
});

describe('Vite streaming middleware', () => {
  for (const preview of [false, true]) {
    test(`${preview ? 'preview' : 'dev'} forwards uploads, empty POSTs and gzip responses`, async () => {
      let server: HttpServer | undefined;
      const hook = preview ? s3ProxyPlugin({}).configurePreviewServer : s3ProxyPlugin({}).configureServer;
      if (typeof hook !== 'function') throw new Error('Missing middleware');
      hook.call({} as never, {
        config: { server: { host: '127.0.0.1' }, preview: { host: '127.0.0.1' } },
        middlewares: { use(handler: Parameters<typeof createServer>[0]) { server = createServer(handler); } },
      } as unknown as ViteDevServer & PreviewServer);
      if (!server) throw new Error('Middleware was not registered');
      const listener = server;
      await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      try {
        const origin = `http://127.0.0.1:${address.port}`;
        const opened = await fetch(`${origin}/api/s3/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            endpoint: `http://127.0.0.1:${upstream.port}`,
            region: 'us-east-1',
            bucket: 'example-bucket',
            pathStyle: true,
            accessKeyId: 'review-key',
            secretAccessKey: 'review-secret',
          }),
        });
        expect(opened.status).toBe(200);
        const sessionId = ((await opened.json()) as { result: { sessionId: string } }).result.sessionId;
        const put = await fetch(`${origin}/api/s3/sessions/${sessionId}/object?key=key`, {
          method: 'PUT',
          body: payload,
          headers: { 'content-type': 'text/plain' },
        });
        expect(put.status).toBe(200);
        await put.text();
        expect(calls.at(-1)?.body).toBe(payload);
        expect(calls.at(-1)?.length).toBe(String(Buffer.byteLength(payload)));
        expect(calls.at(-1)?.authorization).toContain('AWS4-HMAC-SHA256');
        const gzip = await fetch(`${origin}/api/s3/sessions/${sessionId}/object?key=compressed`);
        expect(await gzip.text()).toBe(payload);
        expect(gzip.headers.get('cache-control')).toBe('no-store');
      } finally {
        listener.closeAllConnections();
        await new Promise<void>((resolve) => listener.close(() => resolve()));
      }
    });
  }
});
