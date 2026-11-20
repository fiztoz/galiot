import { describe, expect, test } from 'bun:test';
import { BRAND, brandFromMetaContent } from './branding';
import { DEFAULT_BRAND_NAME, DEFAULT_LOGO_URL } from './server/protocol';

describe('brandFromMetaContent', () => {
  test('no meta tag means the built-in brand', () => {
    const brand = brandFromMetaContent(null);
    expect(brand.name).toBe(DEFAULT_BRAND_NAME);
    expect(brand.logoUrl).toBe(DEFAULT_LOGO_URL);
    expect(brand.customLogo).toBe(false);
    expect(brand.title).toBe('Galiot — The Agile Cloud Explorer');
  });

  test('a deployed brand applies name, tagline, and logo', () => {
    const brand = brandFromMetaContent(
      JSON.stringify({ name: 'Acme Explorer', tagline: 'Company storage', logoUrl: '/branding/logo' }),
    );
    expect(brand.name).toBe('Acme Explorer');
    expect(brand.title).toBe('Acme Explorer — Company storage');
    expect(brand.logoUrl).toBe('/branding/logo');
    expect(brand.customLogo).toBe(true);
  });

  test('empty tagline yields a name-only title', () => {
    const brand = brandFromMetaContent(JSON.stringify({ name: 'Acme', tagline: '', logoUrl: null }));
    expect(brand.title).toBe('Acme');
    expect(brand.customLogo).toBe(false);
  });

  test('malformed JSON, arrays, and junk fall back safely', () => {
    for (const junk of ['{oops', '[]', '"str"', '42', 'null', '']) {
      expect(brandFromMetaContent(junk).name).toBe(DEFAULT_BRAND_NAME);
    }
  });

  test('overlong names fall back; overlong taglines fall back', () => {
    expect(brandFromMetaContent(JSON.stringify({ name: 'x'.repeat(65) })).name).toBe(DEFAULT_BRAND_NAME);
    const brand = brandFromMetaContent(JSON.stringify({ name: 'Acme', tagline: 'y'.repeat(97) }));
    expect(brand.name).toBe('Acme');
    expect(brand.tagline).toBe('The Agile Cloud Explorer');
  });

  test('only same-origin absolute logo paths are accepted', () => {
    for (const hostile of [
      'https://evil.example.com/logo.png',
      '//evil.example.com/logo.png',
      'javascript:alert(1)',
      'data:image/svg+xml,<svg/>',
      'favicon.svg',
    ]) {
      const brand = brandFromMetaContent(JSON.stringify({ name: 'Acme', logoUrl: hostile }));
      expect(brand.logoUrl).toBe(DEFAULT_LOGO_URL);
      expect(brand.customLogo).toBe(false);
    }
  });

  test('missing or non-string fields fall back individually', () => {
    const brand = brandFromMetaContent(JSON.stringify({ name: 7, tagline: null, logoUrl: {} }));
    expect(brand.name).toBe(DEFAULT_BRAND_NAME);
    expect(brand.tagline).toBe('The Agile Cloud Explorer');
    expect(brand.logoUrl).toBe(DEFAULT_LOGO_URL);
  });
});

test('the module-level BRAND is usable in DOM-free environments', () => {
  expect(typeof BRAND.name).toBe('string');
  expect(BRAND.name.length).toBeGreaterThan(0);
  expect(BRAND.title).toContain(BRAND.name);
});
