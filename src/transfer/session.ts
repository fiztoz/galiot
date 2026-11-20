import { sha256Hex } from '../lib/hash';

/**
 * Session bookkeeping for the transfer worker.
 *
 * The worker caches server session ids per connection target. A session dies
 * when the vault locks or idles out, so a cached id can go stale mid-transfer.
 * Persistent transfer identity also binds the original S3 route and credentials
 * across reloads and profile edits.
 */

export interface SessionCacheParts {
  profileId: string;
  endpoint: string;
  bucket: string;
  headers?: Record<string, string>;
  network?: 'server' | 'user';
  region: string;
  pathStyle: boolean;
  credentials: import('../vault/crypto').EncryptedPayload;
  proxyToken?: string;
}

function targetParts(parts: SessionCacheParts) {
  return [parts.profileId, parts.network ?? 'server', parts.endpoint, parts.bucket, parts.region,
    parts.pathStyle, Object.entries(parts.headers ?? {}).sort(), parts.credentials.iv, parts.credentials.ciphertext];
}

export function sessionCacheKey(parts: SessionCacheParts): string {
  return JSON.stringify([...targetParts(parts), parts.proxyToken]);
}

/** Persist only the digest of the S3 route and sealed credential identity. Gate tokens stay in tab memory. */
export function transferTargetIdentity(parts: SessionCacheParts): Promise<string> {
  return sha256Hex(JSON.stringify(targetParts(parts)));
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
