import type { EncryptedPayload } from './crypto';
import type { CredentialPlaintext } from './protocol';
import { canUseVirtualHosting, normalizeEndpoint } from '../s3/url';
import { assertConnectionEndpoint } from '../s3/endpoint';
import { sha256Hex } from '../lib/hash';

/**
 * Reading Galeon profile exports.
 *
 * Galeon writes a `galeon.profiles` document (its `profile_io` module):
 *
 *   { "format": "galeon.profiles", "version": 1, "exportedAt": "...",
 *     "includesSecrets": true,
 *     "profiles": [ { "id": "…", "name": "Prod", "protocol": "s3",
 *                     "endpoint": "https://…", "region": "us-east-1",
 *                     "accessKey": "…", "secretKey": "…", "bucket": "…" } ] }
 *
 * Field names are camelCase because Galeon serializes with serde's
 * `rename_all = "camelCase"`. The same module also accepts a bare profiles
 * array and a `config.json` snapshot (`{ "profiles": [...] }`), so this
 * reader accepts those two shapes too rather than making the user re-export.
 *
 * Secrets only ever appear in a Galeon export when the user asked for them
 * ("include secrets" / keyring export). Everything here is pure and I/O-free
 * so it can be unit-tested; the calling worker is responsible for encrypting
 * the credentials and never returns them to the main thread.
 */

export const GALEON_EXPORT_FORMAT = 'galeon.profiles' as const;
export const GALEON_SUPPORTED_VERSION = 1 as const;

/** Mirrors the limits Galeon's own importer enforces. */
export const MAX_IMPORT_PROFILES = 500;
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;

/** The subset of Galeon's `ConnectionProfile` that an S3 import cares about. */
export interface GaleonProfile {
  id?: string;
  name?: string;
  protocol?: string | null;
  endpoint?: string | null;
  region?: string | null;
  accessKey?: string | null;
  secretKey?: string | null;
  sessionToken?: string | null;
  bucket?: string | null;
  storageClass?: string | null;
  dangerDisableSslVerification?: boolean | null;
  useVirtualHostStyle?: boolean | null;
  hasSavedCredentials?: boolean | null;
}

export interface GaleonExportFile {
  format?: string;
  version?: number;
  exportedAt?: string;
  includesSecrets?: boolean;
  profiles: GaleonProfile[];
}

/** One profile that can be imported, with anything the user should know. */
export interface GaleonPreviewEntry {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  storageClass: string | null;
  notes: string[];
}

/** One profile that cannot be imported, and exactly why. */
export interface GaleonSkippedEntry {
  name: string;
  reason: string;
}

export interface GaleonImportPreview {
  /** SHA-256 of the file text, so confirm can detect a swapped file. */
  contentHash: string;
  total: number;
  importable: GaleonPreviewEntry[];
  skipped: GaleonSkippedEntry[];
  includesSecrets: boolean;
}

export type GaleonMapped =
  | {
      status: 'ready';
      entry: GaleonPreviewEntry;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    }
  | { status: 'skipped'; skipped: GaleonSkippedEntry };

export interface PreparedConnectionRow {
  id: string;
  name: string;
  protocol: 's3';
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  encryptedCredentials: EncryptedPayload;
  storageClass: string | null;
}

export interface GaleonImportPrepareResult {
  contentHash: string;
  rows: PreparedConnectionRow[];
  skipped: GaleonSkippedEntry[];
}

const DEFAULT_REGION = 'us-east-1';

function trimmedOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Parses any of the three shapes Galeon accepts.
 *
 * Throws with a human-readable message for a file we cannot read at all
 * (garbage, wrong format, newer version, too large, too many profiles).
 */
