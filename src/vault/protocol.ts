import type { EncryptedPayload } from './crypto';
import type { BucketSearchResult, CorsConfiguration, ListObjectsResult, ObjectMeta, VersionListResult } from '../s3/client';
import type { GaleonImportPrepareResult, GaleonImportPreview } from './galeonImport';

/**
 * Shared message protocol between the main thread and the vault worker.
 *
 * Security invariants enforced by this protocol:
 * - The DEK never leaves the vault worker.
 * - Decrypted credentials never reach the main thread. S3 operations are
 *   executed by the self-hosted server. The worker sends credentials to that
 *   same-origin server once per session, and only results come back here.
 * - The only secret-bearing payloads that cross into the main thread are
 *   *plaintext credentials typed into the connection dialog* (sent once for
 *   encryption / connection testing) and *ciphertext* read from PGlite.
 */

export const VAULT_CHANNEL = 'galiot' as const;
export const VAULT_RESPONSE_CHANNEL = 'galiot:resp' as const;
export const VAULT_EVENT_CHANNEL = 'galiot:event' as const;

export interface CredentialPlaintext {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Non-secret connection settings required to build an S3 client. */
export interface S3ProfileConfig {
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  /**
   * Extra headers to send on every signed request to this connection. Names are
   * already lowercased and screened by `src/s3/customHeaders.ts`.
   *
   * Deliberately *not* applied to presigned URLs: a presigned URL is meant to
   * work for whoever receives it, and they have no way to add these headers. A
   * gateway that hard-requires one therefore cannot serve presigned traffic —
   * see `src/s3/presign.ts`.
   */
  headers?: Record<string, string>;
  /**
   * Retained on the profile shape. Routing ignores it: signed requests always
   * go through the app server.
   */
  network?: 'server' | 'user';
  /** Gate for a public app server. Tab memory only; not an S3 key. */
  proxyToken?: string;
}

/** Credentials either as user-typed plaintext or as vault ciphertext. */
export type Credentials =
  | { plain: CredentialPlaintext }
  | { sealed: EncryptedPayload };

export interface CreateVaultResult {
  /** base64 salt used to derive the KEK */
  salt: string;
  /** base64 AES-KW wrapped DEK */
  wrappedDek: string;
}

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
  /** number of keys visible in the first page of the listing */
  objectCount?: number;
  commonPrefixes?: string[];
}

export interface PresignResult {
  url: string;
}

export interface CorsResult {
  allowed: boolean;
  methods: string[];
}

/**
 * Outcome of writing a bucket CORS policy.
 *
 * `unsupported` is the case that matters: MinIO (and other servers that expose
 * no per-bucket CORS API) answer `501 NotImplemented`, which is not a
 * permissions problem and cannot be fixed by retrying with different
 * credentials.
 */
export interface CorsPutResult {
  applied: boolean;
  error?: string;
  /** HTTP status, when the request reached the server. */
  status?: number;
  /** The server's own error code, e.g. NotImplemented, AccessDenied. */
  code?: string;
  /** True when the endpoint does not implement the bucket-CORS API. */
  unsupported?: boolean;
}

export interface FolderStatsResult {
  /** Every directory key in the subtree (including nested levels). */
  directories: string[];
  /** Every file in the subtree. */
  files: {
    key: string;
    size: number;
    lastModified: string;
    eTag: string;
    storageClass: string | null;
  }[];
  /** True when the entry cap stopped the walk before the subtree was complete. */
  truncated: boolean;
  entryCount: number;
}

export type VaultMethod =
  | 'vault.create'
  | 'vault.unlock'
  | 'vault.lock'
  | 'vault.status'
  | 'vault.verify'
  | 'vault.attachTransferPort'
  | 'creds.encrypt'
  | 's3.test'
  | 's3.probe'
  | 's3.cors.get'
  | 's3.cors.put'
  | 's3.cors.presign'
  | 's3.cors.delete'
  | 's3.list'
  | 's3.delete'
  | 's3.folderStats'
  | 's3.getText'
  | 's3.putText'
  | 's3.presignGet'
  | 's3.presignPut'
  | 's3.mediaUrl'
  | 's3.head'
  | 's3.createFolder'
  | 's3.copy'
  | 's3.rename'
  | 's3.shareLink'
  | 's3.shareWrite'
  | 's3.listBuckets'
  | 's3.listVersions'
  | 's3.deleteVersion'
  | 's3.restoreVersion'
  | 's3.versionUrl'
  | 's3.search'
  | 's3.listTree'
  | 's3.restore'
  | 'galeon.preview'
  | 'galeon.prepare';

