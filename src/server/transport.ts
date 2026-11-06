import { S3_PROXY_PATH, S3_PROXY_TARGET_HEADER, S3_PROXY_TOKEN_HEADER } from './protocol';

/**
 * Sends an already-signed request through the same-origin app server.
 * The secret key is not in this request — only the SigV4 signature.
 */
export async function fetchViaServer(
  signed: Request,
  token: string | undefined,
  body?: BodyInit | null,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = new Headers(signed.headers);
  headers.delete('host');
  headers.set(S3_PROXY_TARGET_HEADER, signed.url);
  if (token) headers.set(S3_PROXY_TOKEN_HEADER, token);

  try {
    return await fetch(S3_PROXY_PATH, {
      method: signed.method,
      headers,
      ...(body !== undefined && body !== null ? { body } : {}),
      ...(signal ? { signal } : {}),
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      'Server proxy request failed. Run Galiot with `bun run dev` or `bun run server` so signed requests can leave from the server. A static file host cannot do that.',
      { cause: error },
    );
  }
}

export function serverGate(options: { proxyToken?: string }): string | undefined {
  return options.proxyToken;
}
