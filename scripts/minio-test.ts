/**
 * Real-server suite for the parts the transfer-integrity suite does not cover.
 *
 * The transfer suite proves bytes survive; this one proves the *protocol
 * behaviour* Galiot depends on, against a real S3 implementation that
 * validates our signatures independently of our own code:
 *
 *   1. presigned object links, fetched with plain curl
 *   2. listing past the 1000-key page boundary (continuation token)
 *   3. keys with leading/trailing spaces and non-ASCII text, which the XML
 *      reader must not trim or mangle
 *   4. multi-delete, including a key that is reported as an error
 *   5. connection custom headers on signed requests
 *
 * Requires a live endpoint. See scripts/minio-test.sh, which starts MinIO in a
 * container and runs both this and the transfer-integrity suite.
 *
 *   GALIOT_S3_ENDPOINT=http://127.0.0.1:9000 \
 *   GALIOT_S3_BUCKET=galiot-protocol \
 *   GALIOT_S3_KEY=… GALIOT_S3_SECRET=… \
 *   bun run test:minio
 */

import { AwsClient } from '../src/lib/aws4fetch';
import { S3Client, S3RequestError } from '../src/s3/client';
import { presignGetUrl, presignPutUrl } from '../src/s3/presign';
import { xmlFirst } from '../src/s3/xml';

const endpoint = process.env.GALIOT_S3_ENDPOINT ?? '';
const bucket = process.env.GALIOT_S3_BUCKET ?? '';
const accessKeyId = process.env.GALIOT_S3_KEY ?? '';
const secretAccessKey = process.env.GALIOT_S3_SECRET ?? '';
const region = process.env.GALIOT_S3_REGION ?? 'us-east-1';
const pathStyle = process.env.GALIOT_S3_PATH_STYLE !== '0';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const signer = () =>
  new AwsClient({ accessKeyId, secretAccessKey, region, service: 's3' });

const client = (b = bucket) =>
  new S3Client({ endpoint, region, bucket: b, pathStyle, accessKeyId, secretAccessKey, direct: true });

/** A client that sends extra headers on every request, as a connection can. */
const clientWithHeaders = (headers: Record<string, string>) =>
  new S3Client({ endpoint, region, bucket, pathStyle, accessKeyId, secretAccessKey, headers, direct: true });

/** 1. Presigned object links, fetched with curl. */
async function testPresignedObjectLinks(c: S3Client): Promise<void> {
  console.log('\n1. presigned object links');

  const key = 'presign/sample.txt';
  const body = 'presigned payload';
  await c.putObject(key, body, 'text/plain');

  const getUrl = await presignGetUrl(signer(), { endpoint, bucket, pathStyle }, key, 300);
  const got = await fetch(getUrl);
  check('a presigned GET works', got.status === 200, `HTTP ${got.status}`);
  check('the payload round-trips', (await got.text()) === body);
  check('the link carries no secret', !getUrl.includes(secretAccessKey));

  // The Content-Type must match what was signed, or a strict server rejects it.
  const putUrl = await presignPutUrl(signer(), { endpoint, bucket, pathStyle }, key, 'text/plain', 300);
  const put = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: 'written through a presigned URL',
  });
  check('a presigned PUT works', put.ok, `HTTP ${put.status}`);
  const readBack = await getBytes(c, key);
  check('the presigned write landed', readBack === 'written through a presigned URL');

  await c.deleteObject(key);
}

