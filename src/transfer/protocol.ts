/**
 * Message contracts for the transfer subsystem.
 *
 * Two channels exist:
 * 1. Main thread ↔ transfer worker (TransferCommand / TransferEvent).
 * 2. Transfer worker ↔ vault worker over a shared MessagePort (SignRequest /
 *    SignResponse). The transfer worker never sees raw credentials — it asks
 *    the vault worker to sign each request, which satisfies the "secrets never
 *    reach the main thread" rule and keeps signing in one place.
 */

/** Non-secret connection target; credentials are resolved by profileId. */
export interface S3Target {
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
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

export interface DownloadJob {
  taskId: string;
  profileId: string;
  target: S3Target;
  credentials: import('../vault/crypto').EncryptedPayload;
  key: string;
  /** Used to verify completeness and to resume from the staged OPFS size. */
  expectedSize: number | null;
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

export type SignRequest = {
  type: 'sign';
  id: number;
  profileId: string;
  /** SigV4 region (non-secret, per connection). */
  region: string;
  /** Sealed credentials; only ever decrypted inside the vault worker. */
  credentials: import('../vault/crypto').EncryptedPayload;
  method: string;
  url: string;
  headers: Record<string, string>;
  /**
   * Only for small text bodies (multipart completion XML) that must be hashed
   * into the signature. Binary payloads use `x-amz-content-sha256:
   * UNSIGNED-PAYLOAD` instead so large Blobs are never hashed.
   */
  body?: string;
};

export type SignResponse =
  | {
      type: 'signed';
      id: number;
      url: string;
      method: string;
      headers: Record<string, string>;
    }
  | { type: 'sign-error'; id: number; error: string };
