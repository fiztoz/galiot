import type { CorsConfiguration, CorsRule } from '../s3/client';

/**
 * CORS policy helpers for the connection wizard (roadmap 5.1).
 *
 * Pure functions so the "does this policy cover us?" verdict is unit-testable
 * without a bucket.
 */

export type CorsVerdict = 'ok' | 'origin-missing' | 'methods-missing' | 'etag-hidden' | 'none';

/** Methods Galiot's explorer and transfer engine actually issue. */
export const REQUIRED_METHODS = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE'] as const;

/** Response headers that must be readable by the browser. */
export const REQUIRED_EXPOSE_HEADERS = ['ETag'] as const;

function ruleCoversOrigin(rule: CorsRule, origin: string): boolean {
  return rule.allowedOrigins.some(
    (allowed) => allowed === '*' || allowed === origin || matchesWildcard(allowed, origin),
  );
}

/** Supports the `https://*.example.com` style patterns S3 accepts. */
function matchesWildcard(pattern: string, origin: string): boolean {
  if (!pattern.includes('*')) return false;
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(origin);
}

export function evaluateCors(
  config: CorsConfiguration,
  origin: string,
): { verdict: CorsVerdict; matched: CorsRule | null; missing: string[] } {
  if (config.rules.length === 0) {
    return { verdict: 'none', matched: null, missing: [] };
  }

  const matched = config.rules.find((rule) => ruleCoversOrigin(rule, origin));
  if (!matched) {
    return { verdict: 'origin-missing', matched: null, missing: ['origin'] };
  }

  const missing: string[] = [];
  const methods = matched.allowedMethods.map((m) => m.toUpperCase());
  for (const method of REQUIRED_METHODS) {
    if (!methods.includes(method)) missing.push(method);
  }

  const exposed = matched.exposeHeaders.map((h) => h.toLowerCase());
  if (!exposed.includes('*') && !REQUIRED_EXPOSE_HEADERS.some((h) => exposed.includes(h.toLowerCase()))) {
    missing.push('ExposeHeader: ETag');
  }

  if (missing.length > 0) {
    const onlyExpose = missing.every((m) => m.startsWith('ExposeHeader'));
    return {
      verdict: onlyExpose ? 'etag-hidden' : missing.some((m) => REQUIRED_METHODS.includes(m as never))
        ? 'methods-missing'
        : 'etag-hidden',
      matched,
      missing,
    };
  }

  return { verdict: 'ok', matched, missing: [] };
}

/** XML snippet users can paste into MinIO/other non-S3 tooling. */
export function corsRuleToXml(rule: CorsRule): string {
  const escape = (v: string): string =>
    v.replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch] ?? ch,
    );

  return [
    '<CORSRule>',
    `  <AllowedOrigin>${escape(rule.allowedOrigins[0] ?? '*')}</AllowedOrigin>`,
    ...rule.allowedMethods.map((m) => `  <AllowedMethod>${escape(m)}</AllowedMethod>`),
    ...rule.allowedHeaders.map((h) => `  <AllowedHeader>${escape(h)}</AllowedHeader>`),
    ...rule.exposeHeaders.map((h) => `  <ExposeHeader>${escape(h)}</ExposeHeader>`),
    `  <MaxAgeSeconds>${rule.maxAgeSeconds}</MaxAgeSeconds>`,
    '</CORSRule>',
  ].join('\n');
}
