import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { runMigrations } from './migrations';
import { replaceListing } from './objects';
import type { AppDB } from './client';

async function freshDb(): Promise<PGlite> {
  // Mirrors the worker's extension set — schema.sql requires pg_trgm.
  return PGlite.create(undefined, { extensions: { pg_trgm } });
}

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';

async function seedProfile(db: PGlite): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO profiles
       (id, name, protocol, endpoint, region, bucket, path_style, encrypted_credentials, created_at, updated_at)
     VALUES ($1, 'test', 's3', 'https://s3.example.com', 'us-east-1', 'my-bucket', false, $2, $3, $4)`,
    [PROFILE_ID, JSON.stringify({ ciphertext: 'abc', iv: 'def' }), now, now],
  );
}

describe('schema migrations', () => {
  test('runMigrations applies the schema and is idempotent', async () => {
    const db = await freshDb();

    await runMigrations(db);
    await runMigrations(db); // second run must be a no-op

    const version = await db.query<{ value: string }>(
      `SELECT value FROM _meta WHERE key = 'schema_version'`,
    );
    expect(version.rows[0]?.value).toBe('1');

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN
       ('_meta', 'profiles', 'objects_cache', 'transfer_tasks', 'transfer_parts', 'presigned_history')
       ORDER BY table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      '_meta',
      'objects_cache',
      'presigned_history',
      'profiles',
      'transfer_parts',
      'transfer_tasks',
    ]);

    // Trigram search extension + GIN index from schema.sql
    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'objects_cache_filename_trgm_idx'`,
    );
    expect(indexes.rows.length).toBe(1);

    await db.close();
  });

  test('vault meta upsert used by createVault persists and overwrites', async () => {
    const db = await freshDb();
    await runMigrations(db);

    const upsert = (salt: string, wrapped: string) =>
      db.query(
        `INSERT INTO _meta (key, value) VALUES ('salt', $1), ('wrapped_dek', $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [salt, wrapped],
      );

    await upsert('salt-v1', 'dek-v1');
    await upsert('salt-v2', 'dek-v2');

    const res = await db.query<{ key: string; value: string }>(
      `SELECT key, value FROM _meta WHERE key IN ('salt', 'wrapped_dek') ORDER BY key`,
    );
    expect(res.rows).toEqual([
      { key: 'salt', value: 'salt-v2' },
      { key: 'wrapped_dek', value: 'dek-v2' },
    ]);

    await db.close();
  });
});

describe('profiles persistence (repository SQL)', () => {
  test('credentials are stored as JSONB and read back parsed', async () => {
    const db = await freshDb();
    await runMigrations(db);
    await seedProfile(db);

    const res = await db.query<{ encrypted_credentials: unknown }>(
      `SELECT encrypted_credentials FROM profiles WHERE name = 'test'`,
    );
    const raw = res.rows[0]?.encrypted_credentials;
    expect(typeof raw).toBe('object');
    expect(raw).toEqual({ ciphertext: 'abc', iv: 'def' });

    await db.close();
  });

  test('deleting a profile cascades to its object cache', async () => {
    const db = await freshDb();
    await runMigrations(db);
    await seedProfile(db);

    await db.query(
      `INSERT INTO objects_cache (profile_id, bucket, key, prefix, filename, is_dir, size)
       VALUES ($1, 'my-bucket', 'a/b.txt', 'a/', 'b.txt', false, 10)`,
      [PROFILE_ID],
    );

    await db.query(`DELETE FROM profiles WHERE id = $1`, [PROFILE_ID]);

    const orphanCheck = await db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM objects_cache`,
    );
    expect(Number(orphanCheck.rows[0]?.count)).toBe(0);

    await db.close();
  });
});

