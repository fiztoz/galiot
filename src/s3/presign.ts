import { AwsClient } from '../lib/aws4fetch';

export async function presignGetUrl(
  client: AwsClient,
  endpoint: string,
  bucket: string,
  key: string,
  expiresIn: number = 3600
): Promise<string> {
  const urlStr = buildUrl(endpoint, bucket, key);
  const url = new URL(urlStr);
  url.searchParams.set('X-Amz-Expires', expiresIn.toString());
  
  const req = await client.sign(url, {
    method: 'GET',
    aws: { signQuery: true }
  });
  
  return req.url;
}

export async function presignPutUrl(
  client: AwsClient,
  endpoint: string,
  bucket: string,
  key: string,
  contentType?: string,
  expiresIn: number = 3600
): Promise<string> {
  const urlStr = buildUrl(endpoint, bucket, key);
  const url = new URL(urlStr);
  url.searchParams.set('X-Amz-Expires', expiresIn.toString());
  
  const headers = new Headers();
  if (contentType) {
    headers.set('Content-Type', contentType);
  }
  
  const req = await client.sign(url, {
    method: 'PUT',
    headers,
    aws: { signQuery: true }
  });
  
  return req.url;
}

function buildUrl(endpoint: string, bucket: string, key: string): string {
  // Assuming path style for simplicity, but could be configured
  const cleanEndpoint = endpoint.replace(/\/$/, '');
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${cleanEndpoint}/${bucket}/${encodedKey}`;
}
