import { afterEach, expect, test } from 'bun:test';
import type { ConnectionRow } from '../db/client';
import { profileConfig } from '../db/objects';
import { disableBridge, enableBridge, getBridgeToken } from './session';

const originalFetch = globalThis.fetch;

afterEach(() => {
  disableBridge();
  globalThis.fetch = originalFetch;
});

test('one enabled companion routes every existing and new connection', async () => {
  globalThis.fetch = (async (_input, init) => {
    expect(new Headers(init?.headers).get('x-galiot-bridge-token')).toBe('shared-token');
    return Response.json({ version: 2 });
  }) as typeof fetch;

  const first: ConnectionRow = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'First',
    protocol: 's3',
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'example-bucket',
    path_style: true,
    storage_class: null,
    custom_headers: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  expect(profileConfig(first).bridgeToken).toBeUndefined();
  await enableBridge(' shared-token ');
  expect(getBridgeToken()).toBe('shared-token');
  expect(profileConfig(first).bridgeToken).toBe('shared-token');
  expect(profileConfig({ ...first, id: '22222222-2222-4222-8222-222222222222' }).bridgeToken)
    .toBe('shared-token');

  disableBridge();
  expect(profileConfig(first).bridgeToken).toBeUndefined();
});
