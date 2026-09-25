import { PGlite } from '@electric-sql/pglite';
import schemaSql from './schema.sql?raw';

/**
 * The schema version this build writes.
 *
 * Bump it and add a step below whenever `schema.sql` changes. A vault lives in
 * OPFS or IndexedDB and outlives every deploy, so an existing database has to be
 * upgraded in place — a fresh `schema.sql` only ever runs for a new vault.
 */
export const SCHEMA_VERSION = 2;

/** The transaction handle PGlite hands the callback. */
type Tx = Parameters<Parameters<PGlite['transaction']>[0]>[0];

async function columnExists(tx: Tx, table: string, column: string): Promise<boolean> {
  const res = await tx.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     )`,
    [table, column],
  );
  return res.rows[0]?.exists ?? false;
}

/**
 * v1 → v2: per-connection custom request headers.
 *
 * Guarded by a catalog lookup rather than `IF NOT EXISTS` alone, because a vault
 * can arrive here already carrying the column — a fresh database built from the
 * v2 `schema.sql` is stamped v2 directly, but one created by an intermediate
 * build is not, and the migration has to be safe to re-run either way.
 */
async function migrateToV2(tx: Tx): Promise<void> {
  if (!(await columnExists(tx, 'profiles', 'custom_headers'))) {
    await tx.exec(`ALTER TABLE profiles ADD COLUMN custom_headers JSONB`);
  }
}

/**
 * Runs database migrations to ensure the schema is up to date.
 * Uses the `_meta` table to track the current schema version.
 *
 * @param db - The PGlite database instance
 */
export async function runMigrations(db: PGlite): Promise<void> {
  await db.transaction(async (tx) => {
    // Check if _meta table exists
    const metaCheck = await tx.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = '_meta'
      );
    `);

    const metaExists = metaCheck.rows[0]?.exists ?? false;

    if (!metaExists) {
      // First run: schema.sql is already at SCHEMA_VERSION, so stamp it as such.
      await tx.exec(schemaSql);
      await tx.query(`INSERT INTO _meta (key, value) VALUES ($1, $2)`, [
        'schema_version',
        String(SCHEMA_VERSION),
      ]);
      return;
    }

    const versionRes = await tx.query<{ value: string }>(
      `SELECT value FROM _meta WHERE key = 'schema_version'`,
    );
    const parsed = parseInt(versionRes.rows[0]?.value ?? '1', 10);
    // A missing or corrupt marker means "oldest shape we know", not "skip
    // everything": NaN would silently bypass every migration below.
    const current = Number.isFinite(parsed) ? parsed : 1;

    if (current < 2) await migrateToV2(tx);

    if (current !== SCHEMA_VERSION) {
      await tx.query(`UPDATE _meta SET value = $1 WHERE key = 'schema_version'`, [
        String(SCHEMA_VERSION),
      ]);
    }
  });
}
