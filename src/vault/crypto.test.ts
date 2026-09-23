import { describe, expect, test } from 'bun:test';
import {
  deriveKEK,
  generateDEK,
  generateSalt,
  wrapDEK,
  unwrapDEK,
  encrypt,
  decrypt,
  zeroBuffer,
} from './crypto';

describe('vault crypto primitives', () => {
  test('generateSalt returns 16 random bytes', () => {
    const salt = generateSalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.length).toBe(16);
  });

  test('encrypt/decrypt round-trips with a fresh DEK', async () => {
    const dek = await generateDEK();
    const payload = await encrypt(dek, 'hunter2-s3cret');

    expect(payload.ciphertext).toBeString();
    expect(payload.iv).toBeString();
    expect(payload.ciphertext).not.toContain('hunter2');

    const plaintext = await decrypt(dek, payload);
    expect(plaintext).toBe('hunter2-s3cret');
  });

  test('ciphertext differs on every encryption (fresh IV)', async () => {
    const dek = await generateDEK();
    const a = await encrypt(dek, 'same input');
    const b = await encrypt(dek, 'same input');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test('decrypt fails with the wrong key', async () => {
    const dekA = await generateDEK();
    const dekB = await generateDEK();
    const payload = await encrypt(dekA, 'secret');
    await expect(decrypt(dekB, payload)).rejects.toThrow();
  });

  test('DEK wraps and unwraps with a passphrase-derived KEK', async () => {
    const salt = generateSalt();
    const kek = await deriveKEK('correct horse battery staple', salt);
    const dek = await generateDEK();

    const wrapped = await wrapDEK(kek, dek);
    const unwrapped = await unwrapDEK(kek, wrapped);

    expect(unwrapped.extractable).toBe(true);
    expect(unwrapped.algorithm.name).toBe('AES-GCM');

    // The unwrapped key must decrypt what the original encrypted.
    const payload = await encrypt(dek, 'roundtrip');
    expect(await decrypt(unwrapped, payload)).toBe('roundtrip');
  });

  test('wrong passphrase cannot unwrap the DEK', async () => {
    const salt = generateSalt();
    const kek = await deriveKEK('correct-passphrase', salt);
    const wrongKek = await deriveKEK('wrong-passphrase', salt);
    const dek = await generateDEK();

    const wrapped = await wrapDEK(kek, dek);
    await expect(unwrapDEK(wrongKek, wrapped)).rejects.toThrow();
  });

  test('zeroBuffer wipes the memory it is given', () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    zeroBuffer(buf);
    expect([...buf]).toEqual([0, 0, 0, 0]);
  });
});
