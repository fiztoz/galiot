import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { contentTypeFor, resolveStaticPath } from './static';
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
