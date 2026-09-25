import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { runMigrations } from '../db/migrations';
import { updateConnection, type ConnectionUpdate } from './repository';
import type { AppDB } from '../db/client';

/**
 * Update semantics, against a real PGlite.
 *
 * The rules that matter: credentials are replaced only when new ones are given,
 * and the cached listing is dropped only when the *target* moves — not when the
 * user merely renames the connection.
 */

let db: PGlite;
let appDb: AppDB;
let id: string;

const SEALED = { ciphertext: 'sealed-blob', iv: 'iv' };

/** Stands in for the vault worker, which owns the real encryption. */
let encryptCalls: unknown[] = [];
const encryptStub = async (credentials: unknown) => {
  encryptCalls.push(credentials);
  return { payload: { ...SEALED, marker: `sealed:${encryptCalls.length}` } };
};

beforeEach(async () => {
  db = await PGlite.create(undefined, { extensions: { pg_trgm } });
  await runMigrations(db);
  appDb = db as unknown as AppDB;
  encryptCalls = [];

  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO profiles
       (id, name, protocol, endpoint, region, bucket, path_style,
        encrypted_credentials, created_at, updated_at)
     VALUES ($1, 'Original', 's3', 'https://s3.example.com', 'us-east-1', 'my-bucket',
             false, $2, $3, $3)`,
    ['11111111-1111-4111-8111-111111111111', JSON.stringify(SEALED), now],
  );
  id = '11111111-1111-4111-8111-111111111111';

  await db.query(
    `INSERT INTO objects_cache (profile_id, bucket, key, prefix, filename, is_dir, size)
     VALUES ($1, 'my-bucket', 'reports/q3.csv', 'reports/', 'q3.csv', false, 2048),
            ($1, 'my-bucket', 'reports/', 'reports/', 'reports', true, 0)`,
    [id],
  );
});

afterEach(async () => {
  await db.close();
});

/** The module resolves `vaultService` internally, so the stub replaces it. */
const withEncrypted = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { vaultService } = await import('./vaultService');
  const original = vaultService.call;
  // @ts-expect-error — the stub stands in for the worker's real encryption.
  vaultService.call = async (method: never, params: never) => {
    if (method === 'creds.encrypt') {
      return encryptStub((params as { credentials: unknown }).credentials);
    }
    return original.call(vaultService, method, params);
  };
  try {
    return await fn();
  } finally {
    vaultService.call = original;
  }
};

const update = (overrides: Partial<ConnectionUpdate> = {}): Promise<{ clearedCache: boolean }> =>
  withEncrypted(() =>
    updateConnection(appDb, id, {
      name: 'Original',
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
      bucket: 'my-bucket',
      pathStyle: false,
      ...overrides,
    }),
  );

const row = () =>
  db
    .query<{
      name: string;
      endpoint: string;
      region: string;
      bucket: string;
      path_style: boolean;
      encrypted_credentials: unknown;
      updated_at: string;
    }>('SELECT * FROM profiles WHERE id = $1', [id])
    .then((r) => r.rows[0]!);

const cacheCount = () =>
  db
    .query<{ count: number }>('SELECT COUNT(*)::int AS count FROM objects_cache WHERE profile_id = $1', [id])
    .then((r) => r.rows[0]!.count);

describe('updateConnection', () => {
  test('changes a name without touching credentials or cache', async () => {
    const result = await update({ name: 'Renamed' });

    expect(result.clearedCache).toBe(false);
    const after = await row();
    expect(after.name).toBe('Renamed');
    expect(JSON.parse(JSON.stringify(after.encrypted_credentials))).toEqual(SEALED);
    expect(await cacheCount()).toBe(2);
    // The sealed blob was never re-wrapped: no reason to send it anywhere.
    expect(encryptCalls).toHaveLength(0);
  });

  test('re-points the bucket and drops the now-wrong cached listing', async () => {
    const result = await update({ bucket: 'other-bucket' });

    expect(result.clearedCache).toBe(true);
    const after = await row();
    expect(after.bucket).toBe('other-bucket');
    expect(await cacheCount()).toBe(0);
    // Credentials survive a bucket change.
    expect(JSON.parse(JSON.stringify(after.encrypted_credentials))).toEqual(SEALED);
  });

  test('treats endpoint, region and addressing changes as target changes', async () => {
    expect((await update({ endpoint: 'http://127.0.0.1:9000' })).clearedCache).toBe(true);

    const region = await update({ region: 'eu-west-1' });
    expect(region.clearedCache).toBe(true);

    const pathStyle = await update({ pathStyle: true });
    expect(pathStyle.clearedCache).toBe(true);
  });

  test('saving identical values is not treated as a target change', async () => {
    // A user who opens the dialog and saves without editing anything must not
    // lose their cached listing.
    const result = await update();
    expect(result.clearedCache).toBe(false);
    expect(await cacheCount()).toBe(2);
  });

  test('replaces credentials only when new ones are supplied', async () => {
    await update({
      name: 'Rotated',
      credentials: { accessKeyId: 'AKIANEW', secretAccessKey: 'new-secret' },
    });

    const after = await row();
    const stored = after.encrypted_credentials as { marker?: string };
    expect(stored.marker).toBe('sealed:1');
    // The plaintext went to the worker once and is not in the row.
    expect(JSON.stringify(after)).not.toContain('new-secret');
    expect(encryptCalls).toEqual([{ accessKeyId: 'AKIANEW', secretAccessKey: 'new-secret' }]);
  });

  test('rotating keys does not clear the cache on its own', async () => {
    const result = await update({
      credentials: { accessKeyId: 'AKIANEW', secretAccessKey: 'new-secret' },
    });
    expect(result.clearedCache).toBe(false);
    expect(await cacheCount()).toBe(2);
  });

  test('bumps updated_at', async () => {
    const before = await row();
    await Bun.sleep(5);
    await update({ name: 'Touched' });
    const after = await row();
    expect(new Date(after.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.updated_at).getTime(),
    );
  });

  test('rejects an unknown id instead of silently doing nothing', async () => {
    await expect(
      withEncrypted(() =>
        updateConnection(appDb, '22222222-2222-4222-8222-222222222222', {
          name: 'x',
          endpoint: 'https://s3.example.com',
          region: 'us-east-1',
          bucket: 'b',
          pathStyle: false,
        }),
      ),
    ).rejects.toThrow(/not found/i);
  });

  test('keeps other profiles and their caches untouched', async () => {
    const otherId = '33333333-3333-4333-8333-333333333333';
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO profiles (id, name, protocol, endpoint, region, bucket, path_style,
                             encrypted_credentials, created_at, updated_at)
       VALUES ($1, 'Other', 's3', 'https://other.example.com', 'us-east-1', 'other-bucket',
               true, $2, $3, $3)`,
      [otherId, JSON.stringify(SEALED), now],
    );
    await db.query(
      `INSERT INTO objects_cache (profile_id, bucket, key, prefix, filename, is_dir, size)
       VALUES ($1, 'other-bucket', 'k.txt', '', 'k.txt', false, 1)`,
      [otherId],
    );

    await update({ bucket: 'my-new-bucket' });

    const survivors = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM objects_cache WHERE profile_id = $1',
      [otherId],
    );
    expect(survivors.rows[0]!.count).toBe(1);
  });
});
