/**
 * Transfer math: S3 multipart part planning and transfer rate estimation.
 * Pure functions — no DOM, no workers — so they stay unit-testable.
 */

/** S3 hard minimum for any part except the last. */
export const S3_MIN_PART_SIZE = 5 * 1024 * 1024;
/** S3 hard limit on parts per multipart upload. */
export const S3_MAX_PARTS = 10_000;
export const DEFAULT_PART_SIZE = 16 * 1024 * 1024;
/** Files at or below this size are uploaded with a single PUT. */
export const SINGLE_PUT_THRESHOLD = 32 * 1024 * 1024;
const MIB = 1024 * 1024;

export interface PlannedPart {
  partNumber: number;
  startByte: number;
  /** Inclusive, matching S3's byte-range convention. */
  endByte: number;
  size: number;
}

/**
 * Splits a file into multipart parts, respecting both S3 constraints:
 * every non-final part is at least 5 MiB, and the part count never exceeds
 * 10 000 (part size grows for very large files).
 */
export function planParts(fileSize: number, requestedPartSize = DEFAULT_PART_SIZE): PlannedPart[] {
  if (!Number.isFinite(fileSize) || fileSize <= 0) return [];

  const minimum = Math.max(Math.ceil(requestedPartSize), S3_MIN_PART_SIZE);
  const neededForLimit = Math.ceil(fileSize / S3_MAX_PARTS);
  const partSize = Math.ceil(Math.max(minimum, neededForLimit) / MIB) * MIB;

  const parts: PlannedPart[] = [];
  let partNumber = 1;

  for (let start = 0; start < fileSize; start += partSize) {
    const end = Math.min(start + partSize, fileSize) - 1;
    parts.push({ partNumber, startByte: start, endByte: end, size: end - start + 1 });
    partNumber += 1;
  }

  return parts;
}

export function shouldUseMultipart(
  fileSize: number,
  threshold: number = SINGLE_PUT_THRESHOLD,
): boolean {
  return fileSize > threshold;
}

export function clampConcurrency(requested: number): number {
  const rounded = Math.round(requested);
  if (!Number.isFinite(rounded)) return 1;
  return Math.min(8, Math.max(1, rounded));
}

export interface SpeedSample {
  /** epoch milliseconds */
  at: number;
  /** cumulative bytes transferred at that moment */
  bytes: number;
}

/**
 * Transfer rate over a trailing window. Sample-based (not instantaneous) so
 * UI speed readings do not flicker between chunks.
 */
export function computeSpeed(samples: SpeedSample[], now: number, windowMs = 5000): number {
  const recent = samples.filter((s) => now - s.at <= windowMs);
  if (recent.length < 2) return 0;

  const first = recent[0];
  const last = recent[recent.length - 1];
  if (!first || !last) return 0;

  const seconds = (last.at - first.at) / 1000;
  if (seconds <= 0) return 0;

  return Math.max(0, Math.round((last.bytes - first.bytes) / seconds));
}

export function etaSeconds(bytesRemaining: number, speedBytesPerSec: number): number | null {
  if (speedBytesPerSec <= 0 || bytesRemaining <= 0) return null;
  return Math.round(bytesRemaining / speedBytesPerSec);
}

/** Formats seconds as `1h 02m` / `2m 05s` / `12s`. */
export function formatEta(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
