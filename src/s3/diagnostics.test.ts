import { describe, expect, test } from 'bun:test';
import { diagnoseCors, type DiagnoseInput } from './diagnostics';

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
