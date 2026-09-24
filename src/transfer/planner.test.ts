import { describe, expect, test } from 'bun:test';
import {
  S3_MAX_PARTS,
  S3_MIN_PART_SIZE,
  DEFAULT_PART_SIZE,
  SINGLE_PUT_THRESHOLD,
  planParts,
  shouldUseMultipart,
  clampConcurrency,
  computeSpeed,
  etaSeconds,
  formatEta,
} from './planner';

const MIB = 1024 * 1024;

describe('planParts', () => {
  test('returns no parts for an empty file', () => {
    expect(planParts(0)).toEqual([]);
    expect(planParts(-1)).toEqual([]);
  });

  test('small file is a single part', () => {
    const parts = planParts(1024);
    expect(parts).toEqual([{ partNumber: 1, startByte: 0, endByte: 1023, size: 1024 }]);
  });

  test('splits with inclusive end bytes and contiguous ranges', () => {
    const size = 10 * MIB;
    const parts = planParts(size);

    expect(parts.length).toBe(1);
    expect(parts[0]?.endByte).toBe(size - 1);

    const multi = planParts(DEFAULT_PART_SIZE * 3 + 12345);
    expect(multi.length).toBe(4);
    expect(multi[0]?.startByte).toBe(0);
    expect(multi[0]?.endByte).toBe(DEFAULT_PART_SIZE - 1);
    expect(multi[1]?.startByte).toBe(DEFAULT_PART_SIZE);
    expect(multi[1]?.endByte).toBe(DEFAULT_PART_SIZE * 2 - 1);
    expect(multi[1]?.partNumber).toBe(2);
    expect(multi[3]?.endByte).toBe(DEFAULT_PART_SIZE * 3 + 12345 - 1);
  });

  test('part sizes always cover the whole file exactly once', () => {
    const size = 97 * MIB + 7;
    const parts = planParts(size);
    const total = parts.reduce((sum, p) => sum + p.size, 0);
    expect(total).toBe(size);

    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]?.startByte).toBe((parts[i - 1]?.endByte ?? -1) + 1);
    }
  });

  test('enforces the 5 MiB minimum for non-final parts', () => {
    // Requesting a tiny part size must be bumped to the S3 minimum.
    const parts = planParts(20 * MIB, 1024);
    for (const part of parts.slice(0, -1)) {
      expect(part.size).toBeGreaterThanOrEqual(S3_MIN_PART_SIZE);
    }
  });

  test('grows part size to stay under the 10 000 part limit', () => {
    // 1 TiB at a 5 MiB part size would need ~200k parts.
    const size = 1024 * 1024 * MIB;
    const parts = planParts(size, S3_MIN_PART_SIZE);

    expect(parts.length).toBeLessThanOrEqual(S3_MAX_PARTS);
    expect(parts.length).toBeGreaterThan(0);
    const total = parts.reduce((sum, p) => sum + p.size, 0);
    expect(total).toBe(size);
  });
});

describe('strategy + concurrency', () => {
  test('single PUT below threshold, multipart above', () => {
    expect(shouldUseMultipart(SINGLE_PUT_THRESHOLD)).toBe(false);
    expect(shouldUseMultipart(SINGLE_PUT_THRESHOLD + 1)).toBe(true);
  });

  test('concurrency is clamped to 1..8', () => {
    expect(clampConcurrency(0)).toBe(1);
    expect(clampConcurrency(-5)).toBe(1);
    expect(clampConcurrency(4)).toBe(4);
    expect(clampConcurrency(99)).toBe(8);
    expect(clampConcurrency(Number.NaN)).toBe(1);
  });
});

describe('speed + ETA', () => {
  test('computes a trailing-window rate', () => {
    const now = 10_000;
    const samples = [
      { at: now - 4000, bytes: 0 },
      { at: now - 3000, bytes: 1_000_000 },
      { at: now, bytes: 3_000_000 },
    ];
    // 3 MB over 4 s
    expect(computeSpeed(samples, now)).toBe(750_000);
  });

  test('ignores samples outside the window', () => {
    const now = 10_000;
    const samples = [
      { at: now - 60_000, bytes: 0 },
      { at: now - 1000, bytes: 500_000 },
    ];
    expect(computeSpeed(samples, now)).toBe(0);
  });

  test('never returns a negative rate', () => {
    const now = 5000;
    const samples = [
      { at: now - 2000, bytes: 900_000 },
      { at: now, bytes: 100_000 },
    ];
    expect(computeSpeed(samples, now)).toBe(0);
  });

  test('eta is null without speed and formatted otherwise', () => {
    expect(etaSeconds(1000, 0)).toBeNull();
    expect(etaSeconds(0, 1000)).toBeNull();
    expect(etaSeconds(2_000_000, 1_000_000)).toBe(2);
    expect(formatEta(null)).toBe('—');
    expect(formatEta(45)).toBe('45s');
    expect(formatEta(125)).toBe('2m 05s');
    expect(formatEta(3725)).toBe('1h 02m');
  });
});
