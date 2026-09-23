import {
  deriveKEK,
  generateDEK,
  generateSalt,
  wrapDEK,
  unwrapDEK,
  encrypt,
  decrypt,
  zeroBuffer,
  type EncryptedPayload,
} from './crypto.js';
import type { CredentialPlaintext } from './protocol.js';

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
  private readonly onLock: (() => void) | undefined;

  private constructor(onLock?: (() => void) | undefined) {
    this.onLock = onLock;
    this.resetTimer();
  }

  private resetTimer(): void {
    if (this.lockTimer !== null) {
      clearTimeout(this.lockTimer);
    }
    this.lockTimer = setTimeout(() => this.lock(), INACTIVITY_TIMEOUT_MS);
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
  public lock(): void {
    const wasUnlocked = this.dek !== null;
    if (this.lockTimer !== null) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
    this.dek = null;
    if (wasUnlocked) {
      this.onLock?.();
    }
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
    onLock?: () => void,
  ): Promise<{ vault: VaultManager; sealed: SealedVault }> {
    const salt = generateSalt();
    const kek = await deriveKEK(passphrase, salt);
    const dek = await generateDEK();

    const wrappedDekBuf = await wrapDEK(kek, dek);
    const sealed: SealedVault = {
      salt: toBase64(salt),
      wrappedDek: toBase64(new Uint8Array(wrappedDekBuf)),
    };

    zeroBuffer(salt);
    zeroBuffer(wrappedDekBuf);

    const vault = new VaultManager(onLock);
    vault.dek = dek;
    return { vault, sealed };
  }

  /**
   * Unlocks an existing vault from persisted sealed material.
   * Throws 'Invalid passphrase' when the KEK cannot unwrap the DEK.
   */
  static async unlock(
    passphrase: string,
    sealed: SealedVault,
    onLock?: () => void,
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
