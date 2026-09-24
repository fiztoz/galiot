import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { runMigrations } from './migrations';
import {
  buildObjectQuery,
  buildSubtreeSizeQuery,
  isFilterActive,
  EMPTY_FILTERS,
} from './queries';

const PROFILE_ID = '22222222-2222-4222-8222-222222222222';

async function seededDb(): Promise<PGlite> {
  const db = await PGlite.create(undefined, { extensions: { pg_trgm } });
  await runMigrations(db);

  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO profiles
       (id, name, protocol, endpoint, region, bucket, path_style, encrypted_credentials, created_at, updated_at)
     VALUES ($1, 'test', 's3', 'https://s3.example.com', 'us-east-1', 'my-bucket', false, $2, $3, $4)`,
    [PROFILE_ID, JSON.stringify({ ciphertext: 'abc', iv: 'def' }), now, now],
  );

  const rows: [string, string, string, boolean, number, string, string | null][] = [
    ['small.txt', '', 'small.txt', false, 10, '2026-01-05T00:00:00.000Z', 'STANDARD'],
    ['big.bin', '', 'big.bin', false, 50_000_000, '2026-06-10T00:00:00.000Z', 'STANDARD_IA'],
    ['archive.zip', '', 'archive.zip', false, 900_000_000, '2025-02-01T00:00:00.000Z', 'GLACIER'],
    ['photos/', '', 'photos', true, 0, '', null],
    ['photos/a.jpg', 'photos/', 'a.jpg', false, 1_000, '2026-06-11T00:00:00.000Z', 'STANDARD'],
    ['photos/2025/', 'photos/', '2025', true, 0, '', null],
    [
      'photos/2025/deep.jpg',
      'photos/2025/',
      'deep.jpg',
      false,
      2_000,
      '2026-06-12T00:00:00.000Z',
      'STANDARD',
    ],
  ];

  for (const [key, prefix, filename, isDir, size, modified, storageClass] of rows) {
    await db.query(
      `INSERT INTO objects_cache
         (profile_id, bucket, key, prefix, filename, is_dir, size, last_modified, storage_class)
       VALUES ($1, 'my-bucket', $2, $3, $4, $5, $6, NULLIF($7, '')::timestamptz, $8)`,
      [PROFILE_ID, key, prefix, filename, isDir, size, modified, storageClass],
    );
  }

  return db;
}

async function runListQuery(
  db: PGlite,
  filters: Parameters<typeof buildObjectQuery>[0]['filters'],
  prefix = '',
): Promise<string[]> {
  const { query, params } = buildObjectQuery({
    profileId: PROFILE_ID,
    bucket: 'my-bucket',
    prefix,
    filters,
  });
  const res = await db.query<{ filename: string }>(query, params);
  return res.rows.map((r) => r.filename);
}

describe('buildObjectQuery', () => {
  test('browse mode lists the folder, folders first', async () => {
    const db = await seededDb();
    expect(await runListQuery(db, EMPTY_FILTERS)).toEqual([
      'photos',
      'archive.zip',
      'big.bin',
      'small.txt',
    ]);
    await db.close();
  });

  test('min-size filter excludes small objects', async () => {
    const db = await seededDb();
    const names = await runListQuery(db, { ...EMPTY_FILTERS, minSize: 1_000_000 });
    expect(names).toEqual(['archive.zip', 'big.bin']);
    await db.close();
  });

  test('date range filter uses inclusive bounds', async () => {
    const db = await seededDb();
    const names = await runListQuery(db, {
      ...EMPTY_FILTERS,
      modifiedAfter: '2026-06-10T00:00:00.000Z',
      modifiedBefore: '2026-06-11T00:00:00.000Z',
    });
    expect(names).toEqual(['big.bin']);
    await db.close();
  });

  test('storage class filter matches exactly', async () => {
    const db = await seededDb();
    expect(await runListQuery(db, { ...EMPTY_FILTERS, storageClass: 'GLACIER' })).toEqual([
      'archive.zip',
    ]);
    // Folder rows carry no storage class, so they never match a class filter.
    expect(await runListQuery(db, { ...EMPTY_FILTERS, storageClass: 'STANDARD' })).toEqual([
      'small.txt',
    ]);
    await db.close();
  });

  test('search spans all prefixes and escapes wildcards', async () => {
    const db = await seededDb();
    expect(await runListQuery(db, { ...EMPTY_FILTERS, search: 'jpg' })).toEqual([
      'a.jpg',
      'deep.jpg',
    ]);
    // A literal '%' must not act as a wildcard.
    expect(await runListQuery(db, { ...EMPTY_FILTERS, search: '%' })).toEqual([]);
    await db.close();
  });

  test('filters combine with a folder listing', async () => {
    const db = await seededDb();
    // photos/ has 2025/ (folder, 0 B) and a.jpg (1 000 B).
    expect(await runListQuery(db, { ...EMPTY_FILTERS, minSize: 900 }, 'photos/')).toEqual([
      'a.jpg',
    ]);
    expect(await runListQuery(db, { ...EMPTY_FILTERS, minSize: 1_500 }, 'photos/')).toEqual([]);
    await db.close();
  });

  test('positional parameters stay consistent as filters stack', async () => {
    const { query, params } = buildObjectQuery({
      profileId: PROFILE_ID,
      bucket: 'my-bucket',
      prefix: 'photos/',
      filters: {
        search: '',
        minSize: 1_000,
        modifiedAfter: '2026-01-01T00:00:00.000Z',
        modifiedBefore: '2027-01-01T00:00:00.000Z',
        storageClass: 'STANDARD',
      },
    });

    expect(params).toEqual([
      PROFILE_ID,
      'my-bucket',
      'photos/',
      1_000,
      '2026-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
      'STANDARD',
    ]);
    expect((query.match(/\$\d/g) ?? []).length).toBe(7);
    expect(query.endsWith('ORDER BY is_dir DESC, filename ASC')).toBe(true);
  });

  test('isFilterActive reflects only filter inputs', () => {
    expect(isFilterActive(EMPTY_FILTERS)).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTERS, search: 'abc' })).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTERS, minSize: 0 })).toBe(true);
  });
});

describe('buildSubtreeSizeQuery (recursive CTE)', () => {
  async function subtreeTotal(db: PGlite, rootKey: string): Promise<{ total: number; count: number }> {
    const { query, params } = buildSubtreeSizeQuery({
      profileId: PROFILE_ID,
      bucket: 'my-bucket',
      rootKey,
    });
    const res = await db.query<{ total: number | string; file_count: number | string }>(query, params);
    return {
      total: Number(res.rows[0]?.total ?? 0),
      count: Number(res.rows[0]?.file_count ?? 0),
    };
  }

  test('rolls up every nested level below the selected folder', async () => {
    const db = await seededDb();
    // photos/ contains a.jpg directly plus photos/2025/deep.jpg nested twice deep.
    expect(await subtreeTotal(db, 'photos/')).toEqual({ total: 3_000, count: 2 });
    await db.close();
  });

  test('rolls up a mid-tree folder', async () => {
    const db = await seededDb();
    expect(await subtreeTotal(db, 'photos/2025/')).toEqual({ total: 2_000, count: 1 });
    await db.close();
  });

  test('rolls up the bucket root', async () => {
    const db = await seededDb();
    // 10 + 50 000 000 + 900 000 000 + 1 000 + 2 000
    expect(await subtreeTotal(db, '')).toEqual({ total: 950_003_010, count: 5 });
    await db.close();
  });

  test('ignores sibling branches', async () => {
    const db = await seededDb();
    // Only deep.jpg lives under photos/2025/ — big.bin at root must not leak in.
    expect((await subtreeTotal(db, 'photos/2025/')).total).toBe(2_000);
    await db.close();
  });
});
