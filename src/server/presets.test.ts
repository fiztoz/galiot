import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { injectBranding, brandingFromEnv } from './branding';
import {
  PRESET_ENDPOINT_ENV,
  PRESET_PATH_STYLE_ENV,
  PRESET_REGION_ENV,
  injectPresets,
  presetsFromEnv,
} from './presets';
import { PRESETS_META_NAME } from './protocol';

const ROOT = new URL('../..', import.meta.url).pathname;
const SHELL = readFileSync(join(ROOT, 'index.html'), 'utf8');

function metaPayload(html: string): { endpoint: string; region: string; pathStyle: boolean } {
  const match = new RegExp(`<meta name="${PRESETS_META_NAME}" content="([^"]*)"`).exec(html);
  expect(match).not.toBeNull();
  const unescaped = match![1]!
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
  return JSON.parse(unescaped);
}

describe('presetsFromEnv', () => {
  test('nothing set means no presets', () => {
    expect(presetsFromEnv({})).toEqual({ endpoint: '', region: '', pathStyle: false });
  });

  test('a company preset round-trips', () => {
    const presets = presetsFromEnv({
      [PRESET_ENDPOINT_ENV]: '  https://s3.example.com  ',
      [PRESET_REGION_ENV]: ' eu-central-1 ',
      [PRESET_PATH_STYLE_ENV]: '1',
    });
    expect(presets).toEqual({ endpoint: 'https://s3.example.com', region: 'eu-central-1', pathStyle: true });
  });

  test('path-style accepts 1/true only', () => {
    expect(presetsFromEnv({ [PRESET_PATH_STYLE_ENV]: 'true' }).pathStyle).toBe(true);
    expect(presetsFromEnv({ [PRESET_PATH_STYLE_ENV]: '0' }).pathStyle).toBe(false);
    expect(presetsFromEnv({ [PRESET_PATH_STYLE_ENV]: 'yes' }).pathStyle).toBe(false);
  });

  test('private LAN and loopback endpoints are allowed', () => {
    expect(presetsFromEnv({ [PRESET_ENDPOINT_ENV]: 'http://10.0.0.5:9000' }).endpoint).toBe('http://10.0.0.5:9000');
    expect(presetsFromEnv({ [PRESET_ENDPOINT_ENV]: 'http://127.0.0.1:9000' }).endpoint).toBe('http://127.0.0.1:9000');
  });

  test('endpoints are screened like live connection targets', () => {
    const bad = [
      's3.example.com',                    // no scheme
      'ftp://s3.example.com',              // wrong scheme
      'https://user:pass@s3.example.com',  // embedded credentials
      'http://169.254.169.254',            // cloud metadata
      'http://[fd00:ec2::254]',            // IPv6 metadata
      'https://s3.example.com\u0000',      // control character
      'https://' + 'x'.repeat(2048),       // overlong
    ];
    for (const endpoint of bad) {
      expect(() => presetsFromEnv({ [PRESET_ENDPOINT_ENV]: endpoint })).toThrow(/GALIOT_PRESET_ENDPOINT/);
    }
  });

  test('region is capped and control-free', () => {
    expect(() => presetsFromEnv({ [PRESET_REGION_ENV]: 'x'.repeat(65) })).toThrow(/too long/);
    expect(() => presetsFromEnv({ [PRESET_REGION_ENV]: 'eu\u0000' })).toThrow(/control characters/);
  });
});

describe('injectPresets', () => {
  test('injects a parseable meta tag into the real shell', () => {
    const presets = presetsFromEnv({
      [PRESET_ENDPOINT_ENV]: 'https://s3.example.com',
      [PRESET_REGION_ENV]: 'eu-central-1',
      [PRESET_PATH_STYLE_ENV]: '1',
    });
    const html = injectPresets(SHELL, presets);
    expect(metaPayload(html)).toEqual(presets);
  });

  test('empty presets still emit the meta tag', () => {
    expect(metaPayload(injectPresets(SHELL, presetsFromEnv({})))).toEqual({
      endpoint: '',
      region: '',
      pathStyle: false,
    });
  });

  test('composes with branding and leaves the CSP meta untouched', () => {
    const html = injectPresets(
      injectBranding(SHELL, brandingFromEnv({ GALIOT_BRAND_NAME: 'Acme Explorer' })),
      presetsFromEnv({ [PRESET_ENDPOINT_ENV]: 'https://s3.example.com' }),
    );
    expect(html).toContain('<title>Acme Explorer — The Agile Cloud Explorer</title>');
    expect(metaPayload(html).endpoint).toBe('https://s3.example.com');
    const csp = /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/s.exec(SHELL)![0];
    expect(html).toContain(csp);
    const scripts = [...html.matchAll(/<script\b[^>]*src=/g)];
    expect(scripts.length).toBe(1);
  });

  test('escapes hostile region text; no raw markup leaks', () => {
    const hostile = '<script>alert(1)</script>" & $&';
    const html = injectPresets(SHELL, { endpoint: '', region: hostile, pathStyle: false });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(metaPayload(html).region).toBe(hostile);
  });
});
