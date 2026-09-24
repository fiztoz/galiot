import { AwsClient } from '../lib/aws4fetch';
import { buildS3Url } from './url';

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
  const url = buildS3Url(target, key);
  url.searchParams.set('X-Amz-Expires', expiresIn.toString());

  const headers = new Headers();
  if (contentType) {
    headers.set('Content-Type', contentType);
  }

  const req = await client.sign(url, {
    method: 'PUT',
    headers,
    aws: { signQuery: true },
  });

  return req.url;
}
