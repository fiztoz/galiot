import { describe, expect, test } from 'bun:test';
import { diagnoseCors, isBlockedByBrowser, type DiagnoseInput } from './diagnostics';

const base: DiagnoseInput = {
  probeUrl: 'http://127.0.0.1:9000/bucket/',
  endpoint: 'http://127.0.0.1:9000',
  pathStyle: false,
};

describe('diagnoseCors', () => {
  test('flags IP endpoints that cannot use virtual-hosted addressing', () => {
    const result = diagnoseCors(base, true);
    expect(result.reason).toBe('addressing-unsupported');
    expect(result.hint).toContain('Path-style');
  });

  test('a missing scheme is called out before anything else', () => {
    const result = diagnoseCors(
      { ...base, rawEndpoint: '127.0.0.1:9000', pathStyle: true },
      false,
    );
    expect(result.reason).toBe('host-unreachable');
    expect(result.hint).toContain('scheme');
  });

  test('unreachable with a scheme is a network problem, not CORS', () => {
    const result = diagnoseCors(
      { ...base, pathStyle: true, rawEndpoint: 'http://127.0.0.1:9000' },
      false,
    );
    expect(result.reason).toBe('host-unreachable');
    expect(result.detail).toContain('not CORS');
  });

  test('reachable but blocked means CORS', () => {
    const result = diagnoseCors({ ...base, pathStyle: true, requestSucceeded: false }, true);
    expect(result.reason).toBe('cors-blocked');
    expect(result.hint).toContain('AllowedHeaders');
    expect(result.detail).toContain('preflight');
  });

  test('a network-level failure is CORS, whatever the wording', () => {
    for (const requestError of [
      'Failed to fetch',
      'TypeError: Failed to fetch',
      undefined,
      '',
    ]) {
      const result = diagnoseCors(
        { ...base, pathStyle: true, requestSucceeded: false, requestError },
        true,
      );
      expect(result.reason).toBe('cors-blocked');
    }
  });

  test('an HTTP error from a reachable bucket is not CORS', () => {
    // Verified in a real browser: a 403 with CORS headers reaches script intact,
    // so reporting it as a CORS block sent users with a wrong key off to
    // rewrite a policy that was already fine.
    const result = diagnoseCors(
      {
        ...base,
        pathStyle: true,
        requestSucceeded: false,
        requestError: 'ListObjects failed: Forbidden',
      },
      true,
    );
    expect(result.reason).toBe('request-rejected');
    expect(result.detail).toContain('not a CORS problem');
    expect(result.detail).toContain('ListObjects failed: Forbidden');
    expect(result.hint).toMatch(/access key|bucket name/i);
    // Crucially, no CORS remediation should be suggested.
    expect(result.hint).not.toContain('AllowedHeaders');
  });

  test('a missing bucket is reported as a rejection, not CORS', () => {
    const result = diagnoseCors(
      {
        ...base,
        pathStyle: true,
        requestSucceeded: false,
        requestError: 'ListObjects failed: Not Found',
      },
      true,
    );
    expect(result.reason).toBe('request-rejected');
  });

  test('a rejected request still beats nothing: addressing is checked first', () => {
    const result = diagnoseCors(
      {
        probeUrl: 'http://127.0.0.1:9000/',
        endpoint: 'http://127.0.0.1:9000',
        pathStyle: false,
        requestSucceeded: false,
        requestError: 'ListObjects failed: Forbidden',
      },
      true,
    );
    expect(result.reason).toBe('addressing-unsupported');
  });
});

describe('isBlockedByBrowser', () => {
  test('classifies network-level failures as browser blocks', () => {
    expect(isBlockedByBrowser('Failed to fetch')).toBe(true);
    expect(isBlockedByBrowser('TypeError: Failed to fetch')).toBe(true);
    expect(isBlockedByBrowser('Load failed')).toBe(true);
    expect(isBlockedByBrowser('NetworkError when attempting to fetch resource.')).toBe(true);
  });

  test('treats an HTTP status as a response we received', () => {
    expect(isBlockedByBrowser('ListObjects failed: Forbidden')).toBe(false);
    expect(isBlockedByBrowser('ListObjects failed: Not Found')).toBe(false);
    expect(isBlockedByBrowser('The bucket does not exist')).toBe(false);
    expect(isBlockedByBrowser('AccessDenied')).toBe(false);
  });

  test('with no error text, stays conservative', () => {
    expect(isBlockedByBrowser(undefined)).toBe(true);
    expect(isBlockedByBrowser(null)).toBe(true);
    expect(isBlockedByBrowser('')).toBe(true);
  });

  test('successful request is reported as ok', () => {
    expect(diagnoseCors({ ...base, pathStyle: true, requestSucceeded: true }, true).reason).toBe('ok');
  });

  test('no request attempted yet is unknown, not a failure', () => {
    const result = diagnoseCors({ ...base, pathStyle: true }, true);
    expect(result.reason).toBe('unknown');
    expect(result.hint).toContain('Test connection');
  });

  test('addressing check does not fire for DNS endpoints', () => {
    const result = diagnoseCors(
      {
        probeUrl: 'https://b.s3.example.com/',
        endpoint: 'https://s3.example.com',
        pathStyle: false,
        requestSucceeded: false,
      },
      true,
    );
    expect(result.reason).toBe('cors-blocked');
  });

  test('always returns the probed URL for display', () => {
    expect(diagnoseCors(base, false).probedUrl).toBe(base.probeUrl);
  });

  test('addressing outranks reachability: it is a provable config error', () => {
    // Even when the host is also down, the deterministic misconfiguration is
    // the more useful thing to tell the user first.
    const result = diagnoseCors(
      { ...base, rawEndpoint: 'http://127.0.0.1:9000', pathStyle: false },
      false,
    );
    expect(result.reason).toBe('addressing-unsupported');
  });
});
