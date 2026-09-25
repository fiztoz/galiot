import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

/**
 * Repository hygiene: no real hostnames in source.
 *
 * A real third-party endpoint's name ended up in a comment and two test files
 * while documenting a genuine bug. Debugging notes are exactly where a real
 * hostname leaks in — the endpoint is the first thing you paste — and once it
 * is in a commit it is in the history forever, where renaming a variable does
 * not help. This turns the convention into a build failure.
 *
 * Docs are exempt: they are required to cite vendor documentation, so real URLs
 * belong there. `src/` should only ever contain documentation-reserved names,
 * loopback or private addresses, the S3 endpoint domains the code legitimately
 * reasons about, and links to public source code.
 */

const RESERVED_TLDS = ['example', 'invalid', 'test', 'localhost', 'local', 'lan'];

/**
 * Reserved by RFC 2606 as whole domains, so `s3.example.com` is as safe as
 * `bucket.example`. The TLD list above cannot cover these: `example.com` has
 * the top-level label `com`.
 */
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

/**
 * Real domains permitted in `src/`, by suffix rather than by exact host, so a
 * regional endpoint or a path variant does not need listing.
 */
const VENDOR_SUFFIXES = ['amazonaws.com', 'cloudflarestorage.com'];

/** Public code hosts, for source citations in comments. */
const CODE_HOSTS = ['github.com', 'raw.githubusercontent.com'];

/** Strips everything a hostname cannot contain, e.g. a trailing `…` or `<`. */
function cleanHost(raw: string): string {
  const withoutCredentials = raw.split('@').pop() ?? '';
  const host = withoutCredentials.split('/')[0] ?? '';
  return host.replace(/[^A-Za-z0-9.:[\]-].*$/, '').replace(/:\d+$/, '');
}

function isLiteralAddress(host: string): boolean {
  if (host === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.startsWith('[')) return true; // IPv6
  return false;
}

/**
 * A candidate must look like a domain at all: at least one dot and an
 * alphabetic top-level label. This is what keeps `https://oth` (a fixture split
 * across string concatenation) and `https://…` (a docs placeholder) out of the
 * results.
 */
function looksLikeDomain(host: string): boolean {
  if (!host.includes('.')) return false;
  const tld = host.split('.').pop() ?? '';
  return /^[A-Za-z]{2,}$/.test(tld);
}

function isAllowed(rawHost: string): boolean {
  const host = cleanHost(rawHost).toLowerCase();
  if (host.length === 0) return false;
  if (!looksLikeDomain(host) && !isLiteralAddress(host)) return true; // not a domain
  if (isLiteralAddress(host)) return true;
  if (CODE_HOSTS.includes(host)) return true;
  if (VENDOR_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return true;
  if (RESERVED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return true;
  const tld = host.split('.').pop() ?? '';
  return RESERVED_TLDS.includes(tld);
}

async function sourceFiles(): Promise<string[]> {
  const glob = new Glob('src/**/*.{ts,tsx}');
  const files: string[] = [];
  for await (const file of glob.scan('.')) {
    if (file.endsWith('.ts') || file.endsWith('.tsx')) files.push(file);
  }
  return files;
}

describe('repository hostnames', () => {
  test('src/ contains no real third-party or customer hostname', async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles()) {
      const lines = (await Bun.file(file).text()).split('\n');

      lines.forEach((line, index) => {
        for (const match of line.matchAll(/\bhttps?:\/\/([^\s'"`)]+)/g)) {
          const host = cleanHost(match[1] ?? '');
          if (host.length === 0 || isAllowed(host)) continue;
          offenders.push(`${file}:${index + 1}  ${host}  —  ${line.trim().slice(0, 90)}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  }, 30_000);

  test('the allowlist is documentation names, vendor S3 domains and code hosts only', () => {
    // Kept literal so widening it is a visible, reviewable edit.
    expect(VENDOR_SUFFIXES).toEqual(['amazonaws.com', 'cloudflarestorage.com']);
    expect(CODE_HOSTS).toEqual(['github.com', 'raw.githubusercontent.com']);
    expect(RESERVED_DOMAINS).toEqual(['example.com', 'example.net', 'example.org']);
  });

  test('rejects things that look like real services', () => {
    for (const host of [
      'minio.example.com',
      'storage.customer-domain.tld',
      // A vendor domain with a real TLD bolted on the end is a lookalike, not
      // a vendor endpoint.
      'acct.r2.cloudflarestorage.com.evil.co',
      's3.eu-west-1.amazonaws.org',
    ]) {
      expect(isAllowed(host)).toBe(false);
    }
    expect(isAllowed('acct.r2.cloudflarestorage.com')).toBe(true);
    expect(isAllowed('bucket.s3.example.com')).toBe(true);
    expect(isAllowed('http://localhost:9000')).toBe(true);
  });
});
