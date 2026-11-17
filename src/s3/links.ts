import type { AppDB, ConnectionRow } from '../db/client';
import { profileConfig } from '../db/objects';
import { getSealedCredentials } from '../vault/repository';
import { vaultService } from '../vault/vaultService';
import { getProxyToken } from '../server/session';
import { S3_ACCESS_TOKEN_HEADER } from '../server/protocol';

export type LinkPermission = 'read' | 'write';

export interface PresignedRecord {
  id: string;
  profile_id: string;
  bucket: string;
  key: string;
  url: string;
  permission: LinkPermission;
  expires_at: Date | string;
  created_at: Date | string;
}

export const EXPIRY_PRESETS: { label: string; seconds: number }[] = [
  { label: '1 hour', seconds: 3600 },
  { label: '24 hours', seconds: 86_400 },
  { label: '7 days', seconds: 604_800 },
];

/**
 * Generates a presigned URL inside the vault worker and records it in
 * `presigned_history`.
 *
 * Note on "revocation": a presigned URL is a self-contained bearer token —
 * once issued, the provider cannot invalidate it without rotating the signing
 * credentials. `deleteLink` therefore only forgets the local record; see
 * `revocationHint` for the honest wording shown in the UI.
 */
/** True for links that stream from this Galiot server rather than from S3. */
export function isServerLink(url: string): boolean {
  try {
    const path = new URL(url, window.location.origin).pathname;
    return path.startsWith('/api/s3/media/') || path.startsWith('/api/s3/upload/');
  } catch {
    return false;
  }
}

export async function createLink(
  db: AppDB,
  profile: ConnectionRow,
  key: string,
  permission: LinkPermission,
  expiresIn: number,
  via: 'server' | 's3' = 'server',
  maxBytes = 100 * 1024 * 1024,
): Promise<PresignedRecord> {
  const sealed = await getSealedCredentials(db, profile.id);
  const config = profileConfig(profile);

  const common = { profile: config, credentials: { sealed }, key, expiresIn };
  let url: string;
  if (via === 'server') {
    const grant =
      permission === 'read'
        ? await vaultService.call('s3.shareLink', common)
        : await vaultService.call('s3.shareWrite', { ...common, maxBytes });
    url = `${window.location.origin}${grant.url}`;
  } else if (permission === 'read') {
    url = (await vaultService.call('s3.presignGet', common)).url;
  } else {
    url = (await vaultService.call('s3.presignPut', {
      ...common,
      contentType: 'application/octet-stream',
    })).url;
  }

  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  await db.query(
    `INSERT INTO presigned_history (id, profile_id, bucket, key, url, permission, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, profile.id, profile.bucket, key, url, permission, expiresAt],
  );

  return {
    id,
    profile_id: profile.id,
    bucket: profile.bucket,
    key,
    url,
    permission,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  };
}

export async function listLinks(db: AppDB, limit = 50): Promise<PresignedRecord[]> {
  const res = await db.query<PresignedRecord>(
    `SELECT * FROM presigned_history ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows;
}

/**
 * Server links are cut off for real: the grant is deleted on the server, so
 * the URL stops working immediately. Presigned S3 links cannot be revoked;
 * deleting those only forgets the local record.
 */
export async function deleteLink(db: AppDB, id: string): Promise<void> {
  const found = await db.query<PresignedRecord>(`SELECT url FROM presigned_history WHERE id = $1`, [id]);
  const url = found.rows[0]?.url;
  if (url && isServerLink(url)) {
    const path = new URL(url, window.location.origin).pathname;
    const token = getProxyToken();
    const headers = new Headers();
    if (token) headers.set(S3_ACCESS_TOKEN_HEADER, token);
    const response = await fetch(path, { method: 'DELETE', headers, cache: 'no-store' });
    if (!response.ok && response.status !== 404) {
      throw new Error('The server did not revoke this link. It is still valid until it expires.');
    }
  }
  await db.query(`DELETE FROM presigned_history WHERE id = $1`, [id]);
}

export async function purgeExpiredLinks(db: AppDB): Promise<number> {
  const res = await db.query<{ count: number }>(
    `DELETE FROM presigned_history WHERE expires_at < NOW() RETURNING 1 AS count`,
  );
  return res.rows.length;
}

export function isExpired(link: Pick<PresignedRecord, 'expires_at'>): boolean {
  return new Date(link.expires_at).getTime() <= Date.now();
}

export const revocationHint =
  'A presigned URL is a bearer token: it stays valid until it expires. Deleting the record here only removes it from Galiot — to truly invalidate it, rotate the access key that signed it.';

export const serverLinkHint =
  'A server link streams from this Galiot host, so it works for people who cannot reach S3 themselves. Revoke it here and it stops working at once.';

export const serverWriteHint =
  'An upload link accepts one PUT to exactly this key, up to the byte cap, until it expires. The recipient never sees credentials and never needs a route to S3.';
