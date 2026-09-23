import { useEffect, useState } from 'react';
import { Sailboat, Lock, Unlock, AlertTriangle } from 'lucide-react';
import { PGliteProvider } from '@electric-sql/pglite-react';
import { initDb, type AppDB } from './db/client';
import { VaultGate } from './components/VaultGate';
import { ConnectionsView } from './components/ConnectionsView';

function Splash({ label }: { label: string }) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex flex-col items-center justify-center p-6">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal-600"></div>
      <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400 font-medium">{label}</p>
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
        <p className="text-sm text-zinc-500 dark:text-zinc-400 break-words">{message}</p>
        <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-4 leading-relaxed">
          The embedded Postgres (WASM) engine could not initialize. Private-browsing modes may
          block OPFS/IndexedDB storage — try a regular window.
        </p>
      </div>
    </div>
  );
}

function Shell({ db }: { db: AppDB }) {
  const [isUnlocked, setIsUnlocked] = useState(false);

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
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 leading-tight hidden sm:block">
              The Agile Cloud Explorer
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
          {isUnlocked ? (
            <>
              <Unlock size={16} className="text-teal-500" />
              <span>Vault Unlocked</span>
            </>
          ) : (
            <>
              <Lock size={16} />
              <span>Vault Locked</span>
            </>
          )}
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <VaultGate db={db} onUnlockChange={setIsUnlocked}>
          <ConnectionsView db={db} />
        </VaultGate>
      </main>
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
  if (!db) return <Splash label="Booting Postgres WASM…" />;

  return (
    <PGliteProvider db={db}>
      <Shell db={db} />
    </PGliteProvider>
  );
}
