/** Limits bytes while the stream is being read, including bodies without a length. */
export async function readBoundedText(message: Request | Response, maxBytes: number): Promise<string> {
  const reader = message.body?.getReader();
  if (!reader) return '';
  const declared = message.headers.get('content-length');
  let buffer = new Uint8Array(0);
  let bytes = 0;
  try {
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      throw new Error('Body is too large or has an invalid length.');
    }
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const end = bytes + value.byteLength;
      if (end > maxBytes) throw new Error('Body is too large.');
      if (end > buffer.length) {
        const capacity = Math.min(maxBytes, Math.max(4096, end, 2 * buffer.length));
        const larger = new Uint8Array(capacity);
        larger.set(buffer.subarray(0, bytes));
        buffer.fill(0);
        buffer = larger;
      }
      buffer.set(value, bytes);
      bytes = end;
    }
    return new TextDecoder().decode(buffer.subarray(0, bytes));
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    buffer.fill(0);
    reader.releaseLock();
  }
}
