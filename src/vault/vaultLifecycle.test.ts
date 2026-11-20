import { afterEach, beforeEach, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { AppDB } from '../db/client';
import { runMigrations } from '../db/migrations';
import { createVault, createConnection, deleteVault, insertSealedConnections, lockVault, readVaultMeta, readVaultState, unlockVault } from './repository';
import { exportVault, prepareVaultRestore, restoreVerifiedBackup } from './export';
import { vaultService } from './vaultService';
import { VaultManager } from './vault';
import { sealManifest } from './exportFormat';

let db: PGlite;
let app: AppDB;
let navigatorDescriptor: PropertyDescriptor | undefined;
let removedStaging: string[] = [];

beforeEach(async () => {
  navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  removedStaging = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    storage: { getDirectory: async () => ({
      removeEntry: async (path: string, options: { recursive: boolean }) => {
        expect(options.recursive).toBe(true);
        removedStaging.push(path);
      },
    }) },
  } });
  db = await PGlite.create(undefined, { extensions: { pg_trgm } });
  await runMigrations(db);
  app = db as unknown as AppDB;
});
afterEach(async () => {
  await lockVault();
  await db.close();
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

test('two setup attempts leave one usable key; restore rejects stale writers and locks the old worker', async () => {
  const password = 'setup fixture password';
  const creates = await Promise.allSettled([createVault(app, password), createVault(app, 'second setup')]);
  expect(creates.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const old = await readVaultMeta(app);
  expect(old).not.toBeNull();
  await lockVault();
  await unlockVault(app, creates[0]?.status === 'fulfilled' ? password : 'second setup');
  await createConnection(app, {
    name: 'before restore', bucket: 'archive', region: 'region', endpoint: 'https://s3.example.com',
    pathStyle: true, accessKeyId: 'fixture-id', secretAccessKey: 'fixture-key',
  });
  const bytes = await exportVault(app);
  expect(await bytes.text()).not.toContain('before restore');

  const replacementPassword = 'replacement fixture password';
  const { vault, sealed } = await VaultManager.create(replacementPassword);
  const envelope = await sealManifest(vault, { ...sealed, profiles: [] });
  vault.lock();
  const file = new File([JSON.stringify(envelope)], 'backup.json');
  const pending = await prepareVaultRestore(file, replacementPassword);
  await restoreVerifiedBackup(app, pending);
  expect((await vaultService.call('vault.status')).unlocked).toBe(false);
  expect((await readVaultMeta(app))?.generation).not.toBe(old!.generation);
  await expect(insertSealedConnections(app, [{
    id: crypto.randomUUID(), name: 'stale', endpoint: 'https://s3.example.com', region: 'region',
    bucket: 'archive', pathStyle: true, storageClass: null, encryptedCredentials: { iv: '', ciphertext: '' },
  }], old!.generation)).rejects.toThrow('Vault changed');
  expect((await db.query('SELECT id FROM profiles')).rows).toHaveLength(0);
  await unlockVault(app, replacementPassword);
  expect((await vaultService.call('vault.status')).unlocked).toBe(true);
  removedStaging = [];
  await deleteVault(app);
  expect(removedStaging).toEqual(['galiot-transfers']);
  expect(await readVaultMeta(app)).toBeNull();
  expect((await vaultService.call('vault.status')).unlocked).toBe(false);
});

test('a database failure discards the provisional worker key', async () => {
  await db.exec("ALTER TABLE _meta ADD CONSTRAINT fixture_write_failure CHECK (key <> 'wrapped_dek')");
  const error = await createVault(app, 'fixture password').catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect(await readVaultState(app)).toBe('create');
  expect((await vaultService.call('vault.status')).unlocked).toBe(false);
});

test('returning to a tab checks its worker against the durable generation', async () => {
  await createVault(app, 'fixture password');
  await db.query("UPDATE _meta SET value = $1 WHERE key = 'vault_generation'", [crypto.randomUUID()]);
  expect(await readVaultState(app)).toBe('unlock');
  expect((await vaultService.call('vault.status')).unlocked).toBe(false);
});

test('unverified legacy metadata requires review and an invalid backup preserves the current generation', async () => {
  await createVault(app, 'current vault fixture');
  const original = await readVaultMeta(app);
  const { vault, sealed } = await VaultManager.create('legacy password');
  vault.lock();
  const backup = {
    version: 1, meta: [{ key: 'salt', value: sealed.salt }, { key: 'wrapped_dek', value: sealed.wrappedDek }], profiles: [],
  };
  const pending = await prepareVaultRestore(new File([JSON.stringify(backup)], 'legacy.json'), 'legacy password');
  await expect(restoreVerifiedBackup(app, pending)).rejects.toThrow('Review');
  const error = await prepareVaultRestore(new File(['{}'], 'broken.json'), 'bad').catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect(await readVaultMeta(app)).toEqual(original);
  expect((await vaultService.call('vault.status')).unlocked).toBe(true);
  await restoreVerifiedBackup(app, pending, true);
  expect((await vaultService.call('vault.status')).unlocked).toBe(false);
});
