import { describe, expect, test } from 'bun:test';
import { VaultManager } from './vault';

describe('VaultManager', () => {
  test('create returns sealed material and an unlocked session', async () => {
    const { vault, sealed } = await VaultManager.create('passphrase-one');

    expect(vault.isUnlocked()).toBe(true);
    expect(sealed.salt).toBeString();
    expect(sealed.wrappedDek).toBeString();

    // Sealed material must not contain the passphrase.
    expect(sealed.salt).not.toContain('passphrase-one');
    expect(sealed.wrappedDek).not.toContain('passphrase-one');
  });

  test('unlock round-trips the DEK with the correct passphrase', async () => {
    const { sealed } = await VaultManager.create('passphrase-two');
    const vault = await VaultManager.unlock('passphrase-two', sealed);
    expect(vault.isUnlocked()).toBe(true);
  });

  test('unlock rejects the wrong passphrase', async () => {
    const { sealed } = await VaultManager.create('passphrase-three');
    await expect(VaultManager.unlock('not-the-passphrase', sealed)).rejects.toThrow(
      'Invalid passphrase',
    );
  });

  test('verify validates without producing a session', async () => {
    const { sealed } = await VaultManager.create('passphrase-four');
    expect(await VaultManager.verify('passphrase-four', sealed)).toBe(true);
    expect(await VaultManager.verify('nope', sealed)).toBe(false);
  });

  test('credentials encrypt/decrypt round-trip only while unlocked', async () => {
    const { vault, sealed } = await VaultManager.create('passphrase-five');
    const creds = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'super-secret-value' };

    const payload = await vault.encryptCredentials(creds);
    expect(JSON.stringify(payload)).not.toContain('super-secret-value');
    expect(await vault.decryptCredentials(payload)).toEqual(creds);

    vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    await expect(vault.decryptCredentials(payload)).rejects.toThrow('Vault is locked');

    // A re-unlocked session can still read the ciphertext (same DEK).
    const reopened = await VaultManager.unlock('passphrase-five', sealed);
    expect(await reopened.decryptCredentials(payload)).toEqual(creds);
  });

  test('lock is idempotent and notifies once per unlock cycle', async () => {
    let lockEvents = 0;
    const { vault } = await VaultManager.create('passphrase-six', () => {
      lockEvents += 1;
    });

    vault.lock();
    vault.lock();
    expect(lockEvents).toBe(1);
  });
});
