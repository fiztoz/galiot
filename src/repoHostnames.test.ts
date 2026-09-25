import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

/**
 * Repository hygiene: no real hostnames or bucket names in source.
 *
 * A real third-party endpoint's name ended up in a comment and two test files
 * while documenting a genuine bug. Debugging notes are exactly where a real
 * hostname leaks in — the endpoint is the first thing you paste — and once it
 * is in a commit it is in the history forever, where renaming a variable does
 * not help. This turns the convention into a build failure.
 *
 * Bucket names get the same treatment because a hostname scan cannot see them:
 * a real customer bucket survived the hostname scrub in four test files, since
 * `bucket: 'x'` contains no host at all.
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

/**
 * Bucket names permitted in fixtures. Kept literal, like the host allowlists
 * above, so widening it is a visible, reviewable edit rather than a silent one.
 * Every entry is either an RFC 2606 flavoured placeholder, a generic English
 * word, or a name this repo's own throwaway MinIO container creates.
 */
const ALLOWED_BUCKET_NAMES = [
  'archive',
  'assets',
  'b',
  'bench',
  'data',
  'example-bucket',
  'galiot-cors',
  'galiot-test',
  'imported-bucket',
  'my-bucket',
  'my-new-bucket',
  'other-bucket',
  'some-bucket',
  'staging-bucket',
];

/**
 * Shapes a bucket name takes in source. Deliberately narrow: each pattern names
 * a place a bucket is declared or signed for, so ordinary prose and unrelated
 * string literals are not swept in.
 */
const BUCKET_PATTERNS: RegExp[] = [
  /\bbucket:\s*'([^']+)'/g, // TS fixture object
  /\bBUCKET\s*=\s*'([^']+)'/g, // TS fixture constant
  /--bucket[= ]+'?([A-Za-z0-9._-]+)'?/g, // aws CLI
  /\bmc\s+(?:cors\s+set|mb|rb|cp|rm)\s+\S*?\/([A-Za-z0-9._-]+)/g, // mc alias/bucket
  // The first path segment of a URL that is unmistakably an S3 request.
  /https?:\/\/[^/\s'"`]+\/([A-Za-z0-9._-]+)\/[^\s'"`]*(?:X-Amz-|[?&](?:cors|list-type|location))/g,
];

/** `BUCKETS=(a b c)` in the shell harness — one pattern, several names. */
const SHELL_BUCKET_ARRAY = /\bBUCKETS=\(([^)]*)\)/g;

/** The only file exempt from its own scan; see `hygieneFiles`. */
const SELF = 'src/repoHostnames.test.ts';

function bucketNamesIn(line: string): string[] {
  const found: string[] = [];
  for (const pattern of BUCKET_PATTERNS) {
    for (const match of line.matchAll(pattern)) {
      const name = match[1];
      if (name) found.push(name);
    }
  }
  for (const match of line.matchAll(SHELL_BUCKET_ARRAY)) {
    for (const name of (match[1] ?? '').split(/\s+/)) {
      if (name) found.push(name);
    }
  }
  return found;
}

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

/** Source plus the shell/TS harnesses, which also carry bucket fixtures. */
async function hygieneFiles(): Promise<string[]> {
  const files = await sourceFiles();
  for await (const file of new Glob('scripts/**/*.{ts,sh}').scan('.')) files.push(file);
  // This file is exempt from its own bucket scan: a guard has to spell out the
  // shapes it rejects, and those counter-examples are exactly what the extractor
  // looks for. The exemption is asserted below to stay a single file so it
  // cannot quietly grow into a hole.
  const exempt = new Set([SELF, `./${SELF}`]);
  return files.filter((file) => !exempt.has(file));
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

describe('repository bucket names', () => {
  test('src/ and scripts/ contain no real customer bucket name', async () => {
    const offenders: string[] = [];

    for (const file of await hygieneFiles()) {
      const lines = (await Bun.file(file).text()).split('\n');

      lines.forEach((line, index) => {
        for (const name of bucketNamesIn(line)) {
          if (ALLOWED_BUCKET_NAMES.includes(name)) continue;
          offenders.push(`${file}:${index + 1}  ${name}  —  ${line.trim().slice(0, 90)}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  }, 30_000);

  test('the extractor actually sees the shapes it claims to', () => {
    // Without these the guard passes vacuously — a regex that matches nothing
    // looks exactly like a clean repository.
    expect(bucketNamesIn(`  bucket: 'example-bucket',`)).toEqual(['example-bucket']);
    expect(bucketNamesIn(`const BUCKET = 'example-bucket';`)).toEqual(['example-bucket']);
    expect(bucketNamesIn(`aws s3api get-bucket-cors --bucket 'example-bucket'`)).toEqual([
      'example-bucket',
    ]);
    expect(bucketNamesIn(`mc cors set galiot/example-bucket`)).toEqual(['example-bucket']);
    expect(bucketNamesIn(`BUCKETS=(galiot-test galiot-cors)`)).toEqual([
      'galiot-test',
      'galiot-cors',
    ]);
    expect(
      bucketNamesIn(`'https://s3.example.com/example-bucket/?cors=&X-Amz-Algorithm=AWS4-HMAC-SHA256'`),
    ).toEqual(['example-bucket']);
    // Ordinary prose and non-S3 URLs must not be swept in.
    expect(bucketNamesIn(`const bucket = computeBucket(x); // no literal here`)).toEqual([]);
    expect(bucketNamesIn(`see https://github.com/electric-sql/pglite/releases`)).toEqual([]);
  });

  test('a real-looking bucket name is rejected', () => {
    // A structural placeholder, not a real customer name: this file is exempt
    // from its own scan, so pasting the thing we scrubbed back in here would
    // quietly undo the scrub.
    const real = 'acme_prod_eu1';
    expect(ALLOWED_BUCKET_NAMES.includes(real)).toBe(false);
    expect(bucketNamesIn(`  bucket: '${real}',`)).toEqual([real]);
  });

  test('only this guard file is exempt from the scan', async () => {
    // If the exemption ever widens, the guard has a hole in it.
    const all = await sourceFiles();
    const scanned = await hygieneFiles();
    expect(all.length - scanned.filter((f) => f.startsWith('src/')).length).toBe(1);
    expect(all.filter((f) => !scanned.includes(f))).toEqual([SELF]);
    expect(SELF).toBe('src/repoHostnames.test.ts');
  });
});
