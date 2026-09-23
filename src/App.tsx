import { useState } from 'react';
import { Sailboat, Lock, Unlock, Plus } from 'lucide-react';
import { VaultGate } from './components/VaultGate';

export function App() {
  const [isUnlocked, setIsUnlocked] = useState(false);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex flex-col font-sans">
      <header className="flex-none border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-teal-600 p-2 rounded-lg text-white">
            <Sailboat size={20} className="stroke-[2.5]" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">Galiot</h1>
        </div>
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
          {isUnlocked ? (
            <>
              <Unlock size={16} />
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

      <main className="flex-1 overflow-auto flex flex-col">
        <VaultGate onUnlockChange={setIsUnlocked}>
          <div className="flex-1 max-w-5xl w-full mx-auto p-6 md:p-12 flex flex-col items-center justify-center text-center">
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-12 max-w-lg w-full shadow-sm">
              <div className="w-16 h-16 bg-zinc-100 dark:bg-zinc-800 rounded-full flex items-center justify-center mx-auto mb-6">
                <Sailboat size={32} className="text-zinc-400 dark:text-zinc-500" />
              </div>
              <h2 className="text-xl font-semibold mb-2">No connections yet</h2>
              <p className="text-zinc-500 dark:text-zinc-400 mb-8">
                Add an S3-compatible cloud storage connection to get started managing your buckets and objects.
              </p>
              <button 
                type="button"
                className="inline-flex items-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-5 py-2.5 rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-900"
              >
                <Plus size={18} />
                Add Connection
              </button>
            </div>
          </div>
        </VaultGate>
      </main>
    </div>
  );
}
