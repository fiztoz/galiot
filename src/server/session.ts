import { S3_ACCESS_TOKEN_HEADER, S3_HEALTH_PATH, S3_PROXY_TOKEN_HEADER } from './protocol';

/** Tab memory only. The proxy token is a capability, not an S3 secret, and it is not written to the vault. */
let proxyToken: string | undefined;

export function getProxyToken(): string | undefined {
  return proxyToken;
}

export function clearProxyToken(): void {
  proxyToken = undefined;
}

export interface ProxyHealth {
  reachable: boolean;
  tokenRequired: boolean;
  tokenAccepted: boolean;
}

export async function readProxyHealth(): Promise<ProxyHealth> {
  try {
    const headers = new Headers();
    if (proxyToken) {
      headers.set(S3_ACCESS_TOKEN_HEADER, proxyToken);
      headers.set(S3_PROXY_TOKEN_HEADER, proxyToken);
    }
    const response = await fetch(S3_HEALTH_PATH, { headers, cache: 'no-store' });
    if (!response.ok) return { reachable: false, tokenRequired: false, tokenAccepted: false };
    const body = (await response.json()) as { tokenRequired?: boolean; tokenAccepted?: boolean };
    return {
      reachable: true,
      tokenRequired: body.tokenRequired === true,
      tokenAccepted: body.tokenAccepted !== false,
    };
  } catch {
    return { reachable: false, tokenRequired: false, tokenAccepted: false };
  }
}

export async function enableProxyToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Enter the access gate configured on the Galiot server.');

  const response = await fetch(S3_HEALTH_PATH, {
    headers: {
      [S3_ACCESS_TOKEN_HEADER]: trimmed,
      [S3_PROXY_TOKEN_HEADER]: trimmed,
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error('Cannot reach the Galiot server. Start it with bun run server, or use bun run dev.');
  }
  const body = (await response.json()) as { tokenRequired?: boolean; tokenAccepted?: boolean };
  if (body.tokenRequired && body.tokenAccepted === false) {
    throw new Error('The server rejected this access gate.');
  }
  proxyToken = trimmed;
}
