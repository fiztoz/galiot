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

  // Every allowed origin is emitted. Emitting only the first would produce a
  // policy that differs from the one Galiot itself applies, which is worse than
  // no copy button at all.
  const origins = rule.allowedOrigins.length > 0 ? rule.allowedOrigins : ['*'];

  return [
    '<CORSRule>',
    ...origins.map((o) => `  <AllowedOrigin>${escape(o)}</AllowedOrigin>`),
    ...rule.allowedMethods.map((m) => `  <AllowedMethod>${escape(m)}</AllowedMethod>`),
    ...rule.allowedHeaders.map((h) => `  <AllowedHeader>${escape(h)}</AllowedHeader>`),
    ...rule.exposeHeaders.map((h) => `  <ExposeHeader>${escape(h)}</ExposeHeader>`),
    `  <MaxAgeSeconds>${rule.maxAgeSeconds}</MaxAgeSeconds>`,
    '</CORSRule>',
  ].join('\n');
}

/**
 * The full policy document, byte-for-byte what Galiot sends to the bucket.
 *
 * One serializer for every path — the worker's PutBucketCors body, the XML the
 * user copies, and the file the MinIO command reads — so a policy cannot differ
 * depending on which path wrote it.
 */
export function corsConfigToXml(config: CorsConfiguration): string {
  const rules = config.rules.map(corsRuleToXml).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration>
${rules}
</CORSConfiguration>`;
}

/**
 * The AWS CLI shape for `put-bucket-cors` / `get-bucket-cors`, which is JSON and
 * uses plural keys — not the XML the S3 API itself takes.
 *
 * Empty collections are omitted rather than sent as `[]`: AWS rejects an empty
 * `AllowedMethods`, and an empty `ExposeHeaders` is an error on some providers.
 */
export function corsConfigToAwsJson(config: CorsConfiguration): string {
  const rules = config.rules.map((rule) => {
    const entry: Record<string, unknown> = {};
    if (rule.allowedOrigins.length > 0) entry.AllowedOrigins = rule.allowedOrigins;
    if (rule.allowedMethods.length > 0) entry.AllowedMethods = rule.allowedMethods;
    if (rule.allowedHeaders.length > 0) entry.AllowedHeaders = rule.allowedHeaders;
    if (rule.exposeHeaders.length > 0) entry.ExposeHeaders = rule.exposeHeaders;
    if (Number.isFinite(rule.maxAgeSeconds)) entry.MaxAgeSeconds = rule.maxAgeSeconds;
    return entry;
  });

  return JSON.stringify({ CORSRules: rules }, null, 2);
}
