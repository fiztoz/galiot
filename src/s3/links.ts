import type { AppDB, ConnectionRow } from '../db/client';
import { profileConfig } from '../db/objects';
import type { EncryptedPayload } from '../vault/crypto';
import { vaultService } from '../vault/vaultService';
import { BRAND } from '../branding';
import { getProxyToken } from '../server/session';
import { S3_ACCESS_TOKEN_HEADER } from '../server/protocol';

export type LinkPermission = 'read' | 'write';

export interface ShareTarget {
  profile_id: string;
  bucket: string;
  target_identity: string;
}

// JSONB gives routing headers a stable order. Only the fingerprint is retained
// in history, including when a credential rotation changes the signing identity.
const TARGET_IDENTITY = `encode(sha256(convert_to(jsonb_build_array(
  id, protocol, endpoint, region, bucket, path_style, network, COALESCE(custom_headers, '{}'::jsonb),
  encrypted_credentials)::text, 'UTF8')), 'hex')`;

export const SHARE_TARGET_QUERY = `SELECT id AS profile_id, bucket, ${TARGET_IDENTITY} AS target_identity
  FROM profiles WHERE id = $1 AND date_trunc('milliseconds', updated_at) = $2
    AND endpoint = $3 AND region = $4 AND bucket = $5 AND path_style = $6
    AND COALESCE(custom_headers, '{}'::jsonb) = $7::jsonb`;

export function shareTargetParams(profile: ConnectionRow) {
  return [profile.id, new Date(profile.updated_at).toISOString(), profile.endpoint, profile.region,
    profile.bucket, profile.path_style, JSON.stringify(profile.custom_headers ?? {})];
}

export interface PresignedRecord {
  id: string;
  profile_id: string;
  bucket: string;
  target_identity: string | null;
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

/** Recognizes server grant URLs, including grants issued before a host change. */
export function isServerLink(url: string): boolean {
  try {
    const link = new URL(url, globalThis.window?.location.origin);
    return !link.search && /^\/api\/s3\/(media|upload)\/[A-Za-z0-9_-]{32,128}$/.test(link.pathname);
  } catch {
    return false;
  }
}

export async function createLink(
  db: AppDB,
  target: ShareTarget,
  key: string,
  permission: LinkPermission,
  expiresIn: number,
  via: 'server' | 's3' = 'server',
  maxBytes = 100 * 1024 * 1024,
): Promise<PresignedRecord> {
  return db.transaction(async tx => {
    // Serialize issuance and its history entry with edits/deletion of this profile.
    const { rows } = await tx.query<ConnectionRow & { encrypted_credentials: EncryptedPayload | string }>(
      `SELECT * FROM profiles WHERE id = $1 AND bucket = $2 AND ${TARGET_IDENTITY} = $3 FOR SHARE`,
      [target.profile_id, target.bucket, target.target_identity],
    );
    const profile = rows[0];
    if (!profile) throw new Error('Connection changed. Close this dialog and select the object again.');
    const sealed = typeof profile.encrypted_credentials === 'string'
      ? JSON.parse(profile.encrypted_credentials) as EncryptedPayload : profile.encrypted_credentials;
    const common = { profile: profileConfig(profile), credentials: { sealed }, key, expiresIn };
    let url: string;
    // The server clamps a grant's lifetime; record the one it applied.
    let lifetime = expiresIn;
    if (via === 'server') {
      const grant = permission === 'read'
        ? await vaultService.call('s3.shareLink', common)
        : await vaultService.call('s3.shareWrite', { ...common, maxBytes });
      url = `${window.location.origin}${grant.url}`;
      lifetime = grant.expiresIn;
    } else if (permission === 'read') {
      url = (await vaultService.call('s3.presignGet', common)).url;
    } else {
      url = (await vaultService.call('s3.presignPut', { ...common, contentType: 'application/octet-stream' })).url;
    }
    const inserted = await tx.query<PresignedRecord>(
      `INSERT INTO presigned_history (id, profile_id, bucket, target_identity, key, url, permission, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [crypto.randomUUID(), profile.id, profile.bucket, target.target_identity, key, url, permission,
        new Date(Date.now() + lifetime * 1000).toISOString()],
    );
    return inserted.rows[0]!;
  });
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
    const issuer = new URL(url, window.location.origin);
    if (issuer.origin !== window.location.origin) {
      throw new Error('Open the issuing server to revoke this link. The link has been kept in history.');
    }
    const token = getProxyToken();
    const headers = new Headers();
    if (token) headers.set(S3_ACCESS_TOKEN_HEADER, token);
    const response = await fetch(issuer.pathname, { method: 'DELETE', headers, cache: 'no-store', redirect: 'error' });
    const body = response.ok ? await response.json() as { result?: { revoked?: boolean } } : null;
    if (body?.result?.revoked !== true) {
      throw new Error('Revocation could not be confirmed by the issuing server. The link has been kept in history.');
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
  `A presigned URL is a bearer token: it stays valid until it expires. Deleting the record here only removes it from ${BRAND.name} — to truly invalidate it, rotate the access key that signed it.`;

export const serverLinkHint =
  `A server link streams from this ${BRAND.name} host, so it works for people who cannot reach S3 themselves. Revoke it here and it stops working at once.`;

export const serverWriteHint =
  'An upload link accepts one PUT to this key, up to its byte limit. Once forwarding starts, a failed or interrupted upload needs a new link.';