/** 2. Listing past the page boundary. */
async function testPagination(c: S3Client): Promise<void> {
  console.log('\n2. listing past the 1000-key page boundary');

  const prefix = 'pagination/';
  const total = 1005;
  // Write in batches; a single PutObjects call is not implemented in the client.
  for (let batch = 0; batch < total; batch += 250) {
    for (let i = batch; i < Math.min(batch + 250, total); i += 1) {
      await c.putObject(`${prefix}${String(i).padStart(5, '0')}.txt`, 'x', 'text/plain');
    }
  }

  const first = await c.listObjects(prefix, { maxKeys: 1000 });
  check('the first page is capped at 1000', first.objects.length === 1000, `${first.objects.length}`);
  check('the listing reports truncation', first.isTruncated === true);
  check('a continuation token is offered', Boolean(first.nextContinuationToken));

  const second = await c.listObjects(prefix, {
    maxKeys: 1000,
    continuationToken: first.nextContinuationToken,
  });
  check('the second page has the remainder', second.objects.length === total - 1000, `${second.objects.length}`);
  check('the second page is the end', second.isTruncated === false);

  // Keys must come back in order and none may be lost across the boundary.
  const all = [...first.objects, ...second.objects].map((o) => o.key);
  check('no key is duplicated', new Set(all).size === all.length);
  check('the first and last keys are the expected ones', all[0] === `${prefix}00000.txt` && all[all.length - 1] === `${prefix}01004.txt`);

  // A delimiter collapses deeper keys into CommonPrefixes instead of listing
  // them, while keys directly under the prefix are still returned. Checked on
  // its own small prefix: inside the 1000-key pagination set above, the direct
  // children fill the page before a "nested/" prefix sorts into view.
  await c.putObject('delimiter-test/top.txt', 'x', 'text/plain');
  await c.putObject('delimiter-test/nested/deep/one.txt', 'x', 'text/plain');
  const delimited = await c.listObjects('delimiter-test/', { delimiter: '/' });
  check(
    // CommonPrefixes are absolute key prefixes, not paths relative to the
    // request — the same shape S3 returns, and what the explorer stores.
    'a nested key collapses into an absolute common prefix',
    delimited.prefixes.includes('delimiter-test/nested/'),
    JSON.stringify(delimited.prefixes),
  );
  check(
    'a key directly under the prefix is still returned',
    delimited.objects.some((o) => o.key === 'delimiter-test/top.txt'),
    JSON.stringify(delimited.objects.map((o) => o.key)),
  );
  check(
    'the nested key is not also returned as a key',
    !delimited.objects.some((o) => o.key === 'delimiter-test/nested/deep/one.txt'),
  );
  await c.deleteObject('delimiter-test/top.txt');
  await c.deleteObject('delimiter-test/nested/deep/one.txt');

  for (const object of [...first.objects, ...second.objects]) {
    await c.deleteObject(object.key);
  }
}

/** 3. Keys whose text must survive verbatim. */
async function testAwkwardKeys(c: S3Client): Promise<void> {
  console.log('\n3. keys with spaces and non-ASCII text');

  const keys = [
    'awkward/ leading-space.txt',
    'awkward/trailing-space .txt',
    'awkward/  both  .txt',
    'awkward/ünïcödé-ключ-鍵.txt',
    'awkward/quote"and<angle>.txt',
    'awkward/ampersand&and&amp.txt',
  ];

  for (const [index, key] of keys.entries()) {
    await c.putObject(key, `payload-${index}`, 'text/plain');
  }

  const listed = await c.listObjects('awkward/', { maxKeys: 100 });
  const returned = listed.objects.map((o) => o.key).sort();
  check('every awkward key is listed back', returned.length === keys.length, `${returned.length} of ${keys.length}`);

  for (const [index, key] of keys.entries()) {
    const found = listed.objects.find((o) => o.key === key);
    check(
      `key survives a round-trip: ${JSON.stringify(key)}`,
      found !== undefined,
      found ? 'mangled' : 'missing from the listing',
    );
    if (found) {
      const body = await getBytes(c, key);
      check(`  and its bytes are intact: ${JSON.stringify(key)}`, body === `payload-${index}`);
    }
  }

  for (const key of keys) await c.deleteObject(key);
}

