import type { AppDB } from '../db/client';
import type { EncryptedPayload } from './crypto';
import type { CredentialPlaintext } from './protocol';
import { vaultService } from './vaultService';

const META_SALT = 'salt';
const META_WRAPPED_DEK = 'wrapped_dek';

export interface VaultMeta {
  salt: string;
  wrappedDek: string;
}

/** Reads the sealed vault material (salt + wrapped DEK), if the vault exists. */
export async function readVaultMeta(db: AppDB): Promise<VaultMeta | null> {
  const res = await db.query<{ key: string; value: string }>(
    `SELECT key, value FROM _meta WHERE key IN ($1, $2)`,
    [META_SALT, META_WRAPPED_DEK],
  );

  let salt: string | undefined;
  let wrappedDek: string | undefined;
  for (const row of res.rows) {
    if (row.key === META_SALT) salt = row.value;
    if (row.key === META_WRAPPED_DEK) wrappedDek = row.value;
  }

  if (!salt || !wrappedDek) return null;
  return { salt, wrappedDek };
}

export async function vaultExists(db: AppDB): Promise<boolean> {
  return (await readVaultMeta(db)) !== null;
}

/**
 * Creates a new vault: the worker generates and keeps the DEK, the sealed
 * material is persisted here. Only ciphertext touches the database.
 */
export async function createVault(db: AppDB, passphrase: string): Promise<void> {
  const sealed = await vaultService.call('vault.create', { passphrase });
  await db.query(
    `INSERT INTO _meta (key, value) VALUES ($1, $2), ($3, $4)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [META_SALT, sealed.salt, META_WRAPPED_DEK, sealed.wrappedDek],
  );
}

export async function unlockVault(db: AppDB, passphrase: string): Promise<void> {
  const meta = await readVaultMeta(db);
  if (!meta) {
    throw new Error('Vault not found');
  }
  await vaultService.call('vault.unlock', {
    passphrase,
    salt: meta.salt,
    wrappedDek: meta.wrappedDek,
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
export async function wipeVaultData(db: AppDB): Promise<void> {
  await db.transaction(async (tx) => {
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
    await tx.query(`INSERT INTO _meta (key, value) VALUES ('schema_version', '1')`, []);
  });
}

/**
 * Irreversibly destroys the vault: drops the DEK in the worker and erases every
 * stored connection, cached object, transfer and generated link.
 *
 * Exported vault backups are unaffected — they are files the user already has.
 */
export async function deleteVault(db: AppDB): Promise<void> {
  // Lock first: if the worker still held the DEK, a new vault could in
  // principle be created before the rows are gone.
  await lockVault();
  await wipeVaultData(db);
}

export async function isVaultUnlocked(): Promise<boolean> {
  const status = await vaultService.call('vault.status');
  return status.unlocked;
}

export interface ConnectionInput {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Encrypts the credentials in the vault worker, then persists the ciphertext
 * as a `profiles` row. The plaintext is never stored.
 */
export async function createConnection(db: AppDB, input: ConnectionInput): Promise<string> {
  const { payload } = await vaultService.call('creds.encrypt', {
    credentials: {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
      sessionToken: input.sessionToken || undefined,
    },
  });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.query(
    `INSERT INTO profiles
       (id, name, protocol, endpoint, region, bucket, path_style, encrypted_credentials, created_at, updated_at)
     VALUES ($1, $2, 's3', $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.name,
      input.endpoint,
      input.region,
      input.bucket,
      input.pathStyle,
      JSON.stringify(payload),
      now,
      now,
    ],
  );

  return id;
}

/** Deletes a connection; `objects_cache` rows cascade with the foreign key. */
export async function deleteConnection(db: AppDB, id: string): Promise<void> {
  await db.query(`DELETE FROM profiles WHERE id = $1`, [id]);
}

export interface ConnectionUpdate {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  /**
   * New credentials. Omit to keep the sealed ones already in the vault, which
   * is what lets a user rename or re-point a connection without retyping keys
   * — and without the secret ever being decrypted on the main thread.
   */
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export interface ConnectionUpdateResult {
  /** True when the cached listing was dropped because the target changed. */
  clearedCache: boolean;
}

/**
 * Updates a connection in place.
 *
 * The cached listing is dropped whenever the *target* changes (endpoint,
 * region, bucket or addressing): those rows were fetched from a different
 * bucket, and leaving them would let a later switch back to the old bucket name
 * show stale contents. A rename keeps the cache, because nothing about the
 * target moved.
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
  const existing = await db.query<{
    endpoint: string;
    region: string;
    bucket: string;
    path_style: boolean;
  }>('SELECT endpoint, region, bucket, path_style FROM profiles WHERE id = $1', [id]);

  const current = existing.rows[0];
  if (!current) throw new Error('Connection not found');

  const targetChanged =
    current.endpoint !== input.endpoint ||
    current.region !== input.region ||
    current.bucket !== input.bucket ||
    current.path_style !== input.pathStyle;

  // Sealed in the worker, as on create; the plaintext goes no further.
  const payload = input.credentials
    ? (
        await vaultService.call('creds.encrypt', {
          credentials: {
            accessKeyId: input.credentials.accessKeyId,
            secretAccessKey: input.credentials.secretAccessKey,
          },
        })
      ).payload
    : null;

  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    if (payload) {
      await tx.query(
        `UPDATE profiles
            SET name = $1, endpoint = $2, region = $3, bucket = $4, path_style = $5,
                encrypted_credentials = $6, updated_at = $7
          WHERE id = $8`,
        [
          input.name,
          input.endpoint,
          input.region,
          input.bucket,
          input.pathStyle,
          JSON.stringify(payload),
          now,
          id,
        ],
      );
    } else {
      await tx.query(
        `UPDATE profiles
            SET name = $1, endpoint = $2, region = $3, bucket = $4, path_style = $5, updated_at = $6
          WHERE id = $7`,
        [input.name, input.endpoint, input.region, input.bucket, input.pathStyle, now, id],
      );
    }

    if (targetChanged) {
      await tx.query('DELETE FROM objects_cache WHERE profile_id = $1', [id]);
    }
  });

  return { clearedCache: targetChanged };
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
): Promise<number> {
  if (rows.length === 0) return 0;

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
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
