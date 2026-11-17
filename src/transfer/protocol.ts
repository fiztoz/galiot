/**
 * Message contracts for the transfer subsystem.
 *
 * Two channels exist:
 * 1. Main thread ↔ transfer worker (TransferCommand / TransferEvent).
 * 2. Transfer worker ↔ vault worker over a shared MessagePort (SessionRequest /
 *    SessionResponse). The transfer worker never sees raw credentials. It asks
 *    the vault worker for a server session id. The self-hosted server signs
 *    and calls S3.
 */

/** Non-secret connection target; credentials are resolved by profileId. */
export interface S3Target {
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  /**
   * Custom headers for this connection, forwarded to the vault worker so they
   * can be folded into the signature. Non-secret by policy — see
   * `src/s3/customHeaders.ts`, which refuses credential-looking names.
   */
  headers?: Record<string, string>;
  /** Retained on the profile shape. The worker always uses the app server. */
  network?: 'server' | 'user';
  /** Gate for a public app server. Tab memory only. */
  proxyToken?: string;
}

export interface CompletedPart {
  partNumber: number;
  eTag: string;
  startByte: number;
  /** Inclusive. */
  endByte: number;
  size: number;
}

export interface UploadJob {
  taskId: string;
  profileId: string;
  target: S3Target;
  /** Sealed (AES-GCM encrypted) credentials — decrypted only inside the vault worker. */
  credentials: import('../vault/crypto').EncryptedPayload;
  key: string;
  file: File;
  partSize: number;
  concurrency: number;
  /** Set when resuming an interrupted multipart upload. */
  uploadId?: string;
  completedParts?: CompletedPart[];
}

/**
 * Where a finished download should land.
 * - `staged`: stream into OPFS staging, then hand a File to the browser.
 * - `directory`: stream straight into a user-granted local folder
 *   (dual-pane mode), resuming from that file's current size.
 */
export type DownloadDestination =
  | { kind: 'staged' }
  | { kind: 'directory'; handle: FileSystemDirectoryHandle; filename: string };

export interface DownloadJob {
  taskId: string;
  profileId: string;
  target: S3Target;
  credentials: import('../vault/crypto').EncryptedPayload;
  key: string;
  /** Used to verify completeness and to resume from the written byte offset. */
  expectedSize: number | null;
  destination: DownloadDestination;
}

export type TransferCommand =
  | { type: 'upload'; job: UploadJob }
  | { type: 'download'; job: DownloadJob }
  | { type: 'pause'; taskId: string }
  | { type: 'cancel'; taskId: string }
  | { type: 'cleanup-staging'; taskId: string };

export type TransferEvent =
  | { type: 'upload-created'; taskId: string; uploadId: string }
  | { type: 'part-complete'; taskId: string; part: CompletedPart }
  | { type: 'progress'; taskId: string; bytesTransferred: number; speedBytesSec: number }
  | { type: 'done'; taskId: string; totalBytes: number; stagedFile?: File }
  | { type: 'paused'; taskId: string; bytesTransferred: number }
  | { type: 'canceled'; taskId: string }
  | { type: 'error'; taskId: string; message: string };

/* ------------------------------------------------------------------ */
/* Vault port (transfer worker → vault worker)                          */
/* ------------------------------------------------------------------ */

export type SessionRequest = {
  type: 'session';
  id: number;
  profileId: string;
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  /** Sealed credentials; decrypted only inside the vault worker. */
  credentials: import('../vault/crypto').EncryptedPayload;
  /** Connection headers. The server screens them again before signing. */
  headers?: Record<string, string>;
  /** Gate for a public Galiot server. Not an S3 key. */
  accessToken?: string;
};

export type SessionResponse =
  | { type: 'session'; id: number; sessionId: string }
  | { type: 'session-error'; id: number; error: string }
  /** Sent when the vault locks: every cached session id is now dead. */
  | { type: 'sessions-closed' };
