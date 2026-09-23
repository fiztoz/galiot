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
