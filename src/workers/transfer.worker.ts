/// <reference lib="webworker" />
import {
  planParts,
  shouldUseMultipart,
  clampConcurrency,
  computeSpeed,
  DEFAULT_PART_SIZE,
  type PlannedPart,
  type SpeedSample,
} from '../transfer/planner';
import type {
  CompletedPart,
  DownloadJob,
  S3Target,
  SignRequest,
  SignResponse,
  TransferCommand,
  TransferEvent,
  UploadJob,
} from '../transfer/protocol';
import { buildS3Url } from '../s3/url';
import { xmlBlocks, xmlFirst } from '../s3/xml';
import { fetchViaBridge } from '../bridge/transport';

/** Per-part retry policy for transient network failures. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;
const PROGRESS_INTERVAL_MS = 300;
const STAGING_DIR = 'galiot-transfers';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Minimal structural type so we do not depend on lib.dom's sync-access API. */
interface SyncAccessHandle {
  write(buffer: BufferSource, options?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

type SyncCapableFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle?: () => Promise<SyncAccessHandle>;
};

/** Mirrors S3Client.buildUrl so signed URLs match the client's addressing. */
function buildObjectUrl(
  target: S3Target,
  key: string,
  query?: Record<string, string>,
): URL {
  return buildS3Url(
    { endpoint: target.endpoint, bucket: target.bucket, pathStyle: target.pathStyle },
    key,
    query,
  );
}

/** Requests signatures from the vault worker over the shared port. */
class PortSigner {
  private pending = new Map<number, { resolve: (v: SignResponse & { type: 'signed' }) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor(private port: MessagePort) {
    port.onmessage = (event: MessageEvent<SignResponse>) => this.handle(event.data);
    port.start();
  }

  private handle(msg: SignResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.type === 'signed') {
      entry.resolve(msg);
    } else {
      entry.reject(new Error(msg.error));
    }
  }

  sign(
    request: Omit<SignRequest, 'type' | 'id'>,
  ): Promise<SignResponse & { type: 'signed' }> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port.postMessage({ type: 'sign', id, ...request } satisfies SignRequest);
    });
  }
}

/**
 * Byte-addressable write target for a download. Backed by OPFS staging (with
 * sync access handles where available) or by a file inside a user-granted local
 * directory, so a resumed transfer continues from whatever is already on disk.
 */
class DownloadTarget {
  private constructor(
    private readonly handle: FileSystemFileHandle,
    private readonly sync: SyncAccessHandle | null,
    private readonly writable: FileSystemWritableFileStream | null,
    public size: number,
    public readonly staged: boolean,
  ) {}

  static async open(job: DownloadJob): Promise<DownloadTarget> {
    const destination = job.destination;
    let handle: FileSystemFileHandle;

    if (destination.kind === 'directory') {
      handle = await destination.handle.getFileHandle(destination.filename, { create: true });
    } else {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(STAGING_DIR, { create: true });
      handle = await dir.getFileHandle(`download-${job.taskId}`, { create: true });
    }

    const file = await handle.getFile();
    const syncCapable = handle as SyncCapableFileHandle;

    let sync: SyncAccessHandle | null = null;
    let writable: FileSystemWritableFileStream | null = null;

    // Sync access handles are OPFS-only, so local-directory files always use
    // the writable-stream path.
    if (destination.kind === 'staged' && typeof syncCapable.createSyncAccessHandle === 'function') {
      sync = await syncCapable.createSyncAccessHandle();
    } else {
      writable = await handle.createWritable({ keepExistingData: true });
      await writable.seek(file.size);
    }

    return new DownloadTarget(
      handle,
      sync,
      writable,
      file.size,
      destination.kind === 'staged',
    );
  }

