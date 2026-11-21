import { afterEach, expect, spyOn, test } from 'bun:test';
import { RemoteS3 } from './remote';

const fetchFixture = () => spyOn(globalThis, 'fetch');
let transport: ReturnType<typeof fetchFixture> | undefined;
afterEach(() => transport?.mockRestore());

function stub(answer: (url: string) => Response) {
  const urls: string[] = [];
  const forward = async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return answer(String(input));
  };
  transport = fetchFixture().mockImplementation(Object.assign(forward, { preconnect: fetch.preconnect }));
  return urls;
}

const expired = () => Response.json({ ok: false, error: 'S3 session expired or unknown.' }, { status: 404 });

test('a forgotten session is reopened once and the call is replayed on the new one', async () => {
  const urls = stub(url => url.includes('/old/')
    ? expired()
    : Response.json({ ok: true, result: { objects: [], prefixes: [], isTruncated: false } }));
  const stale: string[] = [];
  const s3 = new RemoteS3('old', undefined, async id => { stale.push(id); return 'new'; });
  expect((await s3.listObjects('a/')).isTruncated).toBe(false);
  expect(stale).toEqual(['old']);
  expect(urls).toEqual(['/api/s3/sessions/old/call', '/api/s3/sessions/new/call']);

  // The replacement sticks for later calls.
  await s3.listObjects('b/');
  expect(urls.at(-1)).toBe('/api/s3/sessions/new/call');
});

test('an S3 NoSuchKey 404 is not mistaken for an expired session', async () => {
  const urls = stub(() => new Response('<Error><Code>NoSuchKey</Code></Error>', {
    status: 404, headers: { 'content-type': 'application/xml' },
  }));
  let reopened = 0;
  const s3 = new RemoteS3('live', undefined, async () => { reopened += 1; return 'other'; });
  const response = await s3.getObject('missing.txt');
  expect(response.status).toBe(404);
  expect(await response.text()).toContain('NoSuchKey');
  expect(reopened).toBe(0);
  expect(urls).toHaveLength(1);
});

test('a second expiry is reported instead of looping', async () => {
  stub(() => expired());
  const s3 = new RemoteS3('old', undefined, async () => 'new');
  await expect(s3.listObjects()).rejects.toThrow(/session expired/i);
});

test('aborting an upload S3 has already forgotten counts as aborted', async () => {
  stub(() => Response.json({ ok: false, status: 404, code: 'NoSuchUpload', error: 'gone' }));
  expect(await new RemoteS3('live', undefined).abortMultipart('a.bin', 'u1')).toEqual({ aborted: true });
  stub(() => Response.json({ ok: false, status: 403, code: 'AccessDenied', error: 'denied' }));
  await expect(new RemoteS3('live', undefined).abortMultipart('a.bin', 'u1')).rejects.toThrow(/AccessDenied/);
});
