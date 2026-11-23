import {
  deriveKEK,
  derivePasskeyKEK,
  rewrapDEK,
  generateDEK,
  generateSalt,
  wrapDEK,
  unwrapDEK,
  encrypt,
  decrypt,
  zeroBuffer,
  type EncryptedPayload,
} from './crypto.js';
import type { CredentialPlaintext, VaultLockReason } from './protocol.js';

/** Idle time after which the vault self-locks and wipes the DEK reference. */
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

export interface SealedVault {
  /** base64 salt */
  salt: string;
  /** base64 AES-KW wrapped DEK */
  wrappedDek: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * In-memory vault session. Lives exclusively inside the vault worker:
 * the DEK and any decrypted credentials never cross the worker boundary.
 */
export class VaultManager {
  private dek: CryptoKey | null = null;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onLock: ((reason: VaultLockReason) => void) | undefined;

  private constructor(onLock?: ((reason: VaultLockReason) => void) | undefined) {
    this.onLock = onLock;
    this.resetTimer();
  }

  private resetTimer(): void {
    if (this.lockTimer !== null) {
      clearTimeout(this.lockTimer);
    }
    this.lockTimer = setTimeout(() => this.lock('inactivity'), INACTIVITY_TIMEOUT_MS);
  }

  private ensureUnlocked(): CryptoKey {
    if (!this.dek) {
      throw new Error('Vault is locked');
    }
    this.resetTimer();
    return this.dek;
  }

  /**
   * Drops the DEK reference and notifies the host so the UI can re-lock.
   * WebCrypto keys cannot be zeroed in place; dropping the last reference
   * allows the JS engine to reclaim the key material.
   */
  public lock(reason: VaultLockReason = 'manual'): void {
    const wasUnlocked = this.dek !== null;
    if (this.lockTimer !== null) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
    this.dek = null;
    if (wasUnlocked) {
      this.onLock?.(reason);
    }
  }

  /** The user is active in the page: inactivity means no input, not only no S3 calls. */
  public touch(): void {
    if (this.dek) this.resetTimer();
  }

  public isUnlocked(): boolean {
    return this.dek !== null;
  }

  /**
   * Creates a new vault: generates the salt and DEK, wraps the DEK with a
   * passphrase-derived KEK. Returns the sealed material for persistence.
   */
  static async create(
    passphrase: string,
    onLock?: (reason: VaultLockReason) => void,
  ): Promise<{ vault: VaultManager; sealed: SealedVault }> {
    const salt = generateSalt();
    const kek = await deriveKEK(passphrase, salt);
    const dek = await generateDEK();

    const wrappedDekBuf = await wrapDEK(kek, dek);
    const sealed: SealedVault = {
      salt: toBase64(salt),
      wrappedDek: toBase64(new Uint8Array(wrappedDekBuf)),
    };
    // The fresh DEK had to be extractable to be wrapped. Keep the
    // non-extractable unwrapped copy for the session, as unlock does.
    const sessionDek = await unwrapDEK(kek, wrappedDekBuf);

    zeroBuffer(salt);
    zeroBuffer(wrappedDekBuf);

    const vault = new VaultManager(onLock);
    vault.dek = sessionDek;
    return { vault, sealed };
  }

  /**
   * Unlocks an existing vault from persisted sealed material.
   * Throws 'Invalid passphrase' when the KEK cannot unwrap the DEK.
   */
  static async unlock(
    passphrase: string,
    sealed: SealedVault,
    onLock?: (reason: VaultLockReason) => void,
  ): Promise<VaultManager> {
    const salt = fromBase64(sealed.salt);
    const wrappedDek = fromBase64(sealed.wrappedDek);

    let kek: CryptoKey | null = null;
    let dek: CryptoKey | null = null;
    try {
      kek = await deriveKEK(passphrase, salt);
      dek = await unwrapDEK(kek, wrappedDek.buffer as ArrayBuffer);
    } catch {
      throw new Error('Invalid passphrase');
    } finally {
      zeroBuffer(salt);
      zeroBuffer(wrappedDek);
    }

    const vault = new VaultManager(onLock);
    vault.dek = dek;
    // Constructor already armed a timer; keep a single clean state.
    vault.resetTimer();
    return vault;
  }