export interface VaultRequest<M extends VaultMethod = VaultMethod> {
  channel: typeof VAULT_CHANNEL;
  id: number;
  method: M;
  params: VaultParams[M];
}

export interface VaultParams {
  'vault.create': { passphrase: string };
  'vault.unlock': { passphrase: string; salt: string; wrappedDek: string };
  'vault.lock': undefined;
  'vault.status': undefined;
  'vault.verify': { passphrase: string; salt: string; wrappedDek: string };
  'vault.attachTransferPort': { port: MessagePort };
  'creds.encrypt': { credentials: CredentialPlaintext };
  's3.test': { profile: S3ProfileConfig; credentials: Credentials };
  /** CORS-free reachability probe so failures can be classified. */
  's3.probe': { profile: S3ProfileConfig };
  's3.cors.get': { profile: S3ProfileConfig; credentials: Credentials };
  's3.cors.put': {
    profile: S3ProfileConfig;
    credentials: Credentials;
    config: CorsConfiguration;
  };
  /**
   * Presigns PutBucketCors so the user can apply the policy with curl, which
   * needs no S3 tooling, no configuration, and is not subject to CORS.
   */
  's3.cors.presign': { profile: S3ProfileConfig; credentials: Credentials; expiresIn?: number };
  's3.cors.delete': { profile: S3ProfileConfig; credentials: Credentials };
  's3.list': {
    profile: S3ProfileConfig;
    credentials: Credentials;
    prefix: string;
    delimiter?: string;
    maxKeys?: number;
    continuationToken?: string;
  };
  's3.delete': { profile: S3ProfileConfig; credentials: Credentials; keys: string[] };
  's3.folderStats': {
    profile: S3ProfileConfig;
    credentials: Credentials;
    rootKey: string;
    maxEntries?: number;
  };
  /** Fetches a text object for the in-browser editor (size-capped). */
  's3.getText': { profile: S3ProfileConfig; credentials: Credentials; key: string; maxBytes?: number };
  /** Writes editor content back to the bucket. */
  's3.putText': {
    profile: S3ProfileConfig;
    credentials: Credentials;
    key: string;
    body: string;
    contentType: string;
  };
  's3.presignGet': {
    profile: S3ProfileConfig;
    credentials: Credentials;
    key: string;
    expiresIn?: number;
  };
  's3.presignPut': {
    profile: S3ProfileConfig;
    credentials: Credentials;
    key: string;
    contentType?: string;
    expiresIn?: number;
  };
  /** Same-origin preview URL. The browser does not need a route to S3. */
  's3.mediaUrl': {
    profile: S3ProfileConfig;
    credentials: Credentials;
    key: string;
  };
  's3.head': { profile: S3ProfileConfig; credentials: Credentials; key: string };
  's3.createFolder': { profile: S3ProfileConfig; credentials: Credentials; key: string };
  's3.copy': { profile: S3ProfileConfig; credentials: Credentials; sourceKey: string; destKey: string };
  's3.rename': { profile: S3ProfileConfig; credentials: Credentials; sourceKey: string; destKey: string };
  /** Server-streamed share link. Relative URL; the caller makes it absolute. */
  's3.shareLink': { profile: S3ProfileConfig; credentials: Credentials; key: string; expiresIn: number };
  's3.shareWrite': { profile: S3ProfileConfig; credentials: Credentials; key: string; expiresIn: number; maxBytes: number };
  's3.listBuckets': { profile: S3ProfileConfig; credentials: Credentials };
  's3.listVersions': { profile: S3ProfileConfig; credentials: Credentials; key: string };
  's3.deleteVersion': { profile: S3ProfileConfig; credentials: Credentials; key: string; versionId: string };
  's3.restoreVersion': { profile: S3ProfileConfig; credentials: Credentials; key: string; versionId: string };
  /** Same-origin media URL for one version, so old versions download through the server. */
  's3.versionUrl': { profile: S3ProfileConfig; credentials: Credentials; key: string; versionId: string };
  's3.search': { profile: S3ProfileConfig; credentials: Credentials; query: string; prefix?: string };
  's3.listTree': { profile: S3ProfileConfig; credentials: Credentials; prefix: string };
  's3.restore': { profile: S3ProfileConfig; credentials: Credentials; key: string; days: number };
  /**
   * Parses a Galeon profile export inside the worker and returns a preview with
   * no credential material in it. `text` is the raw file the user picked.
   */
  'galeon.preview': { text: string };
  /**
   * Encrypts each importable Galeon profile's credentials and returns rows that
   * are ready to insert. `expectedHash` is the preview's content hash, so a
   * file swapped between preview and confirm is rejected instead of imported.
   */
  'galeon.prepare': { text: string; expectedHash: string };
}

