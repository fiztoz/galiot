import { PGliteWorker } from '@electric-sql/pglite/worker';
import { live } from '@electric-sql/pglite/live';
import type { PGliteWithLive } from '@electric-sql/pglite/live';

/** The application database: a PGlite worker client with the live extension. */
export type AppDB = PGliteWorker & PGliteWithLive;

let dbPromise: Promise<AppDB> | null = null;

/**
 * Spawns the PGlite worker and connects this tab to the shared instance.
 * OPFS-AHP / IndexedDB selection and schema migrations happen worker-side.
 * Safe to call multiple times — resolves to the same connection.
 */
export function initDb(): Promise<AppDB> {
  if (dbPromise) return dbPromise;

  dbPromise = (async () => {
    const worker = new Worker(new URL('../workers/pglite.worker.ts', import.meta.url), {
      type: 'module',
    });

    const db = (await PGliteWorker.create(worker, {
      extensions: { live },
    })) as AppDB;

    // Block until the leader has finished migrations before first use.
    await db.waitReady;
    return db;
  })();

  dbPromise.catch(() => {
    // Allow a retry after a failed init.
    dbPromise = null;
  });

  return dbPromise;
}

/** Row shape of `profiles` (credentials column intentionally omitted). */
export interface ConnectionRow {
  id: string;
  name: string;
  protocol: 's3' | 'sftp';
  endpoint: string;
  region: string;
  bucket: string;
  path_style: boolean;
  storage_class: string | null;
  /** Extra request headers for this connection; null when none are set. */
  custom_headers: Record<string, string> | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Row shape of `objects_cache` entries rendered by the explorer. */
export interface ObjectRow {
  id: number;
  profile_id: string;
  bucket: string;
  key: string;
  prefix: string;
  filename: string;
  is_dir: boolean;
  size: number;
  etag: string | null;
  last_modified: Date | string | null;
  storage_class: string | null;
  content_type: string | null;
}
