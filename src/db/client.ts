import { PGlite } from '@electric-sql/pglite';
import { live } from '@electric-sql/pglite/live';
import { runMigrations } from './migrations';

export interface Profile {
  id: string;
  name: string;
  protocol: 's3' | 'sftp';
  endpoint: string;
  region: string;
  bucket: string;
  path_style: boolean;
  encrypted_credentials: any;
  storage_class: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ObjectEntry {
  id: number;
  profile_id: string;
  bucket: string;
  key: string;
  prefix: string;
  filename: string;
  is_dir: boolean;
  size: number;
  etag: string | null;
  last_modified: Date | null;
  storage_class: string | null;
  content_type: string | null;
  metadata: any;
  tags: any;
  cached_at: Date;
}

export interface TransferTask {
  id: string;
  profile_id: string;
  direction: 'upload' | 'download';
  remote_key: string;
  local_path: string | null;
  file_size: number;
  bytes_transferred: number;
  status: 'queued' | 'transferring' | 'paused' | 'completed' | 'failed';
  speed_bytes_sec: number;
  upload_id: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TransferPart {
  task_id: string;
  part_number: number;
  start_byte: number;
  end_byte: number;
  etag: string | null;
  status: 'pending' | 'uploading' | 'completed';
}

export interface PresignedRecord {
  id: string;
  profile_id: string;
  bucket: string;
  key: string;
  url: string;
  permission: 'read' | 'write';
  expires_at: Date;
  created_at: Date;
}

let dbInstance: PGlite | null = null;

/**
 * Initializes and returns a PGlite database client.
 * Uses OPFS-AHP if available in a Web Worker, otherwise IDB.
 */
export async function createDbClient(): Promise<PGlite> {
  if (dbInstance) return dbInstance;

  let dataDir = 'idb://galiot';
  
  if (
    typeof WorkerGlobalScope !== 'undefined' &&
    self instanceof WorkerGlobalScope &&
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.getDirectory === 'function'
  ) {
    // Attempt OPFS-AHP — will work on Chrome/Firefox workers, fail on Safari
    try {
      await navigator.storage.getDirectory();
      dataDir = 'opfs-ahp://galiot';
    } catch {
      // Fall back to IDB
    }
  }

  dbInstance = await PGlite.create(dataDir, {
    extensions: {
      live,
    },
  });

  await runMigrations(dbInstance);
  return dbInstance;
}

/**
 * Helper to get all profiles
 */
export async function getProfiles(): Promise<Profile[]> {
  const db = await createDbClient();
  const res = await db.query<Profile>(`SELECT * FROM profiles ORDER BY name ASC`);
  return res.rows;
}

/**
 * Helper to get objects in a specific profile/bucket/prefix
 */
export async function getObjects(
  profileId: string,
  bucket: string,
  prefix: string
): Promise<ObjectEntry[]> {
  const db = await createDbClient();
  const res = await db.query<ObjectEntry>(
    `SELECT * FROM objects_cache 
     WHERE profile_id = $1 AND bucket = $2 AND prefix = $3 
     ORDER BY is_dir DESC, filename ASC`,
    [profileId, bucket, prefix]
  );
  return res.rows;
}

/**
 * Helper to get active transfer tasks
 */
export async function getActiveTransfers(): Promise<TransferTask[]> {
  const db = await createDbClient();
  const res = await db.query<TransferTask>(
    `SELECT * FROM transfer_tasks 
     WHERE status IN ('queued', 'transferring', 'paused') 
     ORDER BY created_at ASC`
  );
  return res.rows;
}
