import type { AppDB, ConnectionRow } from './client';
import type { EncryptedPayload } from '../vault/crypto';
import type { S3ProfileConfig } from '../vault/protocol';
import { vaultService } from '../vault/vaultService';
import { parseStoredHeaders } from '../s3/customHeaders';
import type { ListObjectsResult } from '../s3/client';
import { parseNetwork } from '../server/network';
import { getProxyToken } from '../server/session';

/** Safety cap: 20 pages × 1000 keys = 20 000 entries per folder view. */
const MAX_LIST_PAGES = 20;

export function profileConfig(profile: ConnectionRow): S3ProfileConfig {
  return {
    endpoint: profile.endpoint,
    region: profile.region,
    bucket: profile.bucket,
    pathStyle: profile.path_style,
    verifyEditorWrites: profile.verify_editor_writes === true,
    // Re-screened on the way out of the database, not just on the way in: the
    // column is cleartext and outlives upgrades, so a rule added later still has
    // to hold for rows written before it existed.
    headers: parseStoredHeaders(profile.custom_headers),
    network: parseNetwork(profile.network),
    proxyToken: getProxyToken(),
  };
}

interface ListingSnapshot {
  profile: ConnectionRow;
  sealed: EncryptedPayload;
}

/**
 * Read the credentials and verify their target in one snapshot, including
 * legacy JSONB strings. Every action uses this, not the bare sealed blob: if
 * another tab re-pointed the connection, the action must not pair the new
 * credentials with the endpoint and bucket this view still shows.
 */
export async function listingCredentials(db: Pick<AppDB, 'query'>, profile: ConnectionRow): Promise<EncryptedPayload> {
  const { rows } = await db.query<{ encrypted_credentials: EncryptedPayload | string; custom_headers: unknown; verify_editor_writes?: boolean }>(
    `SELECT encrypted_credentials, custom_headers, verify_editor_writes FROM profiles
      WHERE id = $1 AND bucket = $2 AND endpoint = $3 AND region = $4 AND path_style = $5
        AND date_trunc('milliseconds', updated_at) = $6`,
    [profile.id, profile.bucket, profile.endpoint, profile.region, profile.path_style, new Date(profile.updated_at).toISOString()],
  );
  const row = rows[0];
  if (!row || (row.verify_editor_writes === true) !== (profile.verify_editor_writes === true) ||
      JSON.stringify(parseStoredHeaders(row.custom_headers)) !== JSON.stringify(parseStoredHeaders(profile.custom_headers))) {
    throw new Error('This connection was changed in another tab. Refresh to use the current settings.');
  }
  return typeof row.encrypted_credentials === 'string' ? JSON.parse(row.encrypted_credentials) : row.encrypted_credentials;
}

async function verifyListingSnapshot(tx: Pick<AppDB, 'query'>, { profile, sealed }: ListingSnapshot): Promise<void> {
  const current = await listingCredentials(tx, profile);
  if (current.iv !== sealed.iv || current.ciphertext !== sealed.ciphertext) {
    throw new Error('Connection credentials changed while reading the listing. Refresh to use the current identity.');
  }
}

