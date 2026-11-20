import { expect, test } from 'bun:test';
import { readBoundedText } from './boundedBody';

test('decodes UTF-8 split across chunks at the exact byte limit', async () => {
  const encoded = new TextEncoder().encode('a€');
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoded.subarray(0, 2));
      controller.enqueue(encoded.subarray(2));
      controller.close();
    },
  }));
  expect(await readBoundedText(response, 4)).toBe('a€');
});

test('cancels and releases an oversized stream even without a length', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; },
  }));
  await expect(readBoundedText(response, 7)).rejects.toThrow('too large');
  expect(cancelled).toBe(true);
  expect(response.body?.locked).toBe(false);
});
