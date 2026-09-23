import type { AppDB, ConnectionRow } from './client';
import type { S3ProfileConfig } from '../vault/protocol';
import { vaultService } from '../vault/vaultService';
import { getSealedCredentials } from '../vault/repository';
import type { ListObjectsResult } from '../s3/client';

/** Safety cap: 20 pages × 1000 keys = 20 000 entries per folder view. */
const MAX_LIST_PAGES = 20;

export function profileConfig(profile: ConnectionRow): S3ProfileConfig {
  return {
    endpoint: profile.endpoint,
    region: profile.region,
    bucket: profile.bucket,
    pathStyle: profile.path_style,
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
          null,
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
