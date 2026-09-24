import { escapeLike } from '../lib/format';

/**
 * SQL builders for the explorer. Kept pure (no DB access) so the generated
 * SQL and its positional parameters can be unit-tested directly.
 */

export interface ObjectFilters {
  /** Fuzzy filename search; when set, search spans the whole cached profile. */
  search: string;
  /** Minimum object size in bytes. */
  minSize: number | null;
  /** ISO timestamp lower bound on last_modified. */
  modifiedAfter: string | null;
  /** ISO timestamp upper bound on last_modified (inclusive). */
  modifiedBefore: string | null;
  /** Exact storage class match, e.g. 'STANDARD' or 'GLACIER'. */
  storageClass: string | null;
}

export const EMPTY_FILTERS: ObjectFilters = {
  search: '',
  minSize: null,
  modifiedAfter: null,
  modifiedBefore: null,
  storageClass: null,
};

const OBJECT_COLUMNS =
  'id, profile_id, bucket, key, prefix, filename, is_dir, size, etag, ' +
  'last_modified, storage_class, content_type';

export interface BuiltQuery {
  query: string;
  params: unknown[];
}

export function buildObjectQuery(input: {
  profileId: string;
  bucket: string;
  /** Folder to list; ignored while searching. */
  prefix: string;
  filters: ObjectFilters;
}): BuiltQuery {
  const params: unknown[] = [];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const where: string[] = [`profile_id = ${add(input.profileId)}`, `bucket = ${add(input.bucket)}`];

  const { search, minSize, modifiedAfter, modifiedBefore, storageClass } = input.filters;

  if (search.length > 0) {
    where.push(`filename ILIKE '%' || ${add(escapeLike(search))} || '%' ESCAPE '\\'`);
  } else {
    where.push(`prefix = ${add(input.prefix)}`);
  }

  if (minSize !== null && Number.isFinite(minSize) && minSize > 0) {
    where.push(`size >= ${add(minSize)}`);
  }
  if (modifiedAfter) {
    where.push(`last_modified >= ${add(modifiedAfter)}`);
  }
  if (modifiedBefore) {
    where.push(`last_modified <= ${add(modifiedBefore)}`);
  }
  if (storageClass) {
    where.push(`storage_class = ${add(storageClass)}`);
  }

  return {
    query:
      `SELECT ${OBJECT_COLUMNS} FROM objects_cache ` +
      `WHERE ${where.join(' AND ')} ` +
      `ORDER BY is_dir DESC, filename ASC`,
    params,
  };
}

/**
 * Recursive CTE roll-up over the cached directory hierarchy (roadmap 2.4):
 * walks folder rows level by level, then sums every file whose direct parent
 * folder lies in that tree. Correct for partial caches in a way a plain
 * `key LIKE 'prefix%'` sum is not, because only fully-known branches count.
 */
export function buildSubtreeSizeQuery(input: {
  profileId: string;
  bucket: string;
  /** Directory key to roll up (use '' for the bucket root). */
  rootKey: string;
}): BuiltQuery {
  const query = `
WITH RECURSIVE folders AS (
  SELECT key
    FROM objects_cache
   WHERE profile_id = $1 AND bucket = $2 AND is_dir AND prefix = $3
  UNION
  SELECT child.key
    FROM objects_cache child
    JOIN folders parent ON child.prefix = parent.key
   WHERE child.profile_id = $1 AND child.bucket = $2 AND child.is_dir
)
SELECT COALESCE(SUM(o.size), 0) AS total,
       COUNT(*) AS file_count
  FROM objects_cache o
 WHERE o.profile_id = $1
   AND o.bucket = $2
   AND NOT o.is_dir
   AND (o.prefix = $3 OR o.prefix IN (SELECT key FROM folders))
`;

  return { query, params: [input.profileId, input.bucket, input.rootKey] };
}

export function isFilterActive(filters: ObjectFilters): boolean {
  return (
    filters.minSize !== null ||
    filters.modifiedAfter !== null ||
    filters.modifiedBefore !== null ||
    filters.storageClass !== null
  );
}
