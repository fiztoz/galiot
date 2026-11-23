import { describe, expect, spyOn, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { runMigrations, SCHEMA_VERSION } from './migrations';
import { wipeVaultData } from '../vault/repository';
import { matchesStoredTarget } from '../transfer/manager';
import type { DownloadJob } from '../transfer/protocol';
import { transferTargetIdentity } from '../transfer/session';
import { vaultService } from '../vault/vaultService';
import { deleteKeys, profileConfig, replaceListing } from './objects';
import type { AppDB, ConnectionRow } from './client';

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
  test('upgrades a v4 transfer ledger without trusting legacy upload parts', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      await seedProfile(db);
      await db.exec(`ALTER TABLE transfer_tasks DROP COLUMN upload_fingerprint, DROP COLUMN part_size, DROP COLUMN target_identity;
                     UPDATE _meta SET value = '4' WHERE key = 'schema_version'`);
      await db.query(`INSERT INTO transfer_tasks (id, profile_id, direction, remote_key, file_size, status, upload_id)
                     VALUES ($1, $2, 'upload', 'item', 100, 'paused', 'old')`, [crypto.randomUUID(), PROFILE_ID]);
      await runMigrations(db);
      expect((await db.query('SELECT upload_id, upload_fingerprint, part_size, target_identity FROM transfer_tasks')).rows)
        .toEqual([{ upload_id: 'old', upload_fingerprint: null, part_size: null, target_identity: null }]);
    } finally {
      await db.close();
    }
  });

  test('runMigrations refuses a database from a newer build', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      await db.query(`UPDATE _meta SET value = $1 WHERE key = 'schema_version'`, [String(SCHEMA_VERSION + 1)]);
      await expect(runMigrations(db)).rejects.toThrow(/newer than this build/);
      const version = await db.query<{ value: string }>(`SELECT value FROM _meta WHERE key = 'schema_version'`);
      expect(version.rows[0]?.value).toBe(String(SCHEMA_VERSION + 1));
    } finally {
      await db.close();
    }
  });

  test('runMigrations applies the schema and is idempotent', async () => {
    const db = await freshDb();

    await runMigrations(db);
    await runMigrations(db); // second run must be a no-op

    const version = await db.query<{ value: string }>(
      `SELECT value FROM _meta WHERE key = 'schema_version'`,
    );
    expect(version.rows[0]?.value).toBe(String(SCHEMA_VERSION));
    // Pinned so bumping the schema is a deliberate, reviewed edit: a new version
    // needs a migration step for every vault already in the field.
    expect(SCHEMA_VERSION).toBe(7);

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

  /**
   * A vault lives in OPFS/IndexedDB and outlives every deploy, so the upgrade
   * path matters more than the fresh-install path. This rebuilds the v1 shape by
   * hand — column dropped, marker rolled back — and checks the migration puts it
   * back without disturbing the rows already there.
   */
  async function columnNames(db: PGlite, table: string): Promise<string[]> {
    const res = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`,
      [table],
    );
    return res.rows.map((r) => r.column_name);
  }

  test('a v1 vault is upgraded in place and keeps its connections', async () => {
    const db = await freshDb();
    await runMigrations(db);
    expect(await columnNames(db, 'profiles')).toContain('custom_headers');

    // A connection created before the column existed.
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO profiles
         (id, name, protocol, endpoint, region, bucket, path_style, encrypted_credentials, created_at, updated_at)
       VALUES ($1, 'existing', 's3', 'https://s3.example.com', 'us-east-1', 'example-bucket', false, $2, $3, $4)`,
      ['44444444-4444-4444-8444-444444444444', JSON.stringify({ ciphertext: 'a', iv: 'b' }), now, now],
    );

    // Roll the database back to the v1 shape.
    await db.exec(`ALTER TABLE profiles DROP COLUMN custom_headers`);
    await db.query(`UPDATE _meta SET value = '1' WHERE key = 'schema_version'`);
    expect(await columnNames(db, 'profiles')).not.toContain('custom_headers');

    await runMigrations(db);

    expect(await columnNames(db, 'profiles')).toContain('custom_headers');
    const version = await db.query<{ value: string }>(
      `SELECT value FROM _meta WHERE key = 'schema_version'`,
    );
    expect(version.rows[0]?.value).toBe(String(SCHEMA_VERSION));

    // The row survived, and the new column is NULL rather than a bogus default —
    // `parseStoredHeaders` reads NULL as "no custom headers".
    const rows = await db.query<{ name: string; custom_headers: unknown }>(
      `SELECT name, custom_headers FROM profiles`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.name).toBe('existing');
    expect(rows.rows[0]?.custom_headers).toBe(null);

    await db.close();
  });

  test('the migration is safe to re-run and against a corrupt marker', async () => {
    const db = await freshDb();
    await runMigrations(db);
    await runMigrations(db);
    await runMigrations(db);
    expect(await columnNames(db, 'profiles')).toContain('custom_headers');

    // A garbage marker must mean "oldest shape we know", not "skip everything".
    await db.query(`UPDATE _meta SET value = 'not-a-number' WHERE key = 'schema_version'`);
    await db.exec(`ALTER TABLE profiles DROP COLUMN custom_headers`);
    await runMigrations(db);
    expect(await columnNames(db, 'profiles')).toContain('custom_headers');

    const version = await db.query<{ value: string }>(
      `SELECT value FROM _meta WHERE key = 'schema_version'`,
    );
    expect(version.rows[0]?.value).toBe(String(SCHEMA_VERSION));

    await db.close();
  });

  test('custom_headers round-trips a JSONB header map', async () => {
    const db = await freshDb();
    await runMigrations(db);

    const now = new Date().toISOString();
    const headers = { 'x-tenant-id': 'acme', 'x-request-id': 'fixed' };
    await db.query(
      `INSERT INTO profiles
         (id, name, protocol, endpoint, region, bucket, path_style, encrypted_credentials, custom_headers, created_at, updated_at)
       VALUES ($1, 'h', 's3', 'https://s3.example.com', 'us-east-1', 'example-bucket', false, $2, $3, $4, $5)`,
      [
        '55555555-5555-4555-8555-555555555555',
        JSON.stringify({ ciphertext: 'a', iv: 'b' }),
        JSON.stringify(headers),
        now,
        now,
      ],
    );

    const rows = await db.query<{ custom_headers: unknown }>(
      `SELECT custom_headers FROM profiles`,
    );
    const stored = rows.rows[0]?.custom_headers;
    // PGlite may hand back JSONB parsed or as text; both must read identically.
    expect(typeof stored === 'string' ? JSON.parse(stored) : stored).toEqual(headers);

    await db.close();
  });

  test('a v2 vault ends on the server route, including rows that v3 marked as browser calls', async () => {
    const db = await freshDb();
    await runMigrations(db);
    await db.exec(`ALTER TABLE profiles DROP COLUMN network`);
    await db.query(`UPDATE _meta SET value = '2' WHERE key = 'schema_version'`);

    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO profiles
         (id, name, protocol, endpoint, region, bucket, path_style, encrypted_credentials, created_at, updated_at)
       VALUES ($1, 'old', 's3', 'https://s3.example.com', 'us-east-1', 'example-bucket', false, $2, $3, $4)`,
      ['66666666-6666-4666-8666-666666666666', JSON.stringify({ ciphertext: 'a', iv: 'b' }), now, now],
    );

    await runMigrations(db);

    const upgraded = await db.query<{ network: string }>(`SELECT network FROM profiles WHERE name = 'old'`);
    expect(upgraded.rows[0]?.network).toBe('server');

    await db.query(
      `INSERT INTO profiles
         (id, name, protocol, endpoint, region, bucket, path_style, encrypted_credentials, created_at, updated_at)
       VALUES ($1, 'new', 's3', 'https://s3.example.com', 'us-east-1', 'example-bucket', false, $2, $3, $4)`,
      ['77777777-7777-4777-8777-777777777777', JSON.stringify({ ciphertext: 'a', iv: 'b' }), now, now],
    );
    const created = await db.query<{ network: string }>(`SELECT network FROM profiles WHERE name = 'new'`);
    expect(created.rows[0]?.network).toBe('server');

    await db.close();
  });

  test('a v3 vault that stored a browser route moves to the server', async () => {
    const db = await freshDb();
    await runMigrations(db);
    await db.query(`UPDATE _meta SET value = '3' WHERE key = 'schema_version'`);

    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO profiles
         (id, name, protocol, endpoint, region, bucket, path_style, network, encrypted_credentials, created_at, updated_at)
       VALUES ($1, 'browser', 's3', 'https://s3.example.com', 'us-east-1', 'example-bucket', true, 'user', $2, $3, $4)`,
      ['88888888-8888-4888-8888-888888888888', JSON.stringify({ ciphertext: 'a', iv: 'b' }), now, now],
    );

    await runMigrations(db);

    const upgraded = await db.query<{ network: string }>(`SELECT network FROM profiles WHERE name = 'browser'`);
    expect(upgraded.rows[0]?.network).toBe('server');
    const version = await db.query<{ value: string }>(`SELECT value FROM _meta WHERE key = 'schema_version'`);
    expect(version.rows[0]?.value).toBe(String(SCHEMA_VERSION));

    await db.close();
  });

  test('v6 profiles are not opted in to editor verification after migration', async () => {
    const db = await freshDb();
    try {
      await runMigrations(db);
      await db.exec(`ALTER TABLE profiles DROP COLUMN verify_editor_writes;
        UPDATE _meta SET value = '6' WHERE key = 'schema_version';
        INSERT INTO profiles (id, name, protocol, endpoint, region, bucket, encrypted_credentials)
        VALUES (gen_random_uuid(), 'existing', 's3', 'https://s3.example.com', 'us-east-1', 'example-bucket', '{}');`);
      await runMigrations(db);
      const rows = await db.query<{ verify_editor_writes: boolean }>('SELECT verify_editor_writes FROM profiles');
      expect(rows.rows).toEqual([{ verify_editor_writes: false }]);
    } finally {
      await db.close();
    }
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
          storageClass: 'STANDARD',
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

    // Storage class from ListObjectsV2 is persisted (enables the 2.3 filter).
    const storageClass = await db.query<{ storage_class: string | null }>(
      `SELECT storage_class FROM objects_cache WHERE key = 'photos/2024/beach.jpg'`,
    );
    expect(storageClass.rows[0]?.storage_class).toBe('STANDARD');

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

test('transfer dispatch preserves the original authority after profile edits and refuses ambiguous legacy jobs', async () => {
  const db = await freshDb();
  try {
    await runMigrations(db);
    await seedProfile(db);
    const profile = (await db.query<ConnectionRow>('SELECT * FROM profiles')).rows[0]!;
    const credentials = { iv: 'def', ciphertext: 'abc' };
    const target = profileConfig(profile);
    const job: DownloadJob = { taskId: crypto.randomUUID(), profileId: profile.id, target, credentials,
      key: 'file.bin', expectedSize: 3, destination: { kind: 'staged' } };
    const appDb = db as unknown as AppDB;
    const id = await transferTargetIdentity({ ...target, profileId: profile.id, credentials });
    await db.query(`INSERT INTO transfer_tasks (id, profile_id, direction, remote_key, file_size, status)
        VALUES ($1, $2, 'download', 'file.bin', 3, 'paused')`, [job.taskId, profile.id]);
    expect(await matchesStoredTarget(appDb, job)).toBe(false);
    await db.query('UPDATE transfer_tasks SET target_identity = $1 WHERE id = $2', [id, job.taskId]);
    expect(await matchesStoredTarget(appDb, job)).toBe(true);
    await db.query("UPDATE profiles SET name = 'renamed' WHERE id = $1", [profile.id]);
    expect(await matchesStoredTarget(appDb, job)).toBe(true);
    await db.query("UPDATE profiles SET bucket = 'example-bucket' WHERE id = $1", [profile.id]);
    expect(await matchesStoredTarget(appDb, job)).toBe(false);
    expect(await matchesStoredTarget(appDb, { ...job, target: { ...target, bucket: 'example-bucket' } })).toBe(false);
    const rotated = { iv: 'rotated', ciphertext: 'new' };
    await db.query('UPDATE profiles SET bucket = $1, encrypted_credentials = $2 WHERE id = $3',
      [target.bucket, JSON.stringify(rotated), profile.id]);
    expect(await matchesStoredTarget(appDb, { ...job, credentials: rotated })).toBe(false);
    expect(await matchesStoredTarget(appDb, { ...job, key: 'another.bin' })).toBe(false);
  } finally {
    await db.close();
  }
});

test('a bulk delete evicts only acknowledged keys across S3 batch boundaries', async () => {
  const db = await freshDb();
  const keys = Array.from({ length: 1002 }, (_, i) => `key-${i}`);
  const rpc = spyOn(vaultService, 'call');
  try {
    await runMigrations(db);
    await seedProfile(db);
    const profile = (await db.query<ConnectionRow>('SELECT * FROM profiles')).rows[0]!;
    await db.query(`INSERT INTO objects_cache (profile_id, bucket, key, prefix, filename, is_dir, size)
        SELECT $1, $2, name, '', name, false, 1 FROM unnest($3::text[]) AS name`, [profile.id, profile.bucket, keys]);
    rpc.mockResolvedValueOnce({ deleted: keys.slice(1, 1000),
      errors: [{ key: keys[0]!, code: 'Denied', message: 'Retained' }] });
    rpc.mockResolvedValueOnce({ deleted: [keys[1000]!], errors: [] });
    const result = await deleteKeys(db as unknown as AppDB, profile, keys);
    expect(rpc.mock.calls.map(([, params]) => (params as { keys: string[] }).keys.length)).toEqual([1000, 2]);
    expect(result.errors.map(err => err.key)).toEqual([keys[0]!, keys[1001]!]);
    expect((await db.query('SELECT key FROM objects_cache ORDER BY key')).rows).toEqual([{ key: keys[0] }, { key: keys[1001] }]);
    const obsolete = new AbortController();
    obsolete.abort();
    await expect(replaceListing(db as unknown as AppDB, profile.id, profile.bucket, '',
      { prefixes: [], objects: [] }, obsolete.signal)).rejects.toThrow();
    expect((await db.query('SELECT key FROM objects_cache')).rows).toHaveLength(2);
  } finally {
    rpc.mockRestore();
    await db.close();
  }
});

describe('wipeVaultData (vault delete)', () => {
  test('empties every table but leaves a usable schema', async () => {
    const db = await freshDb();
    await runMigrations(db);
    await seedProfile(db);

    await db.query(
      `INSERT INTO objects_cache (profile_id, bucket, key, prefix, filename, is_dir, size)
       VALUES ($1, 'my-bucket', 'a/b.txt', 'a/', 'b.txt', false, 10)`,
      [PROFILE_ID],
    );
    await db.query(
      `INSERT INTO transfer_tasks (id, profile_id, direction, remote_key, file_size, bytes_transferred, status)
       VALUES ('22222222-2222-4222-8222-222222222222', $1, 'upload', 'a/b.txt', 10, 0, 'completed')`,
      [PROFILE_ID],
    );
    await db.query(
      `INSERT INTO transfer_parts (task_id, part_number, start_byte, end_byte, status)
       VALUES ('22222222-2222-4222-8222-222222222222', 1, 0, 9, 'completed')`,
    );
    await db.query(
      `INSERT INTO presigned_history (id, profile_id, bucket, key, url, permission, expires_at)
       VALUES ('33333333-3333-4333-8333-333333333333', $1, 'my-bucket', 'a/b.txt', 'https://x', 'read', NOW())`,
      [PROFILE_ID],
    );
    await db.query(
      `INSERT INTO _meta (key, value) VALUES ('salt', 's'), ('wrapped_dek', 'w')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );

    await wipeVaultData(db as unknown as AppDB);

    for (const table of [
      'profiles',
      'objects_cache',
      'transfer_tasks',
      'transfer_parts',
      'presigned_history',
    ]) {
      const count = await db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
      expect(Number(count.rows[0]?.count)).toBe(0);
    }

    // The vault key material must be gone (only the schema marker may remain).
    const meta = await db.query<{ key: string }>(`SELECT key FROM _meta ORDER BY key`);
    expect(meta.rows.map((r) => r.key)).toEqual(['schema_version']);

    // Schema survives, so a new vault can be created without re-migration.
    await runMigrations(db);
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'profiles'`,
    );
    expect(tables.rows).toHaveLength(1);

    await db.close();
  });

  test('is safe to call twice', async () => {
    const db = await freshDb();
    await runMigrations(db);
    await wipeVaultData(db as unknown as AppDB);
    await wipeVaultData(db as unknown as AppDB);
    const meta = await db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM _meta`);
    expect(Number(meta.rows[0]?.count)).toBe(1);
    await db.close();
  });
});
