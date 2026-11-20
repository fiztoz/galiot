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
  SessionRequest,
  SessionResponse,
  TransferCommand,
  TransferEvent,
  UploadJob,
} from '../transfer/protocol';
import { S3_ACCESS_TOKEN_HEADER } from '../server/protocol';
import { removeStaging, TRANSFER_LOCK, uploadFingerprint } from '../transfer/checkpoint';
import { closeServerSession } from '../s3/remote';
import { downloadFile, publishLocal } from '../transfer/download';
import { isSessionExpired, sessionCacheKey } from '../transfer/session';

/** Per-part retry policy for transient network failures. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;
const PROGRESS_INTERVAL_MS = 300;


const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Asks the vault worker for a server session. The secret never arrives here. */
class PortSession {
  private pending = new Map<number, { resolve: (sessionId: string) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor(private port: MessagePort, private onClosed: () => void) {
    port.onmessage = (event: MessageEvent<SessionResponse>) => this.handle(event.data);
    port.start();
  }

  private handle(msg: SessionResponse): void {
    if (msg.type === 'sessions-closed') {
      for (const entry of this.pending.values()) entry.reject(new Error('Transfer session closed'));
      this.pending.clear();
      this.onClosed();
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.type === 'session') entry.resolve(msg.sessionId);
    else entry.reject(new Error(msg.error));
  }

  open(request: Omit<SessionRequest, 'type' | 'id'>): Promise<string> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port.postMessage({ type: 'session', id, ...request } satisfies SessionRequest);
    });
  }
}

interface TaskRuntime {
  taskId: string;
  profileId: string;
  signingKey: string;
  pauseRequested: boolean;
  cancelRequested: boolean;
  uploadId?: string;
  controllers: Set<AbortController>;
  bytesTransferred: number;
  speedSamples: SpeedSample[];
  lastProgressAt: number;
}

export class TransferEngine {
  constructor(
    private readonly send: (event: TransferEvent) => void = event => postMessage(event),
    private readonly fetchObject: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> =
      (input, init) => globalThis.fetch(input, init),
    private readonly storage = globalThis.navigator?.storage,
    private readonly revokeSession = closeServerSession,
  ) {}

  private readonly tasks = new Map<string, TaskRuntime>();
  private sessions: PortSession | null = null;
  private fingerprintQueue: Promise<void> = Promise.resolve();
  private signingKeys = new Map<string, string>();
  private sessionIds = new Map<string, { id: Promise<string>; token?: string }>();

  attachPort(port: MessagePort): void {
    this.sessions = new PortSession(port, () => {
      this.sessionIds.clear();
      this.signingKeys.clear();
      for (const id of this.tasks.keys()) this.pause(id);
    });
  }

  invalidateProfile(profileId: string): void {
    for (const rt of this.tasks.values()) {
      if (rt.profileId === profileId) this.pause(rt.taskId);
    }
    const cached = this.sessionIds.get(profileId);
    if (cached) void cached.id.then(id => this.revokeSession(id, cached.token), () => undefined);
    this.sessionIds.delete(profileId);
    this.signingKeys.delete(profileId);
  }

  async run(job: UploadJob | DownloadJob): Promise<void> {
    if (this.tasks.has(job.taskId)) return;
    const signingKey = sessionCacheKey({ ...job.target, profileId: job.profileId, credentials: job.credentials });
    if (this.signingKeys.has(job.profileId) && this.signingKeys.get(job.profileId) !== signingKey) {
      this.invalidateProfile(job.profileId);
    }
    this.signingKeys.set(job.profileId, signingKey);
    const rt: TaskRuntime = {
      taskId: job.taskId, profileId: job.profileId, signingKey, pauseRequested: false, cancelRequested: false,
      uploadId: 'file' in job ? job.uploadId : undefined,
      controllers: new Set(), bytesTransferred: 0, speedSamples: [], lastProgressAt: 0,
    };
    this.tasks.set(job.taskId, rt);
    const execute = async () => {
      try {
        if (rt.pauseRequested) throw new Error('Transfer interrupted');
        if ('file' in job) await this.upload(rt, job);
        else await this.download(rt, job);
      } catch (error) {
        if (!rt.cancelRequested || !rt.uploadId || !('file' in job)) throw error;
        try {
          await this.abortMultipart(rt, job, rt.uploadId);
        } catch (cleanupError) {
          this.emit({ type: 'error', taskId: job.taskId,
            message: `Upload stopped. S3 did not confirm multipart cleanup: ${errorText(cleanupError)}` });
          return;
        }
        this.emit({ type: 'canceled', taskId: job.taskId });
      }
    };
    try {
      const locks = globalThis.navigator?.locks;
      if (locks) {
        await locks.request(TRANSFER_LOCK, { mode: 'shared', ifAvailable: true }, async lock => {
          if (!lock) throw new Error('The vault is being deleted.');
          await locks.request(`galiot-task-${job.taskId}`, { ifAvailable: true }, async taskLock => {
            if (taskLock) await execute();
          });
        });
      } else await execute();
    } catch (err) {
      if (rt.cancelRequested) this.emit({ type: 'canceled', taskId: rt.taskId });
      else if (rt.pauseRequested) this.emit({ type: 'paused', taskId: rt.taskId, bytesTransferred: rt.bytesTransferred });
      else this.emit({ type: 'error', taskId: rt.taskId, message: errorText(err) });
    } finally {
      this.tasks.delete(rt.taskId);
      if (rt.cancelRequested && !('file' in job)) {
        try {
          await removeStaging(job.taskId, this.storage);
        } catch (error) {
          this.emit({ type: 'error', taskId: rt.taskId, message: errorText(error) });
        }
      }
    }
  }

