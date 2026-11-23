import { useEffect, useState, type FormEvent } from 'react';
import { Fingerprint } from 'lucide-react';
import type { AppDB } from '../db/client';
import { canUsePasskey, createVaultPasskey, type PasskeyIdentity } from '../vault/passkey';
import { enableVaultPasskey, readPasskeyEnrollment, removeVaultPasskey, resetMasterPasswordWithPasskey, type PasskeyEnrollment } from '../vault/passkeyRepository';
import { readVaultMeta } from '../vault/repository';

const BUTTON = 'cursor-pointer rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50';
const FIELD = 'w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950';
const ACTIONS = { idle: '', enable: 'Create passkey', test: 'Test and enable', change: 'Verify and change password', remove: 'Confirm removal' };

export function VaultPasskeySettings({ db }: { db: AppDB }) {
  const [generation, setGeneration] = useState<string | null>(null);
  const [enrolled, setEnrolled] = useState<PasskeyEnrollment | null>(null);
  const [mode, setMode] = useState<keyof typeof ACTIONS>('idle');
  const [candidate, setCandidate] = useState<PasskeyIdentity | null>(null);
  const [phrase, setPhrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const supported = canUsePasskey();
  const changing = mode === 'change';

  useEffect(() => {
    let active = true;
    void Promise.all([readVaultMeta(db), readPasskeyEnrollment(db)]).then(([meta, entry]) => {
      if (!active) return;
      setGeneration(meta?.generation ?? null);
      setEnrolled(entry);
    }).catch(() => { if (active) setError('Could not read your passkey settings.'); });
    return () => { active = false; };
  }, [db]);

  function select(next: typeof mode) {
    setMode(next);
    setCandidate(null);
    setPhrase('');
    setConfirmation('');
    setError(null);
    setNotice(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!generation || busy || !phrase) return;
    if (changing && (phrase.length < 8 || phrase !== confirmation)) {
      setError(phrase.length < 8 ? 'Use at least 8 characters.' : 'Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'enable') {
        setCandidate(await createVaultPasskey());
        setMode('test');
      } else if (mode === 'test' && candidate) {
        await enableVaultPasskey(db, generation, candidate, phrase);
        setEnrolled(await readPasskeyEnrollment(db));
        select('idle');
        setNotice('Passkey tested and enabled. Your master password still works.');
      } else if (mode === 'remove' && enrolled) {
        await removeVaultPasskey(db, enrolled, phrase);
        setEnrolled(null);
        select('idle');
        setNotice('Passkey unlock was removed from this vault. You can remove the old passkey in your device settings.');
      } else if (changing && enrolled) {
        await resetMasterPasswordWithPasskey(db, enrolled, phrase);
        select('idle');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (mode !== 'enable') {
        setPhrase('');
        setConfirmation('');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800" aria-labelledby="vault-passkey-title">
      <h3 id="vault-passkey-title" className="flex items-center gap-1.5 text-sm font-medium">
        <Fingerprint size={15} aria-hidden="true" /> Passkey unlock
      </h3>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        {enrolled ? <>Enabled for this vault. You can still use your master password.</> :
          <>Optional. Use a compatible system passkey, such as Touch ID or Windows Hello, to unlock this vault.</>}
      </p>
      {!supported && <p className="text-xs text-zinc-600 dark:text-zinc-400">Passkeys require a compatible browser and HTTPS or localhost.</p>}
      {mode === 'idle' ? (
        <div className="flex flex-wrap gap-2">
          {enrolled ? <>
            <button type="button" className={BUTTON} disabled={!supported} onClick={() => select('change')}>Set a new master password with passkey</button>
            <button type="button" className={BUTTON} onClick={() => select('remove')}>Remove passkey unlock</button>
          </> : <button type="button" className={BUTTON} disabled={!generation || !supported} onClick={() => select('enable')}>Enable passkey unlock</button>}
        </div>
      ) : (
        <form onSubmit={submit} aria-label="Manage vault passkey" className="space-y-2">
          {mode === 'test' && <p className="text-xs">Test the passkey before enabling it. If your provider cannot unlock encrypted data, nothing changes.</p>}
          {changing && <p className="text-xs">You’ll confirm with your passkey. This signs all tabs out of the vault. Older backups still use their original password.</p>}
          <label htmlFor="vault-passkey-phrase" className="block text-xs font-medium">{changing ? 'New' : 'Current'} master password</label>
          <input id="vault-passkey-phrase" autoFocus type="password" autoComplete={`${changing ? 'new' : 'current'}-password`}
            disabled={busy} value={phrase} onChange={event => setPhrase(event.target.value)} className={FIELD} />
          {changing && <>
            <label htmlFor="vault-passkey-confirm" className="block text-xs font-medium">Confirm new master password</label>
            <input id="vault-passkey-confirm" type="password" autoComplete="new-password" disabled={busy}
              value={confirmation} onChange={event => setConfirmation(event.target.value)} className={FIELD} />
          </>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || !phrase || (changing && !confirmation)} className={BUTTON}>
              {busy ? 'Waiting…' : ACTIONS[mode]}
            </button>
            <button type="button" disabled={busy} className={BUTTON} onClick={() => select('idle')}>Cancel</button>
          </div>
        </form>
      )}
      {notice && <p role="status" className="text-xs text-teal-700 dark:text-teal-400">{notice}</p>}
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
    </section>
  );
}
