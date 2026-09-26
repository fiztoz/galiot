import { BRIDGE_DEFAULT_PORT, BRIDGE_TOKEN_HEADER } from './policy';

export const BRIDGE_TARGET_HEADER = 'x-galiot-bridge-target';

/** Sends a worker-signed S3 request to the local companion instead of S3. */
export async function fetchViaBridge(
  signed: Request,
  token: string,
  body?: BodyInit | null,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = new Headers(signed.headers);
  // The companion derives Host from the target URL; browsers cannot send it.
  headers.delete('host');
  headers.set(BRIDGE_TARGET_HEADER, signed.url);
  headers.set(BRIDGE_TOKEN_HEADER, token);

  try {
    return await fetch(`http://127.0.0.1:${BRIDGE_DEFAULT_PORT}/proxy`, {
      method: signed.method,
      headers,
      ...(body !== undefined && body !== null ? { body } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Local companion request failed. Check that bun run bridge is still running and this page is allowed.', { cause: error });
  }
}
