import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { runMigrations } from '../db/migrations';
import { insertSealedConnections } from './repository';
import { VaultManager } from './vault';
import { buildGaleonPreview, prepareGaleonImport } from './galeonImport';
import { S3Client } from '../s3/client';
import type { AppDB } from '../db/client';

/**
 * End-to-end proof that a Galeon export becomes a *working* connection.
 *
 * The chain under test is the real one: Galeon's file format → the parser and
 * mapper → the vault's AES-GCM sealing → a `profiles` row → SigV4-signed S3
 * requests. The last step is what makes it worth running: a row that imports
 * cleanly but cannot sign a request is not a working connection.
 */

const ACCESS_KEY = 'AKIAIMPORTKEY0000';
const SECRET_KEY = 'import-secret-key';
const BUCKET = 'imported-bucket';

let server: ReturnType<typeof Bun.serve>;
let port = 0;
let lastAuthorization: string | null = null;

const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>${BUCKET}</Name><KeyCount>2</KeyCount><IsTruncated>false</IsTruncated>
  <Contents><Key>reports/q3.csv</Key><LastModified>2026-01-02T10:00:00.000Z</LastModified>
    <ETag>&quot;etag-1&quot;</ETag><Size>2048</Size><StorageClass>STANDARD</StorageClass></Contents>
  <Contents><Key>reports/q4.csv</Key><LastModified>2026-01-03T10:00:00.000Z</LastModified>
    <ETag>&quot;etag-2&quot;</ETag><Size>4096</Size><StorageClass>GLACIER</StorageClass></Contents>
