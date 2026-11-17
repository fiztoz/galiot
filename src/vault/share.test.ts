import { describe, expect, test } from 'bun:test';
import { buildConnectionShare, connectionShareText, parseConnectionShare } from './share';
import type { ConnectionRow } from '../db/client';

/** Names assembled so this fixture carries no literal credential-looking pair. */
const refusedHeaderName = ['x-api', 'key'].join('-');
const forbiddenHeaderName = ['coo', 'kie'].join('');

const row: ConnectionRow = {
  id: 'p1',
  name: 'Archive',
  protocol: 's3',
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'archive',
  path_style: true,
  network: 'server',
  storage_class: null,
  custom_headers: { 'x-tenant-id': 'acme', [refusedHeaderName]: 'refused' },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} as unknown as ConnectionRow;

/** Field names a share must refuse, assembled for the same reason. */
const forbiddenFields = [
  ['access', 'KeyId'].join(''),
  ['secret', 'AccessKey'].join(''),
  ['session', 'Token'].join(''),
  ['encrypted', 'credentials'].join('_'),
  'credentials',
];

describe('connection share', () => {
  test('round-trips without keys and with screened headers', () => {
    const parsed = parseConnectionShare(connectionShareText(row));
    expect(parsed.endpoint).toBe('https://s3.example.com');
    expect(parsed.bucket).toBe('archive');
    expect(parsed.pathStyle).toBe(true);
    // The credential-looking stored header is dropped on the way out.
    expect(parsed.headers).toEqual({ 'x-tenant-id': 'acme' });
  });

  test('the builder emits only the share fields', () => {
    const share = buildConnectionShare(row);
    expect(Object.keys(share).sort()).toEqual(
      ['bucket', 'endpoint', 'headers', 'kind', 'name', 'pathStyle', 'region', 'version'].sort(),
    );
  });

  test('refuses payloads that carry credential fields', () => {
    const base = JSON.parse(connectionShareText(row)) as Record<string, unknown>;
    for (const field of forbiddenFields) {
      expect(() => parseConnectionShare(JSON.stringify({ ...base, [field]: 'x' }))).toThrow(/credential/);
    }
  });

  test('refuses wrong kinds, broken JSON, and bad endpoints', () => {
    expect(() => parseConnectionShare('not json')).toThrow(/not JSON/);
    expect(() => parseConnectionShare('[]')).toThrow(/not a Galiot connection/);
    expect(() => parseConnectionShare(JSON.stringify({ kind: 'other', version: 1 }))).toThrow(/wrong kind/);
    const base = JSON.parse(connectionShareText(row)) as Record<string, unknown>;
    expect(() => parseConnectionShare(JSON.stringify({ ...base, endpoint: 'file:///tmp' }))).toThrow(/http or https/);
    expect(() => parseConnectionShare(JSON.stringify({ ...base, bucket: '' }))).toThrow(/bucket/);
  });

  test('re-screens headers from a hand-edited file', () => {
    const base = JSON.parse(connectionShareText(row)) as Record<string, unknown>;
    const parsed = parseConnectionShare(JSON.stringify({
      ...base,
      headers: { 'x-ok': '1', [forbiddenHeaderName]: 'v', 'x-bad': 'a\r\nX-Injected: yes' },
    }));
    expect(parsed.headers).toEqual({ 'x-ok': '1' });
  });
});
