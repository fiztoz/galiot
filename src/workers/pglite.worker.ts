/// <reference lib="webworker" />
import { PGlite } from '@electric-sql/pglite';
import { createDbClient } from '../db/client';

export interface DbWorkerMessage {
  id: string;
  type: 'query' | 'exec' | 'close';
  sql?: string;
  params?: any[];
}

export interface DbWorkerResponse {
  id: string;
  type: 'result' | 'error';
  data?: any;
  error?: string;
}

let dbPromise: Promise<PGlite> | null = null;

/**
 * Get or initialize the database instance.
 */
function getDb(): Promise<PGlite> {
  if (!dbPromise) {
    dbPromise = createDbClient().then((db) => {
      self.postMessage({ type: 'ready' });
      return db;
    }).catch((err) => {
      self.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
      throw err;
    });
  }
  return dbPromise;
}

// Start init on worker load
getDb();

self.onmessage = async (event: MessageEvent<DbWorkerMessage>) => {
  const msg = event.data;
  
  if (!msg || !msg.id || !msg.type) {
    return;
  }

  try {
    const db = await getDb();

    switch (msg.type) {
      case 'query':
        if (!msg.sql) throw new Error("Query requires 'sql' field");
        const res = await db.query(msg.sql, msg.params);
        self.postMessage({ id: msg.id, type: 'result', data: res } satisfies DbWorkerResponse);
        break;

      case 'exec':
        if (!msg.sql) throw new Error("Exec requires 'sql' field");
        await db.exec(msg.sql);
        self.postMessage({ id: msg.id, type: 'result' } satisfies DbWorkerResponse);
        break;

      case 'close':
        await db.close();
        dbPromise = null;
        self.postMessage({ id: msg.id, type: 'result' } satisfies DbWorkerResponse);
        break;

      default:
        throw new Error(`Unknown message type: ${(msg as any).type}`);
    }
  } catch (err) {
    self.postMessage({
      id: msg.id,
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    } satisfies DbWorkerResponse);
  }
};
