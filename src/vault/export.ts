import { transferManager } from '../transfer/manager';
import type { AppDB } from '../db/client';
import { vaultService } from './vaultService';

import { SCHEMA_VERSION } from '../db/migrations';
import { readVaultMeta, requireGeneration, withCurrentVault } from './repository';
import type { VerifiedBackup } from './exportFormat';

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

/** Read a consistent database snapshot and encrypt its entire manifest in the worker. */
export async function exportVault(db: AppDB): Promise<Blob> {
  const envelope = await db.transaction(async tx => {
    const meta = await readVaultMeta(tx);
    if (!meta) throw new Error('Vault not found');
    const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${PROFILE_COLUMNS.join(', ')} FROM profiles`);
    return vaultService.call('vault.export', {
      manifest: { salt: meta.salt, wrappedDek: meta.wrappedDek, profiles: rows },
      generation: meta.generation,
    });
  });
  return new Blob([JSON.stringify(envelope)], { type: 'application/json' });
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

export interface PendingRestore {
  generation: string;
  backup: VerifiedBackup;
}

export async function prepareVaultRestore(file: File, passphrase: string): Promise<PendingRestore> {
  const { generation } = await vaultService.call('vault.status');
  if (!generation) throw new Error('Unlock the current vault before restoring a backup');
  const backup = await vaultService.call('vault.import', { file, passphrase });
  return { generation, backup };
}

export async function restoreVerifiedBackup(db: AppDB, { generation, backup }: PendingRestore, reviewedLegacy = false): Promise<void> {
  if (backup.legacy && !reviewedLegacy) throw new Error('Review the legacy connection settings before restoring.');
  await withCurrentVault(db, generation, async () => {
    await transferManager.withVaultDeletion(() => db.transaction(async tx => {
      await requireGeneration(tx, generation);
      if ((await vaultService.call('vault.status')).generation !== generation) {
        throw new Error('Vault locked during restore. Unlock it and retry.');
      }
      await tx.exec('DELETE FROM _meta; DELETE FROM profiles; DELETE FROM transfer_tasks;');
      await tx.query(
        "INSERT INTO _meta (key, value) VALUES ('salt', $1), ('wrapped_dek', $2), ('vault_generation', $3), ('schema_version', $4)",
        [backup.salt, backup.wrappedDek, crypto.randomUUID(), String(SCHEMA_VERSION)],
      );
      const placeholders = PROFILE_COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
      for (const profile of backup.profiles) {
        await tx.query(
          `INSERT INTO profiles (${PROFILE_COLUMNS.join(', ')}) VALUES (${placeholders})`,
          profileValues(profile),
        );
      }
      await vaultService.call('vault.invalidate', { generation });
    }));
    vaultService.notifyReplacement(generation, false);
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
