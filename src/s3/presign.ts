import { AwsClient } from '../lib/aws4fetch.ts';
import { assertSafeObjectKey, buildS3Url } from './url.ts';

/**
 * A connection's custom headers are deliberately NOT applied here.
 *
 * A presigned URL is a bearer token meant to work for whoever receives it, and
 * the recipient has no way to add a header the signature expects. Signing one in
 * would produce a URL that fails for everyone except this browser session —
 * worse than not sending it at all, because it looks like it should work.
 *
 * The consequence is worth stating plainly: an endpoint that hard-requires a
 * custom header cannot serve presigned traffic (share links, or the image /
 * audio / video / PDF previews, which load through elements that cannot carry
 * headers). Listing, upload, download, delete and the editor keep working,
 * because those go through the signed request path.
 */
export interface PresignTarget {
  endpoint: string;
  bucket: string;
  pathStyle: boolean;
}

/** Presigned GET (download) URL. */
export async function presignGetUrl(
  client: AwsClient,
  target: PresignTarget,
  key: string,
  expiresIn: number = 3600,
): Promise<string> {
  assertSafeObjectKey(key);
  const url = buildS3Url(target, key);
  url.searchParams.set('X-Amz-Expires', expiresIn.toString());

  const req = await client.sign(url, {
    method: 'GET',
    aws: { signQuery: true },
  });

  return req.url;
}

/**
 * Presigned PUT (upload) URL. Callers must send exactly the same
 * `Content-Type` header that was signed with.
 */
export async function presignPutUrl(
  client: AwsClient,
  target: PresignTarget,
  key: string,
  contentType?: string,
  expiresIn: number = 3600,
): Promise<string> {
  assertSafeObjectKey(key);
  const url = buildS3Url(target, key);
  url.searchParams.set('X-Amz-Expires', expiresIn.toString());

  const headers = new Headers({ 'content-type': contentType || 'application/octet-stream' });

  const req = await client.sign(url, {
    method: 'PUT',
    headers,
    aws: { signQuery: true, allHeaders: true },
  });

  return req.url;
}
