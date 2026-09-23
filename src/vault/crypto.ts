/**
 * Web Crypto API primitives for Galiot Vault
 */

export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string; // base64
}

// Helpers for base64 serialization
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Generates 16 random bytes for a salt.
 */
export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * Generates 12 random bytes (96-bit) for AES-GCM IV.
 */
export function generateIV(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(12));
}

/**
 * Derives a Key Encryption Key (KEK) using PBKDF2 with SHA-256 and 600,000 iterations.
 * Returns an AES-KW (Key Wrap) 256-bit key.
 */
export async function deriveKEK(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: 600000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-KW', length: 256 },
    true,
    ['wrapKey', 'unwrapKey']
  );
}

/**
 * Generates a random Data Encryption Key (DEK) for AES-GCM-256.
 */
export async function generateDEK(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Wraps the DEK using the KEK (AES-KW).
 */
export async function wrapDEK(kek: CryptoKey, dek: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.wrapKey('raw', dek, kek, 'AES-KW');
}

/**
 * Unwraps the DEK using the KEK (AES-KW).
 */
export async function unwrapDEK(kek: CryptoKey, wrappedDek: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'raw',
    wrappedDek,
    kek,
    'AES-KW',
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a plaintext string using the DEK (AES-GCM-256).
 */
export async function encrypt(dek: CryptoKey, plaintext: string): Promise<EncryptedPayload> {
  const encoder = new TextEncoder();
  const iv = generateIV();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    dek,
    encoder.encode(plaintext)
  );

  return {
    ciphertext: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(iv.buffer as ArrayBuffer)
  };
}

/**
 * Decrypts a payload using the DEK (AES-GCM-256).
 */
export async function decrypt(dek: CryptoKey, payload: EncryptedPayload): Promise<string> {
  const decoder = new TextDecoder();
  const iv = base64ToArrayBuffer(payload.iv);
  const ciphertext = base64ToArrayBuffer(payload.ciphertext);
  
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    dek,
    ciphertext
  );

  return decoder.decode(plaintext);
}

/**
 * Zeros out a buffer for defense-in-depth against memory scraping.
 */
export function zeroBuffer(buffer: ArrayBuffer | Uint8Array): void {
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  for (let i = 0; i < view.length; i++) {
    view[i] = 0;
  }
}
