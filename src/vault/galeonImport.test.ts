import { describe, expect, test } from 'bun:test';
import {
  GALEON_EXPORT_FORMAT,
  MAX_IMPORT_PROFILES,
  buildGaleonPreview,
  galeonExportIncludesSecrets,
  mapGaleonProfile,
  parseGaleonExportFile,
  partitionGaleonProfiles,
  prepareGaleonImport,
  type GaleonProfile,
} from './galeonImport';

/**
 * Fixtures mirror Galeon's own serializer: `#[serde(rename_all = "camelCase")]`
 * on ConnectionProfile, with `skip_serializing_if = "Option::is_none"` — so
 * absent optional fields are genuinely absent keys, not nulls.
 */
function s3Profile(overrides: Partial<GaleonProfile> = {}): GaleonProfile {
  return {
    id: 'p1',
    name: 'Prod',
    protocol: 's3',
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    accessKey: 'AKIAEXAMPLE',
    secretKey: 'super-secret',
    bucket: 'my-bucket',
    dangerDisableSslVerification: false,
    useVirtualHostStyle: null,
    hasSavedCredentials: true,
    ...overrides,
  };
}

function envelope(profiles: GaleonProfile[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: GALEON_EXPORT_FORMAT,
    version: 1,
    exportedAt: '2026-01-01T00:00:00Z',
    includesSecrets: true,
    profiles,
    ...extra,
  });
}

describe('parseGaleonExportFile', () => {
  test('reads the canonical galeon.profiles envelope', () => {
    const file = parseGaleonExportFile(envelope([s3Profile()]));
    expect(file.format).toBe('galeon.profiles');
    expect(file.version).toBe(1);
    expect(file.profiles).toHaveLength(1);
    expect(file.profiles[0]?.name).toBe('Prod');
  });

  test('reads a bare profiles array (a shape Galeon accepts)', () => {
    const file = parseGaleonExportFile(JSON.stringify([s3Profile({ name: 'From Array' })]));
    expect(file.profiles).toHaveLength(1);
    expect(file.profiles[0]?.name).toBe('From Array');
  });

  test('reads a config.json snapshot with other keys alongside', () => {
    const snapshot = JSON.stringify({
      profiles: [s3Profile({ name: 'Cfg' })],
      presignHistory: [],
    });
    const file = parseGaleonExportFile(snapshot);
    expect(file.profiles[0]?.name).toBe('Cfg');
  });

  test('tolerates a BOM and surrounding whitespace', () => {
    const file = parseGaleonExportFile(`\uFEFF\n  ${envelope([s3Profile()])}  \n`);
    expect(file.profiles).toHaveLength(1);
  });

  test('rejects empty, blank and non-JSON input', () => {
    expect(() => parseGaleonExportFile('')).toThrow(/empty/i);
    expect(() => parseGaleonExportFile('   \n ')).toThrow(/empty/i);
    expect(() => parseGaleonExportFile('not-json')).toThrow(/not valid JSON/i);
  });

  test('rejects JSON that is not a profile export', () => {
    expect(() => parseGaleonExportFile('{"foo":1}')).toThrow(/profiles/i);
    expect(() => parseGaleonExportFile('"a string"')).toThrow(/profiles array|export document/i);
    expect(() => parseGaleonExportFile('42')).toThrow(/profiles array|export document/i);
  });

  test('rejects a foreign format even on the snapshot path', () => {
    const json = JSON.stringify({
      format: 'evil.app',
      profiles: [s3Profile()],
    });
    expect(() => parseGaleonExportFile(json)).toThrow(/Unsupported export format/);
  });

  test('rejects a newer version rather than guessing at its fields', () => {
    const json = envelope([s3Profile()], { version: 2 });
    expect(() => parseGaleonExportFile(json)).toThrow(/version 2/);
  });

  test('accepts version 0/absent, as Galeon does for older files', () => {
    const zero = envelope([s3Profile()], { version: 0 });
    expect(parseGaleonExportFile(zero).profiles).toHaveLength(1);
  });

  test('rejects more profiles than Galeon itself would export', () => {
    const many = Array.from({ length: MAX_IMPORT_PROFILES + 1 }, (_, i) =>
      s3Profile({ name: `p${i}` }),
    );
    expect(() => parseGaleonExportFile(envelope(many))).toThrow(/maximum is 500/);
  });

  test('rejects a file over the 5 MB limit', () => {
    const padded = envelope([s3Profile({ name: 'x'.repeat(6 * 1024 * 1024) })]);
    expect(() => parseGaleonExportFile(padded)).toThrow(/larger than 5 MB/);
  });

  test('rejects a profiles array containing non-objects', () => {
    expect(() => parseGaleonExportFile('{"profiles":["nope"]}')).toThrow(/not a profile object/);
  });
});

