import { describe, expect, test } from 'bun:test';
import { checkProxyTarget } from './proxy';
import { resolveProxyAddresses } from './target';

describe('proxy address validation', () => {
  test('rejects alternate IP encodings and the full link-local range', () => {
    for (const host of [
      '169.254.169.254', '2852039166', '0xa9fea9fe',
      '[::ffff:169.254.169.254]', '[0:0:0:0:0:ffff:a9fe:a9fe]',
      '[fe80::1]', '[fe90::1]', '[febf::1]', '[ff02::1]', '[::]', '[fd00:ec2::254]',
      '0.0.0.1', '224.0.0.1', '255.255.255.255',
    ]) expect(checkProxyTarget(`http://${host}/`).ok).toBe(false);
  });

  test('preserves loopback and private IPv4 and IPv6 endpoints', async () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '[::1]', '[::ffff:127.0.0.1]', '[fc00::1]']) {
      const url = new URL(`http://${host}:9000/`);
      expect(checkProxyTarget(url.href).ok).toBe(true);
      expect((await resolveProxyAddresses(url, async () => { throw new Error('literal must not resolve'); }))[0]?.address)
        .toBe(url.hostname.replace(/^\[|\]$/g, ''));
    }
  });

  test('resolves once and rejects empty or malformed answers', async () => {
    const url = new URL('https://s3.example.com/');
    let calls = 0;
    expect(await resolveProxyAddresses(url, async (hostname) => {
      calls += 1;
      expect(hostname).toBe('s3.example.com');
      return [{ address: '10.0.0.5', family: 4 }];
    })).toEqual([{ address: '10.0.0.5', family: 4 }]);
    expect(calls).toBe(1);
    await expect(resolveProxyAddresses(url, async () => [])).rejects.toThrow();
    await expect(resolveProxyAddresses(url, async () => [{ address: '10.0.0.5', family: 6 }])).rejects.toThrow();
  });
});
