import { describe, expect, test } from 'bun:test';
import { normalizeEndpoint } from './ConnectionDialog';

describe('normalizeEndpoint', () => {
  test('leaves explicit schemes alone and trims slashes', () => {
    expect(normalizeEndpoint('https://s3.example.com/')).toBe('https://s3.example.com');
    expect(normalizeEndpoint('http://127.0.0.1:9000///')).toBe('http://127.0.0.1:9000');
  });

  test('defaults public hosts to https', () => {
    expect(normalizeEndpoint('s3.example.com')).toBe('https://s3.example.com');
    expect(normalizeEndpoint('acct.r2.cloudflarestorage.com')).toBe(
      'https://acct.r2.cloudflarestorage.com',
    );
  });

  test('defaults local endpoints to http — MinIO is rarely TLS locally', () => {
    expect(normalizeEndpoint('127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
    expect(normalizeEndpoint('localhost:9000')).toBe('http://localhost:9000');
    expect(normalizeEndpoint('192.168.1.10:9000')).toBe('http://192.168.1.10:9000');
    expect(normalizeEndpoint('minio.local:9000')).toBe('http://minio.local:9000');
  });

  test('keeps a path-less host intact', () => {
    expect(normalizeEndpoint('  s3.example.com  ')).toBe('https://s3.example.com');
  });
});