describe('mapGaleonProfile', () => {
  test('maps a complete S3 profile', () => {
    const mapped = mapGaleonProfile(s3Profile());
    expect(mapped.status).toBe('ready');
    if (mapped.status !== 'ready') return;
    expect(mapped.entry).toMatchObject({
      name: 'Prod',
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
      bucket: 'my-bucket',
      storageClass: null,
    });
    expect(mapped.entry.notes).toEqual([]);
    expect(mapped.accessKeyId).toBe('AKIAEXAMPLE');
    expect(mapped.secretAccessKey).toBe('super-secret');
  });

  test('carries storageClass through when Galeon set one', () => {
    const mapped = mapGaleonProfile(s3Profile({ storageClass: 'GLACIER' }));
    expect(mapped.status === 'ready' && mapped.entry.storageClass).toBe('GLACIER');
  });

  test('defaults a missing protocol to s3, matching Galeon', () => {
    const mapped = mapGaleonProfile(s3Profile({ protocol: undefined }));
    expect(mapped.status).toBe('ready');
  });

  test('skips non-S3 protocols with a clear reason', () => {
    for (const protocol of ['sftp', 'ftp', 'ftps']) {
      const mapped = mapGaleonProfile(s3Profile({ protocol, name: 'Tunneled' }));
      expect(mapped.status).toBe('skipped');
      if (mapped.status === 'skipped') {
        expect(mapped.skipped.reason).toContain(protocol.toUpperCase());
        expect(mapped.skipped.name).toBe('Tunneled');
      }
    }
  });

  test('requires a bucket', () => {
    const mapped = mapGaleonProfile(s3Profile({ bucket: null }));
    expect(mapped.status === 'skipped' && mapped.skipped.reason).toMatch(/bucket/i);
  });

  test('skips profiles whose credentials were not exported', () => {
    const withoutSecrets = mapGaleonProfile(
      s3Profile({ accessKey: undefined, secretKey: undefined, hasSavedCredentials: true }),
    );
    expect(withoutSecrets.status).toBe('skipped');
    if (withoutSecrets.status === 'skipped') {
      expect(withoutSecrets.skipped.reason).toMatch(/include credentials/i);
    }
  });

  test('skips a half-present credential pair', () => {
    const onlyKey = mapGaleonProfile(s3Profile({ secretKey: undefined }));
    expect(onlyKey.status).toBe('skipped');
    const onlySecret = mapGaleonProfile(s3Profile({ accessKey: undefined }));
    expect(onlySecret.status).toBe('skipped');
  });

  test('treats empty-string credentials as absent', () => {
    const mapped = mapGaleonProfile(s3Profile({ accessKey: '', secretKey: '   ' }));
    expect(mapped.status).toBe('skipped');
  });

  test('infers the AWS endpoint when the export has none, and says so', () => {
    const mapped = mapGaleonProfile(
      s3Profile({ endpoint: null, region: 'eu-west-1' }),
    );
    expect(mapped.status).toBe('ready');
    if (mapped.status !== 'ready') return;
    expect(mapped.entry.endpoint).toBe('https://s3.eu-west-1.amazonaws.com');
    expect(mapped.entry.notes.join(' ')).toMatch(/AWS endpoint/);
  });

  test('defaults a missing region to us-east-1 and flags it', () => {
    const mapped = mapGaleonProfile(s3Profile({ region: null }));
    expect(mapped.status === 'ready' && mapped.entry.region).toBe('us-east-1');
    expect(mapped.status === 'ready' && mapped.entry.notes.join(' ')).toMatch(/region/i);
  });

  test('adds a scheme to a bare endpoint and defaults self-hosted hosts to http', () => {
    const bare = mapGaleonProfile(s3Profile({ endpoint: 's3.example.com' }));
    expect(bare.status === 'ready' && bare.entry.endpoint).toBe('https://s3.example.com');

    // Matches the connection dialog: loopback, .local/.internal names and
    // RFC1918 addresses are conventionally plain HTTP (MinIO, LocalStack).
    const minio = mapGaleonProfile(s3Profile({ endpoint: 'minio.local:9000' }));
    expect(minio.status === 'ready' && minio.entry.endpoint).toBe('http://minio.local:9000');

    const lan = mapGaleonProfile(s3Profile({ endpoint: '192.168.1.10:9000' }));
    expect(lan.status === 'ready' && lan.entry.endpoint).toBe('http://192.168.1.10:9000');
  });

  test('rejects an endpoint with whitespace or no host', () => {
    const spaced = mapGaleonProfile(s3Profile({ endpoint: 'https://s3 example com' }));
    expect(spaced.status === 'skipped' && spaced.skipped.reason).toMatch(/whitespace/);

    const noHost = mapGaleonProfile(s3Profile({ endpoint: 'https://' }));
    expect(noHost.status).toBe('skipped');
  });

  test('honours an explicit path-style choice from Galeon', () => {
    const mapped = mapGaleonProfile(s3Profile({ useVirtualHostStyle: false }));
    expect(mapped.status === 'ready' && mapped.entry.pathStyle).toBe(true);
  });

  test('honours explicit virtual-hosted style on a DNS-capable endpoint', () => {
    const mapped = mapGaleonProfile(s3Profile({ useVirtualHostStyle: true }));
    expect(mapped.status === 'ready' && mapped.entry.pathStyle).toBe(false);
  });

  test('keeps virtual-hosted off for IP endpoints and explains why', () => {
    const mapped = mapGaleonProfile(
      s3Profile({ endpoint: 'http://127.0.0.1:9000', useVirtualHostStyle: true }),
    );
    expect(mapped.status === 'ready' && mapped.entry.pathStyle).toBe(true);
    expect(mapped.status === 'ready' && mapped.entry.notes.join(' ')).toMatch(/path-style/);
  });

  test('infers path-style for an IP endpoint when Galeon left it unset', () => {
    const mapped = mapGaleonProfile(
      s3Profile({ endpoint: 'http://192.168.1.10:9000', useVirtualHostStyle: null }),
    );
    expect(mapped.status === 'ready' && mapped.entry.pathStyle).toBe(true);
  });

  test('flags — but does not import — Galeon TLS verification bypass', () => {
    const mapped = mapGaleonProfile(
      s3Profile({ dangerDisableSslVerification: true }),
    );
    expect(mapped.status).toBe('ready');
    if (mapped.status !== 'ready') return;
    expect(mapped.entry.notes.join(' ')).toMatch(/TLS verification/i);
  });

  test('falls back to a name for an unnamed profile', () => {
    const mapped = mapGaleonProfile(s3Profile({ name: '  ' }));
    expect(mapped.status === 'ready' && mapped.entry.name).toBe('Unnamed profile');
  });

  test('carries optional sessionToken through prepare without exposing it in preview', async () => {
    const raw = envelope([s3Profile({ sessionToken: 'sts-session-token-value' })]);
    const preview = await buildGaleonPreview(raw);
    expect(preview.importable).toHaveLength(1);
    expect(JSON.stringify(preview)).not.toContain('sts-session-token-value');

    let capturedCreds: unknown = null;
    const prepared = await prepareGaleonImport(raw, preview.contentHash, async (creds) => {
      capturedCreds = creds;
      return { iv: 'iv', ct: 'ct' } as never;
    });
    expect(prepared.rows).toHaveLength(1);
    expect(capturedCreds).toEqual({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'super-secret',
      sessionToken: 'sts-session-token-value',
    });
  });
});

