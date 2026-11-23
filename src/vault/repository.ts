import { transferManager } from '../transfer/manager';
import type { AppDB } from '../db/client';

import type { EncryptedPayload } from './crypto';
import type { CredentialPlaintext } from './protocol';
import { vaultService } from './vaultService';
import { SCHEMA_VERSION } from '../db/migrations';
import { assertSafeCustomHeaders, parseStoredHeaders } from '../s3/customHeaders';
import { assertConnectionEndpoint } from '../s3/endpoint';


const META_SALT = 'salt';
const META_WRAPPED_DEK = 'wrapped_dek';

/** The JSONB text to store for a header map, or null for "no custom headers". */
function headersColumnValue(headers: Record<string, string>): string | null {
  return Object.keys(headers).length > 0 ? JSON.stringify(headers) : null;
}

export interface VaultMeta {
  salt: string;
  wrappedDek: string;
  generation: string;
}

type VaultQuery = Pick<AppDB, 'query'>;

/** Older vaults used only the two key-material rows. Their wrapped DEK is a stable identity. */
export async function readVaultMeta(db: VaultQuery): Promise<VaultMeta | null> {
  const { rows } = await db.query<{ key: string; value: string }>(
    "SELECT key, value FROM _meta WHERE key IN ('salt', 'wrapped_dek', 'vault_generation')",
  );
  if (rows.length === 0) return null;
  const meta = new Map(rows.map(row => [row.key, row.value]));
  const salt = meta.get(META_SALT);
  const wrappedDek = meta.get(META_WRAPPED_DEK);
  if (!salt || !wrappedDek) throw new Error('Vault key material is incomplete. Restore from a backup.');
  return { salt, wrappedDek, generation: meta.get('vault_generation') ?? wrappedDek };
}

export async function requireGeneration(tx: VaultQuery, expected: string | null): Promise<void> {
  const meta = await readVaultMeta(tx);
  if (!expected || meta?.generation !== expected) throw new Error('Vault changed. Unlock the current vault and retry.');
}

export async function vaultExists(db: AppDB): Promise<boolean> {
  return (await readVaultMeta(db)) !== null;
}

/** Serialize destructive transitions across tabs before touching the transfer staging tree. */
export async function withCurrentVault<T>(db: AppDB, generation: string, action: () => Promise<T>): Promise<T> {
  const run = async () => {
    await requireGeneration(db, generation);
    if ((await vaultService.call('vault.status')).generation !== generation) {
      throw new Error('Vault locked. Unlock the current vault and retry.');
    }
    return action();
  };
  return navigator.locks ? navigator.locks.request('galiot-vault-replacement', run) : run();
}

export async function createVault(db: AppDB, passphrase: string): Promise<void> {
  const generation = crypto.randomUUID();
  let generated = false;
  try {
    await db.transaction(async tx => {
      if (await readVaultMeta(tx)) throw new Error('A vault already exists. Unlock it to continue.');
      const sealed = await vaultService.call('vault.create', { passphrase, generation });
      generated = true;
      await tx.query(
        "INSERT INTO _meta (key, value) VALUES ('salt', $1), ('wrapped_dek', $2), ('vault_generation', $3)",
        [sealed.salt, sealed.wrappedDek, generation],
      );
    });
  } catch (error) {
    if (generated) await vaultService.call('vault.invalidate', { generation });
    throw error;
  }
}

export async function unlockVault(db: AppDB, passphrase: string): Promise<void> {
  await db.transaction(async tx => {
    const meta = await readVaultMeta(tx);
    if (!meta) throw new Error('Vault not found');
    await vaultService.call('vault.unlock', { passphrase, ...meta });
  });
}

export async function lockVault(): Promise<void> {
  await vaultService.call('vault.lock');
}

/**
 * Empties every table while keeping the schema in place.
 *
 * Split from `deleteVault` so the data wipe is testable without a worker: the
 * worker only owns the DEK, never the rows.
 */
export async function wipeVaultData(db: AppDB, expectedGeneration?: string): Promise<void> {
  await db.transaction(async (tx) => {
    if (expectedGeneration !== undefined) {
      await requireGeneration(tx, expectedGeneration);
      await vaultService.call('vault.invalidate', { generation: expectedGeneration });
    }
    // Child rows first so this stays correct even if a foreign key is missing
    // in an older database file.
    await tx.exec(
      `DELETE FROM transfer_parts;
       DELETE FROM transfer_tasks;
       DELETE FROM presigned_history;
       DELETE FROM objects_cache;
       DELETE FROM profiles;
       DELETE FROM _meta;`,
    );
    // Migrations key off table existence, but keep the marker tidy.
    await tx.query(`INSERT INTO _meta (key, value) VALUES ('schema_version', $1)`, [
      String(SCHEMA_VERSION),
    ]);
  });
}

