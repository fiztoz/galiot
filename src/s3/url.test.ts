import { describe, expect, test } from 'bun:test';
import { buildS3Url, canUseVirtualHosting, effectiveAddressing, isIpLiteralHost } from './url';

const R2 = { endpoint: 'https://acct.r2.cloudflarestorage.com/', bucket: 'my-bucket', pathStyle: false };
const MINIO = { endpoint: 'http://localhost:9000', bucket: 'assets', pathStyle: true };

describe('isIpLiteralHost', () => {
  test('recognises IPv4 and IPv6 literals', () => {
    expect(isIpLiteralHost('127.0.0.1')).toBe(true);
    expect(isIpLiteralHost('192.168.1.50')).toBe(true);
    expect(isIpLiteralHost('::1')).toBe(true);
    expect(isIpLiteralHost('[::1]')).toBe(true);
  });

  test('does not treat names as IPs', () => {
    expect(isIpLiteralHost('localhost')).toBe(false);
    expect(isIpLiteralHost('s3.example.com')).toBe(false);
  });
});

describe('canUseVirtualHosting', () => {
  test('true for DNS names', () => {
    expect(canUseVirtualHosting('https://s3.example.com')).toBe(true);
    expect(canUseVirtualHosting('http://localhost:9000')).toBe(true);
  });

  test('false for IP literals — a bucket subdomain cannot exist there', () => {
    expect(canUseVirtualHosting('http://127.0.0.1:9000')).toBe(false);
    expect(canUseVirtualHosting('http://192.168.1.50:9000')).toBe(false);
    expect(canUseVirtualHosting('http://[::1]:9000')).toBe(false);
  });
});

describe('buildS3Url addressing regression', () => {
  test('IP endpoint with pathStyle:false still gets the bucket in the path', () => {
    // Regression: the URL API silently ignores `hostname = 'bucket.127.0.0.1'`,
    // which used to produce a URL with NO bucket at all.
    const url = buildS3Url(
      { endpoint: 'http://127.0.0.1:9000', bucket: 'example-bucket', pathStyle: false },
      'photos/a.jpg',
    );
    expect(url.toString()).toBe('http://127.0.0.1:9000/example-bucket/photos/a.jpg');
    expect(url.pathname.startsWith('/example-bucket/')).toBe(true);
  });

  test('IP endpoint bucket root is correct', () => {
    const url = buildS3Url({ endpoint: 'http://10.0.0.5:9000', bucket: 'data', pathStyle: false });
    expect(url.toString()).toBe('http://10.0.0.5:9000/data/');
  });

  test('query parameters survive the forced path-style fallback', () => {
    const url = buildS3Url(
      { endpoint: 'http://127.0.0.1:9000', bucket: 'b', pathStyle: false },
      'k',
      { 'list-type': '2' },
    );
    expect(url.searchParams.get('list-type')).toBe('2');
    expect(url.pathname).toBe('/b/k');
  });

  test('virtual-hosted addressing is still used for DNS endpoints', () => {
    expect(buildS3Url(R2, 'a.txt').toString()).toBe(
      'https://my-bucket.acct.r2.cloudflarestorage.com/a.txt',
    );
  });

  test('effectiveAddressing reports what will actually be used', () => {
    expect(effectiveAddressing({ endpoint: 'http://127.0.0.1:9000', bucket: 'b', pathStyle: false }).pathStyle).toBe(true);
    expect(effectiveAddressing(R2).pathStyle).toBe(false);
    expect(effectiveAddressing(MINIO).pathStyle).toBe(true);
  });
});

describe('buildS3Url (general behaviour)', () => {
  test('virtual-hosted style prefixes the bucket to the host', () => {
    expect(buildS3Url(R2).toString()).toBe('https://my-bucket.acct.r2.cloudflarestorage.com/');
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
    expect(buildS3Url(MINIO, 'rapports/été.pdf').toString()).toBe(
      'http://localhost:9000/assets/rapports/%C3%A9t%C3%A9.pdf',
    );
  });

  test('appends query parameters, including flag-style ones', () => {
    const url = buildS3Url(MINIO, 'big.bin', { uploadId: 'abc123', partNumber: '3' });
    expect(url.searchParams.get('uploadId')).toBe('abc123');
    expect(url.searchParams.get('partNumber')).toBe('3');

    const create = buildS3Url(MINIO, 'big.bin', { uploads: '' });
    expect(create.searchParams.has('uploads')).toBe(true);
    expect(create.searchParams.get('uploads')).toBe('');
  });

  test('empty keys produce the bucket root', () => {
    expect(buildS3Url(MINIO, '').toString()).toBe('http://localhost:9000/assets/');
  });
});
