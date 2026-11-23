import type { AppDB } from '../db/client';
import { parseVaultPasskey, readPasskeyOutput, type PasskeyIdentity, type VaultPasskey } from './passkey';
import { readVaultMeta, requireGeneration, withCurrentVault } from './repository';
import { vaultService } from './vaultService';

type Query = Pick<AppDB, 'query'>;

export interface PasskeyEnrollment {
  generation: string;
  passkey: VaultPasskey;
}

async function readPasskey(tx: Query): Promise<string | undefined> {
  const { rows } = await tx.query<{ value: string }>("SELECT value FROM _meta WHERE key = 'vault_passkey'");
  return rows[0]?.value;
}

export async function readPasskeyEnrollment(db: AppDB): Promise<PasskeyEnrollment | null> {
  return db.transaction(async tx => {
    const meta = await readVaultMeta(tx);
    const passkey = parseVaultPasskey(await readPasskey(tx));
    return meta && passkey ? { generation: meta.generation, passkey } : null;
  });
}

async function requireEnrollment(tx: Query, enrollment: PasskeyEnrollment): Promise<void> {
  await requireGeneration(tx, enrollment.generation);
  const current = parseVaultPasskey(await readPasskey(tx));
  if (!current || JSON.stringify(current) !== JSON.stringify(enrollment.passkey)) {
    throw new Error('Passkey settings changed in another tab. Refresh and try again.');
  }
}

/** Called directly from the test-and-enable button to preserve browser user activation. */
export async function enableVaultPasskey(db: AppDB, generation: string, passkey: PasskeyIdentity, passphrase: string): Promise<void> {
  const output = await readPasskeyOutput(passkey);
  try {
    await withCurrentVault(db, generation, () => db.transaction(async tx => {
      const meta = await readVaultMeta(tx);
      if (meta?.generation !== generation) throw new Error('Vault changed. Unlock and try again.');
      if (parseVaultPasskey(await readPasskey(tx))) throw new Error('A passkey is already enabled.');
      const { wrappedDek } = await vaultService.call('vault.passkeyEnroll', { ...meta, passphrase, output }, [output]);
      const value = JSON.stringify({ ...passkey, wrappedDek });
      if (!parseVaultPasskey(value)) throw new Error('Invalid passkey record.');
      await tx.query("INSERT INTO _meta (key, value) VALUES ('vault_passkey', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [value]);
    }));
  } finally {
    if (output.byteLength) new Uint8Array(output).fill(0);
  }
}

export async function unlockVaultWithPasskey(db: AppDB, enrollment: PasskeyEnrollment): Promise<void> {
  const output = await readPasskeyOutput(enrollment.passkey);
  try {
    await db.transaction(async tx => {
      await requireEnrollment(tx, enrollment);
      await vaultService.call('vault.passkeyUnlock', {
        generation: enrollment.generation, wrappedDek: enrollment.passkey.wrappedDek, output,
      }, [output]);
    });
  } finally {
    if (output.byteLength) new Uint8Array(output).fill(0);
  }
}

export async function resetMasterPasswordWithPasskey(db: AppDB, enrollment: PasskeyEnrollment, passphrase: string): Promise<void> {
  if (passphrase.length < 8) throw new Error('Password must be at least 8 characters.');
  const { generation, passkey } = enrollment;
  const output = await readPasskeyOutput(passkey);
  try {
    await withCurrentVault(db, generation, async () => {
      await db.transaction(async tx => {
        await requireEnrollment(tx, enrollment);
        const next = await vaultService.call('vault.passkeyRewrap', { generation, wrappedDek: passkey.wrappedDek, passphrase, output }, [output]);
        await tx.query(`INSERT INTO _meta (key, value) VALUES ('salt', $1), ('wrapped_dek', $2), ('vault_generation', $3)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [next.salt, next.wrappedDek, crypto.randomUUID()]);
      });
      await vaultService.call('vault.invalidate', { generation });
      vaultService.notifyReplacement(generation, false);
    });
  } finally {
    if (output.byteLength) new Uint8Array(output).fill(0);
  }
}

/** Confirm the remaining password unlock path before removing passkey access. */
export async function removeVaultPasskey(db: AppDB, enrollment: PasskeyEnrollment, passphrase: string): Promise<void> {
  const { generation } = enrollment;
  await withCurrentVault(db, generation, () => db.transaction(async tx => {
    await requireEnrollment(tx, enrollment);
    const meta = await readVaultMeta(tx);
    if (!meta || !(await vaultService.call('vault.checkPhrase', { ...meta, passphrase })).verified) {
      throw new Error('Check your current master password before removing passkey access.');
    }
    await tx.exec("DELETE FROM _meta WHERE key = 'vault_passkey'");
  }));
}