  static async enrollPasskey(passphrase: string, sealed: SealedVault, output: ArrayBuffer): Promise<string> {
    const salt = fromBase64(sealed.salt);
    const wrapped = fromBase64(sealed.wrappedDek);
    try {
      const from = await deriveKEK(passphrase, salt);
      const to = await derivePasskeyKEK(output);
      const rewrapped = new Uint8Array(await rewrapDEK(from, to, wrapped.buffer as ArrayBuffer));
      try { return toBase64(rewrapped); } finally { zeroBuffer(rewrapped); }
    } catch {
      throw new Error('Could not enable passkey unlock. Check the current master password.');
    } finally {
      zeroBuffer(salt);
      zeroBuffer(wrapped);
    }
  }

  static async unlockWithPasskey(output: ArrayBuffer, wrappedDek: string, onLock?: (reason: VaultLockReason) => void): Promise<VaultManager> {
    const wrapped = fromBase64(wrappedDek);
    try {
      const dek = await unwrapDEK(await derivePasskeyKEK(output), wrapped.buffer as ArrayBuffer);
      const vault = new VaultManager(onLock);
      vault.dek = dek;
      return vault;
    } catch {
      throw new Error('This passkey could not unlock the vault. Use your master password.');
    } finally {
      zeroBuffer(wrapped);
    }
  }

  static async resetPasswordWithPasskey(output: ArrayBuffer, wrappedDek: string, passphrase: string): Promise<SealedVault> {
    if (passphrase.length < 8) throw new Error('Password must be at least 8 characters.');
    const salt = generateSalt();
    const wrapped = fromBase64(wrappedDek);
    try {
      const from = await derivePasskeyKEK(output);
      const to = await deriveKEK(passphrase, salt);
      const rewrapped = new Uint8Array(await rewrapDEK(from, to, wrapped.buffer as ArrayBuffer));
      try { return { salt: toBase64(salt), wrappedDek: toBase64(rewrapped) }; } finally { zeroBuffer(rewrapped); }
    } catch {
      throw new Error('This passkey could not reset the master password.');
    } finally {
      zeroBuffer(salt);
      zeroBuffer(wrapped);
    }
  }

  /**
   * Verifies a passphrase against sealed material without producing a session
   * (used by vault import/restore flows).
   */
  static async verify(passphrase: string, sealed: SealedVault): Promise<boolean> {
    const salt = fromBase64(sealed.salt);
    const wrappedDek = fromBase64(sealed.wrappedDek);
    try {
      const kek = await deriveKEK(passphrase, salt);
      await unwrapDEK(kek, wrappedDek.buffer as ArrayBuffer);
      return true;
    } catch {
      return false;
    } finally {
      zeroBuffer(salt);
      zeroBuffer(wrappedDek);
    }
  }

  async sealBackup(manifest: string, header: Uint8Array<ArrayBuffer>): Promise<EncryptedPayload> {
    return encrypt(this.ensureUnlocked(), manifest, header);
  }

  async openBackup(payload: EncryptedPayload, header: Uint8Array<ArrayBuffer>): Promise<string> {
    return decrypt(this.ensureUnlocked(), payload, header);
  }

  /** Encrypts credentials for storage in the `profiles` table. */
  async encryptCredentials(credentials: CredentialPlaintext): Promise<EncryptedPayload> {
    const dek = this.ensureUnlocked();
    const payload = await encrypt(dek, JSON.stringify(credentials));
    return payload;
  }

  /**
   * Decrypts stored credentials. Only ever called inside the vault worker so
   * the plaintext never reaches the main thread.
   */
  async decryptCredentials(payload: EncryptedPayload): Promise<CredentialPlaintext> {
    const dek = this.ensureUnlocked();
    const json = await decrypt(dek, payload);
    return JSON.parse(json) as CredentialPlaintext;
  }
}
