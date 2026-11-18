import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONTENT_SECURITY_POLICY } from './server/securityHeaders';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

function directives(policy: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of policy.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(' ');
    if (space === -1) map.set(trimmed, '');
    else map.set(trimmed.slice(0, space), trimmed.slice(space + 1));
  }
  return map;
}

const META_CSP =
  /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/s.exec(read('index.html'))![1]!;

/**
 * Galiot is self-hosted only. These guards keep third-party platform configs
 * from creeping back in, and keep the one CSP (server header + meta tag) honest.
 */
describe('release configuration', () => {
  test('no third-party platform deployment configs exist', () => {
    for (const file of ['vercel.json', 'wrangler.jsonc', 'public/_headers', 'netlify.toml']) {
      expect(existsSync(join(ROOT, file)), `${file} should not exist`).toBe(false);
    }
  });

  test('the meta CSP equals the server CSP and names every directive the UI needs', () => {
    // frame-ancestors is inert in a meta tag, so the meta policy is the server
    // policy minus that one directive.
    const expectedMeta = CONTENT_SECURITY_POLICY.replace("frame-ancestors 'none'; ", '');
    expect(META_CSP).toBe(expectedMeta);
    const d = directives(META_CSP);
    for (const required of ['default-src', 'script-src', 'img-src', 'media-src', 'frame-src', 'worker-src', 'connect-src', 'manifest-src', 'object-src', 'base-uri']) {
      expect(d.has(required), `missing ${required}`).toBe(true);
    }
    expect(d.get('connect-src')).toBe("'self'");
    expect(d.get('default-src')).toBe("'none'");
    expect(d.get('object-src')).toBe("'none'");
    // frame-ancestors is inert in a meta CSP; the server header carries it.
    expect(d.has('frame-ancestors')).toBe(false);
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    // Direct S3 presigned links still load cross-origin media.
    expect(d.get('media-src')).toContain('https:');
    expect(d.get('frame-src')).toContain('https:');
  });

  test('package.json carries no platform tooling and declares MIT', () => {
    const pkg = JSON.parse(read('package.json')) as {
      license: string;
      description: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.license).toBe('MIT');
    expect(pkg.description.toLowerCase()).toContain('self-hosted');
    expect(pkg.devDependencies.wrangler).toBeUndefined();
    for (const script of Object.values(pkg.scripts)) {
      expect(script).not.toMatch(/wrangler|vercel|netlify|gh-pages/);
    }
  });

  test('the service worker is plain parseable JS and never caches the API', () => {
    execFileSync('node', ['--check', join(ROOT, 'public', 'sw.js')]);
    const sw = read('public', 'sw.js');
    expect(sw).toContain("url.pathname.startsWith('/api/')");
    expect(sw).toContain("event.request.method !== 'GET'");
  });

  test('CI pins actions and smokes the self-hosted server, not a platform', () => {
    const ci = read('.github', 'workflows', 'deploy.yml');
    const uses = [...ci.matchAll(/uses: (\S+)/g)].map((m) => m[1] as string);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) {
      expect(ref, `${ref} must be pinned to a commit SHA`).toMatch(/@[0-9a-f]{40}$/);
    }
    expect(ci).toContain('/api/health');
    expect(ci).not.toMatch(/wrangler|vercel|netlify|pages deploy/);
  });
});