function lastSegment(key: string): string {
  const trimmed = key.endsWith('/') ? key.slice(0, -1) : key;
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * Replaces the cached listing for one prefix atomically, so the UI's live
 * query re-renders exactly once with fresh data.
 */
export async function replaceListing(
  db: AppDB,
  profileId: string,
  bucket: string,
  prefix: string,
  listing: Pick<ListObjectsResult, 'objects' | 'prefixes'>,
  signal?: AbortSignal,
  snapshot?: ListingSnapshot,
): Promise<void> {
  await db.transaction(async (tx) => {
    signal?.throwIfAborted();
    if (snapshot) await verifyListingSnapshot(tx, snapshot);
    await tx.query(
      `DELETE FROM objects_cache WHERE profile_id = $1 AND bucket = $2 AND prefix = $3`,
      [profileId, bucket, prefix],
    );

    const dirSet = new Set(listing.prefixes);
    for (const dirPrefix of listing.prefixes) {
      signal?.throwIfAborted();
      await tx.query(
        `INSERT INTO objects_cache
           (profile_id, bucket, key, prefix, filename, is_dir, size, cached_at)
         VALUES ($1, $2, $3, $4, $5, true, 0, NOW())
         ON CONFLICT (profile_id, bucket, key) DO UPDATE
           SET prefix = EXCLUDED.prefix,
               filename = EXCLUDED.filename,
               is_dir = true,
               size = 0,
               cached_at = NOW()`,
        [profileId, bucket, dirPrefix, prefix, lastSegment(dirPrefix)],
      );
    }

    for (const obj of listing.objects) {
      signal?.throwIfAborted();
      if ((prefix.length > 0 && obj.key === prefix) || dirSet.has(obj.key)) {
        continue;
      }
      await tx.query(
        `INSERT INTO objects_cache
           (profile_id, bucket, key, prefix, filename, is_dir, size, etag, last_modified, storage_class, content_type, cached_at)
         VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT (profile_id, bucket, key) DO UPDATE
           SET prefix = EXCLUDED.prefix,
               filename = EXCLUDED.filename,
               is_dir = false,
               size = EXCLUDED.size,
               etag = EXCLUDED.etag,
               last_modified = EXCLUDED.last_modified,
               storage_class = EXCLUDED.storage_class,
               content_type = EXCLUDED.content_type,
               cached_at = NOW()`,
        [
          profileId,
          bucket,
          obj.key,
          prefix,
          lastSegment(obj.key),
          obj.size,
          obj.eTag,
          obj.lastModified,
          obj.storageClass,
          null,
        ],
      );
    }
    signal?.throwIfAborted();
  });
}

/**
 * Fetches a full folder listing from S3 (paging through continuation tokens)
 * and refreshes the object cache. Credentials are decrypted worker-side.
 */
export async function loadListing(
  db: AppDB,
  profile: ConnectionRow,
  prefix: string,
  signal?: AbortSignal,
): Promise<{ total: number; truncated: boolean }> {
  const sealed = await listingCredentials(db, profile);
  const config = profileConfig(profile);

  const objects: ListObjectsResult['objects'] = [];
  const prefixes = new Set<string>();

  let continuationToken: string | undefined;
  let truncated = false;
  let pages = 0;

  do {
    signal?.throwIfAborted();
    const page: ListObjectsResult = await vaultService.call('s3.list', {
      profile: config,
      credentials: { sealed },
      prefix,
      delimiter: '/',
      maxKeys: 1000,
      continuationToken,
    });

    objects.push(...page.objects);
    for (const p of page.prefixes) prefixes.add(p);

    continuationToken = page.nextContinuationToken;
    truncated = page.isTruncated;
    pages += 1;
  } while (truncated && continuationToken && pages < MAX_LIST_PAGES);

  await replaceListing(db, profile.id, profile.bucket, prefix, {
    objects,
    prefixes: [...prefixes],
  }, signal, { profile, sealed });

  return { total: objects.length + prefixes.size, truncated };
}

export interface DeletionPlan {
  /** Every key to delete: selected files, each folder's marker, and everything under each folder. */
  keys: string[];
  /** Selected folder prefixes, each ending in `/`. */
  folders: string[];
  /** Objects that will be removed, folder markers excluded. */
  files: number;
  bytes: number;
}

/** Pure: merges selected keys with the objects listed under each selected folder. */
export function mergeDeletion(
  selected: string[],
  trees: ReadonlyMap<string, readonly { key: string; size: number }[]>,
): DeletionPlan {
  const keys = new Set<string>();
  const folders: string[] = [];
  let files = 0;
  let bytes = 0;
  const count = (key: string, size: number) => {
    if (keys.has(key)) return;
    keys.add(key);
    if (!key.endsWith('/')) {
      files += 1;
      bytes += size;
    }
  };
  for (const key of selected) {
    if (!key.endsWith('/')) {
      count(key, 0);
      continue;
    }
    folders.push(key);
    // The marker may not exist as an object; S3 reports a missing key as deleted.
    count(key, 0);
    for (const object of trees.get(key) ?? []) {
      if (!object.key.startsWith(key)) throw new Error('The provider listed a key outside the selected folder.');
      count(object.key, object.size);
    }
  }
  return { keys: [...keys], folders, files, bytes };
}

/**
 * Lists everything a deletion of `selected` would remove. Folders are expanded
 * on the server (capped at 10 000 objects per folder), so the user confirms
 * the real count before anything is deleted.
 */
export async function planDeletion(
  db: AppDB,
  profile: ConnectionRow,
  selected: string[],
  sizes: ReadonlyMap<string, number> = new Map(),
): Promise<DeletionPlan> {
  const trees = new Map<string, { key: string; size: number }[]>();
  const folders = selected.filter(key => key.endsWith('/'));
  if (folders.length) {
    const sealed = await listingCredentials(db, profile);
    for (const prefix of folders) {
      const tree = await vaultService.call('s3.listTree', {
        profile: profileConfig(profile), credentials: { sealed }, prefix,
      });
      trees.set(prefix, tree.objects);
    }
  }
  const plan = mergeDeletion(selected, trees);
  for (const key of selected) if (!key.endsWith('/')) plan.bytes += sizes.get(key) ?? 0;
  return plan;
}

/** Drops cached rows under a folder whose every object was confirmed deleted. */
export async function forgetCachedFolder(db: AppDB, profile: ConnectionRow, prefix: string): Promise<void> {
  await db.query(
    'DELETE FROM objects_cache WHERE profile_id = $1 AND bucket = $2 AND starts_with(key, $3)',
    [profile.id, profile.bucket, prefix],
  );
}

/** Deletes keys from the bucket, then drops their cached rows. */
export async function deleteKeys(
  db: AppDB,
  profile: ConnectionRow,
  keys: string[],
): Promise<{ deleted: string[]; errors: { key: string; code: string; message: string }[] }> {
  const sealed = await listingCredentials(db, profile);
  const result: { deleted: string[]; errors: { key: string; code: string; message: string }[] } = { deleted: [], errors: [] };
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const response = await vaultService.call('s3.delete', {
      profile: profileConfig(profile), credentials: { sealed }, keys: batch,
    });
    const deleted = new Set(response.deleted);
    const failed = new Map(response.errors.map(error => [error.key, error]));
    const confirmed = batch.filter(key => deleted.has(key) && !failed.has(key));
    if (confirmed.length) {
      await db.query(
        'DELETE FROM objects_cache WHERE profile_id = $1 AND bucket = $2 AND key = ANY($3::text[])',
        [profile.id, profile.bucket, confirmed],
      );
      result.deleted.push(...confirmed);
    }
    for (const key of batch) {
      const error = failed.get(key);
      if (error) result.errors.push(error);
      else if (!deleted.has(key)) result.errors.push({ key, code: 'Unconfirmed', message: 'Deletion was not acknowledged' });
    }
  }
  return result;
}

