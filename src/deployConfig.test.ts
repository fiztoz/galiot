/**
 * Deployment-configuration guards.
 *
 * These invariants are invisible to the type checker and to the unit tests, and
 * each one fails open: nothing breaks locally, the site keeps working, and the
 * regression only shows up as a weakened production posture or a leaked
 * credential. They are checked here because they are cheap to check.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

function connectSrc(policy: string): string {
  const match = /connect-src([^;]*)/.exec(policy);
  return match?.[1]?.trim() ?? '';
}

describe('deployed CSP', () => {
  test('connect-src is only the app, with no loopback companion and no direct S3', () => {
    const headerSources: Record<string, string> = {
      'public/_headers': read('public', '_headers'),
      'vercel.json': read('vercel.json'),
      'index.html': read('index.html'),
    };

    for (const [file, text] of Object.entries(headerSources)) {
      expect(text, `${file} still names the retired companion`).not.toContain('127.0.0.1:8787');
      for (const directive of text.match(/connect-src[^;"]*/g) ?? []) {
        expect(connectSrc(directive), `${file} connect-src drifted`).toBe(`'self'`);
      }
    }
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

  test('tests run before the server smoke check, and no platform deploy is wired in', () => {
    expect(workflow).toMatch(/run:\s*bun test/);
    expect(workflow.indexOf('bun test')).toBeLessThan(workflow.indexOf('scripts/server.ts'));
    expect(workflow).not.toContain('wrangler-action');
    expect(workflow).not.toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(workflow).not.toContain('VERCEL_TOKEN');
  });

  test('actions are pinned to commit SHAs, not mutable tags', () => {
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) {
      expect(ref, `${ref} is not SHA-pinned`).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  test('package scripts do not publish to a hosted platform', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.server).toContain('scripts/server.ts');
    expect(pkg.scripts?.deploy).toBeUndefined();
    expect(JSON.stringify(pkg.scripts)).not.toContain('wrangler');
  });
});

/**
 * Every policy the app ships, as a directive -> value map.
 *
 * `default-src 'none'` means any directive that is *absent* silently blocks that
 * resource class. Three features were broken this way in production — the PWA
 * manifest, <audio>/<video> preview and the PDF <iframe> — with no visible
 * error anywhere except the browser console, so the set is asserted explicitly.
 */
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

const HEADER_CSP = /Content-Security-Policy:\s*(.+)/m.exec(read('public', '_headers'))![1]!.trim();
const VERCEL_CSP = (
  JSON.parse(read('vercel.json')) as {
    headers: { headers: { key: string; value: string }[] }[];
  }
).headers[0]!.headers.find((h) => h.key === 'Content-Security-Policy')!.value;
const META_CSP =
  /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/s.exec(read('index.html'))![1]!;

/**
 * Resource classes the UI actually loads. Each must be named explicitly;
 * relying on the default-src fallback is how these broke.
 *   manifest-src  <link rel=manifest>  — without it the app is not installable
 *   media-src     <audio>/<video> preview, fed a presigned https URL
 *   frame-src     the PDF <iframe>, also fed a presigned https URL
 *   img-src       image preview
 *   worker-src    the PGlite / vault / transfer workers
 *   connect-src   the same-origin Galiot server only; S3 is not called from the page
 */
const REQUIRED_DIRECTIVES = [
  'default-src',
  'script-src',
  'img-src',
  'media-src',
  'frame-src',
  'worker-src',
  'connect-src',
  'manifest-src',
  'object-src',
  'base-uri',
] as const;

describe('CSP completeness', () => {
  const policies = {
    'index.html meta': META_CSP,
    'public/_headers': HEADER_CSP,
    'vercel.json': VERCEL_CSP,
  };

  for (const [name, policy] of Object.entries(policies)) {
    test(`${name} names every directive the UI needs`, () => {
      const d = directives(policy);
      for (const required of REQUIRED_DIRECTIVES) {
        expect(d.has(required), `${name} is missing ${required}, so it falls back to default-src 'none'`).toBe(true);
      }
      // The preview features need more than 'self': they load presigned S3 URLs.
      expect(d.get('media-src'), `${name} media-src cannot stream presigned URLs`).toContain('https:');
      expect(d.get('frame-src'), `${name} frame-src cannot render a presigned PDF`).toContain('https:');
      expect(d.get('manifest-src'), `${name} manifest-src`).toBe("'self'");
    });
  }

  test('the two response-header policies are byte-identical', () => {
    // They are served by different hosts; if they drift, behaviour differs per
    // deployment and a regression only reproduces on one of them.
    expect(HEADER_CSP).toBe(VERCEL_CSP);
  });

  test('the meta policy is never looser than the response header', () => {
    const meta = directives(META_CSP);
    const header = directives(HEADER_CSP);

    for (const [name, headerValue] of header) {
      // frame-ancestors is ignored inside a <meta> CSP, so the header carries it
      // alone. Asserting its *absence* keeps that dead config from creeping in
      // and implying the meta tag does something it cannot.
      if (name === 'frame-ancestors') {
        expect(meta.has(name), 'frame-ancestors is inert in a meta CSP — do not add it').toBe(false);
        continue;
      }

      expect(meta.has(name), `meta policy is missing ${name}`).toBe(true);
      if (name === 'connect-src') {
        expect(meta.get(name)).toBe(headerValue);
        expect(meta.get(name)).toBe(`'self'`);
      } else {
        expect(meta.get(name), `${name} drifted between the meta and header policies`).toBe(headerValue);
      }
    }

    for (const name of meta.keys()) {
      expect(
        header.has(name),
        `meta policy has directive ${name} that the header does not — it would only apply on hosts without header support`,
      ).toBe(true);
    }
  });
});

describe('files served verbatim from public/', () => {
  // public/ is copied into dist/ untouched — it is never transpiled. TypeScript
  // syntax in a .js file there is a runtime SyntaxError, and for a service worker
  // the only symptom is "ServiceWorker script evaluation failed". sw.js shipped
  // with two `as Promise<Response>` casts, so the worker never once registered.
  const jsFiles = readdirSync(join(ROOT, 'public')).filter((f) => f.endsWith('.js'));

  test('there is at least one file to check', () => {
    expect(jsFiles.length).toBeGreaterThan(0);
  });

  for (const file of jsFiles) {
    test(`public/${file} is valid plain JavaScript`, () => {
      const target = join(ROOT, 'public', file);
      const proc = Bun.spawnSync(['node', '--check', target]);
      if (proc.exitCode === null) {
        // node absent — do not pretend the file was verified.
        throw new Error('node is not available to syntax-check public/*.js');
      }
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    });

    test(`public/${file} carries no TypeScript-only syntax`, () => {
      const src = read('public', file);
      expect(src).not.toMatch(/\bas\s+[A-Z][A-Za-z0-9_]*(<[^>]*>)?/); // `x as Foo<T>`
      expect(src).not.toMatch(/^\s*(interface|type)\s+\w+/m);
      expect(src).not.toMatch(/:\s*(Promise|string|number|boolean|Response)<</); // annotations
      expect(src).not.toMatch(/\w!\s*[).;,)]/); // non-null assertion
    });
  }
});
