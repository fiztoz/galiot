import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { handleAppRequest } from './api';
import { isAppApiPath } from './protocol';
import { accessGate, assertBindAllowed } from './proxy';

/** Same proxy and bind policy for Vite dev and preview, under Bun or Node. */
export function s3ProxyPlugin(env: NodeJS.ProcessEnv = process.env): Plugin {
  const attach = (
    middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void) => void },
    host: string | boolean | undefined,
  ) => {
    // Vite resolves undefined/false to localhost and true/empty to all interfaces.
    const hostname = host === undefined || host === false ? 'localhost' : host === true || host === '' ? '0.0.0.0' : host;
    const gate = accessGate(env);
    assertBindAllowed(hostname, gate.token, gate.open);
    middlewares.use(async (req, res, next) => {
      const pathname = req.url?.split('?')[0];
      if (!pathname || !isAppApiPath(pathname)) return next();
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once('close', abort);
      try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const method = req.method ?? 'GET';
        const hasBody = method !== 'GET' && method !== 'HEAD' &&
          (headers.has('content-length') || headers.has('transfer-encoding'));
        const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
          method,
          headers,
          body: hasBody ? Readable.toWeb(req) as unknown as ReadableStream<Uint8Array> : undefined,
          signal: controller.signal,
          duplex: 'half',
        } as RequestInit);
        const response = await handleAppRequest(request, { expectedToken: gate.token });
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        if (response.body) await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), res);
        else res.end();
      } catch (error) {
        next(error);
      } finally {
        res.off('close', abort);
      }
    });
  };
  return {
    name: 'galiot-s3-proxy',
    configureServer(server) {
      attach(server.middlewares, server.config.server.host);
    },
    configurePreviewServer(server) {
      attach(server.middlewares, server.config.preview.host);
    },
  };
}
