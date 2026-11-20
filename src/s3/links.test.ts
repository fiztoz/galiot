import { describe, expect, spyOn, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { runMigrations } from '../db/migrations';
import type { AppDB, ConnectionRow } from '../db/client';
import { vaultService } from '../vault/vaultService';
import { createLink, deleteLink, EXPIRY_PRESETS, isExpired, isServerLink, purgeExpiredLinks,
  SHARE_TARGET_QUERY, shareTargetParams, type ShareTarget } from './links';

const PROFILE_ID = '33333333-3333-4333-8333-333333333333';

async function seededDb(): Promise<PGlite> {
  const db = await PGlite.create(undefined, { extensions: { pg_trgm } });
  await runMigrations(db);
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO profiles
       (id, name, protocol, endpoint, region, bucket, path_style, encrypted_credentials, created_at, updated_at)
     VALUES ($1, 'test', 's3', 'https://s3.example.com', 'us-east-1', 'bucket.example.com', false, $2, $3, $4)`,
    [PROFILE_ID, JSON.stringify({ ciphertext: 'abc', iv: 'def' }), now, now],
  );
  return db;
}

/**
 * Inserts a link whose `expires_at` is `offsetMs` from now. `id` is a UUID
 * column, so the human-readable `label` only ever lands in the object key —
 * that is what the assertions below compare on.
 */
async function insertLink(db: PGlite, label: string, offsetMs: number): Promise<void> {
  const now = new Date();
  await db.query(
    `INSERT INTO presigned_history (id, profile_id, bucket, key, url, permission, expires_at, created_at)
     VALUES ($1, $2, 'bucket.example.com', $3, $4, 'read', $5, $6)`,
    [
      crypto.randomUUID(),
      PROFILE_ID,
      `file-${label}.txt`,
      `https://bucket.example.com/file-${label}.txt?X-Amz-Signature=sig`,
      new Date(now.getTime() + offsetMs).toISOString(),
      now.toISOString(),
    ],
  );
}

const HOUR = 3_600_000;

test('v5 history retains its bearer and revocation record without guessing its target', async () => {
  const db = await seededDb();
  try {
    await db.exec(`ALTER TABLE presigned_history DROP COLUMN target_identity;
      UPDATE _meta SET value = '5' WHERE key = 'schema_version'`);
    await insertLink(db, 'legacy', HOUR);
    const before = (await db.query<Record<string, unknown>>('SELECT * FROM presigned_history')).rows[0]!;
    await runMigrations(db);
    await runMigrations(db);
    expect((await db.query('SELECT * FROM presigned_history')).rows).toEqual([{ ...before, target_identity: null }]);
  } finally {
    await db.close();
  }
});

test('issues against the selected target and rejects route or credential changes before signing', async () => {
  const db = await seededDb();
  const appDb = db as unknown as AppDB;
  const rpc = spyOn(vaultService, 'call');
  const loadProfile = async () => (await db.query<ConnectionRow>('SELECT * FROM profiles')).rows[0]!;
  const loadTarget = async (profile: ConnectionRow) =>
    (await db.query<ShareTarget>(SHARE_TARGET_QUERY, shareTargetParams(profile))).rows[0];
  try {
    const original = await loadProfile();
    const selected = (await loadTarget(original))!;
    expect(selected.target_identity).toMatch(/^[0-9a-f]{64}$/);
    await db.query("UPDATE profiles SET name = 'Renamed', updated_at = NOW()");
    expect(await loadTarget(await loadProfile())).toEqual(selected);

    rpc.mockResolvedValueOnce({ url: 'https://s3.example.com/item?signature=test' });
    const issued = await createLink(appDb, selected, 'item', 'write', 3600, 's3');
    expect(issued.target_identity).toBe(selected.target_identity);
    expect(rpc).toHaveBeenCalledWith('s3.presignPut', expect.objectContaining({
      key: 'item', credentials: { sealed: { iv: 'def', ciphertext: 'abc' } },
      profile: expect.objectContaining({ bucket: selected.bucket }),
    }));
    rpc.mockClear();

    // Keep updated_at unchanged. Each change affects authority in its own right.
    let previous = selected;
    for (const sql of [
      "UPDATE profiles SET bucket = 'other'",
      "UPDATE profiles SET endpoint = 'https://gateway.example.com'",
      `UPDATE profiles SET custom_headers = '{"x-tenant":"second"}'`,
      `UPDATE profiles SET encrypted_credentials = '{"iv":"replacement","ciphertext":"sealed"}'`,
      "UPDATE profiles SET region = 'us-west-2'",
      'UPDATE profiles SET path_style = NOT path_style',
    ]) {
      await db.exec(sql);
      for (const via of ['server', 's3'] as const) {
        for (const permission of ['read', 'write'] as const) {
          await expect(createLink(appDb, previous, 'item', permission, 3600, via)).rejects.toThrow('select the object again');
        }
      }
      const current = (await loadTarget(await loadProfile()))!;
      expect(current.target_identity).not.toBe(previous.target_identity);
      previous = current;
    }
    expect(rpc).not.toHaveBeenCalled();
    expect((await db.query('SELECT target_identity FROM presigned_history')).rows)
      .toEqual([{ target_identity: selected.target_identity }]);

    // Older vaults can store JSON strings inside either JSONB column.
    await db.query('UPDATE profiles SET custom_headers = to_jsonb($1::text), encrypted_credentials = to_jsonb($2::text)',
      [JSON.stringify({ 'x-tenant': 'legacy' }), JSON.stringify({ iv: 'legacy', ciphertext: 'sealed' })]);
    const legacy = (await loadTarget(await loadProfile()))!;
    rpc.mockResolvedValueOnce({ url: 'https://s3.example.com/item?signature=test' });
    await createLink(appDb, legacy, 'item', 'read', 3600, 's3');
    expect(rpc).toHaveBeenCalledWith('s3.presignGet', expect.objectContaining({
      credentials: { sealed: { iv: 'legacy', ciphertext: 'sealed' } },
      profile: expect.objectContaining({ headers: { 'x-tenant': 'legacy' } }),
    }));
  } finally {
    rpc.mockRestore();
    await db.close();
  }
});

