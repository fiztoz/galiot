import { useRef, useState } from 'react';
import {
  Download,
  Upload,
  Lock,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  Trash2,
} from 'lucide-react';
import type { AppDB } from '../db/client';
import { downloadVaultBackup, exportVault, importVault } from '../vault/export';
import { deleteVault, lockVault } from '../vault/repository';

interface VaultSettingsProps {
  db: AppDB;
  onLocked: () => void;
  /** Called after the vault has been erased, so the shell can reset itself. */
  onDeleted?: () => void;
}

/**
 * Vault backup/restore. The export is ciphertext-only; the import passphrase is
 * verified inside the vault worker (never on the main thread).
 */
export function VaultSettings({ db, onLocked, onDeleted }: VaultSettingsProps) {
  const [busy, setBusy] = useState<'export' | 'import' | 'lock' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const run = async (action: () => Promise<string | void>) => {
    setError(null);
    setSuccess(null);
    try {
      const message = await action();
      if (message) setSuccess(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleExport = () =>
    run(async () => {
      setBusy('export');
      const blob = await exportVault(db);
      downloadVaultBackup(blob);
      return 'Backup downloaded — store it somewhere safe.';
    }).finally(() => setBusy(null));

  const handlePickImport = () => fileInputRef.current?.click();

  const handleImportFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const passphrase = window.prompt('Passphrase for this vault backup:');
    if (!passphrase) return;

    void run(async () => {
      setBusy('import');
      await importVault(db, file, passphrase);
      return 'Vault restored. Unlock it with the backup passphrase.';
    }).finally(() => setBusy(null));
  };

  const handleLock = () =>
    run(async () => {
      setBusy('lock');
      await lockVault();
      onLocked();
    }).finally(() => setBusy(null));

  const handleDeleteVault = () =>
    run(async () => {
      setBusy('lock');
      if (deletePhrase !== 'DELETE') {
        throw new Error('Type DELETE exactly to confirm.');
      }
      await deleteVault(db);
      setConfirmDelete(false);
      setDeletePhrase('');
      onDeleted?.();
    }).finally(() => setBusy(null));

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
        The backup contains only ciphertext — your passphrase is never stored. Losing both the
        browser profile and the backup means losing the stored credentials.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleExport}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
        >
          {busy === 'export' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          Export backup
        </button>

        <button
          type="button"
          onClick={handlePickImport}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
        >
          {busy === 'import' ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
          Restore backup
        </button>

        <button
          type="button"
          onClick={handleLock}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors disabled:opacity-50"
        >
          {busy === 'lock' ? <Loader2 size={13} className="animate-spin" /> : <Lock size={13} />}
          Lock vault now
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={handleImportFile}
          aria-label="Select a vault backup"
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 p-2.5 text-xs rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400">
          <AlertTriangle size={14} className="flex-none mt-0.5" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {success && (
        <div className="flex items-start gap-2 p-2.5 text-xs rounded-lg border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-400">
          {success.includes('Unlock') ? (
            <AlertTriangle size={14} className="flex-none mt-0.5" />
          ) : (
            <CheckCircle2 size={14} className="flex-none mt-0.5" />
          )}
          <span className="break-words">{success}</span>
        </div>
      )}

      <p className="flex items-start gap-2 text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
        <ShieldCheck size={13} className="flex-none mt-0.5" />
        Restoring replaces every connection and the transfer ledger in this browser.
      </p>

      <div className="pt-3 border-t border-red-100 dark:border-red-900/40">
        {!confirmDelete ? (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors disabled:opacity-50"
          >
            <Trash2 size={13} />
            Delete vault and start over
          </button>
        ) : (
          <div className="space-y-2 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50/60 dark:bg-red-950/25 p-3">
            <p className="text-xs font-medium text-red-700 dark:text-red-400">
              This permanently erases everything in this browser:
            </p>
            <ul className="text-[11px] text-red-600/90 dark:text-red-400/90 list-disc pl-4 space-y-0.5">
              <li>the vault key and every stored connection</li>
              <li>the cached object listing</li>
              <li>transfer history and generated share links</li>
            </ul>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              Backups you already exported are not affected. This cannot be undone.
            </p>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={deletePhrase}
                onChange={(e) => setDeletePhrase(e.target.value)}
                placeholder="Type DELETE to confirm"
                aria-label="Type DELETE to confirm"
                className="flex-1 px-2.5 py-1.5 text-xs bg-white dark:bg-zinc-950 border border-red-200 dark:border-red-900 rounded-lg focus:outline-none focus:ring-1 focus:ring-red-500 dark:text-zinc-100"
              />
              <button
                type="button"
                onClick={() => void handleDeleteVault()}
                disabled={busy !== null || deletePhrase !== 'DELETE'}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {busy === 'lock' ? <Loader2 size={12} className="animate-spin" /> : 'Erase everything'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmDelete(false);
                  setDeletePhrase('');
                }}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
