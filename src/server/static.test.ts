import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CompressedAssets, contentTypeFor, isCompressible, pickEncoding, resolveStaticPath } from './static';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { CONTENT_SECURITY_POLICY, headersForPath } from './securityHeaders';

const ROOT = new URL('../..', import.meta.url).pathname;

describe('static hosting helpers', () => {
  test('security headers come from the single source, not a host file', () => {
    const global = headersForPath('/index.html');
    expect(global['Content-Security-Policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(global['Content-Security-Policy']).toContain("connect-src 'self'");
    expect(global['Content-Security-Policy']).not.toContain("connect-src 'self' https:");
    expect(global['X-Content-Type-Options']).toBe('nosniff');
    expect(headersForPath('/assets/app.js')['Cache-Control']).toContain('immutable');
    expect(headersForPath('/index.html')['Cache-Control']).toBe('no-cache');
  });

  test('a path cannot escape the static root', () => {
    const root = join(ROOT, 'public');
    expect(resolveStaticPath(root, '/')).toBe(join(root, 'index.html'));
    expect(resolveStaticPath(root, '/../package.json')).toBeNull();
    expect(resolveStaticPath(root, '/%2e%2e/package.json')).toBeNull();
  });

  test('content types cover the shipped asset kinds', () => {
    expect(contentTypeFor('/x/a.js')).toContain('javascript');
    expect(contentTypeFor('/x/a.wasm')).toContain('wasm');
    expect(contentTypeFor('/x/a.svg')).toContain('svg');
  });
});

describe('asset compression', () => {
  test('prefers brotli, falls back to gzip, and honours q=0', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br');
    expect(pickEncoding('gzip')).toBe('gzip');
    expect(pickEncoding('br;q=0, gzip;q=0.5')).toBe('gzip');
    expect(pickEncoding('identity')).toBeNull();
    expect(pickEncoding(null)).toBeNull();
  });

  test('only text and WebAssembly are compressed', () => {
    expect(isCompressible('/dist/assets/pglite-x.wasm')).toBe(true);
    expect(isCompressible('/dist/assets/pglite-x.data')).toBe(true);
    expect(isCompressible('/dist/assets/index-x.js')).toBe(true);
    expect(isCompressible('/dist/assets/logo.png')).toBe(false);
    expect(isCompressible('/dist/assets/font.woff2')).toBe(false);
  });

  test('each asset is compressed once per encoding and round-trips', async () => {
    const assets = new CompressedAssets();
    const original = new TextEncoder().encode('console.log("galiot");'.repeat(500));
    let reads = 0;
    const read = async () => { reads += 1; return original.buffer as ArrayBuffer; };
    const br = await assets.get('/a.js', 'br', read);
    await assets.get('/a.js', 'br', read);
    const gz = await assets.get('/a.js', 'gzip', read);
    expect(reads).toBe(2);
    expect(br.byteLength).toBeLessThan(original.byteLength / 10);
    expect(new Uint8Array(brotliDecompressSync(br))).toEqual(original);
    expect(new Uint8Array(gunzipSync(gz))).toEqual(original);
  });
});
