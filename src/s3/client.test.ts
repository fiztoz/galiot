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

describe('ListObjects v1 fallback for older gateways', () => {
  test('a 501 on v2 retries with marker paging and reads NextMarker', async () => {
    const urls: string[] = [];
    const client = new S3Client({
      endpoint: 'https://s3.example.com',
      bucket: 'archive',
      region: 'us-east-1',
      pathStyle: true,
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      dispatch: async (signed) => {
        urls.push(signed.url);
        if (urls.length === 1) {
          return new Response('<Error><Code>NotImplemented</Code></Error>', { status: 501 });
        }
        return new Response(
          '<ListBucketResult><IsTruncated>true</IsTruncated><NextMarker>docs/a.txt</NextMarker>' +
            '<Contents><Key>docs/a.txt</Key><Size>1</Size></Contents></ListBucketResult>',
          { status: 200 },
        );
      },
    });
    const page = await client.listObjects('docs/');
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('list-type=2');
    expect(urls[1]).not.toContain('list-type');
    expect(page.objects.map((o) => o.key)).toEqual(['docs/a.txt']);
    expect(page.nextContinuationToken).toBe('v1:docs/a.txt');

    const second = await client.listObjects('docs/', { continuationToken: page.nextContinuationToken });
    expect(urls).toHaveLength(3);
    expect(urls[2]).toContain('marker=docs%2Fa.txt');
    expect(urls[2]).not.toContain('list-type');
    expect(second.isTruncated).toBe(true);
    expect(second.nextContinuationToken).toBe('v1:docs/a.txt');
  });

  test('a fresh client resumes v1 paging from a marked token', async () => {
    const urls: string[] = [];
    const client = new S3Client({
      endpoint: 'https://s3.example.com',
      bucket: 'archive',
      region: 'us-east-1',
      pathStyle: true,
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      dispatch: async (signed) => {
        urls.push(signed.url);
        return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
      },
    });
    await client.listObjects('docs/', { continuationToken: 'v1:docs/a.txt' });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('marker=docs%2Fa.txt');
    expect(urls[0]).not.toContain('list-type');
  });

  test('a rejected v2 continuation token is not replayed as a v1 marker', async () => {
    let calls = 0;
    const client = new S3Client({
      endpoint: 'https://s3.example.com',
      bucket: 'archive',
      region: 'us-east-1',
      pathStyle: true,
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      dispatch: async () => {
        calls += 1;
        return new Response('<Error><Code>InvalidArgument</Code></Error>', { status: 400 });
      },
    });
    await expect(client.listObjects('docs/', { continuationToken: '1ueGcxLPRx1Tr' })).rejects.toThrow(/InvalidArgument/);
    expect(calls).toBe(1);
  });

  test('a genuine refusal is not retried as v1', async () => {
    let calls = 0;
    const client = new S3Client({
      endpoint: 'https://s3.example.com',
      bucket: 'archive',
      region: 'us-east-1',
      pathStyle: true,
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      dispatch: async () => {
        calls += 1;
        return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
      },
    });
    await expect(client.listObjects()).rejects.toThrow(/AccessDenied/);
    expect(calls).toBe(1);
  });
});

describe('server network routing', () => {
  test('refuses to call S3 from a client that has no server dispatch', async () => {
    const viaServer = new S3Client({
      endpoint: 'https://s3.example.com',
      bucket: 'archive',
      region: 'us-east-1',
      pathStyle: true,
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
    });
    await expect(viaServer.listObjects()).rejects.toThrow(/self-hosted Galiot server/);
  });

  test('a server dispatch receives the signed bucket URL, not a browser fetch', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async () => {
      throw new Error('browser fetch must not run');
    }) as unknown as typeof fetch;
    const viaServer = new S3Client({
      endpoint: 'https://s3.example.com',
      bucket: 'archive',
      region: 'us-east-1',
      pathStyle: true,
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      dispatch: async (signed) => {
        calls.push(signed.url);
        expect(signed.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
        return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
      },
    });
    await viaServer.listObjects();
    expect(calls).toEqual(['https://s3.example.com/archive/?list-type=2']);
  });
});
