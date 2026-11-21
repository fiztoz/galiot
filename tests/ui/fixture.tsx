/** Browser-only test entry; never imported by the production app. */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PGlite } from '@electric-sql/pglite';
import { live } from '@electric-sql/pglite/live';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGliteProvider } from '@electric-sql/pglite-react';
import '../../src/app.css';
import { Explorer } from '../../src/components/Explorer';
import { TransferDrawer } from '../../src/components/TransferDrawer';
import { runMigrations } from '../../src/db/migrations';
import type { AppDB, ConnectionRow } from '../../src/db/client';
import { vaultService } from '../../src/vault/vaultService';
import { transferManager } from '../../src/transfer/manager';

// No worker or network effects: expose only the recorded test keys to the assertions.
const retried: string[] = [];
transferManager.resumeDownload = async (_profile, task) => {
  retried.push(task.remote_key);
  document.body.dataset.retried = JSON.stringify(retried);
};

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';

// The harness exercises real components without a vault or S3 backend: the
// vault service is replaced with canned answers, everything else is genuine.
(vaultService as unknown as { call: (method: string, params: unknown) => Promise<unknown> }).call =
  async (method: string, params: unknown) => {
    const p = params as { key?: string };
    switch (method) {
      case 's3.list':
        return {
          objects: [
            { key: 'report.pdf', lastModified: '2026-11-20T10:00:00Z', size: 1580, eTag: '"a"', storageClass: 'STANDARD' },
            { key: 'notes', lastModified: '2026-11-20T11:00:00Z', size: 24, eTag: '"b"', storageClass: 'STANDARD' },
            { key: 'blob.bin', lastModified: '2026-11-20T12:00:00Z', size: 8, eTag: '"c"', storageClass: 'STANDARD' },
            { key: 'photo.png', lastModified: '2026-11-20T13:00:00Z', size: 68, eTag: '"d"', storageClass: 'GLACIER' },
          ],
          prefixes: ['docs/'],
          isTruncated: false,
        };
      case 's3.mediaUrl':
        if (p.key === 'blob.bin') return { url: new URL('./files/blob.bin?no-inline', import.meta.url).href };
        if (p.key === 'notes') return { url: new URL('./files/notes.txt?no-inline', import.meta.url).href };
        if (p.key === 'photo.png') return { url: new URL('./files/photo.png?no-inline', import.meta.url).href };
        return { url: new URL('./files/sample.pdf?no-inline', import.meta.url).href };
      case 's3.getText':
        return { text: 'hello harness\nsecond line\n', eTag: '"strong"', conditionalPut: true, contentType: 'text/plain' };
      case 's3.revokeMedia':
        return { revoked: true };
      default:
        throw new Error(`harness: unhandled vault method ${method}`);
    }
  };

function Harness() {
  const [db, setDb] = useState<AppDB | null>(null);
  const [error, setError] = useState('');
  const [profile, setProfile] = useState<ConnectionRow | null>(null);

  useEffect(() => {
    void (async () => {
      const instance = await PGlite.create({ extensions: { pg_trgm, live } });
      await runMigrations(instance);
      await instance.query(
        `INSERT INTO profiles (id, name, protocol, endpoint, region, bucket, encrypted_credentials)
         VALUES ($1, 'Harness', 's3', 'https://s3.example.com', 'us-east-1', 'demo', '{}')`,
        [PROFILE_ID],
      );
      const { rows } = await instance.query<ConnectionRow>(
        `SELECT id, name, protocol, endpoint, region, bucket, path_style, network, storage_class, custom_headers, created_at, updated_at
           FROM profiles WHERE id = $1`,
        [PROFILE_ID],
      );
      await instance.query(
        `INSERT INTO transfer_tasks (id, profile_id, direction, remote_key, local_path, file_size, bytes_transferred, status, error_message)
         VALUES
           ('00000000-0000-4000-8000-000000000011', $1, 'download', 'gone-one.bin', '/tmp/gone-one.bin', 100, 0, 'failed', 'Network blip'),
           ('00000000-0000-4000-8000-000000000012', $1, 'download', 'gone-two.bin', '/tmp/gone-two.bin', 200, 0, 'failed', 'Network blip'),
           ('00000000-0000-4000-8000-000000000013', $1, 'download', 'done.bin', '/tmp/done.bin', 50, 50, 'completed', NULL)`,
        [PROFILE_ID],
      );
      setDb(instance as unknown as AppDB);
      setProfile(rows[0] ?? null);
    })().catch((e: unknown) => setError(e instanceof Error ? e.message : 'seed failed'));
  }, []);
  if (error) return <h1>Fixture setup failed: {error}</h1>;

  if (!db || !profile) {
    return <div className="p-8 text-sm text-zinc-500">Seeding harness database…</div>;
  }
  return (
    <PGliteProvider db={db}>
      <div className="h-screen flex flex-col bg-zinc-50 dark:bg-zinc-950">
        <Explorer db={db} profile={profile} onBack={() => {}} />
        <TransferDrawer db={db} />
      </div>
    </PGliteProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
