/**
 * Session bookkeeping for the transfer worker.
 *
 * The worker caches server session ids per connection target. A session dies
 * when the vault locks or idles out, so a cached id can go stale mid-transfer.
 * These two helpers are pure so the retry decision is unit-testable outside
 * the worker, which cannot be imported into a Bun test.
 */

export interface SessionCacheParts {
  profileId: string;
  endpoint: string;
  bucket: string;
  headers?: Record<string, string>;
}

export function sessionCacheKey(parts: SessionCacheParts): string {
  return `${parts.profileId}\0${parts.endpoint}\0${parts.bucket}\0${JSON.stringify(parts.headers ?? {})}`;
}

/**
 * True only for the server's own "session expired or unknown" answer. A 404
 * from S3 (NoSuchKey) arrives as XML, not this JSON, and must not trigger a
 * session reopen.
 */
export function isSessionExpired(status: number, bodyText: string): boolean {
  if (status !== 404) return false;
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown };
    return typeof parsed.error === 'string' && /session expired/i.test(parsed.error);
  } catch {
    return false;
  }
}
