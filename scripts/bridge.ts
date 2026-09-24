/**
 * Galiot companion bridge — optional, local-only.
 *
 * Why it exists: a browser cannot set a bucket's CORS policy, because the
 * request that would do it is itself blocked by the missing policy. This
 * process makes the *same* SigV4-signed request from the machine, where CORS
 * does not apply.
 *
 * It is deliberately not a general proxy:
 *   - listens on 127.0.0.1 only
 *   - only accepts the local app origins
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
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigins) });
    }

    const url = new URL(request.url);

    // Health check: lets the app discover the bridge and the token hint.
    if (url.pathname === '/health') {
      if (!isOriginAllowed(origin, allowedOrigins)) {
        return json({ ok: false, error: 'origin not allowed' }, 403, origin);
      }
      return json({ ok: true, version: 1, tokenRequired: true }, 200, origin);
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

Paste this token into Galiot (Vault → Connections → CORS helper) when it
asks to apply a CORS policy. The bridge only forwards SigV4-signed S3
requests from local app origins, and only to the address you give it.

Allowed origins:
${allowedOrigins.map((origin) => `  - ${origin}`).join('\n')}

Serving Galiot from another origin? Add it explicitly:
  GALIOT_BRIDGE_ORIGINS=https://your-host bun run bridge

Stop it with Ctrl+C.
`);