/**
 * Irreversibly destroys the vault: drops the DEK in the worker and erases every
 * stored connection, cached object, transfer and generated link.
 *
 * Exported vault backups are unaffected — they are files the user already has.
 */
export async function deleteVault(db: AppDB): Promise<void> {
  const { generation } = await vaultService.call('vault.status');
  if (!generation) throw new Error('Unlock the vault before deleting it');
  await withCurrentVault(db, generation, async () => {
    await transferManager.withVaultDeletion(() => wipeVaultData(db, generation));
    vaultService.notifyReplacement(generation, true);
  });
}

export async function readVaultState(db: AppDB): Promise<'create' | 'unlock' | 'unlocked'> {
  return db.transaction(async tx => {
    const meta = await readVaultMeta(tx);
    const status = await vaultService.call('vault.status');
    if (status.unlocked && meta && status.generation === meta.generation) return 'unlocked';
    if (status.generation) await vaultService.call('vault.invalidate', { generation: status.generation });
    return meta ? 'unlock' : 'create';
  });
}

export interface ConnectionInput {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  verifyEditorWrites?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Extra headers for every request. Re-validated here, not just in the UI. */
  customHeaders?: Record<string, string>;
}

/**
 * Encrypts the credentials in the vault worker, then persists the ciphertext
 * as a `profiles` row. The plaintext is never stored.
 */
