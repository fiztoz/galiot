/**
 * Deployment-configuration guards.
 *
 * These invariants are invisible to the type checker and to the unit tests, and
 * each one fails open: nothing breaks locally, the site keeps working, and the
 * regression only shows up as a weakened production posture or a leaked
 * credential. They are checked here because they are cheap to check.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

/** Where the optional local CORS bridge listens. */
const BRIDGE_ORIGIN = 'http://127.0.0.1:8787';

function connectSrc(policy: string): string {
  const match = /connect-src([^;]*)/.exec(policy);
  return match?.[1]?.trim() ?? '';
}

describe('deployed CSP', () => {
  // The bridge is a privileged local listener. It is reachable in development
  // only because index.html's meta policy allows it; in production the response
  // header is stricter and a request must satisfy *every* applicable policy, so
  // the header is what actually decides. Adding the bridge origin to a header
  // file would undo that and let any deployed page talk to a visitor's
  // localhost.
  test('response-header policies never allow the local bridge', () => {
    const headerSources: Record<string, string> = {
      'public/_headers': read('public', '_headers'),
      'vercel.json': read('vercel.json'),
    };

    for (const [file, text] of Object.entries(headerSources)) {
      expect(text, `${file} must not mention the bridge origin`).not.toContain(BRIDGE_ORIGIN);
      for (const directive of text.match(/connect-src[^;"]*/g) ?? []) {
        expect(connectSrc(directive), `${file} connect-src drifted`).toBe("'self' https:");
      }
    }
  });

  test('the dev meta policy still allows the bridge, or the feature is dead', () => {
    const html = read('index.html');
    const meta = /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/s.exec(html);
    expect(meta, 'index.html lost its CSP meta tag').not.toBeNull();
    expect(connectSrc(meta![0])).toContain(BRIDGE_ORIGIN);
  });

  test('every policy keeps the directives that stop framing and plugins', () => {
    const policies = [read('index.html'), read('public', '_headers'), read('vercel.json')];
    for (const policy of policies) {
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("object-src 'none'");
      // No policy may ever allow inline script — that is the control the whole
      // "no XSS sinks" argument rests on. Scoped by `;` so this reads the
      // script-src directive only and never trips over style-src, which does
      // legitimately need 'unsafe-inline' for Tailwind.
      expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(policy).not.toMatch(/script-src[^;]*'unsafe-eval'/);
    }
    // frame-ancestors is ignored in a <meta> CSP, so only the headers carry it.
    expect(read('public', '_headers')).toContain("frame-ancestors 'none'");
    expect(read('vercel.json')).toContain("frame-ancestors 'none'");
  });
});

describe('build output', () => {
  test('source maps stay opt-in so Cloudflare cannot publish them', () => {
    const config = read('vite.config.ts');
    expect(config, 'sourcemap must not be unconditionally true').not.toMatch(/sourcemap:\s*true/);
    expect(config).toMatch(/sourcemap:\s*process\.env\.GALIOT_SOURCEMAPS === "1"/);
  });

  test('vercel.json pins the build rather than relying on auto-detection', () => {
    const vercel = JSON.parse(read('vercel.json')) as {
      outputDirectory?: string;
      installCommand?: string;
      rewrites?: unknown;
    };
    expect(vercel.outputDirectory).toBe('dist');
    expect(vercel.installCommand).toContain('--frozen-lockfile');
    // Galiot has no client-side router, so an unknown path should stay a 404
    // instead of returning the app shell with a 200.
    expect(vercel.rewrites).toBeUndefined();
  });
});

describe('CI', () => {
  const workflow = read('.github', 'workflows', 'deploy.yml');

  test('the test suite gates deployment', () => {
    expect(workflow).toMatch(/run:\s*bun test/);
    expect(workflow, 'deploy must wait on verify').toMatch(/needs:\s*verify/);
    // A green suite must be established before anything can publish: tests run
    // in `verify`, and `deploy` needs `verify`, so ordering in the file plus the
    // needs edge is what makes a red suite unshippable.
    expect(workflow.indexOf('bun test')).toBeLessThan(workflow.indexOf('wrangler-action'));
    expect(workflow.split(/^  deploy:/m)[0]).toContain('bun test');
    expect(workflow.split(/^  deploy:/m)[0]).not.toContain('wrangler-action');
  });

  test('actions are pinned to commit SHAs, not mutable tags', () => {
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) {
      expect(ref, `${ref} is not SHA-pinned`).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  test('credentials appear only in the deploy job', () => {
    const [verify, deploy] = workflow.split(/^  deploy:/m);
    expect(verify).toBeDefined();
    expect(deploy).toBeDefined();
    expect(verify!).not.toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(deploy!).toContain('secrets.CLOUDFLARE_API_TOKEN');
  });
});
