import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { runMigrations } from '../db/migrations';
import type { AppDB } from '../db/client';
import { EXPIRY_PRESETS, isExpired, purgeExpiredLinks } from './links';

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