  private emit(event: TransferEvent): void {
    this.send(event);
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

  private async sessionFor(job: UploadJob | DownloadJob): Promise<string> {
    if (!this.sessions) throw new Error('Transfer worker has no session channel');
    const rt = this.tasks.get(job.taskId);
    if (!rt || rt.signingKey !== this.signingKeys.get(job.profileId)) throw new Error('Connection changed');
    const cached = this.sessionIds.get(job.profileId);
    if (cached) return cached.id;
    const pending = this.sessions.open({
      profileId: job.profileId,
      endpoint: job.target.endpoint,
      region: job.target.region,
      bucket: job.target.bucket,
      pathStyle: job.target.pathStyle,
      credentials: job.credentials,
      headers: job.target.headers,
      accessToken: job.target.proxyToken,
    });
    this.sessionIds.set(job.profileId, { id: pending, token: job.target.proxyToken });
    try {
      return await pending;
    } catch (err) {
      if (this.sessionIds.get(job.profileId)?.id === pending) this.sessionIds.delete(job.profileId);
      throw err;
    }
  }

  private async serverFetch(
    job: UploadJob | DownloadJob,
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: BodyInit | null; signal?: AbortSignal } = {},
  ): Promise<Response> {
    // A cached session can die mid-transfer (vault lock, idle expiry). Reopen
    // once on the server's own expired-session answer; an S3 404 is not that.
    for (let attempt = 0; ; attempt += 1) {
      const sessionId = await this.sessionFor(job);
      options.signal?.throwIfAborted();
      const cached = this.sessionIds.get(job.profileId);
      const headers = new Headers(options.headers);
      if (job.target.proxyToken) headers.set(S3_ACCESS_TOKEN_HEADER, job.target.proxyToken);
      let response: Response;
      try {
        response = await this.fetchObject(`/api/s3/sessions/${sessionId}${path}`, {
          method: options.method ?? 'GET',
          headers,
          body: options.body ?? undefined,
          signal: options.signal,
          cache: 'no-store',
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        throw new Error(
          'Cannot reach the application server. Run `bun run dev` or `bun run server`. S3 is called from that process, so the machine running it must be able to reach the bucket.',
          { cause: error },
        );
      }
      if (attempt === 0 && response.status === 404) {
        const text = await response.clone().text();
        if (isSessionExpired(response.status, text)) {
          if (this.sessionIds.get(job.profileId) === cached) this.sessionIds.delete(job.profileId);
          continue;
        }
      }
      return response;
    }
  }

  private async serverCall<T>(
    job: UploadJob | DownloadJob,
    op: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.serverFetch(job, '/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, ...body }),
      signal,
    });
    const payload = (await response.json()) as { ok?: boolean; result?: T; error?: string };
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `S3 ${op} failed: ${response.status}`);
    }
    return payload.result as T;
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

