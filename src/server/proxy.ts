/**
 * Retired signed-request forwarder. Not mounted.
 *
 * The app server signs and calls S3 itself (`src/server/api.ts`). These helpers
 * remain for the transport tests and the target checks the API still uses.
 */

import { S3_PROXY_PATH, S3_PROXY_TARGET_HEADER, S3_PROXY_TOKEN_HEADER, S3_PROXY_DEFAULT_PORT } from './protocol';
import { BlockedProxyTargetError, isBlockedProxyHost, resolveProxyAddresses, type ProxyLookup } from './target';
import { forwardRequest } from './upstream';

export { S3_PROXY_PATH, S3_PROXY_TARGET_HEADER, S3_PROXY_TOKEN_HEADER, S3_PROXY_DEFAULT_PORT } from './protocol';
export { isBlockedProxyHost } from './target';

const FORWARD_METHODS = new Set(['GET', 'HEAD', 'PUT', 'POST', 'DELETE']);

const STRIP_HEADERS = [
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-connection',
  'te',
  'trailer',
  'origin',
  'referer',
  'cookie',
  'accept-encoding',
  S3_PROXY_TARGET_HEADER,
  S3_PROXY_TOKEN_HEADER,
];

export interface ProxyOptions {
  /**
   * When set, every forwarded request must carry this token. Null is only safe
   * on a loopback listener: a public bind without a token is an open proxy.
   */
  expectedToken: string | null;
  lookup?: ProxyLookup;
  forward?: typeof forwardRequest;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Refuses a non-loopback listen unless the operator set a token or explicitly
 * accepted an open signed-request proxy.
 */
export const PROXY_GATE_ENV = 'GALIOT_PROXY_TOKEN';
export const PROXY_OPEN_ENV = 'GALIOT_PROXY_OPEN';
export const PROXY_HOST_ENV = 'GALIOT_HOST';
export const PROXY_PORT_ENV = 'GALIOT_PORT';

export function assertBindAllowed(hostname: string, token: string | null, open: boolean): void {
  if (isLoopbackHost(hostname) || token || open) return;
  throw new Error(
    'Refusing to listen on a non-loopback address without GALIOT_PROXY_TOKEN. Set a token, or set GALIOT_PROXY_OPEN=1 only if you accept an open signed-request proxy.',
  );
}

export function checkProxyTarget(target: string): { ok: true; url: URL } | { ok: false; detail: string } {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, detail: 'Target is not a valid absolute URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, detail: 'Only http and https targets are allowed.' };
  }
  if (url.username || url.password) {
    return { ok: false, detail: 'Targets must not embed credentials.' };
  }
  if (isBlockedProxyHost(url.hostname)) {
    return { ok: false, detail: 'This target address is blocked.' };
  }
  return { ok: true, url };
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function hasSignature(headers: Headers): boolean {
  return (headers.get('authorization') ?? '').startsWith('AWS4-HMAC-SHA256');
}

/**
 * Health when the target header is absent. Otherwise forwards one signed S3
 * request. Same-origin callers need no CORS headers; a foreign origin is not
 * granted any.
 */
export async function handleS3Proxy(request: Request, options: ProxyOptions): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== S3_PROXY_PATH) return json({ ok: false, error: 'not found' }, 404);

  const target = request.headers.get(S3_PROXY_TARGET_HEADER);
  if ((request.method === 'GET' || request.method === 'HEAD') && !target) {
    const presented = request.headers.get(S3_PROXY_TOKEN_HEADER);
    const body = JSON.stringify({
      ok: true,
      tokenRequired: options.expectedToken !== null,
      tokenAccepted: options.expectedToken === null || presented === options.expectedToken,
    });
    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  if (!FORWARD_METHODS.has(request.method)) {
    return json({ ok: false, error: 'Only S3 request methods are allowed.', reason: 'bad-method' }, 405);
  }

  if (options.expectedToken && request.headers.get(S3_PROXY_TOKEN_HEADER) !== options.expectedToken) {
    return json({ ok: false, error: 'Missing or incorrect proxy token.', reason: 'bad-token' }, 403);
  }

  const checked = checkProxyTarget(target ?? '');
  if (!checked.ok) return json({ ok: false, error: checked.detail, reason: 'bad-target' }, 400);

  if (!hasSignature(request.headers)) {
    return json(
      { ok: false, error: 'The proxy only forwards SigV4-signed S3 requests.', reason: 'not-signed' },
      403,
    );
  }

  const upstreamHeaders = new Headers(request.headers);
  for (const name of STRIP_HEADERS) upstreamHeaders.delete(name);
  for (const name of [...upstreamHeaders.keys()]) {
    if (name.startsWith('sec-') || name.startsWith('x-galiot-')) upstreamHeaders.delete(name);
  }

  const length = request.headers.get('content-length');
  if (length !== null) {
    if (!/^(0|[1-9]\d*)$/.test(length) || !Number.isSafeInteger(Number(length))) {
      return json({ ok: false, error: 'Invalid Content-Length.', reason: 'bad-length' }, 400);
    }
    upstreamHeaders.set('content-length', length);
  } else if (request.body) {
    return json({ ok: false, error: 'S3 uploads require Content-Length.', reason: 'length-required' }, 411);
  }

  try {
    const addresses = await resolveProxyAddresses(checked.url, options.lookup);
    const upstream = await (options.forward ?? forwardRequest)(checked.url, addresses, request, upstreamHeaders);
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (lower === 'connection' || lower === 'transfer-encoding' || lower === 'keep-alive') return;
      if (lower.startsWith('access-control-')) return;
      responseHeaders.set(name, value);
    });
    responseHeaders.set('cache-control', 'no-store');
    responseHeaders.delete('cdn-cache-control');
    responseHeaders.delete('surrogate-control');
    const empty = request.method === 'HEAD' || upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
    return new Response(empty ? null : upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (err) {
    if (err instanceof BlockedProxyTargetError) {
      return json({ ok: false, error: err.message, reason: 'bad-target' }, 400);
    }
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
  }
}

/** Reads listen settings from the environment and refuses an unguarded public bind. */
export function proxyListenConfig(env: NodeJS.ProcessEnv = process.env): {
  hostname: string;
  port: number;
  gate: string | null;
  open: boolean;
} {
  const hostname = env[PROXY_HOST_ENV] || '127.0.0.1';
  const port = Number(env[PROXY_PORT_ENV] || S3_PROXY_DEFAULT_PORT);
  const gate = accessGate(env);
  assertBindAllowed(hostname, gate.token, gate.open);
  return { hostname, port, gate: gate.token, open: gate.open };
}

/** Gate for a non-loopback bind. The previous proxy env names still work. */
export function accessGate(env: NodeJS.ProcessEnv = process.env): { token: string | null; open: boolean } {
  const named = env.GALIOT_GATE?.trim() || env[PROXY_GATE_ENV]?.trim() || null;
  const open = env.GALIOT_GATE_OPEN === '1' || env[PROXY_OPEN_ENV] === '1';
  return { token: named, open };
}
