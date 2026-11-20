import { expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { live } from '@electric-sql/pglite/live';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGliteProvider } from '@electric-sql/pglite-react';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { AppDB, ObjectRow } from '../db/client';
import { runMigrations } from '../db/migrations';
import { ShareDialog } from './ShareDialog';

test('object sharing, stale selection and connection-wide revocation use distinct controls', async () => {
  const db = await PGlite.create({ extensions: { pg_trgm, live } });
  const window = new Window({ url: 'https://example.com' });
  const globals = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, globals);
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const id = crypto.randomUUID();
  const target = { profile_id: id, bucket: 'archive', target_identity: 'current' };
  const file = { profile_id: id, bucket: 'archive', key: 'item' } as ObjectRow;
  const render = async (object: ObjectRow | null, identity: string) => {
    await act(async () => root.render(
      <PGliteProvider db={db}><ShareDialog db={db as unknown as AppDB} target={target}
        currentIdentity={identity} file={object} onClose={() => {}} /></PGliteProvider>,
    ));
  };
  async function waitForRows(count: number) {
    for (let i = 0; i < 100 && container.querySelectorAll('li').length !== count; i++) {
      await act(async () => { await Bun.sleep(10); });
    }
    expect(container.querySelectorAll('li')).toHaveLength(count);
  }
  try {
    await runMigrations(db);
    await db.query(`INSERT INTO profiles (id, name, protocol, endpoint, region, bucket, encrypted_credentials)
      VALUES ($1, 'Test', 's3', 'https://s3.example.com', 'us-east-1', 'archive', '{}')`, [id]);
    const records = [
      { identity: 'current', key: 'item' }, { identity: 'earlier', key: 'item' },
      { identity: null, key: 'item' }, { identity: 'earlier', key: 'missing-key' },
    ];
    const urls = records.map(() => 'https://example.com/api/s3/media/' + crypto.randomUUID());
    for (const [index, record] of records.entries()) {
      await db.query(`INSERT INTO presigned_history (id, profile_id, bucket, key, target_identity, url, permission, expires_at)
        VALUES ($1, $2, 'archive', $3, $4, $5, 'read', NOW() + INTERVAL '1 hour')`,
      [crypto.randomUUID(), id, record.key, record.identity, urls[index]]);
    }

    await render(file, 'current');
    await waitForRows(1);
    expect(container.querySelector('a')?.href).toBe(urls[0]!);
    expect(container.textContent).toContain('Generate download link');

    await render(file, 'replacement');
    expect(container.querySelector('[role=alert]')?.textContent).toContain('select the object again');
    expect(container.textContent).not.toContain('Generate download link');
    expect(container.querySelector('a')).toBeNull();

    await render(null, 'current');
    await waitForRows(4);
    expect(container.textContent).toContain('archive/missing-key');
    expect(container.textContent).toContain('Unverified legacy target');
    expect(container.textContent).toContain('Earlier target');
    expect(container.querySelectorAll('button[aria-label="Revoke this link now"]')).toHaveLength(4);
    expect(container.querySelector('button[aria-label="Copy URL"], a')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    await db.close();
    await window.happyDOM.close();
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