  private async upload(rt: TaskRuntime, job: UploadJob): Promise<void> {
    const file = job.file;

    if (file.size === 0) {
      await this.putObject(rt, job, file, 'text/plain');
      return;
    }

    if (!shouldUseMultipart(file.size)) {
      await this.putObject(rt, job, file, file.type || 'application/octet-stream');
      return;
    }

    const partSize = job.partSize || DEFAULT_PART_SIZE;
    const fingerprintSignal = this.track(rt);
    // Folder uploads can submit thousands of jobs. Bound the concurrent file reads.
    const hashing = this.fingerprintQueue.then(() => uploadFingerprint(file, fingerprintSignal));
    this.fingerprintQueue = hashing.then(() => undefined, () => undefined);
    const fingerprint = await hashing;
    let uploadId = job.uploadId;
    if (uploadId && job.uploadFingerprint && job.uploadFingerprint !== fingerprint) {
      throw new Error('The selected file differs from the original upload. Re-select the original file.');
    }
    if (uploadId && !job.uploadFingerprint) {
      // Legacy ledgers have no fingerprint. Never reuse bytes of unknown provenance.
      await this.abortMultipart(rt, job, uploadId);
      rt.uploadId = undefined;
      uploadId = undefined;
    }
    const parts = planParts(file.size, partSize);
    const done = new Map<number, CompletedPart>();

    if (uploadId && job.completedParts) {
      for (const part of job.completedParts) done.set(part.partNumber, part);
      rt.bytesTransferred = [...done.values()].reduce((sum, p) => sum + p.size, 0);
    }

    if (uploadId) {
      // Trust the server over local bookkeeping: only keep parts S3 knows about.
      try {
        const remote = await this.listParts(rt, job, uploadId);
        for (const partNumber of [...done.keys()]) {
          const landed = remote.get(partNumber);
          const local = done.get(partNumber)!;
          if (landed?.eTag !== local.eTag || landed?.size !== local.size) done.delete(partNumber);
        }
        rt.bytesTransferred = [...done.values()].reduce((sum, p) => sum + p.size, 0);
      } catch (err) {
        throw new Error(`Could not verify existing parts: ${errorText(err)}`);
      }
    } else {
      uploadId = await this.createMultipart(rt, job);
      rt.uploadId = uploadId;
      this.emit({ type: 'upload-created', taskId: job.taskId, uploadId, fingerprint, partSize });
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

    const results = await Promise.allSettled(
      Array.from({ length: clampConcurrency(job.concurrency) }, () => poolWorker()),
    );
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;

    if (rt.cancelRequested) throw new Error('Transfer canceled');

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
    this.uploadDone(rt, job);
  }

  private uploadDone(rt: TaskRuntime, job: UploadJob): void {
    this.emit({ type: 'done', taskId: job.taskId, totalBytes: rt.bytesTransferred,
      upload: { profileId: job.profileId, bucket: job.target.bucket, key: job.key, prefix: job.prefix } });
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
      const res = await this.serverFetch(job, `/object?key=${encodeURIComponent(job.key)}`, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
      }
      this.advance(rt, body.size, true);
      this.uploadDone(rt, job);
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
        const query = new URLSearchParams({
          key: job.key,
          uploadId,
          partNumber: String(part.partNumber),
        });
        const res = await this.serverFetch(job, `/part?${query}`, {
          method: 'PUT',
          body: blob,
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }

        const eTag = res.headers.get('etag');
        if (!eTag) {
          throw new Error('The S3 server did not return an ETag for this part.');
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

  private async createMultipart(_rt: TaskRuntime, job: UploadJob): Promise<string> {
    if (_rt.pauseRequested) throw new Error('Transfer interrupted');
    // Once initiated, receive the upload ID even if the user clicks Cancel.
    // S3 needs that ID to abort a newly created upload.
    const result = await this.serverCall<{ uploadId: string }>(job, 'createMultipart', {
      key: job.key,
      contentType: job.file.type || undefined,
    });
    if (!result.uploadId) throw new Error('Failed to parse UploadId from response');
    return result.uploadId;
  }

  private async listParts(
    _rt: TaskRuntime,
    job: UploadJob,
    uploadId: string,
  ): Promise<Map<number, CompletedPart>> {
    const result = await this.serverCall<{ parts: { partNumber: number; eTag: string; size: number }[] }>(
      job,
      'listParts',
      { key: job.key, uploadId },
      this.track(_rt),
    );
    const parts = new Map<number, CompletedPart>();
    for (const part of result.parts) {
      if (!part.partNumber) continue;
      parts.set(part.partNumber, {
        partNumber: part.partNumber,
        eTag: part.eTag,
        size: part.size,
        startByte: 0,
        endByte: 0,
      });
    }
    return parts;
  }

  private async completeMultipart(
    _rt: TaskRuntime,
    job: UploadJob,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.serverCall(job, 'completeMultipart', {
      key: job.key,
      uploadId,
      parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.eTag })),
    }, this.track(_rt));
  }

  private async abortMultipart(
    _rt: TaskRuntime,
    job: UploadJob,
    uploadId: string,
  ): Promise<void> {
    await this.serverCall(job, 'abortMultipart', { key: job.key, uploadId }, this.track(_rt, _rt.cancelRequested));
  }

  private track(rt: TaskRuntime, allowCanceledCleanup = false): AbortSignal {
    const controller = new AbortController();
    if (rt.pauseRequested && !allowCanceledCleanup) controller.abort();
    rt.controllers.add(controller);
    return controller.signal;
  }

  /* ---------------------------- downloads ---------------------------- */

  private async download(rt: TaskRuntime, job: DownloadJob): Promise<void> {
    const signal = this.track(rt);
    const file = await downloadFile(job, (method, headers) =>
      this.serverFetch(job, `/object?key=${encodeURIComponent(job.key)}&raw=1`, { method, headers, signal }),
      signal, bytes => this.advance(rt, bytes), () => rt.pauseRequested && !rt.cancelRequested, this.storage);
    signal.throwIfAborted();
    if (job.destination.kind === 'directory') {
      await publishLocal(file, job.destination, signal);
      await removeStaging(job.taskId, this.storage);
    }
    this.emit({ type: 'done', taskId: job.taskId, totalBytes: file.size,
      stagedFile: job.destination.kind === 'staged' ? file : undefined,
      filename: job.key.split('/').pop() || 'download' });
  }
}

const engine = new TransferEngine();

if (typeof self !== 'undefined' && typeof document === 'undefined') addEventListener(
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
      case 'download':
        void engine.run(msg.job);
        break;

      case 'invalidate-profile':
        engine.invalidateProfile(msg.profileId);
        break;

      case 'pause':
        engine.pause(msg.taskId);
        break;

      case 'cancel':
        engine.cancel(msg.taskId);
        break;

    }
  },
);
