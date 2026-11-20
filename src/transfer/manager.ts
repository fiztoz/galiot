import type { AppDB, ConnectionRow } from '../db/client';
import { profileConfig } from '../db/objects';
import { getSealedCredentials } from '../vault/repository';
import { vaultService } from '../vault/vaultService';
import { sessionCacheKey, transferTargetIdentity } from './session';
import type { EncryptedPayload } from '../vault/crypto';
import { removeStaging, TRANSFER_LOCK } from './checkpoint';
import { DEFAULT_PART_SIZE, clampConcurrency } from './planner';
import type {
  CompletedPart,
  DownloadDestination,
  DownloadJob,
  TransferCommand,
  TransferEvent,
  UploadJob,
} from './protocol';

export interface TransferTaskRow {
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
  upload_fingerprint?: string | null;
  part_size?: number | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface UploadOptions {
  partSize?: number;
  concurrency?: number;
  /**
   * Per-file relative paths (folder picks and directory drops), parallel to
   * `files`. When absent, each file lands under its own name.
   */
  relativePaths?: string[];
}

type Listener = (event: TransferEvent) => void;

/** Progress writes are throttled so the DB is not hammered by chunk events. */
const PROGRESS_WRITE_MS = 400;

function triggerFileDownload(file: File, filename: string, release: () => void): () => void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  const revoke = () => URL.revokeObjectURL(url);
  const timer = setTimeout(() => {
    revoke();
    release();
  }, 30_000);
  return () => { clearTimeout(timer); revoke(); };
}

/** Authorize both a fresh dispatch and a resume against the immutable ledger entry and live profile. */
export async function matchesStoredTarget(db: AppDB, job: DownloadJob | UploadJob): Promise<boolean> {
  const result = await db.query<ConnectionRow & { target_identity: string | null; encrypted_credentials: EncryptedPayload | string }>(
    `SELECT p.*, t.target_identity FROM transfer_tasks t JOIN profiles p ON p.id = t.profile_id
     WHERE t.id = $1 AND p.id = $2 AND t.remote_key = $3 AND t.direction = $4`,
    [job.taskId, job.profileId, job.key, 'file' in job ? 'upload' : 'download'],
  );
  const row = result.rows[0];
  if (!row?.target_identity || row.protocol !== 's3') return false;
  const credentials: EncryptedPayload = typeof row.encrypted_credentials === 'string'
    ? JSON.parse(row.encrypted_credentials) : row.encrypted_credentials;
  const live = { ...profileConfig(row), profileId: row.id, credentials };
  const proposed = { ...job.target, profileId: job.profileId, credentials: job.credentials };
  return sessionCacheKey(live) === sessionCacheKey(proposed) &&
    row.target_identity === await transferTargetIdentity(proposed);
}

/**
 * Main-thread coordinator for the transfer worker.
 *
 * Responsibilities: job bookkeeping, persisting progress to PGlite, and
 * handing the signing channel to the vault worker. It never sees raw S3
 * credentials — only sealed blobs travel through here.
 */
class TransferManager {
  private worker: Worker | null = null;
  private db: AppDB | null = null;
  private listeners = new Set<Listener>();
  private lastProgressWrite = new Map<string, number>();
  private initPromise: Promise<void> | null = null;

  private channel: BroadcastChannel | null = null;
  private generation = 0;
  private deleting = false;
  private profileChanges = new Map<string, number>();
  private events: Promise<void> = Promise.resolve();
  private directoryTargets = new Map<string, DownloadDestination>();
  private browserDownloads = new Map<string, () => void>();

