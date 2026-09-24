/**
 * Policy for the optional local bridge (`bun run bridge`).
 *
 * The bridge exists for one reason: a browser cannot change a bucket's CORS
 * policy, because the very request that would do it is blocked by the missing
 * policy. A process on the same machine is not subject to CORS, so it can.
 *
 * That makes the bridge a privileged listener on a local port, which means it
 * must not become an open proxy. The rules below are deliberately strict and
 * kept free of I/O so they can be unit-tested.
 */

/** Origins allowed to talk to the bridge (the app in local development). */
export const ALLOWED_BRIDGE_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

export const BRIDGE_DEFAULT_PORT = 8787;
export const BRIDGE_TOKEN_HEADER = 'x-galiot-bridge-token';

export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_BRIDGE_ORIGINS.includes(origin);
}

export function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': isOriginAllowed(origin) ? (origin ?? '') : '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': `content-type, ${BRIDGE_TOKEN_HEADER}`,
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

export type RejectionReason =
  | 'bad-origin'
  | 'bad-token'
  | 'bad-target'
  | 'not-signed';

export interface ForwardRequest {
  /** Absolute http(s) URL to call, e.g. the S3 bucket CORS endpoint. */
  target: string;
  method: string;
  headers: Record<string, string>;
}

export type ForwardCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: RejectionReason; detail: string };

/**
 * Validates a forward request. Every rejection path exists to stop a hostile
 * page (or a stray tab) from using the bridge as an open proxy.
 */
export function checkForwardRequest(
  request: ForwardRequest,
  options: { origin: string | null; token: string | null; expectedToken: string | null },
): ForwardCheck {
  if (!isOriginAllowed(options.origin)) {
    return { ok: false, reason: 'bad-origin', detail: 'Origin is not an allowed local app origin.' };
  }

  if (!options.expectedToken) {
    return { ok: false, reason: 'bad-token', detail: 'The bridge is running without a token.' };
  }

  if (options.token !== options.expectedToken) {
    return { ok: false, reason: 'bad-token', detail: 'Missing or incorrect bridge token.' };
  }

  let url: URL;
  try {
    url = new URL(request.target);
  } catch {
    return { ok: false, reason: 'bad-target', detail: 'Target is not a valid absolute URL.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'bad-target', detail: 'Only http and https targets are allowed.' };
  }

  // Require a SigV4 signature: without it the bridge would be a general
  // purpose request forwarder for anyone who can reach the port.
  const hasSignature = Object.keys(request.headers).some(
    (name) => name.toLowerCase() === 'authorization' && String(request.headers[name] ?? '').startsWith('AWS4-HMAC-SHA256'),
  );
  if (!hasSignature) {
    return {
      ok: false,
      reason: 'not-signed',
      detail: 'The bridge only forwards SigV4-signed S3 requests.',
    };
  }

  return { ok: true, url };
}
