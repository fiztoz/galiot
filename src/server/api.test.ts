import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { handleAppRequest } from './api';
import { SessionStore } from './sessions';
import { publicOrigins } from './proxy';
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

describe('browser control and share boundaries', () => {
  test('gate-free controls accept local clients and reject foreign origins, hosts and plain-text requests', async () => {
    const options = { expectedToken: null, sessions: new SessionStore(), lookup: LOOKUP, listenerPort: 8788 };
    const submit = (host: string, origin: string, type = 'application/json') => handleAppRequest(
      new Request(`http://${host}/api/s3/sessions`, {
        method: 'POST', headers: { origin, 'content-type': type }, body: sessionBody(),
      }), options,
    );
    expect((await submit('localhost:8788', 'http://localhost:8788')).status).toBe(200);
    expect((await submit('localhost:8788', 'https://example.com')).status).toBe(403);
    expect((await submit('example.com:8788', 'http://example.com:8788')).status).toBe(403);
    expect((await submit('localhost:8080', 'http://localhost:8080')).status).toBe(403);
    expect((await submit('localhost:8788', 'http://localhost:8788', 'text/plain')).status).toBe(400);
  });

  test('open listeners allow configured TLS authorities and literal addresses', async () => {
    const origins = publicOrigins({ GALIOT_PUBLIC_ORIGINS: ' https://galiot.example.com , https://galiot.example.com:8443' });
    const options = { expectedToken: null, open: true, listenerPort: 8788, publicOrigins: origins, sessions: new SessionStore(), lookup: LOOKUP };
    const submit = (host: string, origin: string) => handleAppRequest(new Request('http://' + host + '/api/s3/sessions', {
      method: 'POST', headers: { host, origin, 'content-type': 'application/json' }, body: sessionBody(),
    }), options);
    expect((await submit('galiot.example.com', origins[0]!)).status).toBe(200);
    expect((await submit('galiot.example.com:8443', origins[1]!)).status).toBe(200);
    expect((await submit('10.0.0.5:8899', 'http://10.0.0.5:8899')).status).toBe(200);
    expect((await submit('example.com:8788', 'http://example.com:8788')).status).toBe(403);
    expect((await submit('galiot.example.com', 'https://example.com')).status).toBe(403);
    expect((await submit('galiot.example.com:444', 'https://galiot.example.com:444')).status).toBe(403);
    expect(() => publicOrigins({ GALIOT_PUBLIC_ORIGINS: 'https://example.com/path' })).toThrow('GALIOT_PUBLIC_ORIGINS');
  });

  test('object downloads sandbox the response and retain only safe media headers', async () => {
    const { forward } = scripted([
      { body: 'document', headers: { 'content-type': 'text/html', 'set-cookie': 'fixture=1', location: '/other' } },
      { body: 'part', status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/8', 'x-amz-version-id': 'video-version' } },
    ]);
    const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP, forward };
    const created = await open(options);
    const { result: { sessionId } } = await created.json() as { result: { sessionId: string } };
    const shared = await handleAppRequest(callRequest(sessionId, { op: 'share', key: 'file.pdf' }), options);
    const { result: { url } } = await shared.json() as { result: { url: string } };
    const read = () => new Request('http://127.0.0.1' + url);
    const document = await handleAppRequest(read(), options);
    expect(document.headers.get('content-type')).toBe('application/octet-stream');
    expect(document.headers.get('content-disposition')).toStartWith('attachment');
    expect(document.headers.get('content-security-policy')).toContain('sandbox');
    expect(document.headers.get('x-content-type-options')).toBe('nosniff');
    expect(document.headers.has('set-cookie')).toBe(false);
    expect(document.headers.has('location')).toBe(false);
    const media = await handleAppRequest(read(), options);
    expect(media.status).toBe(206);
    expect(media.headers.get('content-type')).toBe('video/mp4');
    expect(media.headers.get('content-range')).toBe('bytes 0-3/8');
    expect(media.headers.get('x-amz-version-id')).toBe('video-version');
  });

  test('transfer reads transmit the stored bytes of encoded S3 objects', async () => {
    const metadata = { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'etag': '"stored"' };
    const { forward } = scripted([{ headers: metadata, body: 'stored bytes' }]);
    const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP, forward };
    const { result: { sessionId } } = await (await open(options)).json() as { result: { sessionId: string } };
    const response = await handleAppRequest(new Request(`http://localhost/api/s3/sessions/${sessionId}/object?key=test&raw=1`, {
      headers: { 'x-galiot-access-token': GATE },
    }), options);
    expect(response.headers.has('content-encoding')).toBe(false);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('etag')).toBe('"stored"');
    expect(await response.text()).toBe('stored bytes');
  });

  test('a different store cannot confirm revocation of an issued link', async () => {
    const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP };
    const { result: { sessionId } } = await (await open(options)).json() as { result: { sessionId: string } };
    const token = options.sessions.mintMedia(sessionId, 'one.txt')!;
    expect(new SessionStore().revokeMedia(token)).toBe(false);
    expect(options.sessions.revokeMedia(token)).toBe(true);
    expect(options.sessions.revokeMedia(token)).toBe(true);
  });

  test('idle credential cleanup runs without a subsequent request', async () => {
    const store = new SessionStore();
    const id = store.create(JSON.parse(sessionBody()));
    const grant = store.mintMedia(id, 'sample.txt', { ttlMs: 10 });
    const wiped: string[] = [];
    const revoked: string[] = [];
    const destroy = store.destroy.bind(store);
    const revoke = store.revokeMedia.bind(store);
    store.destroy = session => { wiped.push(session); destroy(session); };
    store.revokeMedia = token => { revoked.push(token); return revoke(token); };
    store.use(id, 10);
    await Bun.sleep(40);
    expect(wiped).toContain(id);
    expect(revoked).toContain(grant!);
  });
});

