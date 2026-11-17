import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSessionExpired, sessionCacheKey } from './session';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

describe('isSessionExpired', () => {
  test('only the server expired-session JSON triggers a reopen', () => {
    expect(isSessionExpired(404, '{"ok":false,"error":"S3 session expired or unknown."}')).toBe(true);
  });

  test('an S3 NoSuchKey 404 is XML and must not reopen the session', () => {
    expect(isSessionExpired(404, '<Error><Code>NoSuchKey</Code></Error>')).toBe(false);
  });

  test('other statuses and other errors are not session expiry', () => {
    expect(isSessionExpired(200, '{"ok":true}')).toBe(false);
    expect(isSessionExpired(403, '{"ok":false,"error":"Missing or incorrect server access token."}')).toBe(false);
    expect(isSessionExpired(404, '{"ok":false,"error":"This link expired or was revoked."}')).toBe(false);
    expect(isSessionExpired(404, '')).toBe(false);
  });
});

describe('sessionCacheKey', () => {
  const base = { profileId: 'p1', endpoint: 'https://s3.example.com', bucket: 'archive' };

  test('same target maps to one key, headers included', () => {
    expect(sessionCacheKey(base)).toBe(sessionCacheKey({ ...base }));
    expect(sessionCacheKey({ ...base, headers: { 'x-a': '1' } })).not.toBe(sessionCacheKey(base));
  });

  test('a different bucket or endpoint is a different session', () => {
    expect(sessionCacheKey({ ...base, bucket: 'example-bucket' })).not.toBe(sessionCacheKey(base));
    expect(sessionCacheKey({ ...base, endpoint: 'https://s3.example.com:9000' })).not.toBe(sessionCacheKey(base));
  });
});

/**
 * The worker cannot be imported into a Bun test (module-scope message listeners),
 * so the wiring that makes the retry real is asserted as source, the same way
 * signing.test.ts guards the custom-header path.
 */
describe('stale-session wiring', () => {
  test('the transfer worker reopens once on an expired session', () => {
    const worker = read('workers', 'transfer.worker.ts');
    expect(worker).toContain('isSessionExpired(response.status, text)');
    expect(worker).toContain('this.sessionIds.delete(sessionCacheKey({');
  });

  test('a vault lock clears the transfer worker cache over the port', () => {
    expect(read('workers', 'vault.worker.ts')).toContain("transferPort?.postMessage({ type: 'sessions-closed' })");
    const worker = read('workers', 'transfer.worker.ts');
    expect(worker).toContain("new PortSession(port, () => this.sessionIds.clear())");
    expect(worker).toContain("if (msg.type === 'sessions-closed')");
  });

  test('the port protocol carries the closed notice', () => {
    expect(read('transfer', 'protocol.ts')).toContain("| { type: 'sessions-closed' }");
  });
});