</ListBucketResult>`;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      lastAuthorization = request.headers.get('authorization');
      const url = new URL(request.url);
      if (url.searchParams.get('list-type') === '2') {
        return new Response(LIST_XML, {
          headers: { 'Content-Type': 'application/xml' },
        });
      }
      return new Response('NotImplemented', { status: 501 });
    },
  });
  port = server.port ?? 0;
});

afterAll(async () => {
  await server.stop(true);
});

/** The export Galeon writes: camelCase, secrets included, one S3 profile. */
function galeonExport(endpoint: string): string {
  return JSON.stringify({
    format: 'galeon.profiles',
    version: 1,
    exportedAt: '2026-01-05T09:00:00Z',
    includesSecrets: true,
    profiles: [
      {
        id: 'galeon-profile-1',
        name: 'Imported MinIO',
        protocol: 's3',
        endpoint,
        region: 'us-east-1',
        accessKey: ACCESS_KEY,
        secretKey: SECRET_KEY,
        bucket: BUCKET,
        dangerDisableSslVerification: false,
        useVirtualHostStyle: null,
        hasSavedCredentials: true,
      },
    ],
  });
}

describe('Galeon import end to end', () => {
  test('a Galeon export becomes a sealed row that can sign a real S3 request', async () => {
    const db = await PGlite.create(undefined, { extensions: { pg_trgm } });
    await runMigrations(db);
    // The app talks to PGlite through a worker; in-process PGlite satisfies the
    // same query/transaction surface, so the cast is the test boundary.
    const appDb = db as unknown as AppDB;
    const { vault } = await VaultManager.create('correct horse battery staple');

    const text = galeonExport(`127.0.0.1:${port}`);

    // 1. Preview: the main thread would render exactly this, and it must be
    //    free of credential material.
    const preview = await buildGaleonPreview(text);
    expect(preview.total).toBe(1);
    expect(preview.importable).toHaveLength(1);
    expect(preview.skipped).toEqual([]);
    expect(preview.includesSecrets).toBe(true);
    expect(JSON.stringify(preview)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(preview)).not.toContain(ACCESS_KEY);
    expect(preview.importable[0]?.endpoint).toBe(`http://127.0.0.1:${port}`);

    // 2. Prepare: the worker seals the credentials. Same result, verified
    //    against the hash the preview handed out.
    const prepared = await prepareGaleonImport(
      text,
      preview.contentHash,
      (credentials) => vault.encryptCredentials(credentials),
    );
    expect(prepared.rows).toHaveLength(1);
    expect(JSON.stringify(prepared.rows)).not.toContain(SECRET_KEY);
    expect(prepared.contentHash).toBe(preview.contentHash);

    const count = await insertSealedConnections(appDb, prepared.rows);
    expect(count).toBe(1);

    // 3. The row is a normal connection: read it back the way the app does.
    const rows = await db.query<{
      name: string;
      endpoint: string;
      region: string;
      bucket: string;
      path_style: boolean;
      encrypted_credentials: unknown;
    }>('SELECT * FROM profiles');
    const row = rows.rows[0]!;
    expect(row.name).toBe('Imported MinIO');
    expect(row.bucket).toBe(BUCKET);
    expect(row.endpoint).toBe(`http://127.0.0.1:${port}`);
    // An IP endpoint cannot use virtual-hosted addressing, so the mapper must
    // have chosen path-style even though Galeon left the flag unset.
    expect(row.path_style).toBe(true);

    // 4. The sealed blob decrypts back to exactly the exported keys.
    const sealed = (
      typeof row.encrypted_credentials === 'string'
        ? JSON.parse(row.encrypted_credentials)
        : row.encrypted_credentials
    ) as Parameters<VaultManager['decryptCredentials']>[0];
    const decrypted = await vault.decryptCredentials(sealed);
    expect(decrypted.accessKeyId).toBe(ACCESS_KEY);
    expect(decrypted.secretAccessKey).toBe(SECRET_KEY);

    // 5. And it actually works: the imported row and its sealed keys list the
    //    bucket through the real S3 client, including the XML response parsing.
    const client = new S3Client({
      endpoint: row.endpoint,
      region: row.region,
      bucket: row.bucket,
      pathStyle: row.path_style,
      accessKeyId: decrypted.accessKeyId,
      secretAccessKey: decrypted.secretAccessKey,
    });
    const listing = await client.listObjects('', { maxKeys: 10 });

    expect(listing.objects.map((o) => o.key)).toEqual(['reports/q3.csv', 'reports/q4.csv']);
    expect(listing.objects[0]?.size).toBe(2048);
    expect(listing.objects[1]?.storageClass).toBe('GLACIER');
    expect(lastAuthorization).toContain('AWS4-HMAC-SHA256');
    expect(lastAuthorization).toContain(ACCESS_KEY);
    expect(lastAuthorization).toContain('/us-east-1/s3/aws4_request');

    vault.lock();
    await db.close();
  });

  test('a file swapped after the preview is refused', async () => {
    const db = await PGlite.create(undefined, { extensions: { pg_trgm } });
    await runMigrations(db);
    const { vault } = await VaultManager.create('another passphrase');

    const original = galeonExport(`127.0.0.1:${port}`);
    const preview = await buildGaleonPreview(original);

    // The user picks a different file (or the file changes on disk) between
    // preview and confirm.
    const swapped = original.replace('Imported MinIO', 'Swapped In');

    await expect(
      prepareGaleonImport(swapped, preview.contentHash, (credentials) =>
        vault.encryptCredentials(credentials),
      ),
    ).rejects.toThrow(/changed after the preview/);

    // Nothing was written, so there is no half-applied import to clean up.
    const rows = await db.query('SELECT * FROM profiles');
    expect(rows.rows).toHaveLength(0);

    vault.lock();
    await db.close();
  });

  test('profiles without credentials are reported, not imported', async () => {
    const db = await PGlite.create(undefined, { extensions: { pg_trgm } });
    await runMigrations(db);
    // The app talks to PGlite through a worker; in-process PGlite satisfies the
    // same query/transaction surface, so the cast is the test boundary.
    const appDb = db as unknown as AppDB;
    const { vault } = await VaultManager.create('third passphrase');

    // Exactly what Galeon writes when the user does not tick "include secrets".
    const text = JSON.stringify({
      format: 'galeon.profiles',
      version: 1,
      includesSecrets: false,
      profiles: [
        {
          id: 'p1',
          name: 'No keys',
          protocol: 's3',
          endpoint: 'https://s3.example.com',
          region: 'us-east-1',
          bucket: 'some-bucket',
          hasSavedCredentials: true,
        },
      ],
    });

    const preview = await buildGaleonPreview(text);
    expect(preview.includesSecrets).toBe(false);
    expect(preview.importable).toHaveLength(0);
    expect(preview.skipped[0]?.reason).toMatch(/include credentials/);

    const prepared = await prepareGaleonImport(
      text,
      preview.contentHash,
      (credentials) => vault.encryptCredentials(credentials),
    );
    expect(prepared.rows).toHaveLength(0);
    expect(await insertSealedConnections(appDb, prepared.rows)).toBe(0);

    const rows = await db.query('SELECT * FROM profiles');
    expect(rows.rows).toHaveLength(0);

    vault.lock();
    await db.close();
  });
});