export function parseGaleonExportFile(raw: string): GaleonExportFile {
  const text = raw.trim().replace(/^\uFEFF/, '');

  if (text.length === 0) {
    throw new Error('The Galeon export file is empty.');
  }
  if (byteLength(text) > MAX_IMPORT_FILE_BYTES) {
    throw new Error(
      `The file is larger than ${Math.floor(MAX_IMPORT_FILE_BYTES / (1024 * 1024))} MB, which is beyond what Galeon itself exports.`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }

  if (Array.isArray(value)) {
    return finish({ profiles: value as GaleonProfile[] }, 'profiles array');
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected a Galeon export document or a profiles array.');
  }

  const record = value as Record<string, unknown>;

  // Enforce the format even on the looser config-snapshot path, like Galeon does.
  if (typeof record.format === 'string' && record.format.length > 0) {
    if (record.format !== GALEON_EXPORT_FORMAT) {
      throw new Error(
        `Unsupported export format "${record.format}". Expected "${GALEON_EXPORT_FORMAT}".`,
      );
    }
  }
  if (typeof record.version === 'number' && record.version > GALEON_SUPPORTED_VERSION) {
    throw new Error(
      `This file is version ${record.version}; Galiot understands up to version ${GALEON_SUPPORTED_VERSION}. Export again from your Galeon version.`,
    );
  }

  if (!Array.isArray(record.profiles)) {
    throw new Error('No "profiles" array found — this does not look like a Galeon export.');
  }

  return finish(
    {
      format: typeof record.format === 'string' ? record.format : undefined,
      version: typeof record.version === 'number' ? record.version : undefined,
      includesSecrets: record.includesSecrets === true,
      profiles: record.profiles as GaleonProfile[],
    },
    'export document',
  );
}

function finish(file: GaleonExportFile, shape: string): GaleonExportFile {
  if (file.profiles.length > MAX_IMPORT_PROFILES) {
    throw new Error(
      `This ${shape} contains ${file.profiles.length} profiles; the maximum is ${MAX_IMPORT_PROFILES}.`,
    );
  }
  if (file.profiles.some((profile) => typeof profile !== 'object' || profile === null)) {
    throw new Error('One of the entries in the profiles array is not a profile object.');
  }
  return file;
}

/**
 * Maps one Galeon profile onto a Galiot connection.
 *
 * Galeon is a multi-protocol tool; Galiot is S3-only, so anything else is
 * skipped with a reason rather than silently dropped. Credentials are returned
 * separately from the (secret-free) preview entry so the caller can encrypt
 * them without ever building a preview that contains them.
 */
export function mapGaleonProfile(raw: GaleonProfile): GaleonMapped {
  const name = trimmedOrNull(raw.name) ?? 'Unnamed profile';
  const notes: string[] = [];
  const skip = (reason: string): GaleonMapped => ({ status: 'skipped', skipped: { name, reason } });

  const protocol = (trimmedOrNull(raw.protocol) ?? 's3').toLowerCase();
  if (protocol !== 's3') {
    return skip(`Galiot is S3-only, and this profile uses ${protocol.toUpperCase()}.`);
  }

  const bucket = trimmedOrNull(raw.bucket);
  if (!bucket) {
    return skip('No bucket is set on this profile.');
  }

  let region = trimmedOrNull(raw.region);
  if (!region) {
    region = DEFAULT_REGION;
    notes.push(`No region in the export; using ${DEFAULT_REGION}.`);
  }

  const rawEndpoint = trimmedOrNull(raw.endpoint);
  let endpoint: string;
  if (rawEndpoint) {
    if (/\s/.test(rawEndpoint)) {
      return skip('The endpoint contains whitespace.');
    }
    endpoint = normalizeEndpoint(rawEndpoint);
    try {
      assertConnectionEndpoint(endpoint);
    } catch {
      return skip('The endpoint is not a valid URL.');
    }
  } else {
    // Galeon treats a missing endpoint as "the AWS endpoint for this region".
    endpoint = `https://s3.${region}.amazonaws.com`;
    notes.push('No endpoint in the export; using the AWS endpoint for this region.');
  }

  // Galeon's `useVirtualHostStyle: true/false` forces the addressing; absent
  // means "SDK default", which is virtual-hosted on AWS and path-style on
  // self-hosted servers — so infer it from the endpoint instead of guessing.
  const virtualHostable = canUseVirtualHosting(endpoint);
  let pathStyle: boolean;
  if (raw.useVirtualHostStyle === true) {
    pathStyle = !virtualHostable;
    if (!virtualHostable) {
      notes.push(
        'Galeon used virtual-hosted addressing, but this endpoint is an IP or local host, so Galiot uses path-style.',
      );
    }
  } else if (raw.useVirtualHostStyle === false) {
    pathStyle = true;
  } else {
    pathStyle = !virtualHostable;
  }

  if (raw.dangerDisableSslVerification === true) {
    // Galeon forces this off on import for the same reason: an untrusted file
    // should not be able to turn off TLS verification for the user.
    notes.push('This profile disabled TLS verification in Galeon. Galiot always verifies TLS.');
  }

  const accessKeyId = trimmedOrNull(raw.accessKey);
  const secretAccessKey = trimmedOrNull(raw.secretKey);
  const sessionToken = trimmedOrNull(raw.sessionToken) ?? undefined;
  if (!accessKeyId || !secretAccessKey) {
    return skip(
      'No credentials in this export. In Galeon, re-export with "include credentials" checked, then import again.',
    );
  }

  const storageClass = trimmedOrNull(raw.storageClass);

  return {
    status: 'ready',
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    entry: { name, endpoint, region, bucket, pathStyle, storageClass, notes },
  };
}

/** Splits a parsed export into what can be imported and what cannot. */
export function partitionGaleonProfiles(
  file: GaleonExportFile,
): { ready: GaleonMapped[]; skipped: GaleonSkippedEntry[] } {
  const ready: GaleonMapped[] = [];
  const skipped: GaleonSkippedEntry[] = [];
  for (const profile of file.profiles) {
    const mapped = mapGaleonProfile(profile);
    if (mapped.status === 'ready') ready.push(mapped);
    else skipped.push(mapped.skipped);
  }
  return { ready, skipped };
}

/** True when any profile in the file carries credentials. */
export function galeonExportIncludesSecrets(file: GaleonExportFile): boolean {
  if (file.includesSecrets) return true;
  return file.profiles.some((profile) => {
    const protocol = (trimmedOrNull(profile.protocol) ?? 's3').toLowerCase();
    return (
      protocol === 's3' &&
      trimmedOrNull(profile.accessKey) !== null &&
      trimmedOrNull(profile.secretKey) !== null
    );
  });
}

/**
 * Parses the file and returns what can be imported, with no credential
 * material in the result. Safe to render: everything in here came out of
 * `GaleonPreviewEntry`, which has no key fields.
 */
export async function buildGaleonPreview(text: string): Promise<GaleonImportPreview> {
  const file = parseGaleonExportFile(text);
  const importable: GaleonPreviewEntry[] = [];
  const skipped: GaleonSkippedEntry[] = [];

  for (const profile of file.profiles) {
    const mapped = mapGaleonProfile(profile);
    if (mapped.status === 'ready') importable.push(mapped.entry);
    else skipped.push(mapped.skipped);
  }

  return {
    contentHash: await sha256Hex(text),
    total: file.profiles.length,
    importable,
    skipped,
    includesSecrets: galeonExportIncludesSecrets(file),
  };
}

/**
 * Encrypts each importable profile's credentials and returns insertable rows.
 *
 * `encrypt` is supplied by the vault worker so the plaintext keys are sealed
 * without this module — or the caller's return value — ever holding them. The
 * `expectedHash` check closes the gap between preview and confirm: a file
 * swapped on disk in between is rejected instead of silently imported.
 */
export async function prepareGaleonImport(
  text: string,
  expectedHash: string,
  encrypt: (credentials: CredentialPlaintext) => Promise<EncryptedPayload>,
  newId: () => string = () => crypto.randomUUID(),
): Promise<GaleonImportPrepareResult> {
  const file = parseGaleonExportFile(text);
  const contentHash = await sha256Hex(text);
  if (contentHash !== expectedHash) {
    throw new Error(
      'The file changed after the preview was shown. Select it again and review the new preview.',
    );
  }

  const rows: PreparedConnectionRow[] = [];
  const skipped: GaleonSkippedEntry[] = [];

  for (const profile of file.profiles) {
    const mapped = mapGaleonProfile(profile);
    if (mapped.status !== 'ready') {
      skipped.push(mapped.skipped);
      continue;
    }

    const encryptedCredentials = await encrypt({
      accessKeyId: mapped.accessKeyId,
      secretAccessKey: mapped.secretAccessKey,
      ...(mapped.sessionToken ? { sessionToken: mapped.sessionToken } : {}),
    });

    rows.push({
      id: newId(),
      name: mapped.entry.name,
      protocol: 's3',
      endpoint: mapped.entry.endpoint,
      region: mapped.entry.region,
      bucket: mapped.entry.bucket,
      pathStyle: mapped.entry.pathStyle,
      storageClass: mapped.entry.storageClass,
      encryptedCredentials,
    });
  }

  return { contentHash, rows, skipped };
}
