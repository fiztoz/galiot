import { afterEach, expect, spyOn, test } from 'bun:test';
import { MAX_EDITOR_BYTES, readEditorText, RemoteS3 } from './remote';

const fetchFixture = () => spyOn(globalThis, 'fetch');
let transport: ReturnType<typeof fetchFixture> | undefined;
afterEach(() => transport?.mockRestore());

test('editor decoding preserves original MIME, UTF-8 BOM, line endings and split characters', async () => {
  const text = '\uFEFFa\r\n🙂';
  const bytes = new TextEncoder().encode(text);
  const res = new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { 'content-type': 'application/octet-stream', 'x-galiot-object-type': 'application/json; charset=UTF-8', etag: '"read"' } });
  expect(await readEditorText(res, bytes.byteLength)).toEqual({
    text, size: bytes.byteLength, contentType: 'application/json; charset=UTF-8', eTag: '"read"',
  });
  await expect(readEditorText(new Response(Uint8Array.of(0xe2)), 10)).rejects.toThrow('UTF-8');
  await expect(readEditorText(new Response('abc', { headers: { 'content-type': 'text/plain; charset=utf-16' } }), 10)).rejects.toThrow('encoding');
  await expect(readEditorText(new Response('decoded', { headers: { 'content-encoding': 'gzip' } }), 10)).rejects.toThrow('encoding');
  await expect(readEditorText(new Response('🙂'), 3)).rejects.toThrow('large');
});

test('conditional editor saves carry the original MIME at the empty and 2 MiB boundaries', async () => {
  const s3 = new RemoteS3('session', undefined);
  const sizes: number[] = [];
  const forward = async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('/api/s3/sessions/session/object?key=a%20b');
    expect(init?.method).toBe('PUT');
    expect(new Headers(init?.headers).get('if-match')).toBe('"read"');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    sizes.push((init?.body as Blob).size);
    return new Response(null, { headers: { etag: '"written"' } });
  };
  transport = fetchFixture().mockImplementation(Object.assign(forward, { preconnect: fetch.preconnect }));
  for (const draft of ['', 'é'.repeat(MAX_EDITOR_BYTES / 2)]) {
    expect(await s3.putTextIfMatch('a b', draft, 'application/json', '"read"')).toEqual({ eTag: '"written"' });
  }
  await expect(s3.putTextIfMatch('a b', 'é'.repeat(MAX_EDITOR_BYTES / 2) + 'x', null, '"read"')).rejects.toThrow('2 MiB');
  await expect(s3.putTextIfMatch('a b', 'x', null, '*')).rejects.toThrow('strong ETag');
  await expect(s3.putTextIfMatch('a b', '\udc00', null, '"read"')).rejects.toThrow('incomplete Unicode');
  expect(sizes).toEqual([0, MAX_EDITOR_BYTES]);
  transport.mockResolvedValue(new Response(null, { status: 412 }));
  await expect(s3.putTextIfMatch('a b', 'later', null, '"read"')).rejects.toThrow('remote object changed');
});
