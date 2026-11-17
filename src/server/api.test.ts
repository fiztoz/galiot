import { describe, expect, test } from 'bun:test';
import { handleAppRequest } from './api';
import { SessionStore } from './sessions';
import type { ProxyAddress } from './target';

const GATE = 'alpha-gate';

function sessionBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'archive',
    pathStyle: true,
    accessKeyId: 'AKIA',
    secretAccessKey: 'secret',
    ...extra,
  });
}

async function open(options: Parameters<typeof handleAppRequest>[1], body = sessionBody()) {
  return handleAppRequest(new Request('http://127.0.0.1/api/s3/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-galiot-access-token': GATE },
    body,
  }), options);
}

interface ScriptedResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

/** Records every upstream call and answers from a fixed script, in order. */
function scripted(responses: ScriptedResponse[]) {
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const forward = async (
    url: URL,
    _addresses: readonly ProxyAddress[],
    request: Request,
    headers: Headers,
  ): Promise<Response> => {
    calls.push({ method: request.method, url: url.toString(), headers: Object.fromEntries(headers) });
    const next = responses.shift() ?? { status: 200, body: '' };
    return new Response(next.body ?? '', { status: next.status ?? 200, headers: next.headers });
  };
  return { calls, forward };
}

function callRequest(sessionId: string, body: Record<string, unknown>): Request {
  return new Request(`http://127.0.0.1/api/s3/sessions/${sessionId}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-galiot-access-token': GATE },
    body: JSON.stringify(body),
  });
}

const LOOKUP = async () => [{ address: '10.0.0.5', family: 4 }] as ProxyAddress[];

const LIST_TWO =
  '<ListBucketResult><IsTruncated>false</IsTruncated>' +
  '<Contents><Key>a/x.txt</Key><Size>1</Size></Contents>' +
  '<Contents><Key>a/y.txt</Key><Size>2</Size></Contents>' +
  '</ListBucketResult>';

describe('server-side file operations', () => {
  test('copy signs a copy-source header and never moves bytes through the caller', async () => {
    const sessions = new SessionStore();
    const { calls, forward } = scripted([
      { headers: { 'content-length': '10', 'content-type': 'text/plain' } },
      { body: '<CopyObjectResult><ETag>"copied"</ETag></CopyObjectResult>' },
    ]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;

    const response = await handleAppRequest(callRequest(sessionId, { op: 'copy', sourceKey: 'a.txt', destKey: 'b.txt' }), options);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { result: { copied: number } }).result.copied).toBe(1);
    expect(calls[0]?.method).toBe('HEAD');
    expect(calls[1]?.method).toBe('PUT');
    expect(calls[1]?.headers['x-amz-copy-source']).toBe('/archive/a.txt');
    expect(calls[1]?.url).toBe('https://s3.example.com/archive/b.txt');
  });

  test('rename of a folder copies every key then deletes the sources in one batch', async () => {
    const sessions = new SessionStore();
    const { calls, forward } = scripted([
      { body: LIST_TWO },
      { headers: { 'content-length': '1' } },
      { body: '<CopyObjectResult><ETag>"x"</ETag></CopyObjectResult>' },
      { headers: { 'content-length': '2' } },
      { body: '<CopyObjectResult><ETag>"y"</ETag></CopyObjectResult>' },
      { body: '<DeleteResult><Deleted><Key>a/x.txt</Key></Deleted><Deleted><Key>a/y.txt</Key></Deleted></DeleteResult>' },
    ]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;

    const response = await handleAppRequest(callRequest(sessionId, { op: 'rename', sourceKey: 'a/', destKey: 'b/' }), options);
    expect(((await response.json()) as { result: { moved: number } }).result.moved).toBe(2);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'HEAD', 'PUT', 'HEAD', 'PUT', 'POST']);
    expect(calls[2]?.headers['x-amz-copy-source']).toBe('/archive/a/x.txt');
    expect(calls[4]?.headers['x-amz-copy-source']).toBe('/archive/a/y.txt');
    expect(calls[5]?.url).toContain('delete=');
  });

  test('a folder cannot be moved inside itself', async () => {
    const sessions = new SessionStore();
    const { calls, forward } = scripted([]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;
    const response = await handleAppRequest(callRequest(sessionId, { op: 'rename', sourceKey: 'a/', destKey: 'a/sub/' }), options);
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('createFolder puts an empty object at a slash-terminated key', async () => {
    const sessions = new SessionStore();
    const { calls, forward } = scripted([{ headers: { etag: '"d"' } }]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;
    const response = await handleAppRequest(callRequest(sessionId, { op: 'createFolder', key: 'docs/' }), options);
    expect(response.status).toBe(200);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe('https://s3.example.com/archive/docs/');
  });

  test('a server-originated PUT carries Content-Length, not chunked encoding', async () => {
    const sessions = new SessionStore();
    const { calls, forward } = scripted([{ headers: { etag: '"p"' } }]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;
    const response = await handleAppRequest(callRequest(sessionId, { op: 'putText', key: 'a.txt', body: 'hello server', contentType: 'text/plain' }), options);
    expect(response.status).toBe(200);
    expect(calls[0]?.headers['content-length']).toBe('12');
    expect(calls[0]?.headers['transfer-encoding']).toBeUndefined();
  });

  test('head reports the storage class the bucket sends', async () => {
    const sessions = new SessionStore();
    const { forward } = scripted([{ headers: { 'content-length': '5', 'content-type': 'text/plain', etag: '"e"', 'x-amz-storage-class': 'GLACIER' } }]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;
    const response = await handleAppRequest(callRequest(sessionId, { op: 'head', key: 'a.txt' }), options);
    const result = ((await response.json()) as { result: { storageClass: string | null; contentLength: number } }).result;
    expect(result.storageClass).toBe('GLACIER');
    expect(result.contentLength).toBe(5);
  });

  test('a server share link reads without the gate and is cut off by a gated revoke', async () => {
    const sessions = new SessionStore();
    const { forward } = scripted([{ body: 'object bytes' }, { body: 'still readable' }]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;

    const shared = await handleAppRequest(callRequest(sessionId, { op: 'share', key: 'a.txt', expiresIn: 3600 }), options);
    const url = ((await shared.json()) as { result: { url: string } }).result.url;
    expect(url.startsWith('/api/s3/media/')).toBe(true);

    const read = await handleAppRequest(new Request(`http://127.0.0.1${url}`), options);
    expect(read.status).toBe(200);
    expect(await read.text()).toBe('object bytes');

    // The operator's vault locks and the session dies; an issued link must not.
    const closed = await handleAppRequest(new Request(`http://127.0.0.1/api/s3/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'x-galiot-access-token': GATE },
    }), options);
    expect(closed.status).toBe(200);
    const afterLock = await handleAppRequest(new Request(`http://127.0.0.1${url}`), options);
    expect(afterLock.status).toBe(200);
    expect(await afterLock.text()).toBe('still readable');

    const anonymousRevoke = await handleAppRequest(new Request(`http://127.0.0.1${url}`, { method: 'DELETE' }), options);
    expect(anonymousRevoke.status).toBe(403);

    const revoke = await handleAppRequest(new Request(`http://127.0.0.1${url}`, {
      method: 'DELETE',
      headers: { 'x-galiot-access-token': GATE },
    }), options);
    expect(((await revoke.json()) as { result: { revoked: boolean } }).result.revoked).toBe(true);

    const after = await handleAppRequest(new Request(`http://127.0.0.1${url}`), options);
    expect(after.status).toBe(404);
  });

  test('listVersions filters to the exact key and reports delete markers', async () => {
    const sessions = new SessionStore();
    const { calls, forward } = scripted([
      { body:
        '<ListVersionsResult>' +
        '<Version><Key>a.txt</Key><VersionId>v2</VersionId><IsLatest>true</IsLatest><LastModified>2026-01-02T00:00:00Z</LastModified><Size>9</Size><ETag>"b"</ETag></Version>' +
        '<DeleteMarker><Key>a.txt</Key><VersionId>v3</VersionId><IsLatest>false</IsLatest><LastModified>2026-01-03T00:00:00Z</LastModified></DeleteMarker>' +
        '<Version><Key>a.txt.bak</Key><VersionId>v9</VersionId><IsLatest>true</IsLatest><Size>1</Size></Version>' +
        '</ListVersionsResult>' },
    ]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;
    const response = await handleAppRequest(callRequest(sessionId, { op: 'listVersions', key: 'a.txt' }), options);
    const result = ((await response.json()) as { result: { versions: { versionId: string; isDeleteMarker: boolean }[]; unversioned: boolean } }).result;
    expect(result.versions.map((v) => v.versionId)).toEqual(['v3', 'v2']);
    expect(result.versions[0]?.isDeleteMarker).toBe(true);
    expect(result.unversioned).toBe(false);
    expect(calls[0]?.url).toContain('versions=');
    expect(calls[0]?.url).toContain('prefix=a.txt');
  });

  test('restoreVersion copies the old version onto the same key', async () => {
    const sessions = new SessionStore();
    const { calls, forward } = scripted([{ body: '<CopyObjectResult><ETag>"r"</ETag></CopyObjectResult>' }]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;
    const response = await handleAppRequest(callRequest(sessionId, { op: 'restoreVersion', key: 'a.txt', versionId: 'v1' }), options);
    expect(response.status).toBe(200);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.headers['x-amz-copy-source']).toBe('/archive/a.txt?versionId=v1');
    expect(calls[0]?.url).toBe('https://s3.example.com/archive/a.txt');
  });

  test('search walks pages and caps matches', async () => {
    const sessions = new SessionStore();
    const page = (keys: string[], truncated: boolean) =>
      `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>` +
      (truncated ? '<NextContinuationToken>next</NextContinuationToken>' : '') +
      keys.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join('') +
      '</ListBucketResult>';
    const { calls, forward } = scripted([
      { body: page(['docs/report-1.txt', 'img/logo.png'], true) },
      { body: page(['docs/report-2.txt'], false) },
    ]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;
    const response = await handleAppRequest(callRequest(sessionId, { op: 'search', query: 'report' }), options);
    const result = ((await response.json()) as { result: { objects: { key: string }[]; scanned: number; truncated: boolean } }).result;
    expect(result.objects.map((o) => o.key)).toEqual(['docs/report-1.txt', 'docs/report-2.txt']);
    expect(result.scanned).toBe(3);
    expect(result.truncated).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('continuation-token=next');
  });

  test('listTree carries sizes and storage classes for folder downloads', async () => {
    const sessions = new SessionStore();
    const { forward } = scripted([
      { body:
        '<ListBucketResult><IsTruncated>false</IsTruncated>' +
        '<Contents><Key>a/x.txt</Key><Size>1</Size><StorageClass>GLACIER</StorageClass></Contents>' +
        '<Contents><Key>a/y.txt</Key><Size>2</Size></Contents>' +
        '</ListBucketResult>' },
    ]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;
    const response = await handleAppRequest(callRequest(sessionId, { op: 'listTree', prefix: 'a/' }), options);
    const result = ((await response.json()) as { result: { objects: { key: string; size: number; storageClass: string | null }[] } }).result;
    expect(result.objects).toEqual([
      { key: 'a/x.txt', size: 1, storageClass: 'GLACIER' },
      { key: 'a/y.txt', size: 2, storageClass: null },
    ]);
  });

  test('head surfaces object-lock mode, retain-until, and legal hold', async () => {
    const sessions = new SessionStore();
    const { forward } = scripted([
      { headers: {
        'content-length': '5',
        'x-amz-object-lock-mode': 'COMPLIANCE',
        'x-amz-object-lock-retain-until-date': '2030-01-01T00:00:00Z',
        'x-amz-object-lock-legal-hold': 'ON',
      } },
    ]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;
    const response = await handleAppRequest(callRequest(sessionId, { op: 'head', key: 'a.txt' }), options);
    const result = ((await response.json()) as { result: { objectLockMode: string | null; retainUntil: string | null; legalHold: string | null } }).result;
    expect(result.objectLockMode).toBe('COMPLIANCE');
    expect(result.retainUntil).toBe('2030-01-01T00:00:00Z');
    expect(result.legalHold).toBe('ON');
  });

  test('restore on a provider without archive tiers reports unsupported, not denied', async () => {
    const sessions = new SessionStore();
    const { forward } = scripted([{ status: 501, body: '<Error><Code>NotImplemented</Code></Error>' }]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;
    const response = await handleAppRequest(callRequest(sessionId, { op: 'restore', key: 'a.txt', days: 1 }), options);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; unsupported: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.unsupported).toBe(true);
    expect(body.code).toBe('NotImplemented');
  });

  test('a write grant accepts one bounded PUT without the gate and is revocable', async () => {
    const sessions = new SessionStore();
    const { calls, forward } = scripted([{ headers: { etag: '"u"' } }]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;

    const granted = await handleAppRequest(callRequest(sessionId, { op: 'shareWrite', key: 'inbox/a.bin', expiresIn: 3600, maxBytes: 16 }), options);
    const grant = ((await granted.json()) as { result: { url: string; maxBytes: number } }).result;
    expect(grant.url.startsWith('/api/s3/upload/')).toBe(true);
    expect(grant.maxBytes).toBe(16);

    const put = await handleAppRequest(new Request(`http://127.0.0.1${grant.url}`, {
      method: 'PUT',
      headers: { 'content-length': '5', 'content-type': 'application/octet-stream' },
      body: 'hello',
    }), options);
    expect(put.status).toBe(200);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe('https://s3.example.com/archive/inbox/a.bin');
    expect(calls[0]?.headers['content-length']).toBe('5');

    const tooBig = await handleAppRequest(new Request(`http://127.0.0.1${grant.url}`, {
      method: 'PUT',
      headers: { 'content-length': '17' },
      body: 'x'.repeat(17),
    }), options);
    expect(tooBig.status).toBe(413);

    const noLength = await handleAppRequest(new Request(`http://127.0.0.1${grant.url}`, {
      method: 'PUT',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello'));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit), options);
    expect(noLength.status).toBe(411);

    const wrongMethod = await handleAppRequest(new Request(`http://127.0.0.1${grant.url}`), options);
    expect(wrongMethod.status).toBe(405);

    const anonRevoke = await handleAppRequest(new Request(`http://127.0.0.1${grant.url}`, { method: 'DELETE' }), options);
    expect(anonRevoke.status).toBe(403);
    const revoke = await handleAppRequest(new Request(`http://127.0.0.1${grant.url}`, {
      method: 'DELETE',
      headers: { 'x-galiot-access-token': GATE },
    }), options);
    expect(revoke.status).toBe(200);
    const after = await handleAppRequest(new Request(`http://127.0.0.1${grant.url}`, {
      method: 'PUT',
      headers: { 'content-length': '5' },
      body: 'hello',
    }), options);
    expect(after.status).toBe(404);
  });

  test('a read grant cannot be used to upload', async () => {
    const sessions = new SessionStore();
    const { forward } = scripted([]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;
    const granted = await handleAppRequest(callRequest(sessionId, { op: 'share', key: 'a.txt', expiresIn: 3600 }), options);
    const url = ((await granted.json()) as { result: { url: string } }).result.url;
    const put = await handleAppRequest(new Request(`http://127.0.0.1${url}`, {
      method: 'PUT',
      headers: { 'content-length': '5' },
      body: 'hello',
    }), options);
    expect(put.status).toBe(405);
  });

  test('list-buckets signs the endpoint root and returns the names', async () => {
    const { calls, forward } = scripted([
      { body: '<ListAllMyBucketsResult><Buckets><Bucket><Name>archive</Name></Bucket><Bucket><Name>logs</Name></Bucket></Buckets></ListAllMyBucketsResult>' },
    ]);
    const response = await handleAppRequest(new Request('http://127.0.0.1/api/s3/list-buckets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galiot-access-token': GATE },
      body: sessionBody(),
    }), { expectedToken: GATE, lookup: LOOKUP, forward });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { result: { buckets: string[] } }).result.buckets).toEqual(['archive', 'logs']);
    expect(calls[0]?.url).toBe('https://s3.example.com/');
    expect(calls[0]?.headers.authorization).toContain('AWS4-HMAC-SHA256');
  });
});

describe('server-side S3 API', () => {
  test('health reports the gate without calling S3', async () => {
    let called = false;
    const response = await handleAppRequest(new Request('http://127.0.0.1/api/health'), {
      expectedToken: GATE,
      forward: async () => {
        called = true;
        return new Response('no');
      },
    });
    expect(called).toBe(false);
    expect(await response.json()).toEqual({ ok: true, tokenRequired: true, tokenAccepted: false });
  });

  test('a public bind still needs the gate before a session exists', async () => {
    const response = await handleAppRequest(new Request('http://127.0.0.1/api/s3/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: sessionBody(),
    }), { expectedToken: GATE, sessions: new SessionStore() });
    expect(response.status).toBe(403);
  });

  test('refuses a metadata address and does not open a connection', async () => {
    let forwarded = false;
    const response = await open({
      expectedToken: GATE,
      sessions: new SessionStore(),
      forward: async () => {
        forwarded = true;
        return new Response('no');
      },
    }, sessionBody({ endpoint: 'http://169.254.169.254' }));
    expect(response.status).toBe(400);
    expect(forwarded).toBe(false);
  });

  test('signs and connects only to the session endpoint', async () => {
    const sessions = new SessionStore();
    const calls: { url: string; authorization: string | null; tenant: string | null }[] = [];
    const options = {
      expectedToken: GATE,
      sessions,
      lookup: async () => [{ address: '10.0.0.5', family: 4 }] as ProxyAddress[],
      forward: async (url: URL, _addresses: readonly ProxyAddress[], _request: Request, headers: Headers) => {
        calls.push({
          url: url.toString(),
          authorization: headers.get('authorization'),
          tenant: headers.get('x-tenant-id'),
        });
        return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', {
          status: 200,
          headers: { etag: '"abc"', 'access-control-allow-origin': '*', 'cache-control': 'public' },
        });
      },
    };
    const created = await open(options, sessionBody({
      headers: { 'x-tenant-id': 'acme', 'x-api-key': 'nope' },
    }));
    expect(created.status).toBe(200);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;

    const listed = await handleAppRequest(new Request(`http://127.0.0.1/api/s3/sessions/${sessionId}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galiot-access-token': GATE },
      body: JSON.stringify({ op: 'list', endpoint: 'http://169.254.169.254/latest' }),
    }), options);
    expect(listed.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://s3.example.com/archive/?list-type=2');
    expect(calls[0]?.authorization).toContain('AWS4-HMAC-SHA256');
    expect(calls[0]?.tenant).toBe('acme');
    const body = await listed.json() as { ok: boolean; result: { isTruncated: boolean } };
    expect(body.ok).toBe(true);
    expect(body.result.isTruncated).toBe(false);

    const closed = await handleAppRequest(new Request(`http://127.0.0.1/api/s3/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'x-galiot-access-token': GATE },
    }), options);
    expect(closed.status).toBe(200);
    const again = await handleAppRequest(new Request(`http://127.0.0.1/api/s3/sessions/${sessionId}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galiot-access-token': GATE },
      body: JSON.stringify({ op: 'list' }),
    }), options);
    expect(again.status).toBe(404);
  });
});
