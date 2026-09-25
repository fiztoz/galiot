/**
 * Custom request headers for a connection.
 *
 * Some S3-compatible gateways and reverse proxies need an extra header on every
 * request — a tenant id, a routing hint, a tracing tag. This module is the only
 * place that decides which headers a connection may add, and it is enforced on
 * the way in (the dialog, the repository) *and* on the way out (the client, the
 * signer), because the stored value is cleartext in the database and an older
 * row could contain anything.
 *
 * Three classes of header are refused:
 *
 *  1. Browser-forbidden names. `fetch` silently drops these, so accepting them
 *     would produce a setting that looks saved and does nothing — the worst
 *     kind of bug to debug against a live endpoint.
 *  2. SigV4 inputs. `authorization`, `x-amz-date`, `x-amz-content-sha256` and
 *     friends are computed per request and hashed into the signature. Letting a
 *     stored value override one desynchronises the signature from the request
 *     that is actually sent, which every server answers as
 *     `403 SignatureDoesNotMatch`.
 *  3. Credential-looking names. Custom headers are stored in cleartext (see
 *     `profiles.custom_headers`), so a header whose name says "token" or
 *     "api-key" would be a secret sitting readable in IndexedDB/OPFS. Refusing
 *     the name keeps that mistake from being made silently; a gateway that
 *     genuinely authenticates by header needs the encrypted-store design instead.
 *
 * Values are checked for CR/LF/NUL so a stored header cannot smuggle a second
 * header into the request.
 */

/** Hard caps, so a pasted blob cannot bloat the row or the request. */
export const MAX_CUSTOM_HEADERS = 20;
export const MAX_HEADER_NAME_LENGTH = 128;
export const MAX_HEADER_VALUE_LENGTH = 8192;

/** RFC 7230 token characters. Anything else cannot be a header name. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Names the browser will not let a page set. `fetch` drops them without an
 * error, so these are refused up front rather than silently ignored.
 */
const BROWSER_FORBIDDEN = new Set([
  'accept-charset',
  'accept-encoding',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

const BROWSER_FORBIDDEN_PREFIXES = ['access-control-', 'proxy-', 'sec-'];

/**
 * Headers Galiot computes per request and hashes into the SigV4 signature.
 * Overriding one makes the signature describe a request that was never sent.
 */
const SIGNING_INPUTS = new Set([
  'authorization',
  'x-amz-algorithm',
  'x-amz-content-sha256',
  'x-amz-credential',
  'x-amz-date',
  'x-amz-expires',
  'x-amz-security-token',
  'x-amz-signature',
  'x-amz-signedheaders',
]);

/**
 * Headers Galiot sets itself and whose value carries meaning elsewhere:
 *   range          resumable downloads restart from a byte offset
 *   content-type   uploads and presigned PUTs must agree with what was signed
 *   content-md5    the integrity check compares it against the ETag
 */
const APP_OWNED = new Set(['range', 'content-type', 'content-md5']);

/**
 * The app-owned set, sorted, so a test can pin it as a literal list — widening
 * or shrinking it then shows up as a reviewable diff rather than a silent one.
 */
export const APP_OWNED_FOR_TEST = [...APP_OWNED].sort();

/**
 * Patterns that mean "this value is a secret". Written as an explicit list
 * rather than a word list so the boundary cases are visible and testable:
 * `x-api-key` and `x-auth-token` are refused, while `x-partition-key` and
 * `x-api-version` are ordinary routing hints and are not.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /authorization/,
  /(?:^|[-_])api[-_]?key(?:$|[-_])/,
  /(?:^|[-_])auth(?:$|[-_])/,
  /(?:^|[-_])bearer(?:$|[-_])/,
  /(?:^|[-_])credential[s]?(?:$|[-_])/,
  /(?:^|[-_])passw(?:or)?d(?:$|[-_])/,
  /(?:^|[-_])private[-_]?key(?:$|[-_])/,
  /(?:^|[-_])secret(?:$|[-_])/,
  /(?:^|[-_])token(?:$|[-_])/,
];

export type HeaderRejection =
  | { kind: 'browser-forbidden' }
  | { kind: 'signing-input' }
  | { kind: 'app-owned' }
  | { kind: 'credential-looking' }
  | { kind: 'invalid-name' }
  | { kind: 'invalid-value' }
  | { kind: 'name-too-long' }
  | { kind: 'value-too-long' };

/**
 * Why a header name is refused, in words the dialog can show verbatim. Returning
 * a reason rather than a boolean is what makes this usable as UI validation
 * instead of a mystery "invalid header".
 */
export function rejectReason(name: string, value: string): HeaderRejection | null {
  const lower = name.trim().toLowerCase();

  if (lower.length === 0) return { kind: 'invalid-name' };
  if (lower.length > MAX_HEADER_NAME_LENGTH) return { kind: 'name-too-long' };
  if (!TOKEN.test(lower)) return { kind: 'invalid-name' };

  if (BROWSER_FORBIDDEN.has(lower) || BROWSER_FORBIDDEN_PREFIXES.some((p) => lower.startsWith(p))) {
    return { kind: 'browser-forbidden' };
  }
  if (SIGNING_INPUTS.has(lower)) return { kind: 'signing-input' };
  if (APP_OWNED.has(lower)) return { kind: 'app-owned' };

  // `x-amz-meta-*` is user object metadata, stored on the object rather than
  // used to authenticate the request, so it is allowed through even when the
  // metadata happens to be about a token.
  if (!lower.startsWith('x-amz-meta-') && CREDENTIAL_PATTERNS.some((p) => p.test(lower))) {
    return { kind: 'credential-looking' };
  }

  if (/[\r\n\0]/.test(value)) return { kind: 'invalid-value' };
  if (value.length > MAX_HEADER_VALUE_LENGTH) return { kind: 'value-too-long' };

  return null;
}

const REJECTION_TEXT: Record<HeaderRejection['kind'], string> = {
  'browser-forbidden': 'browsers refuse to send this header, so it would be saved and then silently ignored',
  'signing-input': 'Galiot computes this header per request and signs it; overriding it breaks the SigV4 signature',
  'app-owned': 'Galiot sets this header itself (resumable ranges, upload content type, integrity checks)',
  'credential-looking':
    'custom headers are stored unencrypted, so a name like this would keep a secret in readable browser storage',
  'invalid-name': 'not a valid HTTP header name',
  'invalid-value': 'header values cannot contain a line break or NUL — that would smuggle a second header',
  'name-too-long': `header name is longer than ${MAX_HEADER_NAME_LENGTH} characters`,
  'value-too-long': `header value is longer than ${MAX_HEADER_VALUE_LENGTH} characters`,
};

export function rejectText(rejection: HeaderRejection): string {
  return REJECTION_TEXT[rejection.kind];
}

/** One header row as the dialog holds it, before it is committed. */
export interface HeaderDraft {
  name: string;
  value: string;
}

export interface HeaderIssue {
  name: string;
  reason: string;
}

export type NormalizeResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; issues: HeaderIssue[] };

/**
 * Validates and canonicalises a set of custom headers.
 *
 * Names are lowercased (HTTP header names are case-insensitive, HTTP/2 requires
 * lowercase, and it makes duplicate detection exact). Values are trimmed of
 * surrounding whitespace only — SigV4 collapses inner runs of whitespace when it
 * builds the canonical header, so keeping the value as typed is what the
 * signature will describe.
 *
 * Accepts the shapes that reach it: draft rows from the dialog, a parsed JSONB
 * object from the database, or an entries array.
 */
export function normalizeCustomHeaders(
  input: readonly HeaderDraft[] | Record<string, unknown> | null | undefined,
): NormalizeResult {
  const pairs: [string, string][] = [];

  if (input === null || input === undefined) {
    // nothing to do
  } else if (Array.isArray(input)) {
    for (const row of input) {
      const name = String(row?.name ?? '').trim();
      // A row with no name is an empty trailing row in the editor, not an error.
      if (name.length === 0 && String(row?.value ?? '').trim().length === 0) continue;
      pairs.push([name, String(row?.value ?? '').trim()]);
    }
  } else if (typeof input === 'object') {
    for (const [name, value] of Object.entries(input)) {
      if (typeof value !== 'string') continue;
      const trimmedName = name.trim();
      if (trimmedName.length === 0 && value.trim().length === 0) continue;
      pairs.push([trimmedName, value.trim()]);
    }
  }

  const issues: HeaderIssue[] = [];
  const headers: Record<string, string> = {};
  const seen = new Set<string>();

  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    const rejection = rejectReason(name, value);
    if (rejection) {
      issues.push({ name: name || '(blank)', reason: rejectText(rejection) });
      continue;
    }
    if (seen.has(lower)) {
      issues.push({ name, reason: 'is set twice — remove one of them' });
      continue;
    }
    seen.add(lower);
    headers[lower] = value;
  }

  if (pairs.length > MAX_CUSTOM_HEADERS) {
    issues.push({
      name: '(too many)',
      reason: `a connection can carry at most ${MAX_CUSTOM_HEADERS} custom headers`,
    });
  }

  return issues.length === 0 ? { ok: true, headers } : { ok: false, issues };
}

