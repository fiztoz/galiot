import { describe, expect, test } from 'bun:test';
import {
  APP_OWNED_FOR_TEST,
  MAX_CUSTOM_HEADERS,
  MAX_HEADER_NAME_LENGTH,
  MAX_HEADER_VALUE_LENGTH,
  assertSafeCustomHeaders,
  normalizeCustomHeaders,
  parseStoredHeaders,
  rejectReason,
  withCustomHeaders,
} from './customHeaders';

/** Shorthand: the rejection kind for one header, or null when allowed. */
const kind = (name: string, value = 'v') => rejectReason(name, value)?.kind ?? null;

describe('header names that are allowed', () => {
  test('ordinary routing, tenancy and tracing headers pass', () => {
    for (const name of [
      'x-tenant-id',
      'x-request-id',
      'x-forwarded-for',
      'x-correlation-id',
      'x-amz-meta-uploaded-by',
      'x-partition-key',
      'x-api-version',
      'x-trace-sample',
      'if-none-match',
    ]) {
      expect(kind(name), `${name} should be allowed`).toBe(null);
    }
  });

  test('object metadata is allowed even when it is about a token', () => {
    expect(kind('x-amz-meta-token-count')).toBe(null);
    expect(kind('x-amz-meta-api-key-hint')).toBe(null);
  });
});

describe('header names that are refused', () => {
  test('browser-forbidden names, which fetch would silently drop', () => {
    for (const name of [
      'cookie',
      'set-cookie',
      'host',
      'origin',
      'referer',
      'connection',
      'content-length',
      'transfer-encoding',
      'upgrade',
      'via',
      'date',
      'expect',
      'te',
      'trailer',
      'keep-alive',
      'dnt',
      'accept-encoding',
      'accept-charset',
    ]) {
      expect(kind(name), `${name} should be refused`).toBe('browser-forbidden');
    }
  });

  test('prefix families that are browser-forbidden', () => {
    expect(kind('sec-fetch-site')).toBe('browser-forbidden');
    expect(kind('sec-ch-ua')).toBe('browser-forbidden');
    expect(kind('proxy-authorization')).toBe('browser-forbidden');
    expect(kind('proxy-anything')).toBe('browser-forbidden');
    expect(kind('access-control-allow-origin')).toBe('browser-forbidden');
  });

  test('SigV4 inputs, which would desynchronise the signature', () => {
    for (const name of [
      'authorization',
      'x-amz-date',
      'x-amz-content-sha256',
      'x-amz-security-token',
      'x-amz-algorithm',
      'x-amz-credential',
      'x-amz-signature',
      'x-amz-signedheaders',
      'x-amz-expires',
    ]) {
      expect(kind(name), `${name} should be refused`).toBe('signing-input');
    }
  });

  test('headers Galiot owns because a feature depends on their exact value', () => {
    expect(kind('range')).toBe('app-owned');
    expect(kind('content-type')).toBe('app-owned');
    expect(kind('content-md5')).toBe('app-owned');
    expect(kind('x-galiot-bridge-target')).toBe('app-owned');
    expect(APP_OWNED_FOR_TEST).toEqual(['content-md5', 'content-type', 'range', 'x-galiot-bridge-target']);
  });

  test('credential-looking names, because the column is cleartext', () => {
    for (const name of [
      'x-api-key',
      'api-key',
      'apikey',
      'x-apikey',
      'x-auth-token',
      'x-access-token',
      'token',
      'x-secret',
      'x-client-secret',
      'x-password',
      'x-passwd',
      'bearer',
      'x-bearer-token',
      'x-credential',
      'x-credentials',
      'x-private-key',
      'x-privatekey',
      'x-amz-authorization',
      'my-authorization-header',
    ]) {
      expect(kind(name), `${name} should be refused`).toBe('credential-looking');
    }
  });

  test('refusal is case- and separator-insensitive', () => {
    expect(kind('X-API-KEY')).toBe('credential-looking');
    expect(kind('X_Api_Key')).toBe('credential-looking');
    expect(kind('  Authorization  ')).toBe('signing-input');
    expect(kind('COOKIE')).toBe('browser-forbidden');
  });

  test('malformed names', () => {
    expect(kind('')).toBe('invalid-name');
    expect(kind('   ')).toBe('invalid-name');
    expect(kind('has space')).toBe('invalid-name');
    expect(kind('has:colon')).toBe('invalid-name');
    expect(kind('has(parens)')).toBe('invalid-name');
    expect(kind('x'.repeat(MAX_HEADER_NAME_LENGTH + 1))).toBe('name-too-long');
  });

  test('header injection through the value', () => {
    expect(kind('x-tenant', 'ok\r\nX-Injected: yes')).toBe('invalid-value');
    expect(kind('x-tenant', 'ok\nX-Injected: yes')).toBe('invalid-value');
    expect(kind('x-tenant', 'ok\0')).toBe('invalid-value');
    expect(kind('x-tenant', 'v'.repeat(MAX_HEADER_VALUE_LENGTH + 1))).toBe('value-too-long');
  });
});

