import { describe, expect, test } from 'bun:test';
import { formatBytes, formatDate, escapeLike } from './format';

describe('formatBytes', () => {
  test('handles small byte counts', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  test('scales through units', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });

  test('rejects nonsense', () => {
    expect(formatBytes(-5)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('formatDate', () => {
  test('formats ISO strings and Date objects', () => {
    expect(formatDate('2026-09-24T10:30:00Z')).not.toBe('—');
    expect(formatDate(new Date(2026, 8, 24, 14, 5))).toBe('2026-09-24 14:05');
  });

  test('handles empty values', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('')).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
  });
});

describe('escapeLike', () => {
  test('escapes LIKE wildcards', () => {
    expect(escapeLike('100%_done')).toBe('100\\%\\_done');
    expect(escapeLike('back\\slash')).toBe('back\\\\slash');
  });

  test('leaves normal input untouched', () => {
    expect(escapeLike('report-final.pdf')).toBe('report-final.pdf');
  });
});
