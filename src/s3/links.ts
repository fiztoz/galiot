import type { AppDB, ConnectionRow } from '../db/client';
import { profileConfig } from '../db/objects';
import { getSealedCredentials } from '../vault/repository';
import { vaultService } from '../vault/vaultService';

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
export async function createLink(
  db: AppDB,
  profile: ConnectionRow,
  key: string,
  permission: LinkPermission,
  expiresIn: number,
): Promise<PresignedRecord> {
  const sealed = await getSealedCredentials(db, profile.id);
  const config = profileConfig(profile);

  const common = { profile: config, credentials: { sealed }, key, expiresIn };
  const { url } =
    permission === 'read'
      ? await vaultService.call('s3.presignGet', common)
      : await vaultService.call('s3.presignPut', {
          ...common,
          contentType: 'application/octet-stream',
        });

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

export async function deleteLink(db: AppDB, id: string): Promise<void> {
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