/**
 * Throws on invalid input, for the non-UI paths (repository writes, the worker)
 * where a silent no-op would be worse than a failure.
 */
export function assertSafeCustomHeaders(
  input: readonly HeaderDraft[] | Record<string, unknown> | null | undefined,
): Record<string, string> {
  const result = normalizeCustomHeaders(input);
  if (!result.ok) {
    const detail = result.issues.map((i) => `${i.name}: ${i.reason}`).join('; ');
    throw new Error(`Custom headers were rejected — ${detail}`);
  }
  return result.headers;
}

/**
 * Reads the stored JSONB column defensively.
 *
 * The column is cleartext and survives upgrades, so a row written by an older
 * build — or edited by hand — must never be able to inject a forbidden header.
 *
 * Filtering is per entry rather than all-or-nothing on purpose: one header that
 * a later rule made invalid must not silently disable the other four on a
 * connection that was working. Dropping only the offender keeps the guarantee
 * (a refused header is never sent) without the surprise.
 */
export function parseStoredHeaders(raw: unknown): Record<string, string> {
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (candidate === null || candidate === undefined) return {};
  if (typeof candidate !== 'object' || Array.isArray(candidate)) return {};

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const lower = name.trim().toLowerCase();
    const trimmed = value.trim();
    if (rejectReason(lower, trimmed) !== null) continue;
    headers[lower] = trimmed;
  }
  return headers;
}

/**
 * Overlays the connection's custom headers on the ones a call already needs.
 *
 * Call-specific headers win: `range` on a resumed download and `content-type` on
 * an upload are part of what the signature covers, so a stored header must not
 * displace them. `rejectReason` refuses those names anyway; this is the second
 * line of defence for a row that predates the rule.
 */
export function withCustomHeaders(
  custom: Record<string, string> | undefined,
  call: Record<string, string> = {},
): Record<string, string> {
  if (!custom) return call;
  const merged: Record<string, string> = { ...custom };
  for (const [name, value] of Object.entries(call)) {
    merged[name.toLowerCase()] = value;
  }
  return merged;
}
