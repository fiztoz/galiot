import { BRIDGE_DEFAULT_PORT, BRIDGE_TOKEN_HEADER } from './policy';

/** Companion tokens live only in this tab's memory, never in PGlite. */
const enabled = new Map<string, string>();

export function bridgeTokenFor(profileId: string): string | undefined {
  return enabled.get(profileId);
}

export function disableBridgeFor(profileId: string): void {
  enabled.delete(profileId);
}

export function disableAllBridgeSessions(): void {
  enabled.clear();
}

export async function enableBridgeFor(profileId: string, token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Enter the token printed by bun run bridge.');

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${BRIDGE_DEFAULT_PORT}/health`, {
      headers: { [BRIDGE_TOKEN_HEADER]: trimmed },
      cache: 'no-store',
    });
  } catch {
    throw new Error('Cannot reach the local companion. Start bun run bridge, allow this page as an origin, and permit local network access if your browser asks.');
  }

  if (!response.ok) {
    throw new Error(response.status === 403
      ? 'The companion rejected this page or token. Check GALIOT_BRIDGE_ORIGINS and the printed token.'
      : `The local companion returned HTTP ${response.status}.`);
  }

  const health = await response.json() as { version?: number };
  if ((health.version ?? 0) < 2) {
    throw new Error('This companion is too old for connection routing. Start the version from this Galiot checkout.');
  }

  enabled.set(profileId, trimmed);
}
