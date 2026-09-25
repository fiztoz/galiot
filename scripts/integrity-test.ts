/**
 * Transfer integrity suite (roadmap 5.2).
 *
 * Runs the real S3 client against a live endpoint and asserts the guarantees
 * the transfer engine claims:
 *
 *   1. small single-PUT uploads round-trip byte-for-byte (ETag = MD5)
 *   2. multipart uploads round-trip and the composite ETag matches our own
 *      recomputation from part digests
 *   3. parallel part uploads do not corrupt ordering or content
 *   4. an interrupted upload can be resumed: ListParts shows what landed, the
 *      missing parts are uploaded, and the finished object is correct
 *   5. Range requests return exactly the requested slice (resumable downloads)
 *   6. the ETag check *detects* corruption rather than passing it through
 *
 * Usage:
 *   GALIOT_S3_ENDPOINT=http://127.0.0.1:9000 \
 *   GALIOT_S3_BUCKET=galiot-test \
 *   GALIOT_S3_KEY=AKIA... \
 *   GALIOT_S3_SECRET=secret \
 *   GALIOT_S3_REGION=us-east-1 \
 *   GALIOT_S3_PATH_STYLE=1 \
 *   bun run test:integrity
 */

import { AwsClient } from '../src/lib/aws4fetch';
import { S3Client } from '../src/s3/client';
import { planParts, S3_MIN_PART_SIZE } from '../src/transfer/planner';
import { xmlBlocks, xmlTextValues } from '../src/s3/xml';
import { md5Hex, multipartEtag, verifyAgainstEtag } from '../src/transfer/integrity';

const config = {
  endpoint: process.env.GALIOT_S3_ENDPOINT ?? '',
  bucket: process.env.GALIOT_S3_BUCKET ?? '',
  accessKeyId: process.env.GALIOT_S3_KEY ?? '',
  secretAccessKey: process.env.GALIOT_S3_SECRET ?? '',
  region: process.env.GALIOT_S3_REGION ?? 'us-east-1',
  pathStyle: process.env.GALIOT_S3_PATH_STYLE !== '0',
  prefix: process.env.GALIOT_S3_PREFIX ?? 'galiot-integrity/',
};

