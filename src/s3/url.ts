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

export function buildS3Url(
  addressing: S3Addressing,
  key?: string,
  queryParams?: Record<string, string>,
): URL {
  // Strip every trailing slash: URL.toString() always ends with one, which
  // would otherwise produce a double slash in the object path.
  const base = addressing.endpoint.replace(/\/+$/, '');

  let urlStr: string;
  if (addressing.pathStyle) {
    urlStr = `${base}/${encodeURIComponent(addressing.bucket)}`;
    if (key) {
      urlStr += `/${encodeKey(key)}`;
    } else {
      urlStr += '/';
    }
  } else {
    const url = new URL(addressing.endpoint);
    url.hostname = `${addressing.bucket}.${url.hostname}`;
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
