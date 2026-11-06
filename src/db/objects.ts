import type { AppDB, ConnectionRow } from './client';
import type { S3ProfileConfig } from '../vault/protocol';
import { vaultService } from '../vault/vaultService';
import { getSealedCredentials } from '../vault/repository';
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
    // Re-screened on the way out of the database, not just on the way in: the
    // column is cleartext and outlives upgrades, so a rule added later still has
    // to hold for rows written before it existed.
    headers: parseStoredHeaders(profile.custom_headers),
    network: parseNetwork(profile.network),
    proxyToken: getProxyToken(),
  };
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
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(
      `DELETE FROM objects_cache WHERE profile_id = $1 AND bucket = $2 AND prefix = $3`,
      [profileId, bucket, prefix],
    );

    for (const dirPrefix of listing.prefixes) {
      await tx.query(
        `INSERT INTO objects_cache
           (profile_id, bucket, key, prefix, filename, is_dir, size)
         VALUES ($1, $2, $3, $4, $5, true, 0)`,
        [profileId, bucket, dirPrefix, prefix, lastSegment(dirPrefix)],
      );
    }

    for (const obj of listing.objects) {
      await tx.query(
        `INSERT INTO objects_cache
           (profile_id, bucket, key, prefix, filename, is_dir, size, etag, last_modified, storage_class, content_type)
         VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8, $9, $10)`,
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
): Promise<{ total: number; truncated: boolean }> {
  const sealed = await getSealedCredentials(db, profile.id);
  const config = profileConfig(profile);

  const objects: ListObjectsResult['objects'] = [];
  const prefixes = new Set<string>();

  let continuationToken: string | undefined;
  let truncated = false;
  let pages = 0;

  do {
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
  });

  return { total: objects.length + prefixes.size, truncated };
}

/** Deletes keys from the bucket, then drops their cached rows. */
export async function deleteKeys(
  db: AppDB,
  profile: ConnectionRow,
  keys: string[],
): Promise<{ deleted: string[]; errors: { key: string; code: string; message: string }[] }> {
  const sealed = await getSealedCredentials(db, profile.id);
  const result = await vaultService.call('s3.delete', {
    profile: profileConfig(profile),
    credentials: { sealed },
    keys,
  });

  await db.transaction(async (tx) => {
    for (const key of keys) {
      await tx.query(
        `DELETE FROM objects_cache WHERE profile_id = $1 AND bucket = $2 AND key = $3`,
        [profile.id, profile.bucket, key],
      );
    }
  });

  return result;
}

/** Produces a short-lived presigned download URL (generated in the worker). */
export async function presignDownload(
  db: AppDB,
  profile: ConnectionRow,
  key: string,
  expiresIn = 3600,
): Promise<string> {
  const sealed = await getSealedCredentials(db, profile.id);
  const { url } = await vaultService.call('s3.presignGet', {
    profile: profileConfig(profile),
    credentials: { sealed },
    key,
    expiresIn,
  });
  return url;
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
  const sealed = await getSealedCredentials(db, profile.id);
  const stats = await vaultService.call('s3.folderStats', {
    profile: profileConfig(profile),
    credentials: { sealed },
    rootKey,
    maxEntries,
  });

  await db.transaction(async (tx) => {
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

    for (const file of stats.files) {
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
  });

  return { truncated: stats.truncated, entryCount: stats.entryCount };
}

/** Parent folder prefix of a key, e.g. 'a/b/c.txt' → 'a/b/'. */
function parentPrefixOf(key: string): string {
  const slash = key.lastIndexOf('/');
  return slash === -1 ? '' : key.slice(0, slash + 1);
}
