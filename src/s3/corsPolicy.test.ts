import { describe, expect, test } from 'bun:test';
import { evaluateCors, corsRuleToXml, REQUIRED_METHODS } from './corsPolicy';
import type { CorsRule } from './client';

const ORIGIN = 'https://galiot.example.com';

const goodRule: CorsRule = {
  allowedOrigins: [ORIGIN],
  allowedMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE'],
  allowedHeaders: ['*'],
  exposeHeaders: ['ETag'],
  maxAgeSeconds: 3600,
};

const rule = (overrides: Partial<CorsRule> = {}): CorsRule => ({ ...goodRule, ...overrides });

describe('evaluateCors', () => {
  test('accepts a complete policy for our origin', () => {
    const result = evaluateCors({ rules: [goodRule] }, ORIGIN);
    expect(result.verdict).toBe('ok');
    expect(result.missing).toEqual([]);
  });

  test('reports an empty configuration', () => {
    expect(evaluateCors({ rules: [] }, ORIGIN).verdict).toBe('none');
  });

  test('flags a policy that does not cover the origin', () => {
    const result = evaluateCors(
      { rules: [rule({ allowedOrigins: ['https://other.example'] })] },
      ORIGIN,
    );
    expect(result.verdict).toBe('origin-missing');
  });

  test('treats a wildcard origin as covering everything', () => {
    const result = evaluateCors({ rules: [rule({ allowedOrigins: ['*'] })] }, ORIGIN);
    expect(result.verdict).toBe('ok');
  });

  test('understands subdomain wildcard patterns', () => {
    const result = evaluateCors(
      { rules: [rule({ allowedOrigins: ['https://*.example.com'] })] },
      ORIGIN,
    );
    expect(result.verdict).toBe('ok');
  });

  test('flags missing methods', () => {
    const result = evaluateCors(
      { rules: [rule({ allowedMethods: ['GET', 'HEAD'] })] },
      ORIGIN,
    );
    expect(result.verdict).toBe('methods-missing');
    for (const method of REQUIRED_METHODS) {
      if (!['GET', 'HEAD'].includes(method)) {
        expect(result.missing).toContain(method);
      }
    }
  });

  test('flags a policy that hides ETag (multipart uploads would break)', () => {
    const result = evaluateCors({ rules: [rule({ exposeHeaders: [] })] }, ORIGIN);
    expect(result.verdict).toBe('etag-hidden');
    expect(result.missing).toContain('ExposeHeader: ETag');
  });

  test('accepts a wildcard expose-header list', () => {
    const result = evaluateCors({ rules: [rule({ exposeHeaders: ['*'] })] }, ORIGIN);
    expect(result.verdict).toBe('ok');
  });

  test('method matching is case-insensitive', () => {
    const result = evaluateCors(
      { rules: [rule({ allowedMethods: ['get', 'head', 'put', 'post', 'delete'] })] },
      ORIGIN,
    );
    expect(result.verdict).toBe('ok');
  });

  test('picks the first rule that covers the origin', () => {
    const result = evaluateCors(
      {
        rules: [
          rule({ allowedOrigins: ['https://elsewhere.example'] }),
          rule({ exposeHeaders: [] }),
        ],
      },
      ORIGIN,
    );
    expect(result.verdict).toBe('etag-hidden');
    expect(result.matched?.allowedOrigins).toEqual([ORIGIN]);
  });
});

describe('corsRuleToXml', () => {
  test('renders every field as XML', () => {
    const xml = corsRuleToXml(goodRule);
    expect(xml).toContain(`<AllowedOrigin>${ORIGIN}</AllowedOrigin>`);
    expect(xml).toContain('<AllowedMethod>DELETE</AllowedMethod>');
    expect(xml).toContain('<ExposeHeader>ETag</ExposeHeader>');
    expect(xml).toContain('<MaxAgeSeconds>3600</MaxAgeSeconds>');
  });

  test('escapes XML metacharacters', () => {
    const xml = corsRuleToXml(rule({ allowedOrigins: ['https://a.example/?x=1&y=2'] }));
    expect(xml).toContain('&amp;');
    expect(xml).not.toContain('&y=');
  });
});
