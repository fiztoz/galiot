/// <reference lib="webworker" />
import { PGlite } from '@electric-sql/pglite';
import { live } from '@electric-sql/pglite/live';
import { worker } from '@electric-sql/pglite/worker';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { runMigrations } from '../db/migrations';

/**
 * Picks the fastest durable storage available to this worker:
 * OPFS Access Handle (Chrome/Firefox workers) with IndexedDB fallback (Safari).
 */
async function resolveDataDir(): Promise<string> {
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.getDirectory === 'function'
    ) {
      await navigator.storage.getDirectory();
      return 'opfs-ahp://galiot';
    }
  } catch {
    // OPFS unavailable — fall through to IndexedDB
  }
  return 'idb://galiot';
}

worker({
  init: async (options) => {
    const workerOptions = options as { dataDir?: string };
    const dataDir = workerOptions.dataDir ?? (await resolveDataDir());

    const db = await PGlite.create(dataDir, {
      // pg_trgm must be registered before schema.sql runs CREATE EXTENSION.
      extensions: { live, pg_trgm },
    });

    // Schema must be guaranteed before any query RPC is served.
    await runMigrations(db);

    return db;
  },
});
