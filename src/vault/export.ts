import type { AppDB } from '../db/client';
import { vaultService } from './vaultService';

/**
 * Vault backup/restore.
 *
 * The file contains only ciphertext (wrapped DEK + sealed credentials), but
 * verifying an import requires PBKDF2 — which must never run on the main
 * thread, so verification is delegated to the vault worker.
 */

export interface VaultExportData {
  version: number;
  meta: { key: string; value: string }[];
  profiles: Record<string, unknown>[];
}

/** Columns copied during import — must exist in `schema.sql`. */
const PROFILE_COLUMNS = [
  'id',
  'name',
  'protocol',
  'endpoint',
  'region',
  'bucket',
  'path_style',
  'network',
  'encrypted_credentials',
  'storage_class',
  'custom_headers',
  'created_at',
  'updated_at',
] as const;

/** Dumps the vault as a JSON file. Works while locked. */
export async function exportVault(db: AppDB): Promise<Blob> {
  const metaRes = await db.query<{ key: string; value: string }>('SELECT key, value FROM _meta');
  const profilesRes = await db.query<Record<string, unknown>>('SELECT * FROM profiles');

  const payload: VaultExportData = {
    version: 1,
    meta: metaRes.rows,
    profiles: profilesRes.rows,
  };

  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

function profileValues(profile: Record<string, unknown>): unknown[] {
  return PROFILE_COLUMNS.map((column) => {
    // Older backups stored `user` for a browser call. Restore them on the
    // server route, which is the only route this build uses.
    if (column === 'network') return 'server';
    const value = profile[column];
    if (value === undefined || value === null) {
      switch (column) {
        case 'protocol':
          return 's3';
        case 'path_style':
          return false;
        case 'created_at':
        case 'updated_at':
          return new Date().toISOString();
        default:
          return null;
      }
    }
    // JSONB columns may come back parsed — re-serialize for the insert.
    if (
      (column === 'encrypted_credentials' || column === 'custom_headers') &&
      typeof value !== 'string'
    ) {
      return JSON.stringify(value);
    }
    return value;
  });
}

/**
 * Restores a backup after verifying the passphrase in the vault worker.
 * The current vault is replaced only once the passphrase checks out.
 */
export async function importVault(db: AppDB, file: File, passphrase: string): Promise<void> {
  let data: VaultExportData;
  try {
    data = JSON.parse(await file.text()) as VaultExportData;
  } catch {
    throw new Error('Failed to parse vault backup file');
  }

  if (!data.version || !data.meta || !data.profiles) {
    throw new Error('Invalid vault export format');
  }

  const salt = data.meta.find((m) => m.key === 'salt')?.value;
  const wrappedDek = data.meta.find((m) => m.key === 'wrapped_dek')?.value;
  if (!salt || !wrappedDek) {
    throw new Error('Backup does not contain vault key material');
  }

  const { valid } = await vaultService.call('vault.verify', {
    passphrase,
    salt,
    wrappedDek,
  });
  if (!valid) {
    throw new Error('Invalid passphrase for the provided vault file');
  }

  await db.transaction(async (tx) => {
    await tx.exec('DELETE FROM _meta; DELETE FROM profiles;');
    // transfer ledger is invalidated by the new vault; drop it with the keys.
    await tx.exec('DELETE FROM transfer_tasks;');

    for (const meta of data.meta) {
      await tx.query('INSERT INTO _meta (key, value) VALUES ($1, $2)', [meta.key, meta.value]);
    }

    const placeholders = PROFILE_COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
    for (const profile of data.profiles) {
      await tx.query(
        `INSERT INTO profiles (${PROFILE_COLUMNS.join(', ')}) VALUES (${placeholders})`,
        profileValues(profile),
      );
    }
  });
}

/** Triggers a browser download for a backup blob. */
export function downloadVaultBackup(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `galiot-vault-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
