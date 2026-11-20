import { assertConnectionEndpoint } from '../s3/endpoint';
import { assertSafeCustomHeaders } from '../s3/customHeaders';
import type { EncryptedPayload } from './crypto';
import { VaultManager, type SealedVault } from './vault';

export interface BackupManifest extends SealedVault {
  profiles: Record<string, unknown>[];
}

export interface BackupEnvelope extends SealedVault {
  version: 2;
  manifest: EncryptedPayload;
}

export interface VerifiedBackup extends BackupManifest {
  legacy: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encrypted(value: unknown): EncryptedPayload {
  const payload: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!record(payload) || typeof payload.iv !== 'string' || typeof payload.ciphertext !== 'string' ||
      atob(payload.iv).length !== 12 || atob(payload.ciphertext).length < 16) {
    throw new Error('Invalid backup ciphertext');
  }
  return { iv: payload.iv, ciphertext: payload.ciphertext };
}

function keyMaterial(salt: unknown, wrappedDek: unknown): SealedVault {
  if (typeof salt !== 'string' || typeof wrappedDek !== 'string' ||
      atob(salt).length !== 16 || atob(wrappedDek).length !== 40) {
    throw new Error('Invalid backup key material');
  }
  return { salt, wrappedDek };
}

function header(sealed: SealedVault): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(['galiot.vault.backup', 2, sealed.salt, sealed.wrappedDek]));
}

export async function sealManifest(vault: VaultManager, data: BackupManifest): Promise<BackupEnvelope> {
  // Normalize database timestamps just as they appear in a JSON backup.
  const snapshot = JSON.stringify({ profiles: data.profiles });
  const manifest = JSON.parse(snapshot) as { profiles: unknown };
  try {
    await verifiedProfiles(manifest.profiles, vault);
  } catch {
    throw new Error('Cannot export a restorable backup. Check the saved connection settings and credentials.');
  }
  return {
    version: 2,
    salt: data.salt,
    wrappedDek: data.wrappedDek,
    manifest: await vault.sealBackup(snapshot, header(data)),
  };
}

function legacyKeys(meta: unknown): SealedVault {
  if (!Array.isArray(meta)) throw new Error('Invalid backup metadata');
  const values = new Map<string, string>();
  for (const item of meta) {
    if (!record(item) || typeof item.key !== 'string' || typeof item.value !== 'string' || values.has(item.key)) {
      throw new Error('Invalid or duplicate backup metadata');
    }
    values.set(item.key, item.value);
  }
  return keyMaterial(values.get('salt'), values.get('wrapped_dek'));
}

async function verifiedProfiles(raw: unknown, verifier: VaultManager): Promise<Record<string, unknown>[]> {
  if (!Array.isArray(raw)) throw new Error('Invalid backup profile list');
  const ids = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const row of raw) {
    if (!record(row) || typeof row.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id) ||
        ids.has(row.id.toLowerCase()) || typeof row.endpoint !== 'string' ||
        !['name', 'bucket', 'region'].every(key => typeof row[key] === 'string' && row[key]) ||
        (row.protocol != null && row.protocol !== 's3' && row.protocol !== 'sftp') ||
        (row.path_style != null && typeof row.path_style !== 'boolean') ||
        (row.storage_class != null && typeof row.storage_class !== 'string') ||
        ![row.created_at, row.updated_at].every(date => date == null ||
          (typeof date === 'string' && Number.isFinite(Date.parse(date))))) {
      throw new Error('Invalid or duplicate backup profile');
    }
    ids.add(row.id.toLowerCase());
    assertConnectionEndpoint(row.endpoint);
    const headers: unknown = typeof row.custom_headers === 'string' ? JSON.parse(row.custom_headers) : row.custom_headers;
    if (headers != null && (!record(headers) || Object.values(headers).some(value => typeof value !== 'string'))) {
      throw new Error('Invalid backup headers');
    }
    const safeHeaders = assertSafeCustomHeaders(headers as Record<string, string> | undefined);
    const sealed = encrypted(row.encrypted_credentials);
    const creds = await verifier.decryptCredentials(sealed);
    if (!record(creds) || typeof creds.accessKeyId !== 'string' || !creds.accessKeyId ||
        typeof creds.secretAccessKey !== 'string' || !creds.secretAccessKey ||
        (creds.sessionToken != null && typeof creds.sessionToken !== 'string')) {
      throw new Error('Invalid credentials in backup');
    }
    rows.push({
      id: row.id, name: row.name, endpoint: row.endpoint, region: row.region, bucket: row.bucket,
      protocol: row.protocol, path_style: row.path_style, storage_class: row.storage_class,
      custom_headers: Object.keys(safeHeaders).length ? safeHeaders : null, created_at: row.created_at, updated_at: row.updated_at,
      encrypted_credentials: sealed,
    });
  }
  return rows;
}

/** Worker only. Return sealed rows only after checking the complete backup. */
export async function openManifest(file: Blob, passphrase: string): Promise<VerifiedBackup> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error('Invalid vault backup file');
  }
  if (!record(raw) || (raw.version !== 1 && raw.version !== 2)) throw new Error('Unsupported vault backup format');
  const sealed = raw.version === 1 ? legacyKeys(raw.meta) : keyMaterial(raw.salt, raw.wrappedDek);
  const verifier = await VaultManager.unlock(passphrase, sealed);
  try {
    const manifest: unknown = raw.version === 1 ? raw :
      JSON.parse(await verifier.openBackup(encrypted(raw.manifest), header(sealed)));
    if (!record(manifest)) throw new Error('Invalid manifest');
    return { ...sealed, legacy: raw.version === 1, profiles: await verifiedProfiles(manifest.profiles, verifier) };
  } catch {
    throw new Error('Backup integrity check failed. The current vault has been preserved.');
  } finally {
    verifier.lock();
  }
}
