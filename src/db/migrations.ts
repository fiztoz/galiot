import { PGlite } from '@electric-sql/pglite';
import schemaSql from './schema.sql?raw';

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
      // First run, execute full schema
      await tx.exec(schemaSql);
      
      // Set initial version
      await tx.query(
        `INSERT INTO _meta (key, value) VALUES ($1, $2)`,
        ['schema_version', '1']
      );
    } else {
      // Future migrations can be handled here based on schema_version
      // const currentVersion = parseInt(versionResult.rows[0]?.value ?? '1', 10);
      // if (currentVersion < 2) { await applyV2Migration(tx); }
    }
  });
}
