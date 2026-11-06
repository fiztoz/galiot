import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
blocked.addSubnet('0.0.0.0', 8, 'ipv4');
blocked.addSubnet('169.254.0.0', 16, 'ipv4');
blocked.addSubnet('224.0.0.0', 4, 'ipv4');
blocked.addSubnet('240.0.0.0', 4, 'ipv4');
blocked.addAddress('::', 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('ff00::', 8, 'ipv6');
// The IPv6 metadata endpoint is inside otherwise legitimate private space.
blocked.addAddress('fd00:ec2::254', 'ipv6');

export function unbracketHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** BlockList applies IPv4 rules to IPv4-mapped IPv6 addresses too. */
export function isBlockedProxyHost(hostname: string): boolean {
  const host = unbracketHost(hostname);
  const family = isIP(host);
  return family !== 0 && blocked.check(host, family === 4 ? 'ipv4' : 'ipv6');
}

export class BlockedProxyTargetError extends Error {
  constructor() {
    super('This target address is blocked.');
  }
}

export interface ProxyAddress { address: string; family: number }
export type ProxyLookup = (hostname: string) => Promise<readonly ProxyAddress[]>;

const lookupAll: ProxyLookup = (hostname) => lookup(hostname, { all: true, verbatim: true });

/** Validate every answer; the transport can fall back only within this fixed set. */
export async function resolveProxyAddresses(url: URL, resolve: ProxyLookup = lookupAll): Promise<ProxyAddress[]> {
  const host = unbracketHost(url.hostname);
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await resolve(host);
  if (addresses.length === 0) throw new Error('The S3 endpoint did not resolve to an address.');
  for (const candidate of addresses) {
    if (isIP(candidate.address) === 0 || isIP(candidate.address) !== candidate.family || isBlockedProxyHost(candidate.address)) {
      throw new BlockedProxyTargetError();
    }
  }
  return addresses.map(({ address, family }) => ({ address, family }));
}
