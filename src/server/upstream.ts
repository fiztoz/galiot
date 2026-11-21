import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { unbracketHost, type ProxyAddress } from './target.ts';

/** An endpoint that accepts the connection and then goes silent is dropped after this. */
export const UPSTREAM_IDLE_MS = 120_000;

/**
 * Connect only to validated addresses, retaining the signed Host and TLS name.
 * Raw HTTP streams preserve Content-Encoding bytes in both Bun and Node/Vite.
 * There is no second DNS lookup, environment proxy, decompression, or redirect.
 */
export function forwardRequest(
  url: URL,
  addresses: ProxyAddress[],
  request: Request,
  headers: Headers,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const originalHost = unbracketHost(url.hostname);
    const connect = secure ? httpsRequest : httpRequest;
    const options: RequestOptions & { autoSelectFamily: boolean } = {
      hostname: originalHost,
      port: url.port || (secure ? 443 : 80),
      path: url.pathname + url.search,
      method: request.method,
      headers: { ...Object.fromEntries(headers), host: url.host },
      ...(secure && !isIP(originalHost) ? { servername: originalHost } : {}),
      signal: request.signal,
      // No DNS occurs here. Preserve dual-stack fallback within the checked set.
      autoSelectFamily: true,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      // Each request connects using the addresses validated for this request.
      agent: false,
      // Socket idle limit, not a total: a long download keeps resetting it.
      timeout: UPSTREAM_IDLE_MS,
    };
    const upstream = connect(options, (response) => {
      try {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item);
        }
        const status = response.statusCode ?? 502;
        const empty = request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
        if (empty) response.resume();
        resolve(new Response(empty ? null : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>, {
          status,
          headers: responseHeaders,
        }));
      } catch (error) {
        // This callback runs after the Promise executor has returned.
        response.destroy();
        reject(error);
      }
    });
    upstream.on('timeout', () => upstream.destroy(new Error(`The S3 endpoint did not respond within ${UPSTREAM_IDLE_MS / 1000} s.`)));
    upstream.on('error', reject);
    if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
      void pipeline(Readable.fromWeb(request.body as unknown as NodeReadableStream), upstream).catch(reject);
    } else {
      upstream.end();
    }
  });
}