  private broadcast(message: { type: 'stop' } | { type: 'invalidate-profile'; profileId: string }): void {
    if (this.channel) {
      this.channel.postMessage(message);
    } else if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('galiot-transfer-control');
      channel.postMessage(message);
      channel.close();
    }
  }

  private stop(): void {
    ++this.generation;
    this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
    this.lastProgressWrite.clear();
    this.profileChanges.clear();
    this.directoryTargets.clear();
    for (const revoke of this.browserDownloads.values()) revoke();
    this.browserDownloads.clear();
  }

  /** Stop writers in all tabs, take exclusive ownership of staging, then perform the vault wipe. */
  async withVaultDeletion<T>(wipe: () => Promise<T>): Promise<T> {
    this.deleting = true;
    this.stop();
    this.broadcast({ type: 'stop' });
    try {
      const run = async () => {
        await this.events;
        await removeStaging();
        return wipe();
      };
      const locks = globalThis.navigator?.locks;
      return await (locks ? locks.request(TRANSFER_LOCK, run) : run());
    } finally {
      this.deleting = false;
    }
  }

  invalidateProfile(profileId: string): void {
    const command = { type: 'invalidate-profile', profileId } as const;
    this.profileChanged(profileId);
    this.broadcast(command);
  }

  private profileChanged(profileId: string): void {
    this.profileChanges.set(profileId, (this.profileChanges.get(profileId) ?? 0) + 1);
    this.worker?.postMessage({ type: 'invalidate-profile', profileId } satisfies TransferCommand);
  }

  /** Spawns the transfer worker and wires the worker↔worker signing port. */
  init(db: AppDB): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.db = db;
    if (this.deleting) return Promise.reject(new Error('The vault is being deleted.'));
    if (!this.channel && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('galiot-transfer-control');
      this.channel.onmessage = ({ data }) => {
        if (data?.type === 'stop') this.stop();
        if (data?.type === 'invalidate-profile' && typeof data.profileId === 'string') this.profileChanged(data.profileId);
      };
    }
    const generation = this.generation;
    this.initPromise = (async () => {
      const worker = new Worker(new URL('../workers/transfer.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.addEventListener('message', (event: MessageEvent<TransferEvent>) => {
        this.events = this.events.then(async () => {
          if (generation === this.generation) await this.handleEvent(event.data);
        }).catch(error => console.error('Could not persist transfer state:', error));
      });
      worker.addEventListener('error', (event) => {
        console.error('Transfer worker error:', event.message);
      });
      this.worker = worker;

      // One end goes to the transfer worker, the other to the vault worker.
      // MessagePorts transfer by reference, so no data flows through here.
      const channel = new MessageChannel();
      worker.postMessage({ type: 'attach-signing-port', port: channel.port1 }, [channel.port1]);
      await vaultService.attachTransferPort(channel.port2);

      // Worker state does not survive a reload: park unfinished transfers so
      // the user can resume them (uploads need the File re-picked).
      if (generation !== this.generation) return;
      const locks = await globalThis.navigator?.locks?.query();
      const active = (locks?.held ?? []).flatMap(lock =>
        lock.name?.startsWith('galiot-task-') ? [lock.name.slice('galiot-task-'.length)] : []);
      await db.query(
        `UPDATE transfer_tasks
            SET status = 'paused', speed_bytes_sec = 0, updated_at = NOW()
          WHERE status IN ('queued', 'transferring') AND NOT (id::text = ANY($1::text[]))`, [active],
      );
    })();

    this.initPromise.catch(() => {
      if (generation === this.generation) this.initPromise = null;
    });
    return this.initPromise;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private requireDb(): AppDB {
    if (!this.db) throw new Error('TransferManager not initialized');
    return this.db;
  }

  private post(command: TransferCommand, generation = this.generation): void {
    if (this.deleting || generation !== this.generation || !this.worker) throw new Error('Transfer worker stopped.');
    this.worker.postMessage(command);
  }

  private async dispatch(job: DownloadJob | UploadJob, generation: number) {
    const revision = this.profileChanges.get(job.profileId);
    const authorized = await matchesStoredTarget(this.requireDb(), job);
    if (!authorized || revision !== this.profileChanges.get(job.profileId)) {
      const message = 'This task’s original connection cannot be verified. Queue a new transfer for the intended destination.';
      await this.handleEvent({ type: 'error', taskId: job.taskId, message });
      throw new Error(message);
    }
    if ('file' in job) this.post({ type: 'upload', job }, generation);
    else this.post({ type: 'download', job }, generation);
  }

  /** Queues local files for upload into `prefix` of the given connection. */
  async enqueueUploads(
    profile: ConnectionRow,
    prefix: string,
    files: File[],
    options: UploadOptions = {},
  ): Promise<string[]> {
    if (files.length === 0) return [];
    const generation = this.generation;
    const db = this.requireDb();
    await this.init(db);
    const credentials = await getSealedCredentials(db, profile.id);
    const target = profileConfig(profile);
    const identity = await transferTargetIdentity({ ...target, profileId: profile.id, credentials });
    const taskIds: string[] = [];

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i] as File;
      const relative = options.relativePaths?.[i] ?? file.name;
      const key = `${prefix}${relative}`;
      const taskId = crypto.randomUUID();

      await db.query(
        `INSERT INTO transfer_tasks
           (id, profile_id, direction, remote_key, local_path, file_size, bytes_transferred, status, target_identity)
         VALUES ($1, $2, 'upload', $3, $4, $5, 0, 'queued', $6)`,
        [taskId, profile.id, key, relative, file.size, identity],
      );

      const job: UploadJob = {
        taskId,
        profileId: profile.id,
        target,
        credentials,
        key,
        prefix,
        file,
        partSize: options.partSize ?? DEFAULT_PART_SIZE,
        concurrency: clampConcurrency(options.concurrency ?? 4),
      };
      await this.dispatch(job, generation);
      taskIds.push(taskId);
    }

    return taskIds;
  }

  /**
   * Queues a resumable download. `destination` decides where bytes land: OPFS
   * staging (handed to the browser on completion) or straight into a local
   * folder for dual-pane mode.
   */
  async enqueueDownload(
    profile: ConnectionRow,
    key: string,
    size: number | null,
    destination: DownloadDestination = { kind: 'staged' },
    localPath: string | null = null,
  ): Promise<string> {
    const generation = this.generation;
    const db = this.requireDb();
    await this.init(db);
    const credentials = await getSealedCredentials(db, profile.id);
    const taskId = crypto.randomUUID();
    const target = profileConfig(profile);
    const identity = await transferTargetIdentity({ ...target, profileId: profile.id, credentials });

    await db.query(
      `INSERT INTO transfer_tasks
         (id, profile_id, direction, remote_key, local_path, file_size, bytes_transferred, status, target_identity)
       VALUES ($1, $2, 'download', $3, $4, $5, 0, 'queued', $6)`,
      [taskId, profile.id, key, localPath, size ?? 0, identity],
    );

    const job: DownloadJob = {
      taskId,
      profileId: profile.id,
      target,
      credentials,
      key,
      expectedSize: size,
      destination,
    };
    if (destination.kind === 'directory') this.directoryTargets.set(taskId, destination);
    await this.dispatch(job, generation);
    return taskId;
  }

  /**
   * Resumes a paused multipart upload. Browsers cannot retain File handles
   * across reloads. The worker verifies the reselected file's content before reusing parts.
   */
  async resumeUpload(profile: ConnectionRow, task: TransferTaskRow, file: File): Promise<void> {
    const generation = this.generation;
    const db = this.requireDb();
    await this.init(db);
    if (file.size !== Number(task.file_size)) {
      throw new Error(
        `File size mismatch: task expects ${task.file_size} bytes, picked ${file.size}`,
      );
    }

    const credentials = await getSealedCredentials(db, profile.id);
    const partsRes = await db.query<{
      part_number: number;
      start_byte: number | string;
      end_byte: number | string;
      etag: string | null;
    }>(
      `SELECT part_number, start_byte, end_byte, etag
         FROM transfer_parts WHERE task_id = $1 AND status = 'completed'
        ORDER BY part_number ASC`,
      [task.id],
    );

    const completedParts: CompletedPart[] = partsRes.rows.map((row) => {
      const startByte = Number(row.start_byte);
      const endByte = Number(row.end_byte);
      return {
        partNumber: Number(row.part_number),
        eTag: row.etag ?? '',
        startByte,
        endByte,
        size: endByte - startByte + 1,
      };
    });

    const job: UploadJob = {
      taskId: task.id,
      profileId: profile.id,
      target: profileConfig(profile),
      credentials,
      key: task.remote_key,
      file,
      partSize: Number(task.part_size) || DEFAULT_PART_SIZE,
      concurrency: 4,
      uploadId: task.upload_id ?? undefined,
      uploadFingerprint: task.upload_fingerprint,
      completedParts,
    };

    await db.query(
      `UPDATE transfer_tasks SET status = 'queued', error_message = NULL, updated_at = NOW()
        WHERE id = $1`,
      [task.id],
    );
    await this.dispatch(job, generation);
  }

  /**
   * Reuses revision-bound staging. After a reload the local folder handle is gone,
   * so the browser download picker receives the finished file.
   */
  async resumeDownload(profile: ConnectionRow, task: TransferTaskRow): Promise<void> {
    const generation = this.generation;
    const db = this.requireDb();
    await this.init(db);
    const credentials = await getSealedCredentials(db, profile.id);

    const job: DownloadJob = {
      taskId: task.id,
      profileId: profile.id,
      target: profileConfig(profile),
      credentials,
      key: task.remote_key,
      expectedSize: Number(task.file_size) || null,
      destination: this.directoryTargets.get(task.id) ?? { kind: 'staged' },
    };

    await db.query(
      `UPDATE transfer_tasks SET status = 'queued', error_message = NULL, updated_at = NOW()
        WHERE id = $1`,
      [task.id],
    );
    await this.dispatch(job, generation);
  }

  pause(taskId: string): void {
    this.post({ type: 'pause', taskId });
  }

  cancel(taskId: string): void {
    this.post({ type: 'cancel', taskId });
  }

  async removeTask(taskId: string): Promise<void> {
    const db = this.requireDb();
    await db.query(`DELETE FROM transfer_tasks WHERE id = $1`, [taskId]);
    this.directoryTargets.delete(taskId);
    if (!this.browserDownloads.has(taskId)) await removeStaging(taskId);
  }

  async clearFinished(): Promise<void> {
    const db = this.requireDb();
    const removed = await db.query<{ id: string }>(
      `DELETE FROM transfer_tasks WHERE status IN ('completed', 'failed') RETURNING id`,
    );
    for (const row of removed.rows) {
      this.directoryTargets.delete(row.id);
      if (!this.browserDownloads.has(row.id)) await removeStaging(row.id);
    }
  }

  private async handleEvent(event: TransferEvent): Promise<void> {
    const generation = this.generation;
    for (const listener of this.listeners) {
      listener(event);
    }

    const db = this.db;
    if (!db || !event.taskId) return;

    switch (event.type) {
      case 'upload-created':
        await db.transaction(async tx => {
          await tx.query('DELETE FROM transfer_parts WHERE task_id = $1', [event.taskId]);
          await tx.query(
            `UPDATE transfer_tasks SET upload_id = $2, upload_fingerprint = $3, part_size = $4,
                bytes_transferred = 0, status = 'transferring', updated_at = NOW() WHERE id = $1`,
            [event.taskId, event.uploadId, event.fingerprint, event.partSize],
          );
        });
        break;

      case 'part-complete':
        await db.query(
          `INSERT INTO transfer_parts (task_id, part_number, start_byte, end_byte, etag, status)
           VALUES ($1, $2, $3, $4, $5, 'completed')
           ON CONFLICT (task_id, part_number)
           DO UPDATE SET etag = EXCLUDED.etag, status = 'completed'`,
          [
            event.taskId,
            event.part.partNumber,
            event.part.startByte,
            event.part.endByte,
            event.part.eTag,
          ],
        );
        break;

      case 'progress': {
        const now = Date.now();
        const last = this.lastProgressWrite.get(event.taskId) ?? 0;
        if (now - last < PROGRESS_WRITE_MS) break;
        this.lastProgressWrite.set(event.taskId, now);
        await db.query(
          `UPDATE transfer_tasks
              SET bytes_transferred = $2, speed_bytes_sec = $3, status = 'transferring',
                  updated_at = NOW()
            WHERE id = $1 AND status IN ('queued', 'transferring', 'paused')`,
          [event.taskId, event.bytesTransferred, event.speedBytesSec],
        );
        break;
      }

      case 'paused':
        await db.query(
          `UPDATE transfer_tasks
              SET status = 'paused', bytes_transferred = $2, speed_bytes_sec = 0, updated_at = NOW()
            WHERE id = $1`,
          [event.taskId, event.bytesTransferred],
        );
        break;

      case 'done': {
        this.directoryTargets.delete(event.taskId);
        await db.query(
          `UPDATE transfer_tasks
              SET status = 'completed', bytes_transferred = $2, speed_bytes_sec = 0,
                  error_message = NULL, updated_at = NOW()
            WHERE id = $1`,
          [event.taskId, event.totalBytes],
        );
        if (event.stagedFile && generation === this.generation) {
          const revoke = triggerFileDownload(event.stagedFile, event.filename ?? 'download', () => {
            this.browserDownloads.delete(event.taskId);
            void removeStaging(event.taskId).catch(error => console.error('Could not release staged download:', error));
          });
          this.browserDownloads.set(event.taskId, revoke);
        }
        this.lastProgressWrite.delete(event.taskId);
        break;
      }

      case 'canceled':
        this.directoryTargets.delete(event.taskId);
        await db.query(
          `UPDATE transfer_tasks
              SET status = 'failed', speed_bytes_sec = 0,
                  error_message = 'Canceled by user', updated_at = NOW()
            WHERE id = $1`,
          [event.taskId],
        );
        break;

      case 'error':
        await db.query(
          `UPDATE transfer_tasks
              SET status = 'failed', speed_bytes_sec = 0, error_message = $2, updated_at = NOW()
            WHERE id = $1`,
          [event.taskId, event.message.slice(0, 500)],
        );
        break;
    }
  }
}

export const transferManager = new TransferManager();
