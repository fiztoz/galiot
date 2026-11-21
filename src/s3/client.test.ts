import { afterEach, describe, expect, mock, test } from 'bun:test';
import { S3Client } from './client';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
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

  test('a v1 page that ends in folders resumes after the last prefix', async () => {
    const client = new S3Client({
      endpoint: 'https://s3.example.com', bucket: 'archive', region: 'us-east-1', pathStyle: true,
      accessKeyId: 'AKIA', secretAccessKey: 'secret',
      dispatch: async () => new Response(
        '<ListBucketResult><IsTruncated>true</IsTruncated>' +
          '<Contents><Key>a.txt</Key><Size>1</Size></Contents>' +
          '<CommonPrefixes><Prefix>b/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>c/</Prefix></CommonPrefixes>' +
          '</ListBucketResult>',
        { status: 200 },
      ),
    });
    const page = await client.listObjects('', { delimiter: '/', continuationToken: 'v1:0' });
    expect(page.nextContinuationToken).toBe('v1:c/');
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
