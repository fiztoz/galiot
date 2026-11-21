import { describe, expect, test } from 'bun:test';
import { assertBindAllowed, checkProxyTarget, isBlockedProxyHost } from './proxy';

describe('proxy target policy', () => {
  test('allows an https endpoint and a private LAN address', () => {
    expect(checkProxyTarget('https://s3.example.com/bucket').ok).toBe(true);
    expect(checkProxyTarget('http://10.0.0.5:9000/bucket').ok).toBe(true);
    expect(checkProxyTarget('http://127.0.0.1:9000/bucket').ok).toBe(true);
  });

  test('rejects a non-http scheme', () => {
    expect(checkProxyTarget('file:///tmp/notes').ok).toBe(false);
  });

  test('blocks the link-local range used by cloud metadata services', () => {
    expect(isBlockedProxyHost('169.254.169.254')).toBe(true);
    expect(isBlockedProxyHost('0.0.0.0')).toBe(true);
    expect(checkProxyTarget('http://169.254.1.1/latest').ok).toBe(false);
  });

  test('a public bind without a gate is refused unless explicitly opened', () => {
    expect(() => assertBindAllowed('0.0.0.0', null, false)).toThrow(/PROXY/);
    expect(() => assertBindAllowed('127.0.0.1', null, false)).not.toThrow();
    expect(() => assertBindAllowed('0.0.0.0', 'alpha-gate', false)).not.toThrow();
    expect(() => assertBindAllowed('0.0.0.0', null, true)).not.toThrow();
  });
});
