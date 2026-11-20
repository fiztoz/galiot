import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  BRAND_LOGO_ENV,
  BRAND_NAME_ENV,
  BRAND_TAGLINE_ENV,
  MAX_LOGO_BYTES,
  brandedManifest,
  brandTitle,
  brandingFromEnv,
  escapeHtml,
  injectBranding,
  logoResponseHeaders,
} from './branding';
import { BRANDING_LOGO_PATH, BRANDING_META_NAME } from './protocol';

const ROOT = new URL('../..', import.meta.url).pathname;
const SHELL = readFileSync(join(ROOT, 'index.html'), 'utf8');
const MANIFEST = readFileSync(join(ROOT, 'public', 'manifest.webmanifest'), 'utf8');

const dir = mkdtempSync(join(tmpdir(), 'galiot-branding-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SVG = '<svg viewBox="0 0 8 8"><rect width="8" height="8" fill="navy"/></svg>';
const logoPath = join(dir, 'logo.svg');
writeFileSync(logoPath, SVG);

function metaPayload(html: string): { name: string; tagline: string; logoUrl: string | null } {
  const match = new RegExp(`<meta name="${BRANDING_META_NAME}" content="([^"]*)"`).exec(html);
  expect(match).not.toBeNull();
  // The browser unescapes attribute entities before JS reads them.
  const unescaped = match![1]!
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
  return JSON.parse(unescaped);
}

describe('brandingFromEnv', () => {
  test('defaults when nothing is set', () => {
    const brand = brandingFromEnv({});
    expect(brand.name).toBe('Galiot');
    expect(brand.tagline).toBe('The Agile Cloud Explorer');
    expect(brand.logoUrl).toBeNull();
    expect(brand.logo).toBeNull();
  });

  test('trims name and tagline; explicit empty tagline removes it', () => {
    const brand = brandingFromEnv({
      [BRAND_NAME_ENV]: '  Acme Explorer  ',
      [BRAND_TAGLINE_ENV]: '  ',
    });
    expect(brand.name).toBe('Acme Explorer');
    expect(brand.tagline).toBe('');
    expect(brandTitle(brand)).toBe('Acme Explorer');
  });

  test('blank name falls back to the default', () => {
    expect(brandingFromEnv({ [BRAND_NAME_ENV]: '   ' }).name).toBe('Galiot');
  });

  test('rejects overlong names and control characters', () => {
    expect(() => brandingFromEnv({ [BRAND_NAME_ENV]: 'x'.repeat(65) })).toThrow(/too long/);
    expect(() => brandingFromEnv({ [BRAND_NAME_ENV]: 'Acme\u0000' })).toThrow(/control characters/);
  });

  test('reads a logo file and serves it same-origin', () => {
    const brand = brandingFromEnv({ [BRAND_LOGO_ENV]: logoPath });
    expect(brand.logoUrl).toBe(BRANDING_LOGO_PATH);
    expect(brand.logo?.contentType).toBe('image/svg+xml');
    expect(Buffer.from(brand.logo!.bytes).toString('utf8')).toBe(SVG);
  });

  test('rejects a missing, empty, oversized, or wrong-type logo', () => {
    expect(() => brandingFromEnv({ [BRAND_LOGO_ENV]: join(dir, 'nope.svg') })).toThrow(/unreadable/);
    const empty = join(dir, 'empty.svg');
    writeFileSync(empty, '');
    expect(() => brandingFromEnv({ [BRAND_LOGO_ENV]: empty })).toThrow(/empty file/);
    const big = join(dir, 'big.png');
    writeFileSync(big, Buffer.alloc(MAX_LOGO_BYTES + 1));
    expect(() => brandingFromEnv({ [BRAND_LOGO_ENV]: big })).toThrow(/larger than/);
    const exe = join(dir, 'logo.exe');
    writeFileSync(exe, 'MZ');
    expect(() => brandingFromEnv({ [BRAND_LOGO_ENV]: exe })).toThrow(/must end in/);
  });
});

describe('injectBranding', () => {
  test('brands the title, favicon, and meta tag of the real shell', () => {
    const brand = brandingFromEnv({
      [BRAND_NAME_ENV]: 'Acme Explorer',
      [BRAND_TAGLINE_ENV]: 'Company object storage',
      [BRAND_LOGO_ENV]: logoPath,
    });
    const html = injectBranding(SHELL, brand);
    expect(html).toContain('<title>Acme Explorer — Company object storage</title>');
    expect(html).toContain(`href="${BRANDING_LOGO_PATH}"`);
    expect(html).toContain('type="image/svg+xml"');
    expect(html).not.toContain('href="/favicon.svg"');
    expect(metaPayload(html)).toEqual({
      name: 'Acme Explorer',
      tagline: 'Company object storage',
      logoUrl: BRANDING_LOGO_PATH,
    });
  });

  test('default branding keeps the built-in favicon and still emits the meta tag', () => {
    const html = injectBranding(SHELL, brandingFromEnv({}));
    expect(html).toContain('<title>Galiot — The Agile Cloud Explorer</title>');
    expect(html).toContain('href="/favicon.svg"');
    expect(metaPayload(html).logoUrl).toBeNull();
  });

  test('the CSP meta tag is untouched', () => {
    const csp = /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/s.exec(SHELL)![0];
    expect(injectBranding(SHELL, brandingFromEnv({ [BRAND_NAME_ENV]: 'Acme' }))).toContain(csp);
  });

  test('escapes hostile names in the title and meta; no inline script appears', () => {
    const hostile = '<script>alert(1)</script>" & \' $&';
    const html = injectBranding(SHELL, brandingFromEnv({ [BRAND_NAME_ENV]: hostile }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(metaPayload(html).name).toBe(hostile);
    // $& in a replacement string must stay literal, not expand to the match.
    expect(html).toContain('$&');
    const scripts = [...html.matchAll(/<script\b[^>]*src=/g)];
    expect(scripts.length).toBe(1); // only the original module script
  });

  test('escapeHtml covers the attribute-breaking characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('brandedManifest', () => {
  test('renames the PWA and points icons at the custom logo', () => {
    const brand = brandingFromEnv({
      [BRAND_NAME_ENV]: 'Acme Explorer International',
      [BRAND_LOGO_ENV]: logoPath,
    });
    const manifest = JSON.parse(brandedManifest(MANIFEST, brand));
    expect(manifest.name).toBe('Acme Explorer International');
    expect(manifest.short_name).toBe('Acme Explore'); // 12-char launcher cap
    expect(manifest.icons).toEqual([
      { src: BRANDING_LOGO_PATH, sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
    ]);
    expect(manifest.start_url).toBe('/');
  });

  test('default brand keeps the built-in icon', () => {
    const manifest = JSON.parse(brandedManifest(MANIFEST, brandingFromEnv({})));
    expect(manifest.name).toBe('Galiot');
    expect(manifest.icons[0].src).toBe('/favicon.svg');
  });
});

test('logo responses are sandboxed and sniff-proof', () => {
  const headers = logoResponseHeaders('image/svg+xml');
  expect(headers['Content-Security-Policy']).toContain('sandbox');
  expect(headers['Content-Security-Policy']).not.toContain('allow-scripts');
  expect(headers['X-Content-Type-Options']).toBe('nosniff');
  expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
});