  async write(chunk: Uint8Array, offset: number): Promise<void> {
    if (this.sync) {
      // Streamed chunks are typed as Uint8Array<ArrayBufferLike>; OPFS wants a
      // plain BufferSource view. No copy - this is the same underlying buffer.
      this.sync.write(chunk as unknown as BufferSource, { at: offset });
      this.sync.flush();
    } else if (this.writable) {
      await this.writable.seek(offset);
      await this.writable.write(chunk as unknown as FileSystemWriteChunkType);
    }
    this.size = offset + chunk.byteLength;
  }

  async reset(): Promise<void> {
    if (this.sync) this.sync.truncate(0);
    else if (this.writable) await this.writable.truncate(0);
    this.size = 0;
  }

  async close(): Promise<void> {
    if (this.sync) this.sync.close();
    if (this.writable) await this.writable.close();
  }

  /** Flushes and returns a File backed by the target (no full read into RAM). */
  async finish(): Promise<File> {
    await this.close();
    return this.handle.getFile();
  }
}

interface TaskRuntime {
  taskId: string;
  pauseRequested: boolean;
  cancelRequested: boolean;
  controllers: Set<AbortController>;
  bytesTransferred: number;
  speedSamples: SpeedSample[];
  lastProgressAt: number;
}

class TransferEngine {
  private readonly tasks = new Map<string, TaskRuntime>();
  private signer: PortSigner | null = null;

  attachPort(port: MessagePort): void {
    this.signer = new PortSigner(port);
  }

  private runtime(taskId: string): TaskRuntime {
    let rt = this.tasks.get(taskId);
    if (!rt) {
      rt = {
        taskId,
        pauseRequested: false,
        cancelRequested: false,
        controllers: new Set(),
        bytesTransferred: 0,
        speedSamples: [],
        lastProgressAt: 0,
      };
      this.tasks.set(taskId, rt);
    }
    return rt;
  }

  private emit(event: TransferEvent): void {
    postMessage(event);
  }