const LIST_TWO =
  '<ListBucketResult><IsTruncated>false</IsTruncated>' +
  '<Contents><Key>a/x.txt</Key><Size>1</Size></Contents>' +
  '<Contents><Key>a/y.txt</Key><Size>2</Size></Contents>' +
  '</ListBucketResult>';

describe('automatic editor verification', () => {
  function gateway(mode: 'enforce' | 'ignore' | 'reject-all' | 'deny-cleanup', bodyGate = Promise.resolve()) {
    const writes: { path: string; ifMatch: string | null; ifNoneMatch: string | null; length: string | null }[] = [];
    const deletes: { path: string; versionId: string | null }[] = [];
    const versions = new Map<string, { text: string; eTag: string }>();
    let revision = 0;
    const forward: NonNullable<Parameters<typeof handleAppRequest>[1]['forward']> = async (url, _addresses, request, headers) => {
      if (url.searchParams.has('list-type')) return new Response(LIST_TWO);
      const probe = url.pathname.startsWith('/staging-bucket/.galiot-editor-check/');
      if (!probe) {
        if (request.method === 'PUT' && headers.get('if-match') === '"user-revision"') return new Response(null, { status: 200 });
        throw new Error('Unexpected upstream request');
      }
      const latest = [...versions.values()].at(-1);
      if (request.method === 'GET') {
        return latest ? new Response(latest.text, { headers: { etag: latest.eTag } }) : new Response(null, { status: 404 });
      }
      if (request.method === 'DELETE') {
        const versionId = url.searchParams.get('versionId');
        deletes.push({ path: url.pathname, versionId });
        if (mode === 'deny-cleanup') return new Response(null, { status: 403 });
        if (!versionId || !versions.delete(versionId)) return new Response(null, { status: 400 });
        return new Response(null, { status: 204 });
      }
      const ifMatch = headers.get('if-match');
      writes.push({ path: url.pathname, ifMatch, ifNoneMatch: headers.get('if-none-match'), length: headers.get('content-length') });
      await bodyGate;
      if (ifMatch && mode !== 'ignore' && (mode === 'reject-all' || ifMatch !== latest?.eTag)) {
        return new Response(null, { status: 412 });
      }
      const versionId = `version-${++revision}`;
      versions.set(versionId, { text: await request.text(), eTag: `"${versionId}"` });
      return new Response(null, { headers: { 'x-amz-version-id': versionId } });
    };
    return { forward, writes, deletes, versions };
  }

  async function editorSession(options: Parameters<typeof handleAppRequest>[1], extra: Record<string, unknown> = {}) {
    const response = await open(options, sessionBody({ bucket: 'staging-bucket', verifyEditorWrites: true, ...extra }));
    const { result } = await response.json() as { result: { sessionId: string } };
    return result.sessionId;
  }

  async function support(id: string, options: Parameters<typeof handleAppRequest>[1]) {
    const response = await handleAppRequest(callRequest(id, { op: 'editorWriteSupport' }), options);
    return (await response.json() as { result: { conditionalPut: boolean; issue?: string } }).result;
  }

  function save(id: string, options: Parameters<typeof handleAppRequest>[1]) {
    return handleAppRequest(new Request(`http://localhost/api/s3/sessions/${id}/object?key=accounting.txt`, {
      method: 'PUT', body: 'new content',
      headers: { 'content-length': '11', 'if-match': '"user-revision"', 'x-galiot-access-token': GATE },
    }), options);
  }

  test('starts after listing without blocking it; one server-side proof enables only that session’s saves', async () => {
    const resume = Promise.withResolvers<void>();
    const fake = gateway('enforce', resume.promise);
    let now = Date.now();
    const options = { expectedToken: GATE, sessions: new SessionStore(() => now), lookup: LOOKUP, forward: fake.forward };
    const id = await editorSession(options);
    expect(fake.writes).toHaveLength(0);
    try {
      const listed = await handleAppRequest(callRequest(id, { op: 'list' }), options);
      expect((await listed.json()).ok).toBe(true);
      expect((await save(id, options)).status).toBe(501);
    } finally {
      resume.resolve();
    }
    expect(await Promise.all([support(id, options), support(id, options)])).toEqual([{ conditionalPut: true }, { conditionalPut: true }]);
    expect(fake.writes).toHaveLength(3);
    expect(fake.writes[0]).toMatchObject({ ifNoneMatch: '*', ifMatch: null });
    expect(Number(fake.writes[0]?.length)).toBeGreaterThan(0);
    expect(fake.writes[1]?.ifMatch).not.toBe(fake.writes[2]?.ifMatch);
    expect(fake.writes[2]?.ifMatch).toBe('"version-1"');
    const key = fake.writes[0]?.path ?? '';
    expect(key).toStartWith('/staging-bucket/.galiot-editor-check/');
    expect(new Set(fake.writes.map(write => write.path))).toEqual(new Set([key]));
    expect(fake.deletes).toEqual([{ path: key, versionId: 'version-1' }, { path: key, versionId: 'version-2' }]);
    expect(fake.versions.size).toBe(0);
    expect((await save(id, options)).status).toBe(200);
    const other = await editorSession(options, { verifyEditorWrites: false, conditionalPut: true });
    expect((await handleAppRequest(callRequest(other, { op: 'list' }), options)).status).toBe(200);
    expect((await support(other, options)).conditionalPut).toBe(false);
    expect((await save(other, options)).status).toBe(501);
    expect(fake.writes).toHaveLength(3);

    now += 10 * 60_000;
    expect((await save(id, options)).status).toBe(501);
    expect((await support(id, options)).conditionalPut).toBe(true);
    expect(fake.writes).toHaveLength(6);
    expect(fake.writes[3]?.path).not.toBe(key);
    options.sessions.destroy(id);
    expect((await save(id, options)).status).toBe(404);
  });

  for (const [mode, message] of [
    ['ignore', 'mismatched ETag'], ['reject-all', 'current ETag'], ['deny-cleanup', '.galiot-editor-check/'],
  ] as const) {
    test(`keeps the editor read-only when the gateway responds with ${mode}`, async () => {
      const fake = gateway(mode);
      const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP, forward: fake.forward };
      const id = await editorSession(options);
      const first = await support(id, options);
      expect(first.conditionalPut).toBe(false);
      expect(first.issue).toContain(message);
      expect(await support(id, options)).toEqual(first);
      expect((await save(id, options)).status).toBe(501);
      expect(fake.writes).toHaveLength(mode === 'ignore' ? 2 : 3);
      expect(fake.versions.size).toBe(mode === 'deny-cleanup' ? 2 : 0);
    });
  }
});

