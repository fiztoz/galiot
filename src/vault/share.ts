import type { ConnectionRow } from '../db/client';
import { parseStoredHeaders } from '../s3/customHeaders';

/**
 * Share one connection without its secrets.
 *
 * The payload carries only what a colleague needs to point at the same bucket:
 * endpoint, region, bucket, addressing, and the screened custom headers. Keys
 * are never included — the recipient types their own. Sharing keys is a
 * different decision with a different tool: the ciphertext-only vault backup
 * (Vault settings), which moves a whole vault under its passphrase.
 */

export const CONNECTION_SHARE_KIND = 'galiot.connection' as const;

export interface ConnectionShare {
  kind: typeof CONNECTION_SHARE_KIND;
  version: 1;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  headers: Record<string, string>;
}

export function buildConnectionShare(profile: ConnectionRow): ConnectionShare {
  return {
    kind: CONNECTION_SHARE_KIND,
    version: 1,
    name: profile.name,
    endpoint: profile.endpoint,
    region: profile.region,
    bucket: profile.bucket,
    pathStyle: profile.path_style,
    headers: parseStoredHeaders(profile.custom_headers),
  };
}

export function connectionShareText(profile: ConnectionRow): string {
  return JSON.stringify(buildConnectionShare(profile), null, 2);
}

/**
 * Parses a shared connection. Rejects anything that is not exactly this shape,
 * and re-screens headers rather than trusting the file. A payload that somehow
 * contains credential-looking fields is refused outright, so a hand-edited
 * "share" cannot smuggle keys into a form that looks secret-free.
 */
export function parseConnectionShare(text: string): ConnectionShare {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('This is not JSON. Paste the contents of a Galiot connection file.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('This is not a Galiot connection file.');
  }
  const row = parsed as Record<string, unknown>;
  if (row.kind !== CONNECTION_SHARE_KIND || row.version !== 1) {
    throw new Error('This is not a Galiot connection file (wrong kind or version).');
  }
  for (const forbidden of ['accessKeyId', 'secretAccessKey', 'sessionToken', 'encrypted_credentials', 'credentials']) {
    if (forbidden in row) {
      throw new Error('This file contains credential fields. Connection shares must not carry keys — refusing it.');
    }
  }
  const str = (value: unknown, name: string, max: number): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > max) {
      throw new Error(`The connection file's ${name} is missing or invalid.`);
    }
    return value;
  };
  const endpoint = str(row.endpoint, 'endpoint', 2048);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('The connection file has an invalid endpoint URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The endpoint must be http or https.');
  }
  return {
    kind: CONNECTION_SHARE_KIND,
    version: 1,
    name: str(row.name, 'name', 128),
    endpoint,
    region: str(row.region, 'region', 64),
    bucket: str(row.bucket, 'bucket', 255),
    pathStyle: row.pathStyle === true,
    headers: parseStoredHeaders(row.headers),
  };
}