/**
 * Walks a remote folder subtree (worker-side, paginated + capped) and upserts
 * every discovered directory and file into `objects_cache`, so the recursive
 * CTE can produce an exact roll-up.
 */
export async function harvestFolderStats(
  db: AppDB,
  profile: ConnectionRow,
  rootKey: string,
  maxEntries = 20000,
): Promise<{ truncated: boolean; entryCount: number }> {
  const sealed = await listingCredentials(db, profile);
  const stats = await vaultService.call('s3.folderStats', {
    profile: profileConfig(profile),
    credentials: { sealed },
    rootKey,
    maxEntries,
  });

  await db.transaction(async (tx) => {
    await verifyListingSnapshot(tx, { profile, sealed });
    for (const key of stats.directories) {
      await tx.query(
        `INSERT INTO objects_cache
           (profile_id, bucket, key, prefix, filename, is_dir, size, cached_at)
         VALUES ($1, $2, $3, $4, $5, true, 0, NOW())
         ON CONFLICT (profile_id, bucket, key) DO UPDATE
           SET prefix = EXCLUDED.prefix,
               filename = EXCLUDED.filename,
               cached_at = NOW()`,
        [profile.id, profile.bucket, key, parentPrefixOf(key), lastSegment(key)],
      );
    }

    const dirSet = new Set(stats.directories);
    for (const file of stats.files) {
      if (file.key === rootKey || dirSet.has(file.key)) {
        continue;
      }
      await tx.query(
        `INSERT INTO objects_cache
           (profile_id, bucket, key, prefix, filename, is_dir, size, etag, last_modified, storage_class, cached_at)
         VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8, $9, NOW())
         ON CONFLICT (profile_id, bucket, key) DO UPDATE
           SET prefix = EXCLUDED.prefix,
               filename = EXCLUDED.filename,
               size = EXCLUDED.size,
               etag = EXCLUDED.etag,
               last_modified = EXCLUDED.last_modified,
               storage_class = EXCLUDED.storage_class,
               cached_at = NOW()`,
        [
          profile.id,
          profile.bucket,
          file.key,
          parentPrefixOf(file.key),
          lastSegment(file.key),
          file.size,
          file.eTag,
          file.lastModified,
          file.storageClass,
        ],
      );
    }

    // A complete walk is the truth for this subtree: rows it did not see were
    // deleted elsewhere and must not count toward the "exact" size.
    if (!stats.truncated) {
      await tx.query(
        `DELETE FROM objects_cache
          WHERE profile_id = $1 AND bucket = $2 AND starts_with(key, $3) AND key <> $3
            AND NOT (key = ANY($4::text[]))`,
        [profile.id, profile.bucket, rootKey, [...stats.directories, ...stats.files.map(file => file.key)]],
      );
    }
  });

  return { truncated: stats.truncated, entryCount: stats.entryCount };
}

/** Parent folder prefix of a key, e.g. 'a/b/c.txt' → 'a/b/'. */
function parentPrefixOf(key: string): string {
  const slash = key.lastIndexOf('/');
  return slash === -1 ? '' : key.slice(0, slash + 1);
}
