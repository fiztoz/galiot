import { expect, test } from 'bun:test';
import { AwsClient } from '../lib/aws4fetch';
import { S3Client, type S3Dispatch } from './client';
import { presignGetUrl, presignPutUrl } from './presign';
import { xmlTextValues } from './xml';

const target = { endpoint: 'https://s3.example.com', bucket: 'archive', pathStyle: true };
const credentials = { accessKeyId: 'fixture', secretAccessKey: crypto.randomUUID(), region: 'us-east-1', service: 's3' };
const client = (dispatch: S3Dispatch) => new S3Client({ ...target, ...credentials, dispatch });

test('each copy operation requires its own complete XML result and ETag', async () => {
  const reply = (xml: string) => client(async () => new Response(xml));
  const failure = '<Error><Code>InternalError</Code></Error>';
  const parts = [{ PartNumber: 1, ETag: '"part"' }];
  await expect(reply(failure).copyPart('a', 'b', 'upload', 1, 0, 1)).rejects.toThrow('InternalError');
  await expect(reply(failure).completeMultipartUpload('b', 'upload', parts)).rejects.toThrow('InternalError');
  for (const xml of [
    '<CopyObjectResult></CopyObjectResult>',
    '<CopyPartResult><ETag>"part"</ETag></CopyPartResult>',
    '<CopyObjectResult><!-- <ETag>"old"</ETag> --></CopyObjectResult>',
    '<CopyObjectResult><ETag>"incomplete"</ETag>',
  ]) await expect(reply(xml).copyObject('a', 'b')).rejects.toThrow('UnconfirmedResult');

  const xml = '<?xml version="1.0"?>\n<s:CopyPartResult xmlns:s="urn:s3"><s:ETag>&quot;part&quot;</s:ETag></s:CopyPartResult>';
  expect(await reply(xml).copyPart('a', 'b', 'upload', 1, 0, 1)).toBe('"part"');
  await reply('<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>')
    .completeMultipartUpload('b', 'upload', parts);
});

test('bulk deletes batch all keys, retain acknowledged successes and reconcile per-key failures', async () => {
  const keys = Array.from({ length: 1003 }, (_, i) => 'file-' + i);
  const batches: number[] = [];
  const s3 = client(async req => {
    const requested = xmlTextValues(await req.text(), 'Key');
    batches.push(requested.length);
    if (batches.length === 2) return new Response('<Error/>', { status: 503 });
    const deleted = requested.slice(0, 999).map(key => '<Deleted><Key>' + key + '</Key></Deleted>').join('');
    return new Response('<DeleteResult>' + deleted +
      '<Deleted><Key>unrequested</Key></Deleted><Error><Key>file-998</Key><Code>AccessDenied</Code></Error></DeleteResult>');
  });
  const result = await s3.deleteObjects(keys);
  expect(batches).toEqual([1000, 3]);
  expect(result.deleted).toEqual(keys.slice(0, 998));
  expect(result.errors.map(e => [e.key, e.code])).toEqual(keys.slice(998).map((key, i) =>
    [key, i === 0 ? 'AccessDenied' : 'UnconfirmedDelete']));
});

test('oversized listing, fallback, and upstream error bodies are cancelled', async () => {
  for (const status of [200, 400, 403]) {
    let cancelled = false;
    const s3 = client(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status, headers: { 'content-length': String(9 * 1024 * 1024) },
    }));
    await expect(s3.listObjects()).rejects.toThrow();
    expect(cancelled).toBe(true);
  }
});

test('an unrepresentable bulk-delete name cannot delete a replacement-character key', async () => {
  const s3 = client(async () => { throw new Error('An invalid key reached the transport'); });
  const result = await s3.deleteObjects(['bad\ud800']);
  expect(result).toMatchObject({ deleted: [], errors: [{ key: 'bad\ud800', code: 'InvalidKey' }] });
});

test('an uncertified provider receives no guarded writes or deletes even when its transport would return success', async () => {
  let calls = 0;
  const s3 = new S3Client({ ...target, ...credentials, bucket: 'other-bucket', dispatch: async () => {
    calls++;
    return new Response(null, { status: 200 });
  } });
  await expect(s3.send(s3.objectUrl('a'), { method: 'PUT', headers: { 'if-match': '"observed"' }, body: '' }))
    .rejects.toThrow('ConditionalWriteUnverified');
  await expect(s3.deleteObject('a', '"observed"')).rejects.toThrow('ConditionalDeleteUnverified');
  expect(calls).toBe(0);
});

test('standard AWS HTTPS S3 endpoints support conditional writes without private gateway configuration', () => {
  for (const endpoint of ['https://s3.amazonaws.com', 'https://s3.eu-west-1.amazonaws.com', 'https://s3.dualstack.us-east-1.amazonaws.com']) {
    for (const pathStyle of [true, false]) {
      const s3 = new S3Client({ ...target, ...credentials, endpoint, pathStyle });
      expect(s3.supportsCondition('put')).toBe(true);
      expect(s3.supportsCondition('move')).toBe(true);
    }
  }
  for (const endpoint of ['http://s3.eu-west-1.amazonaws.com', 'https://s3.us-east-1.amazonaws.com:444',
    'https://s3.us-east-1.amazonaws.com.example.org', 'https://s3.us-east-1.amazonaws.com/gateway',
    'https://s3-website.us-east-1.amazonaws.com', 'https://s3-accesspoint.us-east-1.amazonaws.com']) {
    expect(new S3Client({ ...target, ...credentials, endpoint }).supportsCondition('put')).toBe(false);
  }
  expect(new S3Client({ ...target, ...credentials, endpoint: 'https://s3.amazonaws.com',
    headers: { 'x-tenant': 'example' } }).supportsCondition('move')).toBe(false);
});

test('direct links preserve the exact selected key and bind the upload type', async () => {
  const signer = new AwsClient(credentials);
  const key = 'docs//%2e#? /🙂.txt';
  for (const pathStyle of [true, false]) {
    const addressing = { ...target, pathStyle };
    const get = new URL(await presignGetUrl(signer, addressing, key));
    const put = new URL(await presignPutUrl(signer, addressing, key, 'text/plain'));
    expect(decodeURIComponent(get.pathname)).toBe((pathStyle ? '/archive/' : '/') + key);
    expect(put.pathname).toBe(get.pathname);
    expect(put.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain('content-type');
    await expect(presignPutUrl(signer, addressing, 'docs/../a')).rejects.toThrow();
    await expect(presignGetUrl(signer, addressing, '')).rejects.toThrow();
  }
});
