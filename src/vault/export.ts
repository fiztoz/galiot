import { PGlite } from '@electric-sql/pglite';
import { VaultManager } from './vault.js';

export interface VaultExportData {
  version: number;
  meta: { key: string; value: string }[];
  profiles: Record<string, unknown>[]; // Matches the structure of the profiles table
}

/**
 * Exports all vault data (salt, wrapped DEK, encrypted profiles) from the database
 * as a JSON blob. Does not require the vault to be unlocked.
 */
export async function exportVault(db: PGlite): Promise<Blob> {
  // Ensure schema exists in case we are exporting an empty db
  await VaultManager.initDbSchema(db);

  const metaRes = await db.query<{key: string; value: string}>('SELECT * FROM _meta');
  const profilesRes = await db.query<Record<string, unknown>>('SELECT * FROM profiles');

  const exportData: VaultExportData = {
    version: 1,
    meta: metaRes.rows,
    profiles: profilesRes.rows
  };

  const jsonStr = JSON.stringify(exportData);
  return new Blob([jsonStr], { type: 'application/json' });
}

/**
 * Imports a vault backup file. Verifies the passphrase by attempting to unwrap
 * the DEK in a temporary in-memory DB. Overwrites the existing database contents.
 */
export async function importVault(db: PGlite, file: File, passphrase: string): Promise<void> {
  const text = await file.text();
  let exportData: VaultExportData;
  
  try {
    exportData = JSON.parse(text);
  } catch (e) {
    throw new Error('Failed to parse vault backup file');
  }

  if (!exportData.version || !exportData.meta || !exportData.profiles) {
    throw new Error('Invalid vault export format');
  }

  // Verify passphrase by attempting to unlock using a temporary in-memory PGlite
  const tempDb = new PGlite();
  await VaultManager.initDbSchema(tempDb);
  
  for (const meta of exportData.meta) {
    await tempDb.query('INSERT INTO _meta (key, value) VALUES ($1, $2)', [meta.key, meta.value]);
  }

  try {
    await VaultManager.unlock(passphrase, tempDb);
  } catch (e) {
    throw new Error('Invalid passphrase for the provided vault file');
  } finally {
    await tempDb.close();
  }

  // Passphrase is valid. Safely overwrite the current DB data.
  await VaultManager.initDbSchema(db);
  
  await db.exec('BEGIN;');
  try {
    await db.exec('DELETE FROM _meta;');
    await db.exec('DELETE FROM profiles;');

    for (const meta of exportData.meta) {
      await db.query('INSERT INTO _meta (key, value) VALUES ($1, $2)', [meta.key, meta.value]);
    }

    for (const profile of exportData.profiles) {
      await db.query(
        'INSERT INTO profiles (id, name, endpoint, region, encrypted_credentials, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [
          profile.id, 
          profile.name, 
          profile.endpoint, 
          profile.region, 
          profile.encrypted_credentials, 
          profile.created_at
        ]
      );
    }
    await db.exec('COMMIT;');
  } catch (e) {
    await db.exec('ROLLBACK;');
    throw new Error('Failed to import vault data to database');
  }
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