describe('server-side file operations', () => {
  let previousConditions: string | undefined;
  beforeEach(() => {
    previousConditions = process.env.GALIOT_S3_CONDITIONS;
    process.env.GALIOT_S3_CONDITIONS = JSON.stringify({ 'https://s3.example.com/archive/': ['put', 'move'] });
  });
  afterEach(() => {
    if (previousConditions === undefined) delete process.env.GALIOT_S3_CONDITIONS;
    else process.env.GALIOT_S3_CONDITIONS = previousConditions;
  });

  test('uncertified buckets offer read-only editing and retain move sources without an upstream operation', async () => {
    process.env.GALIOT_S3_CONDITIONS = JSON.stringify({ 'https://s3.example.com/other/': ['put', 'move'] });
    const { calls, forward } = scripted([]);
    const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP, forward };
    const { result } = await (await open(options)).json() as { result: { sessionId: string } };
    const support = await handleAppRequest(callRequest(result.sessionId, { op: 'editorWriteSupport' }), options);
    expect(await support.json()).toMatchObject({ ok: true, result: { conditionalPut: false } });
    const rename = await handleAppRequest(callRequest(result.sessionId, { op: 'rename', sourceKey: 'a', destKey: 'b' }), options);
    expect(rename.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
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

  test('rename copies every key before conditionally deleting the observed sources', async () => {
    const sessions = new SessionStore();
    const { calls, forward } = scripted([
      { body: LIST_TWO },
      { headers: { 'content-length': '1', etag: '"source-x"' } },
      { body: '<CopyObjectResult><ETag>"x"</ETag></CopyObjectResult>' },
      { headers: { 'content-length': '2', etag: '"source-y"' } },
      { body: '<CopyObjectResult><ETag>"y"</ETag></CopyObjectResult>' },
      {}, {},
    ]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const created = await open(options);
    const sessionId = ((await created.json()) as { result: { sessionId: string } }).result.sessionId;

    const response = await handleAppRequest(callRequest(sessionId, { op: 'rename', sourceKey: 'a/', destKey: 'b/' }), options);
    expect(((await response.json()) as { result: { moved: number } }).result.moved).toBe(2);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'HEAD', 'PUT', 'HEAD', 'PUT', 'DELETE', 'DELETE']);
    expect(calls[2]?.headers['x-amz-copy-source']).toBe('/archive/a/x.txt');
    expect(calls[4]?.headers['x-amz-copy-source']).toBe('/archive/a/y.txt');
    expect(calls[2]?.headers['x-amz-copy-source-if-match']).toBe('"source-x"');
    expect(calls[5]?.headers['if-match']).toBe('"source-x"');
    expect(calls[6]?.headers['if-match']).toBe('"source-y"');
  });

  test('an overlapping ancestor move stops before copying', async () => {
    // Moving p/a/ to p/ maps the nested a/y onto the source p/a/y.
    const listing = LIST_TWO.replace('a/y.txt', 'p/a/y.txt').replace('a/x.txt', 'p/a/a/y.txt');
    const { calls, forward } = scripted([{ body: listing }]);
    const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP, forward };
    const { result } = await (await open(options)).json() as { result: { sessionId: string } };
    const res = await handleAppRequest(callRequest(result.sessionId, { op: 'rename', sourceKey: 'p/a/', destKey: 'p/' }), options);
    expect(res.status).toBe(400);
    expect(calls.map(call => call.method)).toEqual(['GET']);
  });

  test('a provider error inside HTTP 200 keeps the source', async () => {
    const { calls, forward } = scripted([
      { headers: { etag: '"source"', 'content-length': '12' } },
      { body: '<Error><Code>InternalError</Code></Error>' },
    ]);
    const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP, forward };
    const { result } = await (await open(options)).json() as { result: { sessionId: string } };
    const res = await handleAppRequest(callRequest(result.sessionId, { op: 'rename', sourceKey: 'a.txt', destKey: 'b.txt' }), options);
    expect(await res.json()).toMatchObject({ ok: false, code: 'InternalError' });
    expect(calls.map(call => call.method)).toEqual(['HEAD', 'PUT']);
  });

  test('multipart move pins every part and aborts a failed completion while retaining the source', async () => {
    const { calls, forward } = scripted([
      { headers: { etag: '"source"', 'x-amz-version-id': 'observed', 'content-length': String(5 * 1024 ** 3 + 1) } },
      { body: '<InitiateMultipartUploadResult><UploadId>upload</UploadId></InitiateMultipartUploadResult>' },
      ...Array.from({ length: 11 }, () => ({ body: '<CopyPartResult><ETag>"part"</ETag></CopyPartResult>' })),
      { body: '<Error><Code>InvalidPart</Code></Error>' }, {},
    ]);
    const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP, forward };
    const { result } = await (await open(options)).json() as { result: { sessionId: string } };
    const res = await handleAppRequest(callRequest(result.sessionId, { op: 'rename', sourceKey: 'a', destKey: 'b' }), options);
    expect(await res.json()).toMatchObject({ ok: false, code: 'InvalidPart' });
    const parts = calls.filter(call => call.method === 'PUT');
    expect(parts).toHaveLength(11);
    for (const part of parts) {
      expect(part.headers['x-amz-copy-source-if-match']).toBe('"source"');
      expect(part.headers['x-amz-copy-source']).toBe('/archive/a?versionId=observed');
    }
    const deletes = calls.filter(call => call.method === 'DELETE');
    expect(deletes.map(call => new URL(call.url).pathname)).toEqual(['/archive/b']);
    expect(new URL(deletes[0]!.url).searchParams.get('uploadId')).toBe('upload');
  });

  test('an unverified gateway cannot assemble a multipart copy from mutable source revisions', async () => {
    delete process.env.GALIOT_S3_CONDITIONS;
    const { calls, forward } = scripted([
      { headers: { etag: '"mutable"', 'content-length': String(5 * 1024 ** 3 + 1), 'x-amz-version-id': 'null' } },
    ]);
    const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP, forward };
    const { result } = await (await open(options)).json() as { result: { sessionId: string } };
    const res = await handleAppRequest(callRequest(result.sessionId, { op: 'copy', sourceKey: 'a', destKey: 'b' }), options);
    expect(res.status).toBe(400);
    expect(calls.map(c => c.method)).toEqual(['HEAD']);
  });

  test('streamed editor writes forward the strong read ETag, MIME, length and provider conflict', async () => {
    const { calls, forward } = scripted([{ status: 412 }]);
    const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP, forward };
    const { result } = await (await open(options)).json() as { result: { sessionId: string } };
    const req = new Request('http://127.0.0.1/api/s3/sessions/' + result.sessionId + '/object?key=a', {
      method: 'PUT', body: '',
      headers: { 'x-galiot-access-token': GATE, 'content-length': '0', 'if-match': '"observed"', 'content-type': 'application/json' },
    });
    expect((await handleAppRequest(req, options)).status).toBe(412);
    expect(calls[0]?.headers['if-match']).toBe('"observed"');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.headers['content-length']).toBe('0');
  });

  test('a conditional cleanup refusal reports the key without retrying an unconditional deletion', async () => {
    const { calls, forward } = scripted([
      { headers: { etag: '"source"', 'content-length': '12' } },
      { body: '<CopyObjectResult><ETag>"dest"</ETag></CopyObjectResult>' },
      { status: 412, body: '<Error><Code>PreconditionFailed</Code></Error>' },
    ]);
    const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP, forward };
    const { result } = await (await open(options)).json() as { result: { sessionId: string } };
    const res = await handleAppRequest(callRequest(result.sessionId, { op: 'rename', sourceKey: 'a.txt', destKey: 'b.txt' }), options);
    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringContaining('a.txt') });
    expect(calls.map(call => call.method)).toEqual(['HEAD', 'PUT', 'DELETE']);
    expect(calls[2]?.headers['if-match']).toBe('"source"');
  });

  test('a version-pinned copy retains the source, including the null version on suspended buckets', async () => {
    for (const versionId of ['v1', 'null']) {
      const { calls, forward } = scripted([
        { headers: { etag: '"same-bytes"', 'x-amz-version-id': versionId, 'content-length': '4' } },
        { body: '<CopyObjectResult><ETag>"same-bytes"</ETag></CopyObjectResult>' },
      ]);
      const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP, forward };
      const { result } = await (await open(options)).json() as { result: { sessionId: string } };
      const res = await handleAppRequest(callRequest(result.sessionId, { op: 'rename', sourceKey: 'a', destKey: 'b' }), options);
      expect(await res.json()).toMatchObject({ ok: false, error: expect.stringContaining('All sources were retained') });
      expect(calls.map(c => c.method)).toEqual(['HEAD', 'PUT']);
      expect(calls[1]?.headers['x-amz-copy-source']).toBe('/archive/a?versionId=' + versionId);
    }
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

  test('multipart cancellation reports the provider status and error code', async () => {
    const { forward } = scripted([{ status: 403, body: '<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>' }]);
    const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP, forward };
    const { result: { sessionId } } = await (await open(options)).json() as { result: { sessionId: string } };
    const response = await handleAppRequest(callRequest(sessionId, {
      op: 'abortMultipart', key: 'sample.bin', uploadId: 'fixture',
    }), options);
    expect(await response.json()).toMatchObject({ ok: false, operation: 'abortMultipart', status: 403, code: 'AccessDenied' });
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

    const put = () => handleAppRequest(new Request(`http://127.0.0.1${grant.url}`, {
      method: 'PUT',
      headers: { 'content-length': '5', 'content-type': 'application/octet-stream' },
      body: 'hello',
    }), options);
    const results = await Promise.all([put(), put()]);
    expect(results.map(result => result.status).sort()).toEqual([200, 404]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe('https://s3.example.com/archive/inbox/a.bin');
    expect(calls[0]?.headers['content-length']).toBe('5');

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

  test('a dispatched empty upload uses its one attempt even if S3 fails', async () => {
    const sessions = new SessionStore();
    const { calls, forward } = scripted([{ status: 503 }]);
    const options = { expectedToken: GATE, sessions, lookup: LOOKUP, forward };
    const { result: { sessionId } } = await (await open(options)).json() as { result: { sessionId: string } };
    const token = sessions.mintMedia(sessionId, 'empty.txt', { kind: 'write', maxBytes: 16 });
    const put = () => handleAppRequest(new Request('http://localhost/api/s3/upload/' + token, {
      method: 'PUT', headers: { 'content-length': '0' },
    }), options);
    expect((await put()).status).toBe(503);
    expect((await put()).status).toBe(404);
    expect(calls).toHaveLength(1);
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

describe('multipart bookkeeping', () => {
  async function session(responses: ScriptedResponse[]) {
    const { calls, forward } = scripted(responses);
    const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP, forward };
    const { result: { sessionId } } = await (await open(options)).json() as { result: { sessionId: string } };
    return { calls, options, sessionId };
  }

  test('listParts follows NextPartNumberMarker past the first 1000 parts', async () => {
    const part = (n: number) => `<Part><PartNumber>${n}</PartNumber><ETag>"e${n}"</ETag><Size>5</Size></Part>`;
    const { calls, options, sessionId } = await session([
      { body: `<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>1</NextPartNumberMarker>${part(1)}</ListPartsResult>` },
      { body: `<ListPartsResult><IsTruncated>false</IsTruncated>${part(2)}</ListPartsResult>` },
    ]);
    const response = await handleAppRequest(callRequest(sessionId, { op: 'listParts', key: 'big.bin', uploadId: 'u1' }), options);
    const body = await response.json() as { ok: boolean; result: { parts: { partNumber: number }[] } };
    expect(body.result.parts.map(p => p.partNumber)).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('part-number-marker=1');
  });

  test('completeMultipart rejects a malformed part instead of dropping it', async () => {
    const { calls, options, sessionId } = await session([]);
    const response = await handleAppRequest(callRequest(sessionId, {
      op: 'completeMultipart',
      key: 'big.bin',
      uploadId: 'u1',
      parts: [{ PartNumber: 1, ETag: '"a"' }, { PartNumber: '2', ETag: '"b"' }],
    }), options);
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('media grant eviction', () => {
  test('a full grant table evicts the grant closest to expiry, not a long share', () => {
    const store = new SessionStore();
    const id = store.create(JSON.parse(sessionBody()));
    const share = store.mintMedia(id, 'shared.txt', { ttlMs: 7 * 24 * 3600 * 1000 })!;
    for (let i = 0; i < 600; i++) store.mintMedia(id, `preview-${i}.png`);
    expect(store.useMedia(share)?.key).toBe('shared.txt');
  });
});

describe('share link failures', () => {
  test('a link holder never sees upstream addresses in an error', async () => {
    const forward = async (): Promise<Response> => { throw new Error('connect ECONNREFUSED 10.0.0.5:9000'); };
    const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP, forward };
    const { result: { sessionId } } = await (await open(options)).json() as { result: { sessionId: string } };
    const token = options.sessions.mintMedia(sessionId, 'shared.txt')!;
    const original = console.error;
    console.error = () => {};
    try {
      const response = await handleAppRequest(new Request(`http://127.0.0.1/api/s3/media/${token}`), options);
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain('10.0.0.5');
    } finally {
      console.error = original;
    }
  });
});

describe('upload integrity', () => {
  test('a valid Content-MD5 reaches S3 with the part; a malformed one is dropped', async () => {
    const { calls, forward } = scripted([{ headers: { etag: '"p1"' } }, { headers: { etag: '"p2"' } }]);
    const options = { expectedToken: GATE, sessions: new SessionStore(), lookup: LOOKUP, forward };
    const { result: { sessionId } } = await (await open(options)).json() as { result: { sessionId: string } };
    const put = (md5: string) => handleAppRequest(new Request(
      `http://127.0.0.1/api/s3/sessions/${sessionId}/part?key=big.bin&uploadId=u1&partNumber=1`, {
        method: 'PUT',
        headers: { 'x-galiot-access-token': GATE, 'content-length': '5', 'content-md5': md5 },
        body: 'hello',
      }), options);
    expect((await put('XUFAKrxLKna5cZ2REBfFkg==')).status).toBe(200);
    expect((await put('not base64 md5')).status).toBe(200);
    expect(calls[0]?.headers['content-md5']).toBe('XUFAKrxLKna5cZ2REBfFkg==');
    expect(calls[1]?.headers['content-md5']).toBeUndefined();
  });
});