export async function createConnection(db: AppDB, input: ConnectionInput): Promise<string> {
  assertConnectionEndpoint(input.endpoint);
  const { payload, generation } = await vaultService.call('creds.encrypt', {
    credentials: {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      sessionToken: input.sessionToken || undefined,
    },
  });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // The dialog validates too, but this is the last gate before cleartext reaches
  // the database, and the repository is reachable from code paths that are not
  // the dialog.
  const headers = assertSafeCustomHeaders(input.customHeaders);

  await db.transaction(async tx => {
    await requireGeneration(tx, generation);
    await tx.query(
      `INSERT INTO profiles
         (id, name, protocol, endpoint, region, bucket, path_style, network, encrypted_credentials, custom_headers, verify_editor_writes, created_at, updated_at)
       VALUES ($1, $2, 's3', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        input.name,
        input.endpoint,
        input.region,
        input.bucket,
        input.pathStyle,
        'server',
        JSON.stringify(payload),
        headersColumnValue(headers),
        input.verifyEditorWrites === true,
        now,
        now,
      ],
    );
  });

  return id;
}

/**
 * Deletes a connection; `objects_cache` and transfer rows cascade with the
 * foreign key. Incomplete uploads are cancelled on S3 first, while the sealed
 * credentials still exist. Returns the uploads that could not be cancelled.
 */
export async function deleteConnection(db: AppDB, id: string): Promise<string[]> {
  const { generation } = await vaultService.call('vault.status');
  const leftovers = await transferManager.discardProfileUploads(db, id);
  await db.transaction(async tx => {
    await requireGeneration(tx, generation);
    await tx.query('DELETE FROM profiles WHERE id = $1', [id]);
  });
  transferManager.invalidateProfile(id);
  return leftovers;
}

export interface ConnectionUpdate {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  verifyEditorWrites?: boolean;
  /**
   * New credentials. Omit to keep the sealed ones already in the vault, which
   * is what lets a user rename or re-point a connection without retyping keys
   * — and without the secret ever being decrypted on the main thread.
   */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /**
   * Replacement custom headers. Omit to keep the stored ones; pass `{}` to clear
   * them. Validated the same way as on create.
   */
  customHeaders?: Record<string, string>;
}

export interface ConnectionUpdateResult {
  /** True when the cached listing was dropped because credentials or the target changed. */
  clearedCache: boolean;
}

/**
 * Updates a connection in place.
 *
 * The cached listing is dropped if credentials are replaced or the target changes (endpoint,
 * region, bucket, addressing or custom headers): those rows were fetched from a
 * different bucket, or through a gateway that a header now routes differently,
 * and leaving them would let a later switch back to the old name show stale
 * contents. A rename keeps the cache, because nothing about the target moved.
 *
 * Presigned history is deliberately kept: those URLs are bearer tokens that
 * stay valid until they expire and cannot be revoked, so deleting the record
 * would only remove the user's copy of a link that still works.
 */
export async function updateConnection(
  db: AppDB,
  id: string,
  input: ConnectionUpdate,
): Promise<ConnectionUpdateResult> {
  assertConnectionEndpoint(input.endpoint);
  // Sealed in the worker, as on create; the plaintext goes no further.
  const sealed = input.credentials
    ? await vaultService.call('creds.encrypt', {
        credentials: {
          accessKeyId: input.credentials.accessKeyId,
          secretAccessKey: input.credentials.secretAccessKey,
          sessionToken: input.credentials.sessionToken || undefined,
        },
      })
    : null;
  const generation = sealed?.generation ?? (await vaultService.call('vault.status')).generation;

  const now = new Date().toISOString();

  const clearedCache = await db.transaction(async (tx) => {
    await requireGeneration(tx, generation);
    const existing = await tx.query<{
      endpoint: string;
      region: string;
      bucket: string;
      path_style: boolean;
      custom_headers: unknown;
    }>('SELECT endpoint, region, bucket, path_style, custom_headers FROM profiles WHERE id = $1', [
      id,
    ]);

    const current = existing.rows[0];
    if (!current) throw new Error('Connection not found');

    const nextNetwork = 'server';
    const storedHeaders = parseStoredHeaders(current.custom_headers);
    const nextHeaders =
      input.customHeaders === undefined ? storedHeaders : assertSafeCustomHeaders(input.customHeaders);
    const headersJson = headersColumnValue(nextHeaders);

    const targetChanged =
      current.endpoint !== input.endpoint ||
      current.region !== input.region ||
      current.bucket !== input.bucket ||
      current.path_style !== input.pathStyle ||
      headersJson !== headersColumnValue(storedHeaders);
    if (sealed) {
      await tx.query(
        `UPDATE profiles
            SET name = $1, endpoint = $2, region = $3, bucket = $4, path_style = $5,
                network = $6, encrypted_credentials = $7, custom_headers = $8,
                verify_editor_writes = COALESCE($9, verify_editor_writes), updated_at = $10
          WHERE id = $11`,
        [
          input.name,
          input.endpoint,
          input.region,
          input.bucket,
          input.pathStyle,
          nextNetwork,
          JSON.stringify(sealed.payload),
          headersJson,
          input.verifyEditorWrites ?? null,
          now,
          id,
        ],
      );
    } else {
      await tx.query(
        `UPDATE profiles
            SET name = $1, endpoint = $2, region = $3, bucket = $4, path_style = $5,
                network = $6, custom_headers = $7,
                verify_editor_writes = COALESCE($8, verify_editor_writes), updated_at = $9
          WHERE id = $10`,
        [
          input.name,
          input.endpoint,
          input.region,
          input.bucket,
          input.pathStyle,
          nextNetwork,
          headersJson,
          input.verifyEditorWrites ?? null,
          now,
          id,
        ],
      );
    }

    const invalidate = targetChanged || sealed !== null;
    if (invalidate) await tx.query('DELETE FROM objects_cache WHERE profile_id = $1', [id]);
    return invalidate;
  });

  if (clearedCache) {
    transferManager.invalidateProfile(id);
  }
  return { clearedCache };
}

/**
 * Inserts connections whose credentials were already sealed by the vault
 * worker (used by the Galeon import, where the file's plaintext keys are
 * encrypted worker-side and never reach the main thread).
 *
 * One transaction: a partial import is worse than none, because the user would
 * not know which half landed.
 */
export async function insertSealedConnections(
  db: AppDB,
  rows: {
    id: string;
    name: string;
    endpoint: string;
    region: string;
    bucket: string;
    pathStyle: boolean;
    encryptedCredentials: EncryptedPayload;
    storageClass: string | null;
  }[],
  generation?: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  for (const row of rows) assertConnectionEndpoint(row.endpoint);

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    if (generation !== undefined) await requireGeneration(tx, generation);
    for (const row of rows) {
      await tx.query(
        `INSERT INTO profiles
           (id, name, protocol, endpoint, region, bucket, path_style,
            encrypted_credentials, storage_class, created_at, updated_at)
         VALUES ($1, $2, 's3', $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.id,
          row.name,
          row.endpoint,
          row.region,
          row.bucket,
          row.pathStyle,
          JSON.stringify(row.encryptedCredentials),
          row.storageClass,
          now,
          now,
        ],
      );
    }
  });

  return rows.length;
}

/** Loads the sealed credentials blob for a connection (worker-only decryption). */
export async function getSealedCredentials(db: AppDB, id: string): Promise<EncryptedPayload> {
  const res = await db.query<{ encrypted_credentials: unknown }>(
    `SELECT encrypted_credentials FROM profiles WHERE id = $1`,
    [id],
  );

  const raw = res.rows[0]?.encrypted_credentials;
  if (!raw) {
    throw new Error('Connection not found');
  }

  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return parsed as EncryptedPayload;
}

export type { CredentialPlaintext };
