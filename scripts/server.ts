/**
 * Galiot app server — provider-neutral.
 *
 * Serves the built SPA and calls S3 from this process. Run it on a host that
 * can reach the bucket. It does not call Cloudflare, Vercel, or any other
 * platform API.
 *
 *   bun run build && bun run server
 *
 * Deployment branding (optional): GALIOT_BRAND_NAME, GALIOT_BRAND_TAGLINE,
 * GALIOT_BRAND_LOGO — see src/server/branding.ts and docs/OPERATIONS.md.
 */

import { resolve } from 'node:path';
import { handleAppRequest } from '../src/server/api';
import {
  brandedManifest,
  brandingFromEnv,
  injectBranding,
  logoResponseHeaders,
} from '../src/server/branding';
import { BRANDING_LOGO_PATH, isAppApiPath } from '../src/server/protocol';
import { injectPresets, presetsFromEnv } from '../src/server/presets';
import { proxyListenConfig, publicOrigins } from '../src/server/proxy';
import { headersForPath } from '../src/server/securityHeaders';
import { CompressedAssets, contentTypeFor, isCompressible, pickEncoding, resolveStaticPath } from '../src/server/static';

const { hostname, port, gate, open } = proxyListenConfig();
const origins = publicOrigins(process.env);
const root = resolve(import.meta.dir, '../dist');

// Branding is read once at startup; a bad logo path fails fast, like a missing
// gate. The shell and manifest are pre-rendered so requests stay cheap.
const branding = brandingFromEnv();
const presets = presetsFromEnv();
const indexFile = Bun.file(resolve(root, 'index.html'));
const shellHtml = (await indexFile.exists())
  ? injectPresets(injectBranding(await indexFile.text(), branding), presets)
  : null;
const manifestFile = Bun.file(resolve(root, 'manifest.webmanifest'));
const manifestJson = (await manifestFile.exists())
  ? brandedManifest(await manifestFile.text(), branding)
  : null;

const compressed = new CompressedAssets();

const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (isAppApiPath(url.pathname)) {
      return handleAppRequest(request, { expectedToken: gate, open, listenerPort: port, listenerHost: hostname, publicOrigins: origins });
    }

    // Deployment logo: same-origin bytes read at startup, sandboxed so an
    // operator SVG opened as a document cannot run scripts.
    if (url.pathname === BRANDING_LOGO_PATH && branding.logo) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405 });
      }
      return new Response(request.method === 'HEAD' ? null : branding.logo.bytes, {
        headers: logoResponseHeaders(branding.logo.contentType),
      });
    }

    if (url.pathname === '/manifest.webmanifest' && manifestJson !== null) {
      const headers = new Headers(headersForPath(url.pathname));
      headers.set('content-type', 'application/manifest+json');
      return new Response(request.method === 'HEAD' ? null : manifestJson, { headers });
    }

    const filePath = resolveStaticPath(root, url.pathname);
    if (!filePath) return new Response('Not found', { status: 404 });

    // The shell carries the injected brand (title, favicon, JSON meta tag).
    if (shellHtml !== null && filePath === resolve(root, 'index.html')) {
      const headers = new Headers(headersForPath(url.pathname));
      headers.set('content-type', 'text/html; charset=utf-8');
      if (url.protocol !== 'https:' && request.headers.get('x-forwarded-proto') !== 'https') {
        headers.delete('strict-transport-security');
      }
      return new Response(request.method === 'HEAD' ? null : shellHtml, { headers });
    }

    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response('Not found', { status: 404 });

    const headers = new Headers(headersForPath(url.pathname));
    if (!headers.has('content-type')) headers.set('content-type', contentTypeFor(filePath));
    // HSTS on plain HTTP pins the browser to HTTPS for this host, including loopback.
    if (url.protocol !== 'https:' && request.headers.get('x-forwarded-proto') !== 'https') {
      headers.delete('strict-transport-security');
    }
    // Hashed assets (PGlite's WASM and data are ~16 MB) go out compressed.
    // A Range request gets the plain file, whose byte offsets it names.
    const encoding = pickEncoding(request.headers.get('accept-encoding'));
    if (url.pathname.startsWith('/assets/') && isCompressible(filePath) && !request.headers.has('range')) {
      headers.set('vary', 'accept-encoding');
      if (encoding) {
        const body = await compressed.get(filePath, encoding, () => file.arrayBuffer());
        headers.set('content-encoding', encoding);
        headers.set('content-length', String(body.byteLength));
        return new Response(request.method === 'HEAD' ? null : body, { headers });
      }
    }
    return new Response(file, { headers });
  },
});

const gateLabel = gate ? 'required' : open ? 'open bind' : 'not required on loopback';
const brandLabel = branding.name === 'Galiot' && !branding.logo
  ? 'default (Galiot)'
  : `custom — ${branding.name}${branding.logo ? ' + logo' : ''}`;

console.log(`
Galiot server listening on http://${server.hostname}:${server.port}

  Static files: ${root}
  S3 API:       /api/s3
  Access gate:  ${gateLabel}
  Branding:     ${brandLabel}
  Preset endpoint: ${presets.endpoint || 'none'}

This process signs S3 requests and opens the connection. The machine running
it must be able to reach the bucket. Credentials stay in memory for the session.
`);
