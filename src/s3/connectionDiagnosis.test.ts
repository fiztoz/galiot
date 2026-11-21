import { describe, expect, test } from 'bun:test';
import { diagnoseConnection, isNetworkFailure } from './connectionDiagnosis';

const dns = { endpoint: 'https://s3.example.com', pathStyle: false };

describe('diagnoseConnection', () => {
  test('a rejection from the endpoint quotes its error', () => {
    for (const requestError of ['ListObjects failed: AccessDenied (403)', 'NoSuchBucket (404)', 'Missing or incorrect server access token.']) {
      const result = diagnoseConnection({ ...dns, requestSucceeded: false, requestError });
      expect(result.reason).toBe('request-rejected');
      expect(result.detail).toContain(requestError);
    }
  });

  test('a server that cannot reach the endpoint names the machine running Galiot', () => {
    const result = diagnoseConnection({
      ...dns, requestSucceeded: false, requestError: 'ListObjects failed: HTTP 502 (502) — connect failed',
    });
    expect(result.reason).toBe('host-unreachable');
    expect(result.hint).toContain('machine running Galiot');
  });

  test('a success says the server made the call', () => {
    const result = diagnoseConnection({ ...dns, requestSucceeded: true });
    expect(result.reason).toBe('ok');
    expect(result.detail).toContain('Galiot server');
  });

  test('nothing attempted yet is unknown, not a failure', () => {
    const result = diagnoseConnection(dns);
    expect(result.reason).toBe('unknown');
    expect(result.hint).toContain('Test connection');
  });

  test('an IP endpoint without path-style is flagged first, even when the request failed', () => {
    const ip = { endpoint: 'http://127.0.0.1:9000', pathStyle: false };
    expect(diagnoseConnection({ ...ip, requestSucceeded: false, requestError: 'ECONNREFUSED' }).reason)
      .toBe('addressing-unsupported');
    expect(diagnoseConnection({ ...ip, pathStyle: true, requestSucceeded: true }).reason).toBe('ok');
  });

  test('a DNS endpoint is never an addressing problem by itself', () => {
    expect(diagnoseConnection({ ...dns, requestSucceeded: false, requestError: 'Failed to fetch' }).reason)
      .toBe('host-unreachable');
  });
});

describe('isNetworkFailure', () => {
  test('network-level errors and missing text count as unreachable', () => {
    for (const error of ['TypeError: Failed to fetch', 'Load failed', 'getaddrinfo ENOTFOUND s3.example.com', '', null, undefined]) {
      expect(isNetworkFailure(error)).toBe(true);
    }
  });

  test('an S3 answer is not a network failure', () => {
    for (const error of ['AccessDenied (403)', 'NoSuchBucket (404)', 'SignatureDoesNotMatch']) {
      expect(isNetworkFailure(error)).toBe(false);
    }
  });
});
