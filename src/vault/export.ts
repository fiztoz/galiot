import type { PGlite } from '@electric-sql/pglite';
import { VaultManager } from './vault.js';

export interface VaultExportData {
  version: number;
  meta: { key: string; value: string }[];
  profiles: Record<string, unknown>[]; // Matches the structure of the profiles table
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
  'encrypted_credentials',
  'storage_class',
  'created_at',
  'updated_at',
] as const;

function profileValues(profile: Record<string, unknown>): unknown[] {
  return PROFILE_COLUMNS.map((column) => {
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
    if (column === 'encrypted_credentials' && typeof value !== 'string') {
      return JSON.stringify(value);
    }
    return value;
  });
}

/**
 * Exports all vault data (salt, wrapped DEK, encrypted profiles) from the database
 * as a JSON blob. Does not require the vault to be unlocked.
 */
export async function exportVault(db: PGlite): Promise<Blob> {
  const metaRes = await db.query<{ key: string; value: string }>('SELECT key, value FROM _meta');
  const profilesRes = await db.query<Record<string, unknown>>('SELECT * FROM profiles');

  const exportData: VaultExportData = {
    version: 1,
    meta: metaRes.rows,
    profiles: profilesRes.rows,
  };

  const jsonStr = JSON.stringify(exportData);
  return new Blob([jsonStr], { type: 'application/json' });
}

/**
 * Imports a vault backup file. Verifies the passphrase against the exported
 * sealed material first, then overwrites the existing vault contents.
 */
export async function importVault(db: PGlite, file: File, passphrase: string): Promise<void> {
  const text = await file.text();
  let exportData: VaultExportData;

  try {
    exportData = JSON.parse(text) as VaultExportData;
  } catch {
    throw new Error('Failed to parse vault backup file');
  }

  if (!exportData.version || !exportData.meta || !exportData.profiles) {
    throw new Error('Invalid vault export format');
  }

  const salt = exportData.meta.find((m) => m.key === 'salt')?.value;
  const wrappedDek = exportData.meta.find((m) => m.key === 'wrapped_dek')?.value;
  if (!salt || !wrappedDek) {
    throw new Error('Backup does not contain vault key material');
  }

  const valid = await VaultManager.verify(passphrase, { salt, wrappedDek });
  if (!valid) {
    throw new Error('Invalid passphrase for the provided vault file');
  }

  // Passphrase is valid. Safely overwrite the current DB data.
  await db.transaction(async (tx) => {
    await tx.exec('DELETE FROM _meta; DELETE FROM profiles;');

    for (const meta of exportData.meta) {
      await tx.query('INSERT INTO _meta (key, value) VALUES ($1, $2)', [meta.key, meta.value]);
    }

    const placeholders = PROFILE_COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
    for (const profile of exportData.profiles) {
      await tx.query(
        `INSERT INTO profiles (${PROFILE_COLUMNS.join(', ')}) VALUES (${placeholders})`,
        profileValues(profile),
      );
    }
  });
}

/**
 * Triggers a browser file download for a Blob (the vault backup).
 * Creates an anchor element and simulates a click.
 */
export function downloadVaultBackup(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `galiot-vault-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Cleanup
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
