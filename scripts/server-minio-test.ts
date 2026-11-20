/**
 * Live verification of the self-hosted server path, against a real S3 server.
 *
 * The unit suites stub the upstream transport. This one starts the actual
 * `handleAppRequest` server in-process and drives it over HTTP exactly as the
 * browser does: sessions, signed calls, streamed object bytes, multipart part
 * uploads, range downloads, server-side copy/rename, and share grants read
 * without the gate and cut off by a gated revoke.
 *
 * Requires a live endpoint. See scripts/minio-test.sh.
 *
 *   GALIOT_S3_ENDPOINT=http://127.0.0.1:9000 \
 *   GALIOT_S3_BUCKET=galiot-test \
 *   GALIOT_S3_KEY=… GALIOT_S3_SECRET=… \
 *   bun run test:minio-server
 */

import { createHash } from 'node:crypto';
import { handleAppRequest } from '../src/server/api';
import { AwsClient } from '../src/lib/aws4fetch';
import { S3Client } from '../src/s3/client';
import { buildS3Url } from '../src/s3/url';
import { readBoundedText } from '../src/lib/boundedBody';

const endpoint = process.env.GALIOT_S3_ENDPOINT ?? '';
const bucket = process.env.GALIOT_S3_BUCKET ?? '';
const accessKeyId = process.env.GALIOT_S3_KEY ?? '';
const secretAccessKey = process.env.GALIOT_S3_SECRET ?? '';
const region = process.env.GALIOT_S3_REGION ?? 'us-east-1';
/** Temporary credentials (SSO/assumed roles) also need the STS session value. */
const sts = process.env.GALIOT_S3_STS || undefined;
/**
 * Scoped mode: the bucket belongs to someone else. Every object read and write
 * stays inside this run's own prefix, and bucket-level configuration (versioning)
 * is never touched. Cleanup removes only that prefix.
 */
const scoped = process.env.GALIOT_LIVE_SCOPED === '1';
const GATE = 'live-suite-gate';
const PART_SIZE = 6 * 1024 * 1024;

if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  console.error('Set GALIOT_S3_ENDPOINT, GALIOT_S3_BUCKET, GALIOT_S3_KEY, GALIOT_S3_SECRET. See scripts/minio-test.sh.');
  process.exit(2);
}

let checks = 0;
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => handleAppRequest(request, { expectedToken: GATE }),
});
const origin = `http://127.0.0.1:${server.port}`;

function gateHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = { 'x-galiot-access-token': GATE };
  if (json) headers['content-type'] = 'application/json';
  return headers;
}

