import { afterEach, beforeEach, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { AppDB } from '../db/client';
import { runMigrations } from '../db/migrations';
import { createVault, createConnection, deleteVault, insertSealedConnections, lockVault, readVaultMeta, readVaultState, unlockVault } from './repository';
import { exportVault, prepareLockedVaultRestore, prepareVaultRestore, restoreLockedVaultBackup, restoreVerifiedBackup } from './export';
import { resetLockedVault, START_OVER_PHRASE } from './repository';
import { createVaultPasskey } from './passkey';
import { enableVaultPasskey, readPasskeyEnrollment, removeVaultPasskey, resetMasterPasswordWithPasskey, unlockVaultWithPasskey } from './passkeyRepository';
import { vaultService } from './vaultService';
import { VaultManager } from './vault';
import { sealManifest } from './exportFormat';

let db: PGlite;
let app: AppDB;
let navigatorDescriptor: PropertyDescriptor | undefined;
let removedStaging: string[] = [];

// Await the RPC before calling Bun's matcher. Its promise matcher can block
// delivery of the worker response the rejected operation is still waiting for.
async function expectFailure(operation: Promise<unknown>, message?: string): Promise<void> {
  const error = await operation.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  if (message) expect((error as Error).message).toContain(message);
}

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
  await expectFailure(insertSealedConnections(app, [{
    id: crypto.randomUUID(), name: 'stale', endpoint: 'https://s3.example.com', region: 'region',
    bucket: 'archive', pathStyle: true, storageClass: null, encryptedCredentials: { iv: '', ciphertext: '' },
  }], old!.generation), 'Vault changed');
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

test('locked reset requires the exact confirmation and cannot clear a newer vault', async () => {
  await createVault(app, 'local fixture phrase');
  await createConnection(app, {
    name: 'before reset', bucket: 'archive', region: 'region', endpoint: 'https://s3.example.com',
    pathStyle: true, accessKeyId: 'fixture-id', secretAccessKey: 'fixture-key',
  });
  const original = (await readVaultMeta(app))!;
  await expectFailure(resetLockedVault(app, original.generation, START_OVER_PHRASE), 'unlocked');
  await lockVault();
  await expectFailure(resetLockedVault(app, original.generation, 'start over'), 'exactly');
  await expectFailure(resetLockedVault(app, crypto.randomUUID(), START_OVER_PHRASE), 'Vault changed');
  expect(removedStaging).toEqual([]);
  expect((await db.query('SELECT id FROM profiles')).rows).toHaveLength(1);
  await resetLockedVault(app, original.generation, START_OVER_PHRASE);
  expect(removedStaging).toEqual(['galiot-transfers']);
  expect((await db.query('SELECT id FROM profiles')).rows).toHaveLength(0);
  expect(await readVaultState(app)).toBe('create');
});

test('a locked backup can be verified without modifying local state, and replaced only on confirmation', async () => {
  const phrase = 'known fixture phrase';
  await createVault(app, phrase);
  const blob = await exportVault(app);
  const file = new File([blob], 'backup.json');
  const initial = (await readVaultMeta(app))!;
  await lockVault();
  await expectFailure(prepareLockedVaultRestore(app, initial.generation, file, 'wrong fixture phrase'));
  expect(await readVaultMeta(app)).toEqual(initial);
  expect(removedStaging).toEqual([]);
  const pending = await prepareLockedVaultRestore(app, initial.generation, file, phrase);
  expect(await readVaultMeta(app)).toEqual(initial);
  expect(removedStaging).toEqual([]);
  await restoreLockedVaultBackup(app, pending);
  expect(removedStaging).toEqual(['galiot-transfers']);
  expect((await readVaultMeta(app))?.generation).not.toBe(initial.generation);
  await expectFailure(restoreLockedVaultBackup(app, pending), 'Vault changed');
  await unlockVault(app, phrase);
  expect(await readVaultState(app)).toBe('unlocked');
});

test('passkey enrollment and password replacement preserve the same vault key in the worker', async () => {
  const phrase = 'original fixture phrase';
  const nextPhrase = 'replacement fixture phrase';
  await createVault(app, phrase);
  const { generation } = (await readVaultMeta(app))!;
  let prfByte: number | null = null;
  let returnedOutput: ArrayBuffer | undefined;
  const rawId = Uint8Array.of(1, 2, 3, 4).buffer;
  class FixtureCredential {
    rawId = rawId;
    getClientExtensionResults() {
      returnedOutput = prfByte === null ? undefined : new Uint8Array(32).fill(prfByte).buffer;
      return { prf: { enabled: true, results: { first: returnedOutput } } };
    }
  }
  const globals = { PublicKeyCredential: FixtureCredential, isSecureContext: true, location: { origin: 'https://galiot.example.com' } };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const seen: CredentialRequestOptions[] = [];
  Object.assign(navigator, { credentials: {
    create: async () => new FixtureCredential(),
    get: async (options: CredentialRequestOptions) => { seen.push(options); return new FixtureCredential(); },
  } });
  try {
    const candidate = await createVaultPasskey();
    await expectFailure(enableVaultPasskey(app, generation, candidate, phrase), 'could not unlock encrypted data');
    expect(await readPasskeyEnrollment(app)).toBeNull();
    prfByte = 44;
    await expectFailure(enableVaultPasskey(app, generation, candidate, 'wrong fixture phrase'), 'current master password');
    expect(await readPasskeyEnrollment(app)).toBeNull();
    await enableVaultPasskey(app, generation, candidate, phrase);
    expect(returnedOutput?.byteLength).toBe(0);
    expect(seen.at(-1)?.publicKey?.userVerification).toBe('required');
    expect(seen.at(-1)?.publicKey?.extensions?.prf?.eval?.first).toHaveLength(32);
    const entry = (await readPasskeyEnrollment(app))!;
    const creds = { accessKeyId: 'fixture-id', secretAccessKey: 'fixture-key' };
    await createConnection(app, {
      name: 'retained connection', bucket: 'archive', region: 'region', endpoint: 'https://s3.example.com',
      pathStyle: true, ...creds,
    });
    await lockVault();
    prfByte = 45;
    await expectFailure(unlockVaultWithPasskey(app, entry), 'could not unlock');
    expect(await readVaultState(app)).toBe('unlock');
    prfByte = 44;
    await unlockVaultWithPasskey(app, entry);
    const backup = new File([await exportVault(app)], 'still-usable.json');
    await resetMasterPasswordWithPasskey(app, entry, nextPhrase);
    expect(await readVaultState(app)).toBe('unlock');
    await expectFailure(unlockVaultWithPasskey(app, entry), 'Vault changed');
    await expectFailure(unlockVault(app, phrase), 'Invalid passphrase');
    await unlockVault(app, nextPhrase);
    expect((await db.query('SELECT name FROM profiles')).rows).toEqual([{ name: 'retained connection' }]);
    expect((await prepareVaultRestore(backup, phrase)).backup.profiles).toHaveLength(1);
    const updated = (await readPasskeyEnrollment(app))!;
    await expectFailure(removeVaultPasskey(app, updated, phrase), 'current master password');
    await lockVault();
    await unlockVaultWithPasskey(app, updated);
    await removeVaultPasskey(app, updated, nextPhrase);
    expect(await readPasskeyEnrollment(app)).toBeNull();
    await lockVault();
    await expectFailure(unlockVaultWithPasskey(app, updated), 'Passkey settings changed');
    await unlockVault(app, nextPhrase);
  } finally {
    Reflect.deleteProperty(navigator, 'credentials');
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
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
  await expectFailure(restoreVerifiedBackup(app, pending), 'Review');
  const error = await prepareVaultRestore(new File(['{}'], 'broken.json'), 'bad').catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect(await readVaultMeta(app)).toEqual(original);
  expect((await vaultService.call('vault.status')).unlocked).toBe(true);
  await restoreVerifiedBackup(app, pending, true);
  expect((await vaultService.call('vault.status')).unlocked).toBe(false);
});
