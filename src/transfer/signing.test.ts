import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeScreenedHeaders } from './signing';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

describe('mergeScreenedHeaders', () => {
  test('per-call headers win over stored ones', () => {
    // A resumed download's Range and an upload's Content-Type are part of what
    // the signature covers; a stored row must not displace them.
    expect(
      mergeScreenedHeaders({ 'x-tenant-id': 'acme', range: 'bytes=0-0' }, { Range: 'bytes=99-' }),
    ).toEqual({ 'x-tenant-id': 'acme', range: 'bytes=99-' });
  });

  test('stored headers are screened again at the trust boundary', () => {
    expect(
      mergeScreenedHeaders({ 'x-tenant-id': 'acme', 'x-api-key': 'nope', cookie: 'session=1' }, {}),
    ).toEqual({ 'x-tenant-id': 'acme' });
  });

  test('a value that would smuggle a second header is dropped', () => {
    expect(mergeScreenedHeaders({ 'x-bad': 'a\r\nX-Injected: yes', 'x-ok': 'v' }, {})).toEqual({
      'x-ok': 'v',
    });
  });

  test('undefined and empty both mean "no custom headers"', () => {
    expect(mergeScreenedHeaders(undefined, { range: 'bytes=0-' })).toEqual({ range: 'bytes=0-' });
    expect(mergeScreenedHeaders({}, {})).toEqual({});
  });
});

/**
 * The request routes that do not go through `S3Client` live inside web workers,
 * which cannot be imported into a Bun test: they register `message` listeners at
 * module scope and call `postMessage`, neither of which exists here.
 *
 * That leaves their wiring untestable directly — and mutation testing showed it
 * matters. Removing either call below leaves the entire suite green
 * while uploads and downloads silently stop sending custom
 * headers. So the call sites are asserted as source. This is deliberately
 * brittle: renaming the helper should force a conscious update here rather than
 * quietly dropping the feature.
 */
describe('worker wiring for custom headers', () => {
  const vaultWorker = read('workers', 'vault.worker.ts');
  const transferWorker = read('workers', 'transfer.worker.ts');

  test('the transfer-signing path merges the job headers', () => {
    expect(vaultWorker).toContain('mergeScreenedHeaders(request.customHeaders, request.headers)');
  });

  test('the transfer worker forwards its target headers to the signer', () => {
    expect(transferWorker).toContain('customHeaders: job.target.headers');
  });

  test('the worker builds clients through the factory that carries headers', () => {
    // makeS3Client is the seam every S3Client in the worker comes from; if it
    // stops delegating, custom headers stop being applied to listing, the editor
    // and delete, none of which the integration test would notice.
    expect(vaultWorker).toMatch(/function makeS3Client[\s\S]{0,200}?return s3ClientForProfile\(profile, creds\);/);
  });

  test('the signing protocol actually carries the field', () => {
    expect(read('transfer', 'protocol.ts')).toMatch(/customHeaders\?:\s*Record<string, string>/);
    expect(read('transfer', 'protocol.ts')).toMatch(/headers\?:\s*Record<string, string>/);
  });
});