  private advance(rt: TaskRuntime, bytes: number, force = false): void {
    rt.bytesTransferred += bytes;
    rt.speedSamples.push({ at: Date.now(), bytes: rt.bytesTransferred });
    if (rt.speedSamples.length > 60) rt.speedSamples.shift();

    const now = Date.now();
    if (!force && now - rt.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    rt.lastProgressAt = now;

    this.emit({
      type: 'progress',
      taskId: rt.taskId,
      bytesTransferred: rt.bytesTransferred,
      speedBytesSec: computeSpeed(rt.speedSamples, now),
    });
  }

  private async signedFetch(
    job: UploadJob | DownloadJob,
    method: string,
    url: URL,
    options: { headers?: Record<string, string>; body?: string | Blob; signal?: AbortSignal } = {},
  ): Promise<Response> {
    if (!this.signer) throw new Error('Transfer worker has no signing channel');
    const signed = await this.signer.sign({
      profileId: job.profileId,
      region: job.target.region,
      credentials: job.credentials,
      method,
      url: url.toString(),
      headers: options.headers ?? {},
      // Custom headers ride along so the vault worker can fold them into the
      // signature. A resumed download's Range stays authoritative.
      customHeaders: job.target.headers,
      ...(typeof options.body === 'string' ? { body: options.body } : {}),
    });
    if (job.target.bridgeToken) {
      const signedRequest = new Request(signed.url, {
        method: signed.method,
        headers: signed.headers,
      });
      return fetchViaBridge(signedRequest, job.target.bridgeToken, options.body, options.signal);
    }
    return fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  pause(taskId: string): void {
    const rt = this.tasks.get(taskId);
    if (!rt) return;
    rt.pauseRequested = true;
    for (const controller of rt.controllers) controller.abort();
  }

  cancel(taskId: string): void {
    const rt = this.tasks.get(taskId);
    if (!rt) return;
    rt.cancelRequested = true;
    rt.pauseRequested = true;
    for (const controller of rt.controllers) controller.abort();
  }

  /* ----------------------------- uploads ----------------------------- */

  async upload(job: UploadJob): Promise<void> {
    const rt = this.runtime(job.taskId);
    const file = job.file;

    if (file.size === 0) {
      await this.putObject(rt, job, file, 'text/plain');
      return;
    }

    if (!shouldUseMultipart(file.size)) {
      await this.putObject(rt, job, file, file.type || 'application/octet-stream');
      return;
    }

    const parts = planParts(file.size, job.partSize || DEFAULT_PART_SIZE);
    const done = new Map<number, CompletedPart>();

    if (job.uploadId && job.completedParts) {
      for (const part of job.completedParts) done.set(part.partNumber, part);
      rt.bytesTransferred = [...done.values()].reduce((sum, p) => sum + p.size, 0);
    }

    let uploadId = job.uploadId;

    if (uploadId) {
      // Trust the server over local bookkeeping: only keep parts S3 knows about.
      try {
        const remote = await this.listParts(rt, job, uploadId);
        for (const partNumber of [...done.keys()]) {
          if (!remote.has(partNumber)) done.delete(partNumber);
        }
        rt.bytesTransferred = [...done.values()].reduce((sum, p) => sum + p.size, 0);
      } catch (err) {
        this.emit({
          type: 'error',
          taskId: job.taskId,
          message: `Could not verify existing parts: ${errorText(err)}`,
        });
        return;
      }
    } else {
      uploadId = await this.createMultipart(rt, job);
      this.emit({ type: 'upload-created', taskId: job.taskId, uploadId });
    }

    const queue = parts.filter((part) => !done.has(part.partNumber));
    let cursor = 0;

    const poolWorker = async (): Promise<void> => {
      for (;;) {
        if (rt.pauseRequested || rt.cancelRequested) return;
        const part = queue[cursor];
        cursor += 1;
        if (!part) return;
        await this.uploadPartWithRetry(rt, job, uploadId as string, part, done);
      }
    };

    await Promise.all(
      Array.from({ length: clampConcurrency(job.concurrency) }, () => poolWorker()),
    );

    if (rt.cancelRequested) {
      await this.abortMultipart(rt, job, uploadId).catch(() => undefined);
      this.emit({ type: 'canceled', taskId: job.taskId });
      return;
    }

    if (rt.pauseRequested) {
      this.emit({ type: 'paused', taskId: job.taskId, bytesTransferred: rt.bytesTransferred });
      return;
    }

    const ordered = parts
      .map((part) => done.get(part.partNumber))
      .filter((part): part is CompletedPart => part !== undefined)
      .sort((a, b) => a.partNumber - b.partNumber);

    if (ordered.length !== parts.length) {
      this.emit({
        type: 'error',
        taskId: job.taskId,
        message: `Upload incomplete: ${ordered.length}/${parts.length} parts acknowledged.`,
      });
      return;
    }

    await this.completeMultipart(rt, job, uploadId, ordered);
    this.advance(rt, 0, true);
    this.emit({ type: 'done', taskId: job.taskId, totalBytes: rt.bytesTransferred });
  }

  private async putObject(
    rt: TaskRuntime,
    job: UploadJob,
    body: Blob,
    contentType: string,
  ): Promise<void> {
    const controller = new AbortController();
    rt.controllers.add(controller);
    try {
      const url = buildObjectUrl(job.target, job.key);
      const res = await this.signedFetch(job, 'PUT', url, {
        headers: {
          'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
          'content-type': contentType,
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
      }
      this.advance(rt, body.size, true);
      this.emit({ type: 'done', taskId: job.taskId, totalBytes: rt.bytesTransferred });
    } finally {
      rt.controllers.delete(controller);
    }
  }

  private async uploadPartWithRetry(
    rt: TaskRuntime,
    job: UploadJob,
    uploadId: string,
    part: PlannedPart,
    done: Map<number, CompletedPart>,
  ): Promise<void> {
    const blob = job.file.slice(part.startByte, part.endByte + 1);
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (rt.pauseRequested || rt.cancelRequested) return;

      const controller = new AbortController();
      rt.controllers.add(controller);
      try {
        const url = buildObjectUrl(job.target, job.key, {
          uploadId,
          partNumber: String(part.partNumber),
        });
        const res = await this.signedFetch(job, 'PUT', url, {
          headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
          body: blob,
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }

        const eTag = res.headers.get('etag');
        if (!eTag) {
          throw new Error(
            'Missing ETag response header — add "ETag" to Access-Control-Expose-Headers in the bucket CORS policy',
          );
        }

        const completed: CompletedPart = {
          partNumber: part.partNumber,
          eTag,
          startByte: part.startByte,
          endByte: part.endByte,
          size: part.size,
        };
        done.set(part.partNumber, completed);
        this.advance(rt, part.size);
        this.emit({ type: 'part-complete', taskId: job.taskId, part: completed });
        return;
      } catch (err) {
        if (rt.pauseRequested || rt.cancelRequested) return;
        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          await delay(RETRY_BASE_MS * attempt);
        }
      } finally {
        rt.controllers.delete(controller);
      }
    }

    throw new Error(
      `Part ${part.partNumber}/${Math.max(...done.keys(), 0) || '?'} failed after ${MAX_ATTEMPTS} attempts: ${errorText(lastError)}`,
    );
  }

  private async createMultipart(rt: TaskRuntime, job: UploadJob): Promise<string> {
    const url = buildObjectUrl(job.target, job.key, { uploads: '' });
    const res = await this.signedFetch(job, 'POST', url, { signal: this.track(rt) });
    if (!res.ok) {
      throw new Error(`CreateMultipartUpload failed: ${res.status} ${res.statusText}`);
    }
    const uploadId = xmlFirst(await res.text(), 'UploadId');
    if (!uploadId) throw new Error('Failed to parse UploadId from response');
    return uploadId;
  }

  private async listParts(
    rt: TaskRuntime,
    job: UploadJob,
    uploadId: string,
  ): Promise<Map<number, CompletedPart>> {
    const url = buildObjectUrl(job.target, job.key, { uploadId });
    const res = await this.signedFetch(job, 'GET', url, { signal: this.track(rt) });
    if (!res.ok) {
      throw new Error(`ListParts failed: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    const parts = new Map<number, CompletedPart>();
    for (const block of xmlBlocks(text, 'Part')) {
      const partNumber = parseInt(xmlFirst(block, 'PartNumber') ?? '0', 10);
      const size = parseInt(xmlFirst(block, 'Size') ?? '0', 10);
      const eTag = xmlFirst(block, 'ETag') ?? '';
      if (!partNumber) continue;
      parts.set(partNumber, {
        partNumber,
        eTag,
        size,
        startByte: 0,
        endByte: 0,
      });
    }
    return parts;
  }

  private async completeMultipart(
    rt: TaskRuntime,
    job: UploadJob,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const escapeXml = (value: string): string =>
      value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>` +
      parts
        .map(
          (part) =>
            `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.eTag)}</ETag></Part>`,
        )
        .join('') +
      `</CompleteMultipartUpload>`;

    const url = buildObjectUrl(job.target, job.key, { uploadId });
    const res = await this.signedFetch(job, 'POST', url, {
      headers: { 'content-type': 'application/xml' },
      body: xml,
      signal: this.track(rt),
    });
    if (!res.ok) {
      throw new Error(`CompleteMultipartUpload failed: ${res.status} ${res.statusText}`);
    }
  }

  private async abortMultipart(
    rt: TaskRuntime,
    job: UploadJob,
    uploadId: string,
  ): Promise<void> {
    const url = buildObjectUrl(job.target, job.key, { uploadId });
    await this.signedFetch(job, 'DELETE', url, { signal: this.track(rt) });
  }

  private track(rt: TaskRuntime): AbortSignal {
    const controller = new AbortController();
    rt.controllers.add(controller);
    return controller.signal;
  }

  /* ---------------------------- downloads ---------------------------- */

  async download(job: DownloadJob): Promise<void> {
    const rt = this.runtime(job.taskId);
    const target = await DownloadTarget.open(job);
    let offset = target.size;
    rt.bytesTransferred = offset;

    try {
      if (job.expectedSize !== null && offset > 0 && offset >= job.expectedSize) {
        // Already fully staged from an earlier session.
        const file = await target.finish();
        this.emit({
          type: 'done',
          taskId: job.taskId,
          totalBytes: offset,
          stagedFile: target.staged ? file : undefined,
        });
        return;
      }

      for (;;) {
        if (rt.cancelRequested || rt.pauseRequested) break;

        const headers: Record<string, string> = {};
        if (offset > 0) headers['Range'] = `bytes=${offset}-`;

        const url = buildObjectUrl(job.target, job.key);
        const res = await this.signedFetch(job, 'GET', url, { headers });

        if (offset > 0 && res.status === 200) {
          // Server ignored the range header — restart from zero.
          await target.reset();
          offset = 0;
          rt.bytesTransferred = 0;
          continue;
        }

        if (!res.ok && res.status !== 206) {
          throw new Error(`Download failed: ${res.status} ${res.statusText}`);
        }

        const reader = res.body?.getReader();
        if (!reader) {
          throw new Error('Response body is not streamable');
        }

        let interrupted = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          if (rt.cancelRequested || rt.pauseRequested) {
            await reader.cancel();
            interrupted = true;
            break;
          }

          if (value) {
            await target.write(value, offset);
            offset += value.byteLength;
            this.advance(rt, value.byteLength);
          }
        }
        if (interrupted) break;

        // A short read means the connection dropped — resume with Range.
        if (job.expectedSize !== null && offset < job.expectedSize) continue;
        break;
      }

      if (rt.cancelRequested) {
        this.emit({ type: 'canceled', taskId: job.taskId });
        return;
      }

      if (rt.pauseRequested) {
        this.emit({ type: 'paused', taskId: job.taskId, bytesTransferred: rt.bytesTransferred });
        return;
      }

      if (job.expectedSize !== null && offset !== job.expectedSize) {
        throw new Error(
          `Size mismatch: received ${offset} of ${job.expectedSize} bytes`,
        );
      }

      const file = await target.finish();
      this.emit({
        type: 'done',
        taskId: job.taskId,
        totalBytes: offset,
        stagedFile: target.staged ? file : undefined,
      });
    } catch (err) {
      this.emit({ type: 'error', taskId: job.taskId, message: errorText(err) });
    }
  }

  /** Removes the OPFS staging file after a completed download is handed off. */
  async cleanupStaging(taskId: string): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(STAGING_DIR, { create: true });
      await dir.removeEntry(`download-${taskId}`);
    } catch {
      // Nothing staged (or already removed) — cleanup is best-effort.
    }
  }
}

const engine = new TransferEngine();

addEventListener(
  'message',
  (event: MessageEvent<TransferCommand | { type: 'attach-signing-port'; port: MessagePort }>) => {
    const msg = event.data;
    if (!msg) return;

    if (msg.type === 'attach-signing-port') {
      engine.attachPort(msg.port);
      return;
    }

    switch (msg.type) {
      case 'upload':
        void engine.upload(msg.job).catch((err: unknown) => {
          postMessage({
            type: 'error',
            taskId: msg.job.taskId,
            message: errorText(err),
          } satisfies TransferEvent);
        });
        break;

      case 'download':
        void engine.download(msg.job);
        break;

      case 'pause':
        engine.pause(msg.taskId);
        break;

      case 'cancel':
        engine.cancel(msg.taskId);
        break;

      case 'cleanup-staging':
        void engine.cleanupStaging(msg.taskId);
        break;
    }
  },
);
