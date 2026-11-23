import { useEffect, useState, type FormEvent } from 'react';
import type { AppDB } from '../db/client';
import { prepareLockedVaultRestore, restoreLockedVaultBackup, type PendingRestore } from '../vault/export';
import { readVaultMeta, resetLockedVault, START_OVER_PHRASE } from '../vault/repository';

const FIELD = 'w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-2 text-sm';
const BUTTON = 'cursor-pointer rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';

export function VaultRecoveryPanel({ db, onBack, onRestored }: { db: AppDB; onBack: () => void; onRestored: () => void }) {
  const [generation, setGeneration] = useState<string | null>(null);
  const [step, setStep] = useState<'options' | 'restore' | 'reset'>('options');
  const [file, setFile] = useState<File | null>(null);
  const [phrase, setPhrase] = useState('');
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void readVaultMeta(db).then(meta => {
      if (!active) return;
      if (meta) setGeneration(meta.generation);
      else setError('The local vault no longer exists. Go back to continue.');
    }).catch(() => { if (active) setError('Could not read the local vault. Go back and try again.'); });
    return () => { active = false; };
  }, [db]);

  function select(next: typeof step) {
    setStep(next);
    setFile(null);
    setPending(null);
    setPhrase('');
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !generation) return;
    setBusy(true);
    setError(null);
    try {
      if (step === 'reset') {
        await resetLockedVault(db, generation, phrase);
      } else if (pending) {
        await restoreLockedVaultBackup(db, pending, pending.backup.legacy);
        onRestored();
      } else if (file && phrase) {
        setPhrase('');
        setPending(await prepareLockedVaultRestore(db, generation, file, phrase));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="vault-recovery-title">
      <h2 id="vault-recovery-title" className="text-xl font-semibold">Forgot your master password?</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-300">
        Galiot cannot retrieve your password. If you enabled a passkey, go back and try it. You can also restore an encrypted backup or start over.
      </p>
      {step === 'options' ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!generation} className={BUTTON} onClick={() => select('restore')}>Restore a backup</button>
          <button type="button" disabled={!generation} className={`${BUTTON} text-red-700 dark:text-red-400`} onClick={() => select('reset')}>Start over…</button>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={submit} aria-label={step === 'reset' ? 'Start over' : 'Restore vault backup'}>
          {step === 'reset' ? (
            <>
              <p id="vault-reset-warning" className="rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">
                This permanently removes saved connections, credentials, local transfer records and staged downloads in this browser. It does not delete or change your S3 objects.
              </p>
              <label htmlFor="vault-reset-phrase" className="block text-sm font-medium">Type {START_OVER_PHRASE} to confirm</label>
              <input id="vault-reset-phrase" aria-describedby="vault-reset-warning" autoFocus autoComplete="off" spellCheck={false} className={FIELD}
                value={phrase} disabled={busy} onChange={event => setPhrase(event.target.value)} />
              <button type="submit" disabled={busy || phrase !== START_OVER_PHRASE}
                className={`${BUTTON} border-red-700 bg-red-700 text-white hover:bg-red-800`}>
                {busy ? 'Clearing local vault…' : 'Erase local vault and start over'}
              </button>
            </>
          ) : pending ? (
            <>
              <p className="text-sm">Backup verified. Replace this browser’s vault with {pending.backup.profiles.length} saved connection(s)? Local transfer history and staged downloads will be removed.</p>
              {pending.backup.legacy && (
                <div className="space-y-2 text-sm">
                  <p>This legacy backup cannot authenticate the connection settings. Review them before continuing.</p>
                  <ul className="max-h-44 space-y-2 overflow-auto break-all">
                    {pending.backup.profiles.map((profile, index) => <li key={index} className="rounded border border-zinc-300 p-2 dark:border-zinc-700">
                      <p className="font-medium">{String(profile.name)}</p>
                      <p>{String(profile.endpoint)} · {String(profile.bucket)} · {String(profile.region)}</p>
                      <p>{profile.path_style ? 'Path-style' : 'Virtual-hosted'} · {String(profile.storage_class ?? 'Default storage class')}</p>
                      {Boolean(profile.custom_headers) && <p>Headers: {JSON.stringify(profile.custom_headers)}</p>}
                    </li>)}
                  </ul>
                </div>
              )}
              <button type="submit" disabled={busy} className={BUTTON}>{busy ? 'Restoring…' : 'Replace vault with this backup'}</button>
            </>
          ) : (
            <>
              <p className="text-sm text-zinc-600 dark:text-zinc-300">Use the master password that protected the backup when it was exported. Nothing changes until you confirm a verified backup.</p>
              <label htmlFor="vault-recovery-file" className="block text-sm font-medium">Vault backup file</label>
              <input id="vault-recovery-file" type="file" accept=".json,application/json" disabled={busy} className={FIELD}
                onChange={event => { setFile(event.target.files?.[0] ?? null); setError(null); }} />
              <label htmlFor="vault-recovery-phrase" className="block text-sm font-medium">Master password of the backup</label>
              <input id="vault-recovery-phrase" type="password" autoComplete="current-password" disabled={busy} className={FIELD}
                value={phrase} onChange={event => setPhrase(event.target.value)} />
              <button type="submit" disabled={busy || !file || !phrase} className={BUTTON}>{busy ? 'Verifying…' : 'Verify backup'}</button>
            </>
          )}
        </form>
      )}
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      <button type="button" disabled={busy} onClick={() => step === 'options' ? onBack() : select('options')}
        className="cursor-pointer text-sm font-medium text-teal-700 hover:underline dark:text-teal-400">
        {step === 'options' ? 'Back to unlock' : 'Back to recovery options'}
      </button>
    </section>
  );
}
