import { afterEach, describe, expect, mock, test } from 'bun:test';
import { S3Client } from './client';

/**
 * The reachability probe, which decides whether the app blames the network or
 * the browser. Both halves of it were wrong in ways no unit test could see:
 *
 *  - a previous copy passed `redirect: 'manual'` with `mode: 'no-cors'`, which
 *    Chrome rejects with a TypeError, so it reported *every* host as unreachable
 *    (confirmed in a real browser against an on-premises S3 gateway, a public
 *    site and a dead port: all three threw, while the same request without
 *    `redirect` resolved for the two live hosts);
 *  - a single failed probe cannot distinguish "the host is down" from "the host
 *    does not publish DNS for bucket subdomains", and only the second one is
 *    fixed by a checkbox.
 *
 * Hostnames here are documentation-reserved (`example.com`, RFC 2606). The
 * endpoint that revealed the second bug was a real third-party gateway, and its
 * name does not belong in this repository.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  init: RequestInit;
}

/** Installs a fetch stub and records every call. */
function stubFetch(handler: (url: string) => boolean): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    if (handler(url)) return new Response('', { status: 403 });
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
  return calls;
}

/** A DNS endpoint on a non-standard port, with no wildcard DNS for buckets. */
const client = (pathStyle: boolean) =>
  new S3Client({
    endpoint: 'https://s3.example.com:9021',
    bucket: 'archive',
    region: 'us-east-1',
    pathStyle,
    accessKeyId: 'AKIA',
    secretAccessKey: 'secret',
  });

describe('probeAddressing', () => {
  test('a host that answers is not probed twice', async () => {
    const calls = stubFetch(() => true);
    const result = await client(false).probeAddressing();

    expect(result.reachable).toBe(true);
    expect(result.alternateReachable).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://archive.s3.example.com:9021/');
  });

  test('a missing bucket subdomain is found, not reported as a dead network', async () => {
    // Only the path-style address answers — the shape of a gateway that
    // resolves but publishes no wildcard DNS for bucket subdomains.
    // Exact match: `https://s3.example.com…` also contains "/s3".
    const calls = stubFetch((url) => url === 'https://s3.example.com:9021/archive/');
    const result = await client(false).probeAddressing();

    expect(result.reachable).toBe(false);
    expect(result.alternateReachable).toBe(true);
    expect(result.alternateUrl).toBe('https://s3.example.com:9021/archive/');
    expect(calls.map((c) => c.url)).toEqual([
      'https://archive.s3.example.com:9021/',
      'https://s3.example.com:9021/archive/',
    ]);
  });

  test('when neither form answers it stays a network problem', async () => {
    stubFetch(() => false);
    const result = await client(true).probeAddressing();

    expect(result.reachable).toBe(false);
    expect(result.alternateReachable).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('the reverse case is found too: path-style off for a virtual-host server', async () => {
    const calls = stubFetch((url) => url.includes('archive.s3.example.com'));
    const result = await client(true).probeAddressing();

    expect(result.alternateReachable).toBe(true);
    expect(calls[0]?.url).toBe('https://s3.example.com:9021/archive/');
  });

  test('probes are CORS-free and never pair no-cors with redirect: manual', async () => {
    const calls = stubFetch(() => true);
    await client(false).probeAddressing();

    for (const call of calls) {
      expect(call.init.mode).toBe('no-cors');
      // Chrome throws for this combination, which would make every reachable
      // host look unreachable.
      expect(call.init.redirect).toBeUndefined();
    }
  });
});

describe('local companion routing', () => {
  test('signs inside the worker path and sends the bucket request to loopback', async () => {
    const calls: { url: string; headers: Headers }[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, headers: new Headers(init.headers) });
      return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const viaBridge = new S3Client({
      endpoint: 'https://s3.example.com:9021',
      bucket: 'archive',
      region: 'us-east-1',
      pathStyle: true,
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      bridgeToken: 'session-token',
    });
    const listing = await viaBridge.listObjects();

    expect(listing.objects).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:8787/proxy');
    expect(calls[0]?.headers.get('x-galiot-bridge-target')).toBe(
      'https://s3.example.com:9021/archive/?list-type=2',
    );
    expect(calls[0]?.headers.get('x-galiot-bridge-token')).toBe('session-token');
    expect(calls[0]?.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
  });
});
