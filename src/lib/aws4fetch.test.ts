import { describe, expect, test } from 'bun:test';
import { AwsClient, canonicalUri } from './aws4fetch';
import { buildS3Url, encodeKey } from '../s3/url';

/**
 * The canonical URI must be the path encoded *exactly once*.
 *
 * This was found by uploading to a real MinIO: the vendored signer ran
 * `encodeURI` over a path the URL parser had already encoded, so every `%`
 * became `%25` in the signature while the request carried the single-encoded
 * path. MinIO answered `403 SignatureDoesNotMatch` for every key containing a
 * space or a non-ASCII character.
 */
describe('canonicalUri', () => {
  test('leaves an already-safe path alone', () => {
    expect(canonicalUri('/bucket/a/b.txt')).toBe('/bucket/a/b.txt');
  });

  test('keeps separators literal and encodes a segment once', () => {
    expect(canonicalUri('/bucket/awkward/%20leading.txt')).toBe('/bucket/awkward/%20leading.txt');
  });

  test('does not double-encode an existing escape', () => {
    // The bug: encodeURI('%20') is '%2520'.
    expect(canonicalUri('/bucket/%2520literal.txt')).toBe('/bucket/%2520literal.txt');
    expect(canonicalUri('/bucket/%C3%BC.txt')).toBe('/bucket/%C3%BC.txt');
  });

  test('encodes a raw path that has not been escaped yet', () => {
    expect(canonicalUri('/bucket/ leading.txt')).toBe('/bucket/%20leading.txt');
    expect(canonicalUri('/bucket/ünïcödé.txt')).toBe('/bucket/%C3%BCn%C3%AFc%C3%B6d%C3%A9.txt');
  });

  test('escapes the characters encodeURIComponent leaves alone', () => {
    // S3 requires RFC 3986 encoding, so !'()* must be percent-escaped.
    expect(canonicalUri("/bucket/a!b'c(d)e*f.txt")).toBe(
      '/bucket/a%21b%27c%28d%29e%2Af.txt',
    );
  });

  test('survives a stray percent that is not a valid escape', () => {
    expect(canonicalUri('/bucket/100%.txt')).toBe('/bucket/100%25.txt');
  });

  test('matches the path the request actually sends, for awkward keys', () => {
    const target = { endpoint: 'https://s3.example.com', bucket: 'b', pathStyle: false };
    for (const key of [
      ' leading-space.txt',
      'trailing-space .txt',
      'ünïcödé-ключ-鍵.txt',
      'quote"and<angle>.txt',
      'ampersand&and&amp.txt',
      'percent%20literal.txt',
      'plus+and=eq.txt',
      'hash#and?query.txt',
      'emoji-🚀.txt',
    ]) {
      const url = buildS3Url(target, key);
      // Whatever we sign must be what the URL will put on the wire.
      expect(canonicalUri(url.pathname)).toBe(url.pathname);
    }
  });
});

describe('signer canonical path', () => {
  test('signs a path that a server would reconstruct identically', async () => {
    const client = new AwsClient({
      accessKeyId: 'AKIATESTKEY000000',
      secretAccessKey: 'secret',
      region: 'us-east-1',
      service: 's3',
    });

    // A deterministic timestamp keeps the signature comparable.
    const url = buildS3Url(
      { endpoint: 'https://s3.example.com', bucket: 'b', pathStyle: false },
      'folder/名前 file.txt',
    );
    const signed = await client.sign(url, {
      method: 'GET',
      aws: { datetime: '20260101T000000Z' },
    });

    const authorization = signed.headers.get('authorization')!;
    // The Authorization header lists which headers were signed, not the path,
    // so assert the property that matters: signing does not throw, the path is
    // singly encoded, and the signed request is the one that was sent.
    expect(authorization).toContain('AWS4-HMAC-SHA256');
    expect(signed.url).toContain('%E5%90%8D%E5%89%8D');
    expect(signed.url).toContain('%20');
    expect(signed.url).not.toContain('%25');
    expect(encodeKey('folder/名前 file.txt')).toBe('folder/%E5%90%8D%E5%89%8D%20file.txt');
  });
});
