/**
 * Galiot companion bridge — optional, local-only.
 *
 * It applies bucket CORS policy and, when enabled for a connection, forwards
 * signed S3 traffic for gateways that cannot answer browser preflight.
 *
 * It is deliberately gated:
 *   - listens on 127.0.0.1 only
 *   - accepts only explicitly allowed app origins
 *   - requires a token printed at startup (paste it into Galiot)
 *   - only forwards requests carrying a SigV4 Authorization header
 *
 * Usage:
 *   bun run bridge                       # prints a token
 *   GALIOT_BRIDGE_TOKEN=... bun run bridge
 *   GALIOT_BRIDGE_PORT=8787 bun run bridge
 */

import {
  BRIDGE_DEFAULT_PORT,
  BRIDGE_TOKEN_HEADER,
  checkForwardRequest,
  corsHeaders,
  isOriginAllowed,
  resolveAllowedOrigins,
} from '../src/bridge/policy';
import { BRIDGE_TARGET_HEADER } from '../src/bridge/transport';

const port = Number(process.env.GALIOT_BRIDGE_PORT ?? BRIDGE_DEFAULT_PORT);
const token = process.env.GALIOT_BRIDGE_TOKEN ?? crypto.randomUUID();
const allowedOrigins = resolveAllowedOrigins(
  (process.env.GALIOT_BRIDGE_ORIGINS ?? '').split(',').filter(Boolean),
);

interface ForwardBody {
  target: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function json(payload: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, allowedOrigins) },
  });
}

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(request) {
    const origin = request.headers.get('origin');

    if (request.method === 'OPTIONS') {
      if (!isOriginAllowed(origin, allowedOrigins)) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, allowedOrigins, request.headers.get('access-control-request-headers')),
      });
    }

    const url = new URL(request.url);

    // Health check: lets the app discover the bridge and the token hint.
    if (url.pathname === '/health') {
      if (!isOriginAllowed(origin, allowedOrigins)) {
        return json({ ok: false, error: 'origin not allowed' }, 403, origin);
      }
      if (request.headers.get(BRIDGE_TOKEN_HEADER) !== token) {
        return json({ ok: false, error: 'incorrect bridge token' }, 403, origin);
      }
      return json({ ok: true, version: 2, tokenRequired: true }, 200, origin);
    }

    if (url.pathname === '/proxy') {
      const headers = Object.fromEntries(request.headers.entries());
      const check = checkForwardRequest(
        { target: request.headers.get(BRIDGE_TARGET_HEADER) ?? '', method: request.method, headers },
        {
          origin,
          token: request.headers.get(BRIDGE_TOKEN_HEADER),
          expectedToken: token,
          allowedOrigins,
        },
      );
      if (!check.ok) return json({ ok: false, error: check.detail }, 403, origin);

      const upstreamHeaders = new Headers(request.headers);
      for (const name of [
        'host', 'connection', 'content-length', 'origin', 'referer', 'accept-encoding',
        BRIDGE_TARGET_HEADER, BRIDGE_TOKEN_HEADER,
      ]) upstreamHeaders.delete(name);
      for (const name of [...upstreamHeaders.keys()]) {
        if (name.startsWith('sec-')) upstreamHeaders.delete(name);
      }

      try {
        const upstream = await fetch(check.url, {
          method: request.method,
          headers: upstreamHeaders,
          body: request.body,
          redirect: 'manual',
        });
        const responseHeaders = new Headers(corsHeaders(origin, allowedOrigins));
        for (const name of [
          'content-type', 'content-length', 'etag', 'content-range', 'accept-ranges', 'last-modified',
          'x-amz-request-id', 'x-amz-id-2',
        ]) {
          const value = upstream.headers.get(name);
          if (value) responseHeaders.set(name, value);
        }
        return new Response(
          request.method === 'HEAD' || upstream.status === 204 || upstream.status === 304
            ? null
            : upstream.body,
          { status: upstream.status, headers: responseHeaders },
        );
      } catch (err) {
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502, origin);
      }
    }

    if (url.pathname !== '/forward') {
      return json({ ok: false, error: 'not found' }, 404, origin);
    }

    let body: ForwardBody;
    try {
      body = (await request.json()) as ForwardBody;
    } catch {
      return json({ ok: false, error: 'invalid JSON body' }, 400, origin);
    }

    const check = checkForwardRequest(
      { target: body.target, method: body.method, headers: body.headers ?? {} },
      {
        origin,
        token: request.headers.get(BRIDGE_TOKEN_HEADER),
        expectedToken: token,
        allowedOrigins,
      },
    );

    if (!check.ok) {
      return json({ ok: false, error: check.detail, reason: check.reason }, 403, origin);
    }

    // The signed headers include `host`; fetch forbids setting it, and it is
    // derived from the URL anyway, so drop it before forwarding.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(body.headers ?? {})) {
      if (name.toLowerCase() === 'host') continue;
      headers[name] = value;
    }

    try {
      const upstream = await fetch(check.url.toString(), {
        method: body.method,
        headers,
        ...(body.body !== undefined ? { body: body.body } : {}),
        redirect: 'manual',
      });

      const text = await upstream.text();
      const responseHeaders: Record<string, string> = {};
      // Echo back only what the app needs to reason about the result.
      for (const name of ['content-type', 'etag', 'x-amz-request-id', 'x-amz-id-2']) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders[name] = value;
      }

      return json(
        { ok: upstream.ok, status: upstream.status, headers: responseHeaders, body: text },
        200,
        origin,
      );
    } catch (err) {
      return json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        502,
        origin,
      );
    }
  },
});

console.log(`
Galiot bridge listening on http://127.0.0.1:${server.port}

  Token: ${token}

Paste this token into Galiot (Connections → Local companion) to route
normal S3 traffic, or into the CORS helper to apply a policy. The bridge
forwards SigV4-signed S3 requests only from the origins listed below.

Allowed origins:
${allowedOrigins.map((origin) => `  - ${origin}`).join('\n')}

Serving Galiot from another origin? Add it explicitly:
  Set GALIOT_BRIDGE_ORIGINS to the page's exact origin before starting.

Stop it with Ctrl+C.
`);
