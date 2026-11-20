/** Validates endpoint metadata before it is stored, exported or used as a base URL. */
export function assertConnectionEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('The connection endpoint is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The endpoint must be http or https.');
  }
  if (url.username || url.password || endpoint.includes('?') || endpoint.includes('#')) {
    throw new Error('Remove credentials, query parameters and fragments from the connection endpoint.');
  }
}
