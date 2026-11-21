import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { createServer, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { PreviewServer, ViteDevServer } from 'vite';
import { AwsClient } from '../lib/aws4fetch';
import { BlockedProxyTargetError, resolveProxyAddresses, type ProxyLookup } from './target';
import { forwardRequest } from './upstream';
import { s3ProxyPlugin } from './vite';

const payload = 'example payload '.repeat(8192);
const compressed = gzipSync(payload);
const calls: { url: string; host: string | null; length: string | null; encoding: string | null; body: string; authorization: string | null }[] = [];
let upstream: ReturnType<typeof Bun.serve>;

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
});

afterAll(async () => {
  await upstream?.stop(true);
});

const toLoopback: ProxyLookup = async () => [{ address: '127.0.0.1', family: 4 }];

/** Signs like the server does, then connects through the live transport. */
async function send(
  target: string,
  { method = 'GET', body, lookup = toLoopback }: { method?: string; body?: string; lookup?: ProxyLookup } = {},
): Promise<Response> {
  const signer = new AwsClient({ accessKeyId: 'review-key', secretAccessKey: 'review-secret', service: 's3', region: 'us-east-1' });
  const signed = await signer.sign(target, { method, ...(body !== undefined ? { body } : {}), headers: { 'x-tenant-id': 'example' } });
  const headers = new Headers(signed.headers);
  if (body !== undefined) headers.set('content-length', String(Buffer.byteLength(body)));
  const url = new URL(target);
  const addresses = await resolveProxyAddresses(url, lookup);
  const request = new Request(target, { method, headers, ...(body !== undefined ? { body } : {}) });
  return forwardRequest(url, addresses, request, headers);
}

describe('upstream transport', () => {
  test('falls back within the validated DNS set when the first address refuses connections', async () => {
    let resolutions = 0;
    const response = await send(`http://s3.example.com:${upstream.port}/example-bucket/fallback`, {
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
    const response = await send(target, {
      lookup: async (hostname) => {
        expect(hostname).toBe('s3.example.com');
        return [{ address: '127.0.0.1', family: 4 }];
      },
    });
    expect(response.status).toBe(200);
    await response.text();
    const call = calls.at(-1)!;
    expect(call.url).toBe(target);
    expect(call.host).toBe(`s3.example.com:${upstream.port}`);
    expect(call.authorization).toContain('AWS4-HMAC-SHA256');
  });

  test('a DNS answer in a blocked range is refused before any connection', async () => {
    const before = calls.length;
    await expect(send(`http://s3.example.com:${upstream.port}/example-bucket/x`, {
      lookup: async () => [{ address: '127.0.0.1', family: 4 }, { address: '169.254.169.254', family: 4 }],
    })).rejects.toBeInstanceOf(BlockedProxyTargetError);
    expect(calls.length).toBe(before);
  });

  test('single PUT and multipart-sized bodies keep their exact length and bytes', async () => {
    for (const body of ['', 'hello', payload]) {
      const response = await send(`http://127.0.0.1:${upstream.port}/example-bucket/key?uploadId=example&partNumber=1`, { method: 'PUT', body });
      expect(response.status).toBe(200);
      await response.text();
      const call = calls.at(-1)!;
      expect(call.length).toBe(String(Buffer.byteLength(body)));
      expect(call.encoding).toBeNull();
      expect(call.body).toBe(body);
    }
  });

  test('compressed GET and HEAD keep the wire bytes, encoding and length', async () => {
    const target = `http://127.0.0.1:${upstream.port}/example-bucket/compressed`;
    const response = await send(target);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('content-length')).toBe(String(compressed.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(compressed);
    const head = await send(target, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe(String(compressed.length));
    expect(await head.text()).toBe('');
  });

  test('an upstream redirect is returned, never followed', async () => {
    const before = calls.length;
    const response = await send(`http://127.0.0.1:${upstream.port}/example-bucket/redirect`);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://169.254.169.254/latest');
    expect(calls.length).toBe(before);
  });

  test('an empty 205 has no body, and an invalid upstream status is an error', async () => {
    const reset = await send(`http://127.0.0.1:${upstream.port}/reset`);
    expect(reset.status).toBe(205);
    expect(await reset.text()).toBe('');

    const invalid = createTcpServer((socket) => {
      socket.once('data', () => socket.end('HTTP/1.1 600 Invalid\r\nContent-Length: 3\r\nConnection: close\r\n\r\nbad'));
    });
    await new Promise<void>((resolve) => invalid.listen(0, '127.0.0.1', resolve));
    try {
      const address = invalid.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      await expect(send(`http://127.0.0.1:${address.port}/`)).rejects.toThrow();
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
