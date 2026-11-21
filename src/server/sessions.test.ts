import { expect, test } from 'bun:test';
import { SessionStore, type SessionMaterial } from './sessions';

const MATERIAL: SessionMaterial = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'archive',
  pathStyle: true,
  headers: {},
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret-example',
};

test('session-bound preview grants die with the session; share grants outlive it', () => {
  const store = new SessionStore(() => 1_000_000);
  const session = store.create(MATERIAL);
  const preview = store.mintMedia(session, 'object', { bound: true });
  const share = store.mintMedia(session, 'object');
  expect(preview).not.toBeNull();
  expect(share).not.toBeNull();
  expect(store.useMedia(preview!)).not.toBeNull();

  store.destroy(session);
  expect(store.useMedia(preview!)).toBeNull();
  expect(store.useMedia(share!)).not.toBeNull();
});

test('a session can revoke only its own bound grants', () => {
  const store = new SessionStore(() => 1_000_000);
  const owner = store.create(MATERIAL);
  const other = store.create(MATERIAL);
  const bound = store.mintMedia(owner, 'object', { bound: true })!;
  const share = store.mintMedia(owner, 'object')!;

  expect(store.revokeMediaForSession(other, bound)).toBe(false);
  expect(store.useMedia(bound)).not.toBeNull();
  expect(store.revokeMediaForSession(owner, share)).toBe(false);
  expect(store.useMedia(share)).not.toBeNull();
  expect(store.revokeMediaForSession(owner, bound)).toBe(true);
  expect(store.useMedia(bound)).toBeNull();
  expect(store.revokeMediaForSession(owner, bound)).toBe(false);
});
