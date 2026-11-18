/**
 * Single source of truth for the app's security headers.
 *
 * The self-hosted server applies these to every static response; the same CSP
 * is duplicated in index.html as a meta tag for defence in depth (and for dev,
 * where Vite serves the shell). releaseConfig.test.ts asserts the two match.
 * There is no static-host `_headers` file and no platform config: Galiot is
 * self-hosted only.
 */

export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; media-src 'self' blob: https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'self' blob: https:; worker-src 'self' blob:; manifest-src 'self'";

const GLOBAL_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=()',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
};

/** Hashed build assets are immutable; everything else must revalidate. */
export function headersForPath(pathname: string): Record<string, string> {
  const headers = { ...GLOBAL_HEADERS };
  if (pathname.startsWith('/assets/')) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['Cache-Control'] = 'no-cache';
  }
  return headers;
}
