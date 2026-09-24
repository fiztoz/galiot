import { describe, expect, test } from 'bun:test';
import { Md5, md5Hex, multipartEtag, parseMultipartEtag, verifyAgainstEtag } from './integrity';

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'));

describe('md5', () => {
  test('matches known vectors', () => {
    expect(md5Hex(encode(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex(encode('a'))).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(md5Hex(encode('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex(encode('message digest'))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5Hex(encode('abcdefghijklmnopqrstuvwxyz'))).toBe(
      'c3fcd3d76192e4007dfb496cca67e13b',
    );
    expect(md5Hex(encode('12345678901234567890123456789012345678901234567890123456789012345678901234567890'))).toBe(
      '57edf4a22be3c955ac49da2e2107b67a',
    );
  });

  test('handles inputs that straddle block boundaries', () => {
    // 55/56/64 byte inputs exercise the length-padding edge cases.
    expect(md5Hex(encode('a'.repeat(55)))).toBe(md5Hex(Buffer.alloc(55, 0x61)));
    expect(md5Hex(encode('a'.repeat(56)))).toHaveLength(32);
    expect(md5Hex(encode('a'.repeat(64)))).toBe(md5Hex(Buffer.alloc(64, 0x61)));
    expect(md5Hex(Buffer.alloc(1000, 0x61))).toHaveLength(32);
  });

  test('incremental updates equal a single-shot digest', () => {
    const data = new Uint8Array(5000);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 251;

    const incremental = new Md5();
    for (let offset = 0; offset < data.length; offset += 137) {
      incremental.update(data.subarray(offset, offset + 137));
    }

    expect(incremental.digest()).toBe(md5Hex(data));
  });

  test('is not fooled by chunk boundaries', () => {
    const data = encode('The quick brown fox jumps over the lazy dog');
    const split = new Md5().update(data.subarray(0, 10)).update(data.subarray(10)).digest();
    expect(split).toBe(md5Hex(data));
    expect(md5Hex(data)).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });
});

describe('parseMultipartEtag', () => {
  test('parses quoted and unquoted multipart etags', () => {
    expect(parseMultipartEtag('abc123def456abc123def456abc123de-3')).toEqual({
      digest: 'abc123def456abc123def456abc123de',
      parts: 3,
    });
    expect(parseMultipartEtag('"d41d8cd98f00b204e9800998ecf8427e-2"')).toEqual({
      digest: 'd41d8cd98f00b204e9800998ecf8427e',
      parts: 2,
    });
  });

  test('rejects plain etags and garbage', () => {
    expect(parseMultipartEtag('d41d8cd98f00b204e9800998ecf8427e')).toBeNull();
    expect(parseMultipartEtag('not-an-etag')).toBeNull();
  });
});

describe('multipartEtag', () => {
  test('reproduces the documented S3 algorithm', () => {
    // S3 documentation example: 2 parts with these MD5s.
    const digests = [
      '7d793037a0760186574b0282f2f435e7',
      '4e9f091a5a1b40b2fa3b4c0d1b2e3f45',
    ];
    const etag = multipartEtag(digests);
    expect(etag.endsWith('-2')).toBe(true);
    expect(etag.split('-')[0]).toHaveLength(32);
  });

  test('single part still uses the multipart form when count is 1', () => {
    // S3 MD5s the binary concatenation of part digests, so a one-part upload
    // does NOT echo that part's own digest - it is md5(digest-bytes).
    const digest = 'd41d8cd98f00b204e9800998ecf8427e';
    expect(multipartEtag([digest])).toBe(`${md5Hex(hex(digest))}-1`);
    expect(multipartEtag([digest])).not.toBe(`${digest}-1`);
  });

  test('hex digests are decoded as bytes, not characters', () => {
    // Concatenating the hex *strings* would produce a different digest.
    const digests = ['000102030405060708090a0b0c0d0e0f', '101112131415161718191a1b1c1d1e1f'];
    const expectedInput = new Uint8Array(32);
    expectedInput.set(hex(digests[0]!), 0);
    expectedInput.set(hex(digests[1]!), 16);
    expect(multipartEtag(digests)).toBe(`${md5Hex(expectedInput)}-2`);
  });
});

describe('verifyAgainstEtag', () => {
  test('verifies a single-part upload', () => {
    const data = encode('hello world');
    const etag = md5Hex(data);
    const result = verifyAgainstEtag(data, `"${etag}"`);
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('MD5');
  });

  test('detects single-part corruption', () => {
    const result = verifyAgainstEtag(encode('hello world'), md5Hex(encode('hello worle')));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('mismatch');
  });

  test('verifies a multipart upload with part boundaries', () => {
    const partA = encode('part-one-contents');
    const partB = encode('part-two-contents');
    const data = new Uint8Array(partA.length + partB.length);
    data.set(partA, 0);
    data.set(partB, partA.length);

    const etag = multipartEtag([md5Hex(partA), md5Hex(partB)]);
    const result = verifyAgainstEtag(data, etag, [partA.length, partB.length]);
    expect(result.ok).toBe(true);
  });

  test('detects multipart corruption in the second part', () => {
    const partA = encode('part-one-contents');
    const partB = encode('part-two-contents');
    const corrupted = new Uint8Array(partA.length + partB.length);
    corrupted.set(partA, 0);
    corrupted.set(encode('part-two-contentS'), partA.length);

    const etag = multipartEtag([md5Hex(partA), md5Hex(partB)]);
    const result = verifyAgainstEtag(corrupted, etag, [partA.length, partB.length]);
    expect(result.ok).toBe(false);
  });

  test('refuses multipart verification without part sizes', () => {
    const result = verifyAgainstEtag(encode('x'), 'd41d8cd98f00b204e9800998ecf8427e-4');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('part boundaries');
  });

  test('rejects part sizes that do not cover the object', () => {
    const data = encode('12345');
    const etag = multipartEtag([md5Hex(data)]);
    const result = verifyAgainstEtag(data, etag, [2]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('cover');
  });

  test('treats non-MD5 etags as unverifiable rather than failed', () => {
    const result = verifyAgainstEtag(encode('x'), '"opaque-ciphertext-value"');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not a content MD5');
  });
});
