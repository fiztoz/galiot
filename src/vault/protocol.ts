import type { EncryptedPayload } from './crypto';
import type { ListObjectsResult } from '../s3/client';

/**
 * Shared message protocol between the main thread and the vault worker.
 *
 * Security invariants enforced by this protocol:
 * - The DEK never leaves the vault worker.
 * - Decrypted credentials never leave the vault worker: S3 operations are
 *   executed inside the worker and only results come back.
 * - The only secret-bearing payloads that cross the boundary are *plaintext
 *   credentials typed into the connection dialog* (sent once for encryption /
   connection testing) and *ciphertext* read from PGlite.
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
  | 's3.cors'
  | 's3.list'
  | 's3.delete'
  | 's3.folderStats'
  | 's3.getText'
  | 's3.putText'
  | 's3.presignGet';

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
  's3.cors': { profile: S3ProfileConfig; method?: string };
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
  's3.cors': CorsResult;
  's3.list': ListObjectsResult;
  's3.delete': { deleted: string[]; errors: { key: string; code: string; message: string }[] };
  's3.folderStats': FolderStatsResult;
  's3.getText': { text: string; size: number; contentType: string | null; eTag: string | null };
  's3.putText': { eTag: string };
  's3.presignGet': PresignResult;
};

export type VaultResponse<M extends VaultMethod = VaultMethod> =
  | { channel: typeof VAULT_RESPONSE_CHANNEL; id: number; ok: true; result: VaultResults[M] }
  | { channel: typeof VAULT_RESPONSE_CHANNEL; id: number; ok: false; error: string };

export type VaultEvent = {
  channel: typeof VAULT_EVENT_CHANNEL;
  event: 'locked';
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