describe('replaceListing (explorer cache)', () => {
  test('replaces one prefix atomically with dirs and files', async () => {
    const db = await freshDb();
    await runMigrations(db);
    await seedProfile(db);
    const appDb = db as unknown as AppDB;

    await replaceListing(appDb, PROFILE_ID, 'my-bucket', '', {
      objects: [],
      prefixes: ['photos/', 'docs/'],
    });
    await replaceListing(appDb, PROFILE_ID, 'my-bucket', 'photos/', {
      objects: [
        {
          key: 'photos/2024/beach.jpg',
          lastModified: '2026-09-20T10:00:00.000Z',
          size: 2048,
          eTag: '"abc"',
        },
      ],
      prefixes: ['photos/2024/'],
    });

    const root = await db.query<{ filename: string; is_dir: boolean }>(
      `SELECT filename, is_dir FROM objects_cache WHERE profile_id = $1 AND prefix = '' ORDER BY filename`,
      [PROFILE_ID],
    );
    expect(root.rows).toEqual([
      { filename: 'docs', is_dir: true },
      { filename: 'photos', is_dir: true },
    ]);

    const nested = await db.query<{ filename: string; key: string; size: number; is_dir: boolean }>(
      `SELECT filename, key, size, is_dir FROM objects_cache
       WHERE profile_id = $1 AND prefix = 'photos/' ORDER BY is_dir DESC, filename`,
      [PROFILE_ID],
    );
    expect(nested.rows).toEqual([
      { filename: '2024', key: 'photos/2024/', size: 0, is_dir: true },
      { filename: 'beach.jpg', key: 'photos/2024/beach.jpg', size: 2048, is_dir: false },
    ]);

    // Re-listing the same prefix must not duplicate rows.
    await replaceListing(appDb, PROFILE_ID, 'my-bucket', 'photos/', {
      objects: [],
      prefixes: ['photos/2024/'],
    });
    const count = await db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM objects_cache WHERE prefix = 'photos/'`,
    );
    expect(Number(count.rows[0]?.count)).toBe(1);

    await db.close();
  });
});

describe('explorer SQL patterns', () => {
  test('fuzzy search with escaped LIKE runs and matches literally', async () => {
    const db = await freshDb();
    await runMigrations(db);
    await seedProfile(db);

    await db.query(
      `INSERT INTO objects_cache (profile_id, bucket, key, prefix, filename, is_dir, size)
       VALUES ($1, 'my-bucket', 'reports/50%-done.pdf', 'reports/', '50%-done.pdf', false, 100),
              ($1, 'my-bucket', 'reports/q3.pdf', 'reports/', 'q3.pdf', false, 200)`,
      [PROFILE_ID],
    );

    // Same shape the Explorer live query uses (escapeLike('%') = '\%').
    const res = await db.query<{ filename: string }>(
      `SELECT filename FROM objects_cache
       WHERE profile_id = $1 AND bucket = $2 AND filename ILIKE '%' || $3 || '%' ESCAPE '\\'
       ORDER BY is_dir DESC, filename ASC`,
      [PROFILE_ID, 'my-bucket', '\\%'],
    );
    expect(res.rows.map((r) => r.filename)).toEqual(['50%-done.pdf']);

    await db.close();
  });

  test('folder size roll-up sums cached descendants only', async () => {
    const db = await freshDb();
    await runMigrations(db);
    await seedProfile(db);

    await db.query(
      `INSERT INTO objects_cache (profile_id, bucket, key, prefix, filename, is_dir, size)
       VALUES ($1, 'my-bucket', 'photos/2024/', 'photos/', '2024', true, 0),
              ($1, 'my-bucket', 'photos/2024/a.jpg', 'photos/2024/', 'a.jpg', false, 1000),
              ($1, 'my-bucket', 'photos/2024/b.jpg', 'photos/2024/', 'b.jpg', false, 2500),
              ($1, 'my-bucket', 'photos/logo.png', 'photos/', 'logo.png', false, 99999)`,
      [PROFILE_ID],
    );

    const res = await db.query<{ total: number | string }>(
      `SELECT COALESCE(SUM(size), 0) AS total FROM objects_cache
       WHERE profile_id = $1 AND bucket = $2 AND key LIKE $3 ESCAPE '\\' AND NOT is_dir`,
      [PROFILE_ID, 'my-bucket', 'photos/2024/%'],
    );
    expect(Number(res.rows[0]?.total)).toBe(3500);

    await db.close();
  });
});