async function call<T>(sessionId: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${origin}/api/s3/sessions/${sessionId}/call`, {
    method: 'POST',
    headers: gateHeaders(true),
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { ok?: boolean; result?: T; error?: string };
  if (!response.ok || payload.ok === false) {
    throw new Error(`${String(body.op)} failed: ${payload.error ?? response.status}`);
  }
  return payload.result as T;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// Probe the provider directly, before enabling any capability in this process.
// All keys are unique to this run. Some gateways acknowledge stale conditions.
async function checkProviderConditions(prefix: string, aws: AwsClient) {
  const target = { endpoint, bucket, pathStyle: true };
  const direct = new S3Client({ ...target, region, accessKeyId, secretAccessKey, sessionToken: sts, direct: true });
  const src = prefix + 'condition-source';
  const dst = prefix + 'condition-copy';
  const srcUrl = buildS3Url(target, src);
  const dstUrl = buildS3Url(target, dst);
  const seed = async (body = 'original') => {
    const written = await aws.fetch(srcUrl, { method: 'PUT', body });
    const tag = written.headers.get('etag');
    if (!written.ok || !tag) throw new Error('Could not create the conditional-operation fixture.');
    return tag;
  };
  const unchanged = async (url: URL, value: string) => {
    const response = await aws.fetch(url);
    return response.ok && (await readBoundedText(response, 1024)) === value;
  };
  const stale = await seed('earlier revision');
  let tag = await seed();
  if (tag === stale) throw new Error('The fixture requires distinguishable revision ETags.');
  const stalePut = await aws.fetch(srcUrl, { method: 'PUT', headers: { 'if-match': stale }, body: 'changed' });
  const put = stalePut.status === 412 && await unchanged(srcUrl, 'original');
  if (!put) tag = await seed();
  await direct.putObject(dst, 'keep');
  const copyHeaders = { 'x-amz-copy-source': '/' + encodeURIComponent(bucket) + '/' + src };
  const copy = await aws.fetch(dstUrl, { method: 'PUT', headers: { ...copyHeaders, 'x-amz-copy-source-if-match': stale } });
  const guardedCopy = copy.status === 412 && await unchanged(dstUrl, 'keep');
  if (guardedCopy) await direct.copyObject(src, dst, undefined, tag);
  let guardedPart = false;
  const uploadId = await direct.createMultipartUpload(dst);
  try {
    const url = buildS3Url(target, dst, { uploadId, partNumber: '1' });
    const copiedPart = await aws.fetch(url, { method: 'PUT', headers: { ...copyHeaders, 'x-amz-copy-source-if-match': stale } });
    const listed = await aws.fetch(buildS3Url(target, dst, { uploadId }));
    guardedPart = copiedPart.status === 412 && listed.ok && !/<(?:[\w-]+:)?Part>/.test(await readBoundedText(listed, 65536));
    if (guardedPart) await direct.copyPart(src, dst, uploadId, 1, 0, 7, tag);
  } finally {
    await direct.abortMultipartUpload(dst, uploadId);
  }
  const staleDelete = await aws.fetch(srcUrl, { method: 'DELETE', headers: { 'if-match': stale } });
  const guardedDelete = staleDelete.status === 412 && await unchanged(srcUrl, 'original');
  if (guardedDelete) {
    const matched = await aws.fetch(srcUrl, { method: 'DELETE', headers: { 'if-match': tag } });
    const after = await aws.fetch(srcUrl, { method: 'HEAD' });
    check('provider accepts a matching conditional delete on the probe key', matched.ok && after.status === 404);
  }
  const move = guardedCopy && guardedPart && guardedDelete;
  // The in-process app uses only the operations this run actually observed.
  const capabilities = [...(put ? ['put'] : []), ...(guardedCopy && guardedPart ? ['copy'] : []), ...(move ? ['move'] : [])];
  process.env.GALIOT_S3_CONDITIONS = JSON.stringify({ [buildS3Url(target).href]: capabilities });
  console.log('  Provider enforced stale ETags:', { put, copy: guardedCopy, part: guardedPart, delete: guardedDelete });
  return { put, move };
}

async function main(): Promise<void> {
  console.log(`Galiot server API on ${origin}, S3 at ${endpoint}/${bucket}\n`);

  const health = await fetch(`${origin}/api/health`, { headers: gateHeaders() });
  const healthBody = (await health.json()) as { tokenAccepted: boolean };
  check('health accepts the gate', health.status === 200 && healthBody.tokenAccepted === true);

  const anonymous = await fetch(`${origin}/api/s3/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, region, bucket, pathStyle: true, accessKeyId, secretAccessKey, sessionToken: sts }),
  });
  check('a session without the gate is refused', anonymous.status === 403);

  const opened = await fetch(`${origin}/api/s3/sessions`, {
    method: 'POST',
    headers: gateHeaders(true),
    body: JSON.stringify({ endpoint, region, bucket, pathStyle: true, accessKeyId, secretAccessKey, sessionToken: sts }),
  });
  const sessionId = ((await opened.json()) as { result: { sessionId: string } }).result.sessionId;
  check('session opens against the real endpoint', opened.status === 200 && sessionId.length > 0);

  const prefix = `server-suite-${crypto.randomUUID()}/`;
  const aws = new AwsClient({ accessKeyId, secretAccessKey, sessionToken: sts, region, service: 's3' });
  const conditions = await checkProviderConditions(prefix, aws);
  const listed = await call<{ objects: unknown[] }>(sessionId, { op: 'list', prefix, maxKeys: 5 });
  check('listing works through the session', Array.isArray(listed.objects));
  const helloKey = `${prefix}hello.txt`;
  const put = await call<{ eTag: string }>(sessionId, {
    op: 'putText',
    key: helloKey,
    body: 'hello server',
    contentType: 'text/plain',
  });
  check('putText returns an ETag', put.eTag.length > 0);

  const head = await call<{ contentLength: number; contentType: string }>(sessionId, { op: 'head', key: helloKey });
  check('head reports size and type', head.contentLength === 12 && head.contentType === 'text/plain');

  const editorKey = prefix + 'editor.json';
  const editor = await call<{ eTag: string }>(sessionId, { op: 'putText', key: editorKey, body: '{}', contentType: 'application/json' });
  const editorUrl = origin + '/api/s3/sessions/' + sessionId + '/object?key=' + encodeURIComponent(editorKey);
  const save = (tag: string) => fetch(editorUrl, { method: 'PUT',
    headers: { ...gateHeaders(), 'if-match': tag, 'content-type': 'application/json' }, body: new Blob([]) });
  const reported = await call<{ conditionalPut: boolean }>(sessionId, { op: 'editorWriteSupport' });
  check('editor capability matches observed enforcement', reported.conditionalPut === conditions.put);
  const rejected = await save('"' + crypto.randomUUID() + '"');
  const retained = await fetch(editorUrl, { headers: gateHeaders() });
  check('stale editor save retains original bytes', rejected.status === (conditions.put ? 412 : 501) && await retained.text() === '{}');
  if (conditions.put) {
    const saved = await save(editor.eTag);
    const empty = await fetch(editorUrl, { headers: gateHeaders() });
    check('matching editor save preserves MIME and allows empty bytes',
      saved.ok && empty.headers.get('x-galiot-object-type') === 'application/json' && await empty.text() === '');
  }

  // Multipart upload through /part, the path the transfer worker uses.
  const partBytes = [0, 1].map((n) => {
    const bytes = new Uint8Array(PART_SIZE);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i + n * 7) % 251;
    return bytes;
  });
  const bigKey = `${prefix}big.bin`;
  const created = await call<{ uploadId: string }>(sessionId, {
    op: 'createMultipart',
    key: bigKey,
    contentType: 'application/octet-stream',
  });
  const parts: { PartNumber: number; ETag: string }[] = [];
  for (let n = 0; n < partBytes.length; n += 1) {
    const query = new URLSearchParams({ key: bigKey, uploadId: created.uploadId, partNumber: String(n + 1) });
    const response = await fetch(`${origin}/api/s3/sessions/${sessionId}/part?${query}`, {
      method: 'PUT',
      headers: gateHeaders(),
      body: new Blob([partBytes[n] as Uint8Array]),
    });
    const eTag = response.headers.get('etag') ?? '';
    check(`part ${n + 1} uploaded with an ETag`, response.status === 200 && eTag.length > 0, `status ${response.status}`);
    parts.push({ PartNumber: n + 1, ETag: eTag });
  }
  await call(sessionId, { op: 'completeMultipart', key: bigKey, uploadId: created.uploadId, parts });
  const bigHead = await call<{ contentLength: number }>(sessionId, { op: 'head', key: bigKey });
  check('completed multipart has the full size', bigHead.contentLength === PART_SIZE * 2);

  const whole = new Uint8Array(await (await fetch(`${origin}/api/s3/sessions/${sessionId}/object?key=${encodeURIComponent(bigKey)}`, { headers: gateHeaders() })).arrayBuffer());
  const expected = new Uint8Array(PART_SIZE * 2);
  expected.set(partBytes[0] as Uint8Array, 0);
  expected.set(partBytes[1] as Uint8Array, PART_SIZE);
  check('downloaded bytes match what was uploaded', sha256(whole) === sha256(expected));

  const ranged = await fetch(`${origin}/api/s3/sessions/${sessionId}/object?key=${encodeURIComponent(bigKey)}`, {
    headers: { ...gateHeaders(), range: `bytes=${PART_SIZE}-` },
  });
  const rangedBytes = new Uint8Array(await ranged.arrayBuffer());
  check('range download resumes at the part boundary', ranged.status === 206 && sha256(rangedBytes) === sha256(partBytes[1] as Uint8Array), `status ${ranged.status}`);

  // Server-side file operations.
  await call(sessionId, { op: 'createFolder', key: `${prefix}folder/` });
  await call(sessionId, { op: 'copy', sourceKey: helloKey, destKey: `${prefix}folder/copy.txt` });
  const inFolder = await call<{ objects: { key: string }[] }>(sessionId, { op: 'list', prefix: `${prefix}folder/` });
  check('copy lands inside the new folder', inFolder.objects.some((o) => o.key === `${prefix}folder/copy.txt`));

  const sourceHead = await call<{ versionId: string | null }>(sessionId, { op: 'head', key: prefix + 'folder/copy.txt' });
  let moved = 0;
  let retainedSources = false;
  try {
    const renamed = await call<{ moved: number }>(sessionId, { op: 'rename', sourceKey: `${prefix}folder/`, destKey: `${prefix}moved/` });
    moved = renamed.moved;
  } catch (error) {
    retainedSources = error instanceof Error && /not been verified|sources were retained/.test(error.message);
  }
  const inMoved = await call<{ objects: { key: string }[] }>(sessionId, { op: 'list', prefix: `${prefix}moved/` });
  const oldFolder = await call<{ objects: { key: string }[] }>(sessionId, { op: 'list', prefix: `${prefix}folder/` });
  if (conditions.move && sourceHead.versionId === null) {
    check('verified folder rename moves every key and empties the source', moved >= 1 && inMoved.objects.some((o) => o.key === `${prefix}moved/copy.txt`) && oldFolder.objects.length === 0);
  } else {
    check('source-preserving move reports why the original remains', retainedSources && oldFolder.objects.some(o => o.key === prefix + 'folder/copy.txt'));
    check('destination matches reported copy outcome', inMoved.objects.length === (conditions.move ? inFolder.objects.length : 0));
  }

  // Share grants: readable without the gate, revocable only with it.
  const shared = await call<{ url: string }>(sessionId, { op: 'share', key: helloKey, expiresIn: 3600 });
  const read = await fetch(`${origin}${shared.url}`);
  check('share link reads without the gate', read.status === 200 && (await read.text()) === 'hello server');
  const anonRevoke = await fetch(`${origin}${shared.url}`, { method: 'DELETE' });
  check('revoking without the gate is refused', anonRevoke.status === 403);
  const revoked = await fetch(`${origin}${shared.url}`, { method: 'DELETE', headers: gateHeaders() });
  const after = await fetch(`${origin}${shared.url}`);
  check('gated revoke cuts the link off', revoked.status === 200 && after.status === 404);

  // An issued link outlives the session that minted it (vault lock).
  const survivor = await call<{ url: string }>(sessionId, { op: 'share', key: helloKey, expiresIn: 3600 });
  await fetch(`${origin}/api/s3/sessions/${sessionId}`, { method: 'DELETE', headers: gateHeaders() });
  const afterLock = await fetch(`${origin}${survivor.url}`);
  check('issued link survives session close', afterLock.status === 200);
  await fetch(`${origin}${survivor.url}`, { method: 'DELETE', headers: gateHeaders() });

  // Write grant: bounded PUT through the server, no gate, revocable.
  const writeOpened = await fetch(`${origin}/api/s3/sessions`, {
    method: 'POST',
    headers: gateHeaders(true),
    body: JSON.stringify({ endpoint, region, bucket, pathStyle: true, accessKeyId, secretAccessKey, sessionToken: sts }),
  });
  const writeSession = ((await writeOpened.json()) as { result: { sessionId: string } }).result.sessionId;
  const writeGrant = await call<{ url: string; maxBytes: number }>(writeSession, {
    op: 'shareWrite',
    key: `${prefix}inbox.bin`,
    expiresIn: 3600,
    maxBytes: 32,
  });
  const uploadBig = await fetch(`${origin}${writeGrant.url}`, { method: 'PUT', body: 'x'.repeat(33) });
  check('write grant refuses bodies over the cap', uploadBig.status === 413);
  const uploadOk = await fetch(`${origin}${writeGrant.url}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: 'hello',
  });
  check('write grant accepts a bounded PUT without the gate', uploadOk.status === 200);
  const uploadedHead = await call<{ contentLength: number }>(writeSession, { op: 'head', key: `${prefix}inbox.bin` });
  check('uploaded bytes landed in S3', uploadedHead.contentLength === 5);
  const replay = await fetch(`${origin}${writeGrant.url}`, { method: 'PUT', body: 'again' });
  check('a consumed write grant cannot replace the uploaded object', replay.status === 404);
  const uploadAnonRevoke = await fetch(`${origin}${writeGrant.url}`, { method: 'DELETE' });
  check('revoking a write grant without the gate is refused', uploadAnonRevoke.status === 403);
  await fetch(`${origin}${writeGrant.url}`, { method: 'DELETE', headers: gateHeaders() });
  const uploadAfter = await fetch(`${origin}${writeGrant.url}`, { method: 'PUT', body: 'hello' });
  check('revoked write grant stops accepting uploads', uploadAfter.status === 404);
  await fetch(`${origin}/api/s3/sessions/${writeSession}`, { method: 'DELETE', headers: gateHeaders() });

  const buckets = await fetch(`${origin}/api/s3/list-buckets`, {
    method: 'POST',
    headers: gateHeaders(true),
    body: JSON.stringify({ endpoint, region, accessKeyId, secretAccessKey, sessionToken: sts }),
  });
  const bucketBody = (await buckets.json()) as { ok?: boolean; result?: { buckets: string[] }; code?: string };
  if (bucketBody.ok === true && bucketBody.result) {
    check('list-buckets sees the test bucket', bucketBody.result.buckets.includes(bucket));
  } else if (bucketBody.code) {
    // Bucket-scoped keys often cannot list buckets; that is a permission
    // boundary, not a Galiot defect.
    console.log(`  skip list-buckets — provider answered ${bucketBody.code}`);
  } else {
    check('list-buckets reaches the provider', false, `status ${buckets.status}`);
  }

  // Versioning and whole-bucket search, on a fresh session.
  const verOpened = await fetch(`${origin}/api/s3/sessions`, {
    method: 'POST',
    headers: gateHeaders(true),
    body: JSON.stringify({ endpoint, region, bucket, pathStyle: true, accessKeyId, secretAccessKey, sessionToken: sts }),
  });
  const verSession = ((await verOpened.json()) as { result: { sessionId: string } }).result.sessionId;

  let versioningEnabled = false;
  const enable = scoped
    ? new Response(null, { status: 403 })
    : await aws.fetch(`${endpoint}/${bucket}?versioning`, {
        method: 'PUT',
        headers: { 'content-type': 'application/xml' },
        body: '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
      });
  const verKey = `${prefix}versioned.txt`;
  if (scoped) {
    console.log('  skip versioning checks — scoped run: bucket configuration is not ours to change');
  } else if (enable.status === 403) {
    // A key without s3:PutBucketVersioning cannot exercise versions; that is a
    // permission boundary, not a Galiot defect. Skip with an explanation.
    console.log('  skip versioning checks — this key cannot PutBucketVersioning (403)');
  } else {
  versioningEnabled = enable.status === 200;
  check('versioning enabled on the bucket', enable.status === 200, `status ${enable.status}`);
  await call(verSession, { op: 'putText', key: verKey, body: 'v1', contentType: 'text/plain' });
  await call(verSession, { op: 'putText', key: verKey, body: 'v2-longer', contentType: 'text/plain' });
  const versions = await call<{ versions: { versionId: string; isLatest: boolean }[]; unversioned: boolean }>(verSession, { op: 'listVersions', key: verKey });
  check('two versions listed on a versioned bucket', versions.versions.length === 2 && !versions.unversioned);
  const older = versions.versions.find((v) => !v.isLatest);
  if (older) {
    await call(verSession, { op: 'restoreVersion', key: verKey, versionId: older.versionId });
    const restoredHead = await call<{ contentLength: number }>(verSession, { op: 'head', key: verKey });
    check('restore makes the old bytes current', restoredHead.contentLength === 2);
    const verUrl = await call<{ url: string }>(verSession, { op: 'media', key: verKey, versionId: older.versionId });
    const verRead = await fetch(`${origin}${verUrl.url}`);
    check('old version downloads through the server', verRead.status === 200 && (await verRead.text()) === 'v1');
    await call(verSession, { op: 'deleteVersion', key: verKey, versionId: older.versionId });
    const afterPurge = await call<{ versions: unknown[] }>(verSession, { op: 'listVersions', key: verKey });
    check('purge removes exactly one version', afterPurge.versions.length === 2);
  } else {
    check('an older version exists to restore', false);
  }
  }

  const found = await call<{ objects: { key: string }[]; scanned: number }>(verSession, { op: 'search', query: 'hello', prefix });
  check('search finds the hello key inside the test prefix', found.objects.some((o) => o.key === helloKey) && found.scanned > 0);

  const treeCheck = await call<{ objects: { key: string; size: number }[] }>(verSession, { op: 'listTree', prefix });
  check('listTree expands the prefix for folder downloads', treeCheck.objects.some((o) => o.key === helloKey) && treeCheck.objects.length >= 3);
  await fetch(`${origin}/api/s3/sessions/${verSession}`, { method: 'DELETE', headers: gateHeaders() });

  // Cleanup through the same API.
  const reopened = await fetch(`${origin}/api/s3/sessions`, {
    method: 'POST',
    headers: gateHeaders(true),
    body: JSON.stringify({ endpoint, region, bucket, pathStyle: true, accessKeyId, secretAccessKey, sessionToken: sts }),
  });
  const cleanupSession = ((await reopened.json()) as { result: { sessionId: string } }).result.sessionId;
  const tree = await call<{ objects: { key: string }[] }>(cleanupSession, { op: 'list', prefix });
  const allKeys = [...tree.objects.map((o) => o.key), verKey];
  await call(cleanupSession, { op: 'delete', keys: tree.objects.map((o) => o.key) });
  // Versioned buckets keep noncurrent versions after a plain delete; purge them.
  // Only when this run enabled versioning — never on someone else's bucket.
  if (versioningEnabled) {
    for (const key of allKeys) {
      const listed = await call<{ versions: { versionId: string }[] }>(cleanupSession, { op: 'listVersions', key });
      for (const version of listed.versions) {
        await call(cleanupSession, { op: 'deleteVersion', key, versionId: version.versionId });
      }
    }
  }
  const left = await call<{ objects: { key: string }[] }>(cleanupSession, { op: 'list', prefix });
  const leftVersions = versioningEnabled
    ? await call<{ versions: unknown[] }>(cleanupSession, { op: 'listVersions', key: verKey })
    : { versions: [] };
  check('cleanup removed every test object and version', left.objects.length === 0 && leftVersions.versions.length === 0);
  await fetch(`${origin}/api/s3/sessions/${cleanupSession}`, { method: 'DELETE', headers: gateHeaders() });
}

try {
  await main();
} catch (err) {
  failures += 1;
  console.error(`  FAIL suite threw — ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await server.stop(true);
}

console.log(`\n${checks - failures}/${checks} checks passed against the live server path.`);
process.exit(failures === 0 ? 0 : 1);
