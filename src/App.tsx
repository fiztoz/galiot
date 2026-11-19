import { useEffect, useState } from 'react';
import { Sailboat, Lock, AlertTriangle } from 'lucide-react';
import { PGliteProvider } from '@electric-sql/pglite-react';
import { initDb, type AppDB } from './db/client';
import { VaultGate } from './components/VaultGate';
import { ConnectionsView } from './components/ConnectionsView';
import { TransferDrawer } from './components/TransferDrawer';
import { transferManager } from './transfer/manager';
import { purgeExpiredLinks } from './s3/links';
import { lockVault } from './vault/repository';

function Splash({ label }: { label: string }) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex flex-col items-center justify-center p-6">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal-600"></div>
      <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300 font-medium">{label}</p>
    </div>
  );
}

function FatalError({ message }: { message: string }) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex flex-col items-center justify-center p-6">
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-8 max-w-md w-full shadow-sm">
        <div className="w-12 h-12 rounded-full bg-red-50 dark:bg-red-950/50 flex items-center justify-center mb-4">
          <AlertTriangle size={24} className="text-red-500" />
        </div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-2">
          Galiot failed to start
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
          This browser could not open local storage, so your connections cannot be kept here. Try a regular window, not private browsing.
        </p>
        <details className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
          <summary className="cursor-pointer text-zinc-600 dark:text-zinc-300">Technical detail</summary>
          <p className="mt-2 break-words">{message}</p>
        </details>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-5 inline-flex items-center rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

function Shell({ db }: { db: AppDB }) {
  const [isUnlocked, setIsUnlocked] = useState(false);

  // Spawns the transfer worker and the worker↔worker signing channel. Transfer
  // progress is persisted, so the panel survives navigation and reloads.
  useEffect(() => {
    void transferManager.init(db);

    // A presigned URL is a bearer token, and `presigned_history.url` stores it in
    // cleartext — unlike S3 credentials, which are sealed. Expired links used to
    // survive indefinitely unless the user clicked purge in the share dialog, so
    // drop them on every boot. Best-effort: a failure here (e.g. a database from
    // before the table existed) must not block the UI.
    purgeExpiredLinks(db).catch(() => {});
  }, [db]);

  return (
    <div className="h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex flex-col font-sans">
      <header className="flex-none border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-teal-600 p-2 rounded-lg text-white">
            <Sailboat size={20} className="stroke-[2.5]" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 leading-tight">
              Galiot
            </h1>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-tight hidden sm:block">
              S3 file browser
            </p>
          </div>
        </div>
        {isUnlocked ? (
          <button
            type="button"
            onClick={() => void lockVault()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Lock size={15} />
            Lock
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400">
            <Lock size={15} />
            Locked
          </span>
        )}
      </header>

      <main className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <VaultGate db={db} onUnlockChange={setIsUnlocked}>
          <ConnectionsView db={db} />
        </VaultGate>
      </main>

      {isUnlocked && <TransferDrawer db={db} />}
    </div>
  );
}

export function App() {
  const [db, setDb] = useState<AppDB | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    initDb()
      .then((instance) => {
        if (!cancelled) setDb(instance);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <FatalError message={error} />;
  if (!db) return <Splash label="Starting Galiot…" />;

  return (
    <PGliteProvider db={db}>
      <Shell db={db} />
    </PGliteProvider>
  );
}
