import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MAX_BACKUP_FILE_BYTES, openManifest, sealManifest } from './exportFormat';
import { VaultManager, type SealedVault } from './vault';
import type { EncryptedPayload } from './crypto';

const password = 'backup fixture password';
const file = (data: unknown) => new Blob([JSON.stringify(data)]);

describe('vault backup verification', () => {
  let vault: VaultManager;
  let sealed: SealedVault;
  let credentials: EncryptedPayload;
  beforeAll(async () => {
    ({ vault, sealed } = await VaultManager.create(password));
    credentials = await vault.encryptCredentials({ accessKeyId: 'fixture-id', secretAccessKey: 'fixture-secret' });
  });
  afterAll(() => vault.lock());
  const row = () => ({
    id: '11111111-1111-4111-8111-111111111111', name: 'archive profile', bucket: 'archive', region: 'region',
    endpoint: 'https://s3.example.com', encrypted_credentials: credentials, custom_headers: { 'x-tenant': 'archive' },
  });
  const legacy = (profiles: unknown[]) => ({
    version: 1, profiles, meta: [{ key: 'salt', value: sealed.salt }, { key: 'wrapped_dek', value: sealed.wrappedDek }],
  });

  test('new backups conceal the profile list and authenticate the whole manifest', async () => {
    const envelope = await sealManifest(vault, { ...sealed, profiles: [row()] });
    expect(JSON.stringify(envelope)).not.toContain('archive');
    const verified = await openManifest(file(envelope), password);
    expect(verified.legacy).toBe(false);
    expect(verified.profiles[0]).toMatchObject(row());
    const changed = structuredClone(envelope);
    changed.manifest.ciphertext = (changed.manifest.ciphertext[0] === 'A' ? 'B' : 'A') + changed.manifest.ciphertext.slice(1);
    await expect(openManifest(file(changed), password)).rejects.toThrow('integrity');
    await expect(openManifest(file(envelope), 'wrong password')).rejects.toThrow('passphrase');
  });

  test('legacy verification checks every credential and keeps the metadata review requirement', async () => {
    const verified = await openManifest(file(legacy([row()])), password);
    expect(verified.legacy).toBe(true);
    expect(verified.profiles[0]).toMatchObject(row());
    const damaged = { ...row(), id: '22222222-2222-4222-8222-222222222222', encrypted_credentials: { ...credentials, ciphertext: '' } };
    await expect(openManifest(file(legacy([row(), damaged])), password)).rejects.toThrow('integrity');
  });

  test('a stored header a later rule rejects is dropped from the export, not fatal to it', async () => {
    const stale = { ...row(), custom_headers: JSON.stringify({ 'x-tenant': 'archive', authorization: 'fixture' }) };
    const envelope = await sealManifest(vault, { ...sealed, profiles: [stale] });
    const verified = await openManifest(file(envelope), password);
    expect(verified.profiles[0]?.custom_headers).toEqual({ 'x-tenant': 'archive' });
  });

  test('an oversized file is refused before it is read', async () => {
    const huge = new Blob([new Uint8Array(MAX_BACKUP_FILE_BYTES + 1)]);
    await expect(openManifest(huge, password)).rejects.toThrow('too large');
  });

  test('unsafe legacy endpoints and header values cannot reach restored rows', async () => {
    await expect(openManifest(file(legacy([{ ...row(), endpoint: 'https://s3.example.com?temporary' }])), password)).rejects.toThrow('integrity');
    await expect(openManifest(file(legacy([{ ...row(), custom_headers: { authorization: 'fixture' } }])), password)).rejects.toThrow('integrity');
  });
});
