import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BRIDGE_TARGET_HEADER } from './transport';
import { BRIDGE_TOKEN_HEADER } from './policy';

const ORIGIN = 'https://galiot.example.com';
const TOKEN = 'test-companion-token';
const ROOT = new URL('../..', import.meta.url).pathname;

let upstream: ReturnType<typeof Bun.serve>;
let companion: ReturnType<typeof Bun.spawn>;
let bridgePort: number;
let seen: { method: string; path: string; authorization: string | null; token: string | null; body: Uint8Array }[] = [];

beforeAll(async () => {
  upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        token: request.headers.get(BRIDGE_TOKEN_HEADER),
        body: new Uint8Array(await request.arrayBuffer()),
      });
      return new Response(new Uint8Array([0, 1, 2, 255]), {
        status: 200,
        headers: { etag: '"sample"', 'content-type': 'application/octet-stream' },
      });
    },
  });

  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  if (reservation.port === undefined) throw new Error('Port reservation failed');
  bridgePort = reservation.port;
  reservation.stop(true);
  companion = Bun.spawn([process.execPath, 'scripts/bridge.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      GALIOT_BRIDGE_PORT: String(bridgePort),
      GALIOT_BRIDGE_TOKEN: TOKEN,
      GALIOT_BRIDGE_ORIGINS: ORIGIN,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/health`, {
        headers: { Origin: ORIGIN, [BRIDGE_TOKEN_HEADER]: TOKEN },
      });
      if (response.ok) return;
    } catch { /* process not listening yet */ }
    await Bun.sleep(20);
  }
  throw new Error('Companion did not start');
});

afterAll(() => {
  companion?.kill();
  upstream?.stop(true);
});

describe('local companion proxy', () => {
  test('answers browser preflight for the allowed app origin', async () => {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/proxy`, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': `authorization,${BRIDGE_TARGET_HEADER},${BRIDGE_TOKEN_HEADER}`,
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(response.headers.get('access-control-allow-private-network')).toBe('true');
    expect(response.headers.get('access-control-allow-headers')).toContain(BRIDGE_TARGET_HEADER);
  });

  test('forwards binary bodies and S3 response headers without forwarding the token', async () => {
    seen = [];
    const response = await fetch(`http://127.0.0.1:${bridgePort}/proxy`, {
      method: 'PUT',
      headers: {
        Origin: ORIGIN,
        Authorization: 'AWS4-HMAC-SHA256 Credential=TEST, SignedHeaders=host, Signature=abc',
        [BRIDGE_TARGET_HEADER]: `http://127.0.0.1:${upstream.port}/example-bucket/file`,
        [BRIDGE_TOKEN_HEADER]: TOKEN,
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      },
      body: new Uint8Array([10, 0, 255]),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"sample"');
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('PUT');
    expect(seen[0]?.path).toBe('/example-bucket/file');
    expect(seen[0]?.body).toEqual(new Uint8Array([10, 0, 255]));
    expect(seen[0]?.authorization).toContain('AWS4-HMAC-SHA256');
    expect(seen[0]?.token).toBeNull();
  });

  test('rejects an incorrect token before contacting S3', async () => {
    seen = [];
    const response = await fetch(`http://127.0.0.1:${bridgePort}/proxy`, {
      headers: {
        Origin: ORIGIN,
        Authorization: 'AWS4-HMAC-SHA256 Credential=TEST',
        [BRIDGE_TARGET_HEADER]: `http://127.0.0.1:${upstream.port}/example-bucket/`,
        [BRIDGE_TOKEN_HEADER]: 'wrong',
      },
    });
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});
