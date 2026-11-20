import { describe, expect, test } from 'bun:test';
import { PRESETS, presetsFromMetaContent } from './presets';

describe('presetsFromMetaContent', () => {
  test('no meta tag means no presets', () => {
    expect(presetsFromMetaContent(null)).toEqual({ endpoint: '', region: '', pathStyle: false });
  });

  test('a deployed preset applies', () => {
    const presets = presetsFromMetaContent(
      JSON.stringify({ endpoint: 'https://s3.example.com', region: 'eu-central-1', pathStyle: true }),
    );
    expect(presets).toEqual({ endpoint: 'https://s3.example.com', region: 'eu-central-1', pathStyle: true });
  });

  test('malformed JSON, arrays, and junk fall back safely', () => {
    for (const junk of ['{oops', '[]', '"str"', '42', 'null', '']) {
      expect(presetsFromMetaContent(junk)).toEqual({ endpoint: '', region: '', pathStyle: false });
    }
  });

  test('only absolute http(s) endpoints without credentials survive', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://s3.example.com',
      's3.example.com',
      '//s3.example.com',
      'https://user:pass@s3.example.com',
      'https://s3.example.com?token=fixture',
      'https://s3.example.com#fixture',
      'https://s3.example.com\u0000',
      'https://' + 'x'.repeat(2048),
      42,
      null,
    ]) {
      expect(presetsFromMetaContent(JSON.stringify({ endpoint: hostile })).endpoint).toBe('');
    }
  });

  test('region is capped and control-free; pathStyle must be boolean true', () => {
    expect(presetsFromMetaContent(JSON.stringify({ region: 'x'.repeat(65) })).region).toBe('');
    expect(presetsFromMetaContent(JSON.stringify({ region: 'eu\u0000' })).region).toBe('');
    expect(presetsFromMetaContent(JSON.stringify({ pathStyle: 'true' })).pathStyle).toBe(false);
    expect(presetsFromMetaContent(JSON.stringify({ pathStyle: 1 })).pathStyle).toBe(false);
  });

  test('fields fall back individually', () => {
    const presets = presetsFromMetaContent(JSON.stringify({ endpoint: 'https://s3.example.com', region: 7 }));
    expect(presets.endpoint).toBe('https://s3.example.com');
    expect(presets.region).toBe('');
    expect(presets.pathStyle).toBe(false);
  });
});

test('the module-level PRESETS is usable in DOM-free environments', () => {
  expect(PRESETS).toEqual({ endpoint: '', region: '', pathStyle: false });
});
