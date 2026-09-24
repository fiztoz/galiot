/**
 * Galiot performance benchmark (roadmap 5.3).
 *
 * Two halves:
 *  1. Local engine (no configuration required) — measures exactly what the UI
 *     does: bulk-load an object cache, then time the folder listing, the
 *     trigram search, and the recursive folder roll-up queries at 10k and
 *     100k rows.
 *  2. Live listing (optional) — with GALIOT_S3_* set, measures how fast the
 *     bucket itself lists keys, so the cache-backed numbers can be compared
 *     against a cold start.
 *
 * Usage: bun run bench [rowCount]
 */

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { runMigrations } from '../src/db/migrations';
import { buildObjectQuery, buildSubtreeSizeQuery, EMPTY_FILTERS } from '../src/db/queries';

const PROFILE_ID = '33333333-3333-4222-8222-333333333333';
const BUCKET = 'bench';

/** Formats a duration in milliseconds. */
function fmtMs(duration: number): string {
  return `${duration.toFixed(1)} ms`;
}

/** Milliseconds elapsed since a `performance.now()` timestamp. */
function since(start: number): string {
  return fmtMs(performance.now() - start);
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function seed(db: PGlite, rows: number): Promise<number> {
  const start = performance.now();
  const now = new Date().toISOString();

  await db.query(
    `INSERT INTO profiles
       (id, name, protocol, endpoint, region, bucket, path_style, encrypted_credentials, created_at, updated_at)
     VALUES ($1, 'bench', 's3', 'https://s3.example.com', 'us-east-1', $2, false, $3, $4, $4)
     ON CONFLICT (id) DO NOTHING`,
    [PROFILE_ID, BUCKET, JSON.stringify({ ciphertext: 'x', iv: 'y' }), now],
  );

  // Build the dataset first, then insert in batches: one statement per row is
  // dominated by round-trip overhead and would measure the harness, not PG.
  type Row = [string, string, string, string, number, string, string, boolean];
  const fileRows: Row[] = [];
  const dirKeys = new Map<string, string>();

  for (let i = 0; i < rows; i += 1) {
    const year = 2020 + (i % 6);
    const month = String((i % 12) + 1).padStart(2, '0');
    const inDocs = i % 17 === 0;
    const prefix = inDocs ? 'docs/' : `photos/${year}/${month}/`;
    const key = inDocs ? `docs/report-${i}.pdf` : `photos/${year}/${month}/img-${i}.jpg`;
    const size = 50_000 + ((i * 7919) % 5_000_000);
    const storageClass = i % 23 === 0 ? 'STANDARD_IA' : 'STANDARD';
    const modified = new Date(Date.UTC(year, i % 12, 1)).toISOString();

    fileRows.push([PROFILE_ID, BUCKET, key, prefix, key.slice(key.lastIndexOf('/') + 1), size, modified, storageClass]);

    if (!prefix.endsWith('/')) continue;
    // Remember both the month folder and its parent for the recursive roll-up.
    const parent = prefix.slice(0, prefix.lastIndexOf('/', prefix.length - 2));
    dirKeys.set(prefix, prefix.replace(/\/$/, '').split('/').pop() ?? prefix);
    if (parent) {
      dirKeys.set(parent, parent.split('/').pop() ?? parent);
    }
  }

  const dirRows: Row[] = [...dirKeys.entries()].map(([key, name]) => [
    PROFILE_ID,
    BUCKET,
    key,
    key.slice(0, key.lastIndexOf('/') + 1),
    name,
    0,
    now,
    false,
  ]);

  const BATCH = 500;

  const insertBatch = async (batch: Row[], isDir: boolean): Promise<void> => {
    if (batch.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const row of batch) {
      if (isDir) {
        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, true, 0, NULL)`);
        params.push(row[0], row[1], row[2], row[3], row[4]);
      } else {
        values.push(
          `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, false, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`,
        );
        params.push(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7]);
      }
    }

    await db.query(
      isDir
        ? `INSERT INTO objects_cache (profile_id, bucket, key, prefix, filename, is_dir, size, last_modified)
           VALUES ${values.join(', ')}`
        : `INSERT INTO objects_cache
             (profile_id, bucket, key, prefix, filename, is_dir, size, last_modified, storage_class)
           VALUES ${values.join(', ')}`,
      params,
    );
  };

  for (let offset = 0; offset < dirRows.length; offset += BATCH) {
    await insertBatch(dirRows.slice(offset, offset + BATCH), true);
  }
  for (let offset = 0; offset < fileRows.length; offset += BATCH) {
    await insertBatch(fileRows.slice(offset, offset + BATCH), false);
  }

  // Fresh statistics matter: without them the planner may ignore the indexes.
  await db.exec('ANALYZE objects_cache');

  return performance.now() - start;
}

async function timeQuery(db: PGlite, label: string, sql: string, params: unknown[], runs = 5): Promise<number> {
  // One warm-up run, then take the median of `runs`.
  await db.query(sql, params);
  const samples: number[] = [];

  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    await db.query(sql, params);
    samples.push(performance.now() - start);
  }

  if (process.env.BENCH_DEBUG) console.log(`      [debug] ${label}: ${samples.map((v) => v.toFixed(1)).join(', ')}`);
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] ?? 0;
  const worst = samples[samples.length - 1] ?? 0;
  console.log(
    `    ${label.padEnd(34)} median ${fmtMs(median).padStart(9)}   worst ${fmtMs(worst).padStart(9)}`,
  );
  return median;
}

async function benchLocal(rows: number): Promise<void> {
  console.log(`\n── Local engine: ${rows.toLocaleString()} objects ──`);

  const db = await PGlite.create(undefined, { extensions: { pg_trgm } });
  await runMigrations(db);

  const seedStart = performance.now();
  await seed(db, rows);
  const seedMs = performance.now() - seedStart;
  const heap = process.memoryUsage().heapUsed;

  console.log(`    seed (insert + dirs)              ${since(seedStart)}`.padEnd(60));
  console.log(
    `    throughput                          ${Math.round(rows / (seedMs / 1000)).toLocaleString()} objects/s`.padEnd(60),
  );
  console.log(`    heap after seed                    ${mb(heap)}`.padEnd(60));

  await timeQuery(db, 'sanity: SELECT 1', 'SELECT 1', []);

  const listing = buildObjectQuery({ profileId: PROFILE_ID, bucket: BUCKET, prefix: 'photos/2024/03/', filters: EMPTY_FILTERS });
  await timeQuery(db, 'folder listing (prefix =)', listing.query, listing.params);

  const search = buildObjectQuery({
    profileId: PROFILE_ID,
    bucket: BUCKET,
    prefix: '',
    filters: { ...EMPTY_FILTERS, search: 'img-900' },
  });
  await timeQuery(db, 'fuzzy search (ILIKE, trigram)', search.query, search.params);

  const filtered = buildObjectQuery({
    profileId: PROFILE_ID,
    bucket: BUCKET,
    prefix: '',
    filters: { ...EMPTY_FILTERS, minSize: 2_000_000, storageClass: 'STANDARD' },
  });
  await timeQuery(db, 'size + storage-class filters', filtered.query, filtered.params);

  const root = buildObjectQuery({ profileId: PROFILE_ID, bucket: BUCKET, prefix: '', filters: EMPTY_FILTERS });
  await timeQuery(db, 'bucket-root listing', root.query, root.params);

  const subtree = buildSubtreeSizeQuery({ profileId: PROFILE_ID, bucket: BUCKET, rootKey: 'photos/2024/' });
  await timeQuery(db, 'recursive CTE roll-up', subtree.query, subtree.params, 3);

  await db.close();
}

async function benchRemote(): Promise<void> {
  const endpoint = process.env.GALIOT_S3_ENDPOINT;
  const bucket = process.env.GALIOT_S3_BUCKET;
  if (!endpoint || !bucket) {
    console.log('\n── Live listing: skipped (set GALIOT_S3_ENDPOINT / GALIOT_S3_BUCKET) ──');
    return;
  }

  const { S3Client } = await import('../src/s3/client');
  const client = new S3Client({
    endpoint,
    region: process.env.GALIOT_S3_REGION ?? 'us-east-1',
    bucket,
    pathStyle: process.env.GALIOT_S3_PATH_STYLE !== '0',
    accessKeyId: process.env.GALIOT_S3_KEY ?? '',
    secretAccessKey: process.env.GALIOT_S3_SECRET ?? '',
  });

  console.log(`\n── Live listing: ${endpoint} / ${bucket} ──`);

  const start = performance.now();
  const page = await client.listObjects('', { delimiter: '/', maxKeys: 1000 });
  const elapsed = performance.now() - start;
  const keys = page.objects.length + page.prefixes.length;

  console.log(`    first page                        ${since(start).padStart(9)}`);
  console.log(
    `    keys returned                     ${keys.toLocaleString()} (~${Math.round(keys / (elapsed / 1000)).toLocaleString()}/s)`.padEnd(60),
  );
  console.log(
    `    extrapolated to 500k keys         ~${Math.round((elapsed / Math.max(1, keys)) * 500_000 / 1000).toLocaleString()} s`,
  );
}

const arg = process.argv[2];
const requested = arg === undefined ? Number.NaN : Number(arg);
// No argument sweeps both scales; an argument runs just that size.
const sizes = Number.isFinite(requested) && requested > 0 ? [requested] : [10_000, 100_000];

console.log('Galiot benchmark — engine, search, and roll-up latency');
console.log(`bun ${process.version} · node ${process.versions.node ?? 'n/a'}`);

for (const rows of sizes) {
  await benchLocal(rows);
}
await benchRemote();

console.log('\nDone.\n');