export type VaultResults = {
  'vault.create': CreateVaultResult;
  'vault.unlock': { unlocked: true };
  'vault.lock': { locked: true };
  'vault.status': { unlocked: boolean };
  'vault.verify': { valid: boolean };
  'vault.attachTransferPort': { attached: true };
  'creds.encrypt': { payload: EncryptedPayload };
  's3.test': TestConnectionResult;
  's3.probe': {
    reachable: boolean;
    url: string;
    error?: string;
    /** Whether the *other* addressing form answered, when this one did not. */
    alternateReachable?: boolean;
    alternateUrl?: string;
  };
  's3.cors.get': CorsConfiguration;
  's3.cors.put': CorsPutResult;
  's3.cors.presign': { url: string; expiresIn: number };
  's3.cors.delete': { deleted: true };
  's3.list': ListObjectsResult;
  's3.delete': { deleted: string[]; errors: { key: string; code: string; message: string }[] };
  's3.folderStats': FolderStatsResult;
  's3.getText': { text: string; size: number; contentType: string | null; eTag: string | null };
  's3.putText': { eTag: string };
  's3.presignGet': PresignResult;
  's3.presignPut': PresignResult;
  's3.mediaUrl': { url: string };
  's3.head': ObjectMeta;
  's3.createFolder': { created: boolean };
  's3.copy': { copied: number };
  's3.rename': { moved: number };
  's3.shareLink': { url: string; expiresIn: number };
  's3.shareWrite': { url: string; expiresIn: number; maxBytes: number };
  's3.listBuckets': { buckets: string[] };
  's3.listVersions': VersionListResult;
  's3.deleteVersion': { deleted: boolean };
  's3.restoreVersion': { restored: boolean };
  's3.versionUrl': { url: string };
  's3.search': BucketSearchResult;
  's3.listTree': { objects: { key: string; size: number; storageClass: string | null }[] };
  's3.restore': { requested: boolean };
  'galeon.preview': GaleonImportPreview;
  'galeon.prepare': GaleonImportPrepareResult;
};

export type VaultResponse<M extends VaultMethod = VaultMethod> =
  | { channel: typeof VAULT_RESPONSE_CHANNEL; id: number; ok: true; result: VaultResults[M] }
  | { channel: typeof VAULT_RESPONSE_CHANNEL; id: number; ok: false; error: string };

export type VaultLockReason = 'manual' | 'inactivity';

export type VaultEvent = {
  channel: typeof VAULT_EVENT_CHANNEL;
  event: 'locked';
  reason: VaultLockReason;
};

export type VaultWorkerMessage = VaultRequest | VaultResponse | VaultEvent;

export function isVaultResponse(msg: unknown): msg is VaultResponse {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { channel?: unknown }).channel === VAULT_RESPONSE_CHANNEL
  );
}

export function isVaultEvent(msg: unknown): msg is VaultEvent {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { channel?: unknown }).channel === VAULT_EVENT_CHANNEL
  );
}
