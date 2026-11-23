import { BRAND } from '../branding';

/** Local browser metadata only; the PRF output is never persisted. */
export interface VaultPasskey {
  version: 1;
  origin: string;
  credentialId: string;
  input: string;
  wrappedDek: string;
}
export type PasskeyIdentity = Omit<VaultPasskey, 'wrappedDek'>;

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}

export function parseVaultPasskey(value: string | undefined): VaultPasskey | null {
  if (!value || value.length > 6000) return null;
  try {
    const entry: Partial<VaultPasskey> = JSON.parse(value);
    if (entry.version !== 1 || typeof entry.origin !== 'string' ||
      typeof entry.credentialId !== 'string' || !/^[\w-]{2,4096}$/.test(entry.credentialId) ||
      typeof entry.input !== 'string' || !/^[\w-]{43}$/.test(entry.input) || decode(entry.input).length !== 32 ||
      typeof entry.wrappedDek !== 'string' || !/^[A-Za-z0-9+/]{54}==$/.test(entry.wrappedDek)) return null;
    return entry as VaultPasskey;
  } catch {
    return null;
  }
}

export function canUsePasskey(): boolean {
  return globalThis.isSecureContext === true && typeof PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials?.create === 'function' && typeof navigator.credentials?.get === 'function';
}

function randomBytes(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function createVaultPasskey(): Promise<PasskeyIdentity> {
  if (!canUsePasskey()) throw new Error('Passkeys require a supported browser and HTTPS or localhost.');
  const credential = await navigator.credentials.create({ publicKey: {
    rp: { name: BRAND.name },
    user: { id: randomBytes(), name: 'Local vault', displayName: `${BRAND.name} local vault` },
    challenge: randomBytes(),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    attestation: 'none',
    timeout: 60_000,
    extensions: { prf: {} },
  } });
  if (!(credential instanceof PublicKeyCredential)) throw new Error('Passkey setup was cancelled.');
  if (credential.getClientExtensionResults().prf?.enabled === false) {
    throw new Error('This passkey provider cannot unlock encrypted data. Try a different provider or use your master password.');
  }
  return { version: 1, origin: location.origin, credentialId: encode(new Uint8Array(credential.rawId)), input: encode(randomBytes()) };
}

/** WebAuthn runs on the page; transfer these bytes straight to the vault worker. */
export async function readPasskeyOutput(passkey: PasskeyIdentity): Promise<ArrayBuffer> {
  if (!canUsePasskey() || passkey.origin !== location.origin) {
    throw new Error('This passkey cannot be used on this browser or site. Use your master password.');
  }
  const credential = await navigator.credentials.get({ publicKey: {
    challenge: randomBytes(),
    allowCredentials: [{ type: 'public-key', id: decode(passkey.credentialId) }],
    timeout: 60_000,
    userVerification: 'required',
    extensions: { prf: { eval: { first: decode(passkey.input) } } },
  } });
  if (!(credential instanceof PublicKeyCredential)) throw new Error('Passkey verification was cancelled.');
  const output = credential.getClientExtensionResults().prf?.results?.first;
  if (!(output instanceof ArrayBuffer) || output.byteLength !== 32 || encode(new Uint8Array(credential.rawId)) !== passkey.credentialId) {
    if (output instanceof ArrayBuffer) new Uint8Array(output).fill(0);
    throw new Error('The selected passkey could not unlock encrypted data. Try a compatible passkey or use your master password.');
  }
  return output;
}
