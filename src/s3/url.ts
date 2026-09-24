/**
 * Canonical S3 object URL construction.
 *
 * Shared by the main-thread S3 client and the transfer worker so that every
 * signed request uses byte-identical paths and query strings — SigV4 signs
 * the path, so even a small divergence here causes signature mismatches.
 */

export interface S3Addressing {
  endpoint: string;
  bucket: string;
  pathStyle: boolean;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * True for IPv4/IPv6 literals, where DNS-style bucket subdomains are impossible.
 *
 * This matters more than it looks: the WHATWG URL parser *silently ignores* an
 * assignment like `url.hostname = 'bucket.127.0.0.1'` because the result is not
 * a valid host. Without this check we would emit a URL that contains no bucket
 * at all, and the failure surfaces only as an opaque network error.
 */
export function isIpLiteralHost(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return IPV4.test(bare) || bare.includes(':');
}

/**
 * Whether an endpoint can use virtual-hosted addressing.
 *
 * IP literals cannot; so can any host where prefixing the bucket would not
 * stick (defensive check against silent URL-parser drops).
 */
export function canUseVirtualHosting(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }

  if (isIpLiteralHost(url.hostname)) return false;

  const probe = new URL(url);
  probe.hostname = `bucket.${url.hostname}`;
  return probe.hostname !== url.hostname;
}

/**
 * Hosts that are conventionally served over plain HTTP: loopback, `.local`
 * names, and RFC1918 / link-local private ranges. Used to pick a default
 * scheme, because assuming https for a self-hosted endpoint is a common and
 * very opaque source of "Failed to fetch".
 */
export function isLocalEndpointHost(host: string): boolean {
  const bare = host.split(':')[0] ?? host;
  if (bare === 'localhost' || bare.endsWith('.local') || bare.endsWith('.internal')) return true;
  if (bare === '::1' || bare.startsWith('[')) return bare === '::1' || bare === '[::1]';
  if (!IPV4.test(bare)) return false;

  const [a, b] = bare.split('.').map(Number);
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/**
 * Adds a scheme if missing and strips trailing slashes.
 *
 * Local endpoints default to http, not https: self-hosted MinIO and
 * LocalStack almost always serve plain HTTP, and forcing https there is a
 * silent cause of "Failed to fetch".
 */
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim();

  // An explicit scheme is matched first and its own "//" is never treated as a
  // trailing path slash — otherwise "https://" normalizes to "https:/" and
  // then to the nonsense-but-parseable "https://https:".
  const withScheme = /^(https?):\/\/(.*)$/i.exec(trimmed);
  if (withScheme) {
    return `${withScheme[1]!.toLowerCase()}://${withScheme[2]!.replace(/\/+$/, '')}`;
  }

  const endpoint = trimmed.replace(/\/+$/, '');
  const hostPart = endpoint.split('/')[0] ?? '';
  const scheme = isLocalEndpointHost(hostPart) ? 'http' : 'https';
  return `${scheme}://${endpoint}`;
}

/** Endpoint + addressing that will actually produce a usable URL. */
export function effectiveAddressing(addressing: S3Addressing): S3Addressing {
  return {
    ...addressing,
    pathStyle: addressing.pathStyle || !canUseVirtualHosting(addressing.endpoint),
  };
}

export function buildS3Url(
  addressing: S3Addressing,
  key?: string,
  queryParams?: Record<string, string>,
): URL {
  // Strip every trailing slash: URL.toString() always ends with one, which
  // would otherwise produce a double slash in the object path.
  const base = addressing.endpoint.replace(/\/+$/, '');
  const resolved = effectiveAddressing(addressing);

  let urlStr: string;
  if (resolved.pathStyle) {
    urlStr = `${base}/${encodeURIComponent(resolved.bucket)}`;
    if (key) {
      urlStr += `/${encodeKey(key)}`;
    } else {
      urlStr += '/';
    }
  } else {
    const url = new URL(addressing.endpoint);
    url.hostname = `${resolved.bucket}.${url.hostname}`;
    urlStr = url.toString().replace(/\/+$/, '');
    if (key) {
      urlStr += `/${encodeKey(key)}`;
    }
  }

  const url = new URL(urlStr);
  if (queryParams) {
    for (const [name, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(name, value);
      }
    }
  }
  return url;
}

/** Percent-encodes each path segment but keeps the separators intact. */
export function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}
