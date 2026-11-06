import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { headersForPath, parseHeadersFile, resolveStaticPath } from './static';

const ROOT = new URL('../..', import.meta.url).pathname;

describe('static hosting helpers', () => {
  test('the shipped _headers file is what the server will apply', () => {
    const rules = parseHeadersFile(readFileSync(join(ROOT, 'public', '_headers'), 'utf8'));
    const global = headersForPath(rules, '/index.html');
    expect(global['Content-Security-Policy']).toContain("connect-src 'self' https:");
    expect(global['X-Content-Type-Options']).toBe('nosniff');
    expect(headersForPath(rules, '/assets/app.js')['Cache-Control']).toContain('immutable');
  });

  test('a path cannot escape the static root', () => {
    const root = join(ROOT, 'public');
    expect(resolveStaticPath(root, '/')).toBe(join(root, 'index.html'));
    expect(resolveStaticPath(root, '/../package.json')).toBeNull();
    expect(resolveStaticPath(root, '/%2e%2e/package.json')).toBeNull();
  });
});