/** 4. Multi-delete, with one key reported as an error. */
async function testDeleteObjects(c: S3Client): Promise<void> {
  console.log('\n4. multi-delete');

  const keys = ['delete/a.txt', 'delete/b.txt', 'delete/c.txt'];
  for (const key of keys) await c.putObject(key, 'bye', 'text/plain');

  const result = await c.deleteObjects([...keys, 'delete/never-existed.txt']);

  // Every real key must be acknowledged. A key that was never there is
  // idempotent: MinIO reports it as deleted, and S3 permits either that or a
  // NoSuchKey error, so both are accepted — but it must never vanish silently.
  for (const key of keys) {
    check(
      `deleted key is acknowledged: ${key}`,
      result.deleted.includes(key) || result.errors.some((e) => e.key === key),
    );
  }
  const missingAcknowledged =
    result.deleted.includes('delete/never-existed.txt') ||
    result.errors.some((e) => e.key === 'delete/never-existed.txt');
  check('the missing key is acknowledged somehow', missingAcknowledged, JSON.stringify(result));
  check(
    'no unrecognised keys are reported',
    [...result.deleted, ...result.errors.map((e) => e.key)].every(
      (k) => keys.includes(k) || k === 'delete/never-existed.txt',
    ),
    JSON.stringify(result),
  );

  const after = await c.listObjects('delete/', { maxKeys: 100 });
  check('nothing is left behind', after.objects.length === 0, `${after.objects.length}`);
}

async function getBytes(c: S3Client, key: string): Promise<string> {
  const res = await c.getObject(key);
  if (!res.ok) throw new Error(`GET ${key} failed: ${res.status}`);
  return res.text();
}

/**
 * 8. Custom connection headers, against a real server.
 *
 * The unit suite proves a custom header is *signed*; only a real server can say
 * whether it is *accepted*. SigV4 lists every signed header in `SignedHeaders`,
 * and an implementation is free to reject one it does not expect — so "we signed
 * it correctly" and "the endpoint took it" are different claims, and this is the
 * only place the second one is made.
 */
async function testCustomHeaders(): Promise<void> {
  console.log('\n5. custom connection headers');

  const headers = { 'x-tenant-id': 'acme', 'x-request-id': 'galiot-real-server' };
  const c = clientWithHeaders(headers);

  const key = 'custom-headers/sample.txt';
  const body = 'written with custom headers on the connection';

  const put = await c.putObject(key, body, 'text/plain');
  check('PUT is accepted with extra signed headers', put.eTag.length > 0, 'no ETag returned');

  const head = await c.headObject(key);
  check('HEAD is accepted', head.contentLength === body.length, `len ${head.contentLength}`);

  const listed = await c.listObjects('custom-headers/');
  check('LIST is accepted and finds the key', listed.objects.some((o) => o.key === key));

  check('GET returns the right bytes', (await getBytes(c, key)) === body);

  // A POST with a body and a Content-MD5 is the strictest case: the body hash,
  // the digest header and the custom headers all have to agree.
  const second = 'custom-headers/second.txt';
  await c.putObject(second, 'x', 'text/plain');
  const deleted = await c.deleteObjects([key, second]);
  check('multi-delete is accepted', deleted.deleted.length === 2, JSON.stringify(deleted.deleted));

  // The control: the same operations without custom headers, so a failure above
  // cannot be blamed on the endpoint simply being unhappy.
  const plain = client();
  const controlKey = 'custom-headers/control.txt';
  await plain.putObject(controlKey, 'no custom headers', 'text/plain');
  check('the same operations work without custom headers', (await getBytes(plain, controlKey)) === 'no custom headers');
  await plain.deleteObject(controlKey);
}

async function main(): Promise<void> {
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    console.error(
      'Missing configuration. Set GALIOT_S3_ENDPOINT, GALIOT_S3_BUCKET, GALIOT_S3_KEY and GALIOT_S3_SECRET.',
    );
    process.exit(2);
  }

  console.log(`Target: ${endpoint} / ${bucket} (path-style: ${pathStyle})`);

  const c = client();
  try {
    await c.listObjects('', { maxKeys: 1 });
    check('endpoint is reachable and the bucket lists', true);
  } catch (err) {
    check('endpoint is reachable and the bucket lists', false, err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  await testPresignedObjectLinks(c);
  await testPagination(c);
  await testAwkwardKeys(c);
  await testDeleteObjects(c);
  await testCustomHeaders();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

void main();
