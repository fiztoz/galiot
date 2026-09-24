import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_BRIDGE_ORIGINS,
  resolveAllowedOrigins,
  BRIDGE_TOKEN_HEADER,
  checkForwardRequest,
  corsHeaders,
  isOriginAllowed,
} from './policy';

const SIGNED_HEADERS = {
  authorization: 'AWS4-HMAC-SHA256 Credential=AKIA/20260924/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=deadbeef',
  'x-amz-date': '20260924T000000Z',
};

const options = {
  origin: DEFAULT_BRIDGE_ORIGINS[0]!,
  token: 'secret-token',
  expectedToken: 'secret-token',
};

describe('origin allowlist', () => {
  test('accepts local app origins only', () => {
    expect(isOriginAllowed('http://localhost:5173')).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:5173')).toBe(true);
    expect(isOriginAllowed('https://evil.example')).toBe(false);
    expect(isOriginAllowed('http://localhost:8080')).toBe(false);
    expect(isOriginAllowed(null)).toBe(false);
  });

  test('cors headers echo only allowed origins', () => {
    expect(corsHeaders('http://localhost:5173')['Access-Control-Allow-Origin']).toBe(
      'http://localhost:5173',
    );
    expect(corsHeaders('https://evil.example')['Access-Control-Allow-Origin']).toBe('');
  });
});

describe('checkForwardRequest', () => {
  test('accepts a signed request from an allowed origin', () => {
    const result = checkForwardRequest(
      { target: 'http://127.0.0.1:9000/example-bucket/?cors', method: 'PUT', headers: SIGNED_HEADERS },
      options,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.url.hostname).toBe('127.0.0.1');
  });

  test('rejects disallowed origins', () => {
    const result = checkForwardRequest(
      { target: 'http://127.0.0.1:9000/b/?cors', method: 'PUT', headers: SIGNED_HEADERS },
      { ...options, origin: 'https://evil.example' },
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('bad-origin');
  });

  test('rejects a missing or wrong token', () => {
    expect(
      checkForwardRequest(
        { target: 'http://127.0.0.1:9000/b/?cors', method: 'PUT', headers: SIGNED_HEADERS },
        { ...options, token: null },
      ).ok,
    ).toBe(false);

    const wrong = checkForwardRequest(
      { target: 'http://127.0.0.1:9000/b/?cors', method: 'PUT', headers: SIGNED_HEADERS },
      { ...options, token: 'nope' },
    );
    expect(!wrong.ok && wrong.reason).toBe('bad-token');
  });

  test('rejects unsigned requests so the bridge cannot become an open proxy', () => {
    const result = checkForwardRequest(
      { target: 'http://169.254.169.254/latest/meta-data/', method: 'GET', headers: {} },
      options,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('not-signed');
  });

  test('rejects non-http targets', () => {
    for (const target of ['file:///etc/passwd', 'ftp://x/y']) {
      const result = checkForwardRequest(
        { target, method: 'PUT', headers: SIGNED_HEADERS },
        options,
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe('bad-target');
    }
  });

  test('rejects relative or malformed targets', () => {
    const result = checkForwardRequest(
      { target: '/not-absolute', method: 'PUT', headers: SIGNED_HEADERS },
      options,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('bad-target');
  });

  test('rejects everything while the bridge runs without a token', () => {
    const result = checkForwardRequest(
      { target: 'http://127.0.0.1:9000/b/?cors', method: 'PUT', headers: SIGNED_HEADERS },
      { ...options, expectedToken: null },
    );
    expect(!result.ok && result.reason).toBe('bad-token');
  });

  test('token header name is namespaced to avoid collisions', () => {
    expect(BRIDGE_TOKEN_HEADER).toBe('x-galiot-bridge-token');
  });
});

describe('resolveAllowedOrigins', () => {
  test('defaults cover the local dev server and preview build', () => {
    const origins = resolveAllowedOrigins();
    expect(origins).toContain('http://localhost:5173');
    expect(origins).toContain('http://127.0.0.1:4173');
  });

  test('adds explicit extras', () => {
    const origins = resolveAllowedOrigins(['https://galiot.example.com', 'http://galiot.example.com:5173']);
    expect(origins).toContain('https://galiot.example.com');
    expect(origins).toContain('http://galiot.example.com:5173');
    expect(isOriginAllowed('https://galiot.example.com', origins)).toBe(true);
  });

  test('refuses wildcards and non-http schemes', () => {
    const origins = resolveAllowedOrigins(['*', 'null', 'file://x', 'https://ok.example']);
    expect(origins).not.toContain('*');
    expect(origins).not.toContain('null');
    expect(origins).not.toContain('file://x');
    expect(origins).toContain('https://ok.example');
  });

  test('normalises trailing slashes and de-duplicates', () => {
    const origins = resolveAllowedOrigins(['http://localhost:5173/', 'http://localhost:5173']);
    expect(origins.filter((o) => o === 'http://localhost:5173')).toHaveLength(1);
    expect(isOriginAllowed('http://localhost:5173/', origins)).toBe(true);
  });
});