describe('normalizeCustomHeaders', () => {
  test('lowercases names so duplicate detection is exact', () => {
    const result = normalizeCustomHeaders([{ name: 'X-Tenant-Id', value: 'acme' }]);
    expect(result).toEqual({ ok: true, headers: { 'x-tenant-id': 'acme' } });
  });

  test('trims names and values but keeps inner spacing', () => {
    const result = normalizeCustomHeaders([{ name: '  x-note  ', value: '  two  words  ' }]);
    expect(result).toEqual({ ok: true, headers: { 'x-note': 'two  words' } });
  });

  test('accepts a stored JSONB object as well as dialog rows', () => {
    expect(normalizeCustomHeaders({ 'x-a': '1', 'X-B': '2' })).toEqual({
      ok: true,
      headers: { 'x-a': '1', 'x-b': '2' },
    });
  });

  test('null and undefined mean "no custom headers"', () => {
    expect(normalizeCustomHeaders(null)).toEqual({ ok: true, headers: {} });
    expect(normalizeCustomHeaders(undefined)).toEqual({ ok: true, headers: {} });
    expect(normalizeCustomHeaders([])).toEqual({ ok: true, headers: {} });
    expect(normalizeCustomHeaders({})).toEqual({ ok: true, headers: {} });
  });

  test('a blank trailing editor row is skipped, not an error', () => {
    const result = normalizeCustomHeaders([
      { name: 'x-a', value: '1' },
      { name: '', value: '' },
      { name: '   ', value: '  ' },
    ]);
    expect(result).toEqual({ ok: true, headers: { 'x-a': '1' } });
  });

  test('a name with no value is an error, not a silent drop', () => {
    const result = normalizeCustomHeaders([{ name: '', value: 'orphan' }]);
    expect(result.ok).toBe(false);
  });

  test('duplicate names are reported', () => {
    const result = normalizeCustomHeaders([
      { name: 'x-a', value: '1' },
      { name: 'X-A', value: '2' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.reason).toContain('twice');
  });

  test('collects every problem instead of stopping at the first', () => {
    const result = normalizeCustomHeaders([
      { name: 'cookie', value: 'a=b' },
      { name: 'x-amz-date', value: 'now' },
      { name: 'x-ok', value: 'fine' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toHaveLength(2);
  });

  test('enforces the header count cap', () => {
    const rows = Array.from({ length: MAX_CUSTOM_HEADERS + 1 }, (_, i) => ({
      name: `x-h${i}`,
      value: 'v',
    }));
    const result = normalizeCustomHeaders(rows);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.reason.includes('at most'))).toBe(true);
  });

  test('assertSafeCustomHeaders throws with the reason in the message', () => {
    expect(() => assertSafeCustomHeaders([{ name: 'x-api-key', value: 'v' }])).toThrow(
      /unencrypted/,
    );
    expect(assertSafeCustomHeaders([{ name: 'x-ok', value: 'v' }])).toEqual({ 'x-ok': 'v' });
  });
});

describe('parseStoredHeaders', () => {
  // The column is cleartext and outlives upgrades, so a row written by an older
  // build or edited by hand must not be able to inject a forbidden header.
  test('drops a stored header that the policy now refuses', () => {
    expect(parseStoredHeaders({ 'x-api-key': 'leaked', 'x-ok': 'kept' })).toEqual({
      'x-ok': 'kept',
    });
  });

  test('drops a stored value that would smuggle a second header', () => {
    expect(parseStoredHeaders({ 'x-ok': 'kept', 'x-bad': 'a\r\nX-Injected: yes' })).toEqual({
      'x-ok': 'kept',
    });
  });

  test('keeps every allowed header when one sibling is refused', () => {
    // The guarantee that matters is "a refused header is never sent", not "the
    // whole set is discarded" — a working connection should not lose its other
    // headers because one of them aged out of the policy.
    expect(
      parseStoredHeaders({ 'x-a': '1', cookie: 'session=1', 'x-b': '2', range: 'bytes=0-' }),
    ).toEqual({ 'x-a': '1', 'x-b': '2' });
  });

  test('parses a JSON string, as JSONB may arrive', () => {
    expect(parseStoredHeaders('{"x-ok":"kept"}')).toEqual({ 'x-ok': 'kept' });
  });

  test('returns empty for anything unparseable or wrongly shaped', () => {
    expect(parseStoredHeaders(null)).toEqual({});
    expect(parseStoredHeaders(undefined)).toEqual({});
    expect(parseStoredHeaders('not json')).toEqual({});
    expect(parseStoredHeaders(42)).toEqual({});
    expect(parseStoredHeaders(['x-ok'])).toEqual({});
    expect(parseStoredHeaders({ 'x-ok': 42 })).toEqual({});
  });
});

describe('withCustomHeaders', () => {
  test('call-specific headers win over stored ones', () => {
    // A stored `range` or `content-type` would break resumable downloads and the
    // presigned-PUT content-type contract, so the call always overrides.
    const merged = withCustomHeaders(
      { 'x-tenant': 'acme', range: 'bytes=0-0', 'content-type': 'text/plain' },
      { Range: 'bytes=99-', 'Content-Type': 'application/xml' },
    );
    expect(merged).toEqual({
      'x-tenant': 'acme',
      range: 'bytes=99-',
      'content-type': 'application/xml',
    });
  });

  test('no custom headers leaves the call headers untouched', () => {
    expect(withCustomHeaders(undefined, { range: 'bytes=0-' })).toEqual({ range: 'bytes=0-' });
    expect(withCustomHeaders(undefined)).toEqual({});
  });
});
