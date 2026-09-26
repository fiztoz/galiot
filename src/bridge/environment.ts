/**
 * Where the app is running, from the browser's point of view.
 *
 * The CORS-helper repair action is offered only for a locally served page.
 * The tab-wide companion mode supports deployed pages when
 * the user starts a companion on their own machine and allows that origin.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True for hostnames that resolve to this machine. */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');

  if (host === '' ) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  if (host.endsWith('.local')) return true;

  const match = IPV4.exec(host);
  if (match) {
    const [a, b] = [Number(match[1]), Number(match[2])];
    if (a === 127) return true; // loopback
    if (a === 0) return true; // "this host" conventions
    if (a === 10) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true; // RFC1918
  }

  return false;
}

/**
 * Whether the bridge UI should be offered at all.
 * Defaults to the current location; kept injectable for tests.
 */
export function shouldOfferBridge(hostname?: string): boolean {
  if (typeof window === 'undefined') return false;
  const host = hostname ?? window.location.hostname;
  return isLocalHostname(host);
}
