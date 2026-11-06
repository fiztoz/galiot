/**
 * Galiot app server — provider-neutral.
 *
 * Serves the built SPA and forwards already-signed S3 requests. Run it on any
 * host that can run Bun. It does not call Cloudflare, Vercel, or any other
 * platform API.
 *
 *   bun run build && bun run server
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { handleS3Proxy, proxyListenConfig, S3_PROXY_PATH } from '../src/server/proxy';
import { contentTypeFor, headersForPath, parseHeadersFile, resolveStaticPath } from '../src/server/static';

const { hostname, port, gate, open } = proxyListenConfig();
const root = resolve(import.meta.dir, '../dist');
let headerRules: ReturnType<typeof parseHeadersFile> = [];
try {
  headerRules = parseHeadersFile(readFileSync(join(root, '_headers'), 'utf8'));
} catch {
  headerRules = [];
}

const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === S3_PROXY_PATH) {
      return handleS3Proxy(request, { expectedToken: gate });
    }

    const filePath = resolveStaticPath(root, url.pathname);
    if (!filePath) return new Response('Not found', { status: 404 });
    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response('Not found', { status: 404 });

    const headers = new Headers(headersForPath(headerRules, url.pathname));
    if (!headers.has('content-type')) headers.set('content-type', contentTypeFor(filePath));
    // HSTS on plain HTTP pins the browser to HTTPS for this host, including loopback.
    if (url.protocol !== 'https:' && request.headers.get('x-forwarded-proto') !== 'https') {
      headers.delete('strict-transport-security');
    }
    return new Response(file, { headers });
  },
});

const gateLabel = gate ? 'required' : open ? 'open bind' : 'not required on loopback';

console.log(`
Galiot server listening on http://${server.hostname}:${server.port}

  Static files: ${root}
  S3 proxy:     ${S3_PROXY_PATH}
  Proxy gate:   ${gateLabel}

The proxy forwards signed requests only. It never receives raw S3 keys.
Every connection uses this process's network.
`);