describe('partitionGaleonProfiles', () => {
  test('splits a mixed file into importable and skipped, preserving order', () => {
    const file = parseGaleonExportFile(
      envelope([
        s3Profile({ name: 'Prod' }),
        s3Profile({ name: 'SFTP box', protocol: 'sftp', secretKey: 'pw' }),
        s3Profile({ name: 'Staging', bucket: 'staging-bucket' }),
        s3Profile({ name: 'No creds', accessKey: undefined, secretKey: undefined }),
      ]),
    );
    const { ready, skipped } = partitionGaleonProfiles(file);
    expect(ready.map((r) => (r.status === 'ready' ? r.entry.name : '?'))).toEqual([
      'Prod',
      'Staging',
    ]);
    expect(skipped.map((s) => s.name)).toEqual(['SFTP box', 'No creds']);
  });

  test('an empty profiles array is valid and yields nothing', () => {
    const { ready, skipped } = partitionGaleonProfiles(parseGaleonExportFile(envelope([])));
    expect(ready).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

describe('galeonExportIncludesSecrets', () => {
  test('trusts the envelope flag', () => {
    const file = parseGaleonExportFile(envelope([s3Profile()], { includesSecrets: true }));
    expect(galeonExportIncludesSecrets(file)).toBe(true);
  });

  test('detects credentials present despite a false flag', () => {
    const file = parseGaleonExportFile(envelope([s3Profile()], { includesSecrets: false }));
    expect(galeonExportIncludesSecrets(file)).toBe(true);
  });

  test('reports false when a credential-free export has no secrets', () => {
    const file = parseGaleonExportFile(
      envelope([s3Profile({ accessKey: undefined, secretKey: undefined })], {
        includesSecrets: false,
      }),
    );
    expect(galeonExportIncludesSecrets(file)).toBe(false);
  });
});