test('keeps a grant in history until the issuer confirms revocation', async () => {
  const origin = 'https://example.com';
  const path = '/api/s3/media/' + 'a'.repeat(43);
  const db = await seededDb();
  const appDb = db as unknown as AppDB;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: new URL(origin) } });
  const network = spyOn(globalThis, 'fetch');
  try {
    expect(isServerLink('https://s3.example.com' + path + '?X-Amz-Signature=test')).toBe(false);
    await insertLink(db, 'grant', HOUR);
    const { rows } = await db.query<{ id: string }>('UPDATE presigned_history SET url = $1 RETURNING id', ['https://s3.example.com' + path]);
    const id = rows[0]!.id;
    await expect(deleteLink(appDb, id)).rejects.toThrow('issuing server');
    expect(network).not.toHaveBeenCalled();
    await db.query('UPDATE presigned_history SET url = $1 WHERE id = $2', [origin + path, id]);
    network.mockResolvedValueOnce(Response.json({ result: { revoked: false } }));
    await expect(deleteLink(appDb, id)).rejects.toThrow('kept in history');
    expect(await remainingKeys(db)).toEqual(['file-grant.txt']);
    network.mockResolvedValueOnce(Response.json({ result: { revoked: true } }));
    await deleteLink(appDb, id);
    expect(await remainingKeys(db)).toEqual([]);
  } finally {
    network.mockRestore();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    await db.close();
  }
});

async function remainingKeys(db: PGlite): Promise<string[]> {
  const res = await db.query<{ key: string }>(`SELECT key FROM presigned_history ORDER BY key`);
  return res.rows.map((row) => row.key);
}

describe('purgeExpiredLinks', () => {
  // This runs on every app boot (src/App.tsx). A presigned URL is a bearer token
  // stored in cleartext, so an expired one left behind is a stale credential
  // sitting in IndexedDB/OPFS with no remaining purpose.
  test('deletes only the links that have actually expired', async () => {
    const db = await seededDb();
    await insertLink(db, 'gone-an-hour-ago', -HOUR);
    await insertLink(db, 'gone-long-ago', -7 * 24 * HOUR);
    await insertLink(db, 'still-live', HOUR);

    const purged = await purgeExpiredLinks(db as unknown as AppDB);

    expect(purged).toBe(2);
    expect(await remainingKeys(db)).toEqual(['file-still-live.txt']);
  });

  test('is idempotent — a second boot finds nothing to do', async () => {
    const db = await seededDb();
    await insertLink(db, 'expired', -HOUR);
    await insertLink(db, 'live', HOUR);

    expect(await purgeExpiredLinks(db as unknown as AppDB)).toBe(1);
    expect(await purgeExpiredLinks(db as unknown as AppDB)).toBe(0);
    expect(await remainingKeys(db)).toEqual(['file-live.txt']);
  });

  test('leaves an empty table alone instead of erroring', async () => {
    const db = await seededDb();
    expect(await purgeExpiredLinks(db as unknown as AppDB)).toBe(0);
  });

  test('does not disturb the sealed credentials it sits next to', async () => {
    const db = await seededDb();
    await insertLink(db, 'expired', -HOUR);

    await purgeExpiredLinks(db as unknown as AppDB);

    const profiles = await db.query<{ id: string }>(`SELECT id FROM profiles`);
    expect(profiles.rows).toHaveLength(1);
    expect(profiles.rows[0]?.id).toBe(PROFILE_ID);
  });
});

describe('isExpired', () => {
  test('treats a past expiry as expired and a future one as live', () => {
    expect(isExpired({ expires_at: new Date(Date.now() - 1000).toISOString() })).toBe(true);
    expect(isExpired({ expires_at: new Date(Date.now() + 60_000).toISOString() })).toBe(false);
  });

  test('accepts a Date as well as a string, since PGlite may return either', () => {
    expect(isExpired({ expires_at: new Date(Date.now() - 1000) })).toBe(true);
    expect(isExpired({ expires_at: new Date(Date.now() + 60_000) })).toBe(false);
  });
});

describe('EXPIRY_PRESETS', () => {
  test('the longest link the UI can create is 7 days', () => {
    const seconds = EXPIRY_PRESETS.map((preset) => preset.seconds);
    expect(Math.max(...seconds)).toBe(604_800);
    expect(seconds).toContain(3_600); // 1 hour is the default
    // Guard against a silent bump: a longer-lived cleartext bearer token in
    // presigned_history is a bigger exposure window, so changing this should
    // force a conscious decision here.
    expect(EXPIRY_PRESETS).toHaveLength(3);
  });
});
