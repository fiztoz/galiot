import type { ConnectionRow } from '../db/client';
import { parseStoredHeaders } from '../s3/customHeaders';
import { assertConnectionEndpoint } from '../s3/endpoint';
import { BRAND } from '../branding';

/**
 * Share one connection without its secrets.
 *
 * The payload carries only what a colleague needs to point at the same bucket:
 * endpoint, region, bucket and addressing. The sender can also select screened
 * routing headers. The recipient supplies their own S3 credentials.
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

export function buildConnectionShare(profile: ConnectionRow, includeHeaders = false): ConnectionShare {
  assertConnectionEndpoint(profile.endpoint);
  return {
    kind: CONNECTION_SHARE_KIND,
    version: 1,
    name: profile.name,
    endpoint: profile.endpoint,
    region: profile.region,
    bucket: profile.bucket,
    pathStyle: profile.path_style,
    headers: includeHeaders ? parseStoredHeaders(profile.custom_headers) : {},
  };
}

export function connectionShareText(profile: ConnectionRow, includeHeaders = false): string {
  return JSON.stringify(buildConnectionShare(profile, includeHeaders), null, 2);
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
    throw new Error(`This is not JSON. Paste the contents of a ${BRAND.name} connection file.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`This is not a ${BRAND.name} connection file.`);
  }
  const row = parsed as Record<string, unknown>;
  if (row.kind !== CONNECTION_SHARE_KIND || row.version !== 1) {
    throw new Error(`This is not a ${BRAND.name} connection file (wrong kind or version).`);
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
  assertConnectionEndpoint(endpoint);
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
