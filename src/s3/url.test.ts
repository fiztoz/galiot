import { describe, expect, test } from 'bun:test';
import { buildS3Url, encodeKey } from './url';

const R2 = { endpoint: 'https://acct.r2.cloudflarestorage.com/', bucket: 'my-bucket', pathStyle: false };
const MINIO = { endpoint: 'http://localhost:9000', bucket: 'assets', pathStyle: true };

describe('buildS3Url', () => {
  test('virtual-hosted style prefixes the bucket to the host', () => {
    expect(buildS3Url(R2).toString()).toBe('https://my-bucket.acct.r2.cloudflarestorage.com/');
    expect(buildS3Url(R2, 'photos/beach.jpg').toString()).toBe(
      'https://my-bucket.acct.r2.cloudflarestorage.com/photos/beach.jpg',
    );
  });

  test('path style puts the bucket in the path', () => {
    expect(buildS3Url(MINIO).toString()).toBe('http://localhost:9000/assets/');
    expect(buildS3Url(MINIO, 'a/b.txt').toString()).toBe('http://localhost:9000/assets/a/b.txt');
  });

  test('strips trailing slashes from the endpoint', () => {
    const base = { endpoint: 'https://s3.example.com///', bucket: 'b', pathStyle: true };
    expect(buildS3Url(base, 'k').toString()).toBe('https://s3.example.com/b/k');
  });

  test('encodes each segment but preserves separators', () => {
    expect(buildS3Url(MINIO, 'my folder/a+b/c#d.txt').toString()).toBe(
      'http://localhost:9000/assets/my%20folder/a%2Bb/c%23d.txt',
    );
  });

  test('handles unicode keys', () => {
    expect(encodeKey('rapports/été.pdf')).toBe('rapports/%C3%A9t%C3%A9.pdf');
  });

  test('appends and overwrites query parameters', () => {
    const url = buildS3Url(MINIO, 'big.bin', { uploadId: 'abc123', partNumber: '3' });
    expect(url.searchParams.get('uploadId')).toBe('abc123');
    expect(url.searchParams.get('partNumber')).toBe('3');
    expect(url.toString()).toBe(
      'http://localhost:9000/assets/big.bin?uploadId=abc123&partNumber=3',
    );
  });

  test('supports flag-style queries used by multipart operations', () => {
    const create = buildS3Url(MINIO, 'big.bin', { uploads: '' });
    expect(create.searchParams.has('uploads')).toBe(true);
    expect(create.searchParams.get('uploads')).toBe('');

    const abort = buildS3Url(MINIO, 'big.bin', { uploadId: 'x', partNumber: '' });
    expect(abort.searchParams.has('partNumber')).toBe(true);
  });

  test('empty keys produce the bucket root', () => {
    expect(buildS3Url(MINIO, '').toString()).toBe('http://localhost:9000/assets/');
    expect(buildS3Url(R2, '').toString()).toBe('https://my-bucket.acct.r2.cloudflarestorage.com/');
  });
});
