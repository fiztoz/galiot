import type { AppDB, ConnectionRow } from '../db/client';
import { profileConfig } from '../db/objects';
import { getSealedCredentials } from '../vault/repository';
import { vaultService } from '../vault/vaultService';
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
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface UploadOptions {
  partSize?: number;
  concurrency?: number;
}

type Listener = (event: TransferEvent) => void;

/** Progress writes are throttled so the DB is not hammered by chunk events. */
const PROGRESS_WRITE_MS = 400;

function triggerFileDownload(file: File, filename: string): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
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

  /** Spawns the transfer worker and wires the worker↔worker signing port. */
  init(db: AppDB): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.db = db;
    this.initPromise = (async () => {
      const worker = new Worker(new URL('../workers/transfer.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.addEventListener('message', (event: MessageEvent<TransferEvent>) => {
        void this.handleEvent(event.data);
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
      await db.query(
        `UPDATE transfer_tasks
            SET status = 'paused', speed_bytes_sec = 0, updated_at = NOW()
          WHERE status IN ('queued', 'transferring')`,
      );
    })();

    this.initPromise.catch(() => {
      this.initPromise = null;
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

  private post(command: TransferCommand): void {
    this.worker?.postMessage(command);
  }

  /** Queues local files for upload into `prefix` of the given connection. */
  async enqueueUploads(
    profile: ConnectionRow,
    prefix: string,
    files: File[],
    options: UploadOptions = {},
  ): Promise<string[]> {
    if (files.length === 0) return [];
    const db = this.requireDb();
    const credentials = await getSealedCredentials(db, profile.id);
    const taskIds: string[] = [];

    for (const file of files) {
      const key = `${prefix}${file.name}`;
      const taskId = crypto.randomUUID();

      await db.query(
        `INSERT INTO transfer_tasks
           (id, profile_id, direction, remote_key, local_path, file_size, bytes_transferred, status)
         VALUES ($1, $2, 'upload', $3, $4, $5, 0, 'queued')`,
        [taskId, profile.id, key, file.name, file.size],
      );

      const job: UploadJob = {
        taskId,
        profileId: profile.id,
        target: profileConfig(profile),
        credentials,
        key,
        file,
        partSize: options.partSize ?? DEFAULT_PART_SIZE,
        concurrency: clampConcurrency(options.concurrency ?? 4),
      };
      this.post({ type: 'upload', job });
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
    const db = this.requireDb();
    const credentials = await getSealedCredentials(db, profile.id);
    const taskId = crypto.randomUUID();

    await db.query(
      `INSERT INTO transfer_tasks
         (id, profile_id, direction, remote_key, local_path, file_size, bytes_transferred, status)
       VALUES ($1, $2, 'download', $3, $4, $5, 0, 'queued')`,
      [taskId, profile.id, key, localPath, size ?? 0],
    );

    const job: DownloadJob = {
      taskId,
      profileId: profile.id,
      target: profileConfig(profile),
      credentials,
      key,
      expectedSize: size,
      destination,
    };
    this.post({ type: 'download', job });
    return taskId;
  }

  /**
   * Resumes a paused multipart upload. Browsers cannot retain File handles
   * across reloads, so the user re-picks the file; we verify the size before
   * reusing the existing upload id and part ledger.
   */
  async resumeUpload(profile: ConnectionRow, task: TransferTaskRow, file: File): Promise<void> {
    const db = this.requireDb();
    if (file.size !== Number(task.file_size)) {
      throw new Error(
        `File size mismatch: task expects ${task.file_size} bytes, picked ${file.size}`,
      );
    }
    if (!task.upload_id) {
      throw new Error('This transfer has no resumable upload id');
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
      partSize: DEFAULT_PART_SIZE,
      concurrency: 4,
      uploadId: task.upload_id,
      completedParts,
    };

    await db.query(
      `UPDATE transfer_tasks SET status = 'queued', error_message = NULL, updated_at = NOW()
        WHERE id = $1`,
      [task.id],
    );
    this.post({ type: 'upload', job });
  }

  /**
   * Restarts a paused download; the worker resumes from the target's current
   * byte offset. Resumes from the drawer always target OPFS staging, since the
   * local-folder handle from a previous session is not retained.
   */
  async resumeDownload(profile: ConnectionRow, task: TransferTaskRow): Promise<void> {
    const db = this.requireDb();
    const credentials = await getSealedCredentials(db, profile.id);

    const job: DownloadJob = {
      taskId: task.id,
      profileId: profile.id,
      target: profileConfig(profile),
      credentials,
      key: task.remote_key,
      expectedSize: Number(task.file_size) || null,
      destination: { kind: 'staged' },
    };

    await db.query(
      `UPDATE transfer_tasks SET status = 'queued', error_message = NULL, updated_at = NOW()
        WHERE id = $1`,
      [task.id],
    );
    this.post({ type: 'download', job });
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
    this.post({ type: 'cleanup-staging', taskId });
  }

  async clearFinished(): Promise<void> {
    const db = this.requireDb();
    await db.query(
      `DELETE FROM transfer_tasks WHERE status IN ('completed', 'failed')`,
    );
  }

  private async handleEvent(event: TransferEvent): Promise<void> {
    for (const listener of this.listeners) {
      listener(event);
    }

    const db = this.db;
    if (!db || !event.taskId) return;

    switch (event.type) {
      case 'upload-created':
        await db.query(
          `UPDATE transfer_tasks
              SET upload_id = $2, status = 'transferring', updated_at = NOW()
            WHERE id = $1`,
          [event.taskId, event.uploadId],
        );
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
        await db.query(
          `UPDATE transfer_tasks
              SET status = 'completed', bytes_transferred = $2, speed_bytes_sec = 0,
                  error_message = NULL, updated_at = NOW()
            WHERE id = $1`,
          [event.taskId, event.totalBytes],
        );
        if (event.stagedFile) {
          triggerFileDownload(event.stagedFile, event.stagedFile.name);
          this.post({ type: 'cleanup-staging', taskId: event.taskId });
        }
        this.lastProgressWrite.delete(event.taskId);
        break;
      }

      case 'canceled':
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