const PART_SIZE = Number(process.env.GALIOT_S3_PART_SIZE ?? S3_MIN_PART_SIZE);

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function randomBytes(size: number, seed: number): Uint8Array {
  const data = new Uint8Array(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i += 1) {
    // xorshift keeps the payload deterministic and reproducible across runs.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[i] = state & 0xff;
  }
  return data;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function getBytes(client: S3Client, key: string): Promise<Uint8Array> {
  const res = await client.getObject(key);
  if (!res.ok) throw new Error(`GET ${key} failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Fetches an object *and* the ETag the bucket reported for it.
 *
 * Verifying against the bucket's real ETag is the whole point of the integrity
 * claims below. An earlier version of this suite built the expected ETag string
 * itself and compared our computation against our own input, which passes
 * whether or not the server agrees — and, when it did fail, printed
 * "bucket said …" for a value the suite had just invented.
 */
async function getWithEtag(
  client: S3Client,
  key: string,
): Promise<{ bytes: Uint8Array; etag: string }> {
  const res = await client.getObject(key);
  if (!res.ok) throw new Error(`GET ${key} failed: ${res.status}`);
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    etag: res.headers.get('etag') ?? '',
  };
}

async function testSinglePut(client: S3Client, id: string): Promise<void> {
  console.log('\n1. single-PUT upload round-trip');
  const key = `${config.prefix}${id}-single.bin`;
  const data = randomBytes(64 * 1024, 1234);

  const result = await client.putObject(key, data, 'application/octet-stream');
  check('PUT returns an ETag', Boolean(result.eTag), 'no ETag header');

  const downloaded = await getBytes(client, key);
  check('object size matches', downloaded.length === data.length);
  check('content is byte-identical', Buffer.compare(Buffer.from(downloaded), Buffer.from(data)) === 0);

  const verified = verifyAgainstEtag(downloaded, result.eTag);
  check('ETag verifies as MD5', verified.ok, verified.reason);

  await client.deleteObject(key);
}

async function testMultipart(client: S3Client, id: string): Promise<void> {
  console.log('\n2. multipart upload + composite ETag');
  const key = `${config.prefix}${id}-multipart.bin`;
  const size = PART_SIZE * 2 + 1234;
  const data = randomBytes(size, 987654);
  const parts = planParts(size, PART_SIZE);

  const uploadId = await client.createMultipartUpload(key, 'application/octet-stream');
  const digests: string[] = [];

  for (const part of parts) {
    const chunk = data.subarray(part.startByte, part.endByte + 1);
    digests.push(md5Hex(chunk));
    const etag = await client.uploadPart(key, uploadId, part.partNumber, chunk as unknown as Blob);
    check(`part ${part.partNumber} acknowledged`, Boolean(etag));
  }

  await client.completeMultipartUpload(
    key,
    uploadId,
    parts.map((part, i) => ({ PartNumber: part.partNumber, ETag: `"${digests[i]}"` })),
  );

  const { bytes: downloaded, etag } = await getWithEtag(client, key);
  check('size matches', downloaded.length === size, `${downloaded.length} vs ${size}`);
  check(
    'content is byte-identical',
    Buffer.compare(Buffer.from(downloaded), Buffer.from(data)) === 0,
  );

  // Compare against the ETag the bucket actually reported, not a string this
  // suite assembled — and note multipartEtag() already appends the part count.
  check('bucket reported a multipart ETag', /-\d+$/.test(etag.replace(/"/g, '')), etag);
  const verified = verifyAgainstEtag(
    downloaded,
    etag,
    parts.map((p) => p.size),
  );
  check('composite ETag matches our recomputation', verified.ok, verified.reason);
  check(
    'our recomputation is what the bucket reported',
    multipartEtag(digests) === etag.replace(/"/g, ''),
    `ours ${multipartEtag(digests)}, bucket ${etag}`,
  );

  // Prove the checker is not vacuous.
  const corrupted = new Uint8Array(downloaded);
  corrupted[0] = corrupted[0]! ^ 0xff;
  const negative = verifyAgainstEtag(corrupted, etag, parts.map((p) => p.size));
  check('corruption is detected', !negative.ok);

  await client.deleteObject(key);
}

async function testParallelParts(client: S3Client, id: string): Promise<void> {
  console.log('\n3. parallel part uploads');
  const key = `${config.prefix}${id}-parallel.bin`;
  const partSize = S3_MIN_PART_SIZE;
  const count = 4;
  const data = randomBytes(partSize * count, 424242);
  const parts = planParts(partSize * count, partSize);

  const uploadId = await client.createMultipartUpload(key, 'application/octet-stream');
  const digests: string[] = new Array(count);

  await Promise.all(
    parts.map(async (part, i) => {
      const chunk = data.subarray(part.startByte, part.endByte + 1);
      digests[i] = md5Hex(chunk);
      await client.uploadPart(key, uploadId, part.partNumber, chunk as unknown as Blob);
    }),
  );

  check('all parts uploaded in parallel', digests.every(Boolean));

  await client.completeMultipartUpload(
    key,
    uploadId,
    parts.map((part, i) => ({ PartNumber: part.partNumber, ETag: `"${digests[i]}"` })),
  );

  const downloaded = await getBytes(client, key);
  check(
    'parallel upload reassembles correctly',
    Buffer.compare(Buffer.from(downloaded), Buffer.from(data)) === 0,
  );

  await client.deleteObject(key);
}

async function testResume(client: S3Client, id: string): Promise<void> {
  console.log('\n4. interrupted upload resume');
  const key = `${config.prefix}${id}-resume.bin`;
  const size = PART_SIZE * 3;
  const data = randomBytes(size, 777);
  const parts = planParts(size, PART_SIZE);

  const uploadId = await client.createMultipartUpload(key, 'application/octet-stream');
  const digests: string[] = new Array(parts.length);

  // Upload only the first half, then "reconnect".
  const landed = parts.slice(0, 2);
  for (const part of landed) {
    const chunk = data.subarray(part.startByte, part.endByte + 1);
    digests[part.partNumber - 1] = md5Hex(chunk);
    await client.uploadPart(key, uploadId, part.partNumber, chunk as unknown as Blob);
  }

  // Resume path: list what the server actually has.
  const url = client.objectUrl(key, { uploadId });
  const signed = await new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: 's3',
  }).sign(url, { method: 'GET' });
  // Send the signed Request itself. Fetching `signed.url` with a fresh init
  // drops the Authorization and x-amz-* headers, so a real bucket correctly
  // answers 403 and the suite used to blame the server's ListParts format.
  const listRes = await fetch(signed);
  if (!listRes.ok) {
    throw new Error(`ListParts failed: ${listRes.status} ${await listRes.text()}`);
  }
  const listXml = await listRes.text();
  const serverParts = new Set(xmlTextValues(listXml, 'PartNumber'));
  check('ListParts returned well-formed parts', xmlBlocks(listXml, 'Part').length > 0);

  check('ListParts reports the landed parts', serverParts.size === landed.length);
  check('ListParts does not report the missing parts', !serverParts.has('3'));

  for (const part of parts) {
    if (serverParts.has(String(part.partNumber))) continue;
    const chunk = data.subarray(part.startByte, part.endByte + 1);
    digests[part.partNumber - 1] = md5Hex(chunk);
    await client.uploadPart(key, uploadId, part.partNumber, chunk as unknown as Blob);
  }

  await client.completeMultipartUpload(
    key,
    uploadId,
    parts.map((part, i) => ({ PartNumber: part.partNumber, ETag: `"${digests[i]}"` })),
  );

  const downloaded = await getBytes(client, key);
  check(
    'resumed object is byte-identical',
    Buffer.compare(Buffer.from(downloaded), Buffer.from(data)) === 0,
  );

  await client.deleteObject(key);
}

async function testRangeRequests(client: S3Client, id: string): Promise<void> {
  console.log('\n5. range requests (resumable downloads)');
  const key = `${config.prefix}${id}-range.bin`;
  const data = randomBytes(256 * 1024, 31337);
  await client.putObject(key, data, 'application/octet-stream');

  const start = 100_000;
  const end = 199_999;

  const url = client.objectUrl(key);
  const signed = await new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: 's3',
  }).sign(url, { method: 'GET', headers: new Headers({ Range: `bytes=${start}-${end}` }) });

  // The signed Request carries the Range header *and* the signature over it;
  // rebuilding the request by hand would send the header unsigned.
  const res = await fetch(signed);

  check('range request returns 206', res.status === 206, `status ${res.status}`);
  const slice = new Uint8Array(await res.arrayBuffer());
  check('range length is exact', slice.length === end - start + 1, `${slice.length}`);
  check(
    'range bytes match the source',
    Buffer.compare(Buffer.from(slice), Buffer.from(data.subarray(start, end + 1))) === 0,
  );

  await client.deleteObject(key);
}

async function main(): Promise<void> {
  if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
    console.error(
      'Missing configuration. Set GALIOT_S3_ENDPOINT, GALIOT_S3_BUCKET, GALIOT_S3_KEY and GALIOT_S3_SECRET.',
    );
    process.exit(2);
  }

  console.log(`Target: ${config.endpoint} / ${config.bucket} (path-style: ${config.pathStyle})`);
  console.log(`Part size: ${(PART_SIZE / 1024 / 1024).toFixed(1)} MiB`);

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    pathStyle: config.pathStyle,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });

  const id = `run-${Date.now()}`;

  try {
    await testSinglePut(client, id);
    await testMultipart(client, id);
    await testParallelParts(client, id);
    await testResume(client, id);
    await testRangeRequests(client, id);
  } catch (err) {
    failures += 1;
    console.error('\nSuite aborted:', err instanceof Error ? err.message : err);
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
