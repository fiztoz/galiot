import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Trash2, X } from 'lucide-react';
import type { DeletionPlan } from '../db/objects';
import { formatBytes } from '../lib/format';
import { useFocusTrap } from '../lib/useFocusTrap';

/** Typed to delete a folder, as in the S3 console: a stray click or Enter cannot match it. */
export const FOLDER_DELETE_PHRASE = 'permanently delete';

const SAMPLE_SIZE = 8;

interface DeleteDialogProps {
  /** Expands the selection; folders are listed on the server before anything is removed. */
  plan: () => Promise<DeletionPlan>;
  onConfirm: (plan: DeletionPlan) => Promise<void>;
  onClose: () => void;
}

/**
 * Confirms a deletion after showing exactly what it removes. Files need one
 * deliberate click with Cancel focused; a folder also needs the typed phrase.
 */
export function DeleteDialog({ plan: loadPlan, onConfirm, onClose }: DeleteDialogProps) {
  const [plan, setPlan] = useState<DeletionPlan | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trapRef = useFocusTrap<HTMLDivElement>();

  useEffect(() => {
    let active = true;
    loadPlan().then(
      result => { if (active) setPlan(result); },
      err => { if (active) setError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { active = false; };
  }, [loadPlan]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const folderDelete = (plan?.folders.length ?? 0) > 0;
  const confirmed = plan !== null && (!folderDelete || typed.trim().toLowerCase() === FOLDER_DELETE_PHRASE);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!plan || !confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const shown = plan ? plan.keys.filter(key => !key.endsWith('/') || plan.folders.includes(key)).slice(0, SAMPLE_SIZE) : [];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={trapRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
        aria-describedby="delete-dialog-summary"
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-md"
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <h2 id="delete-dialog-title" className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            {folderDelete ? 'Delete folder contents' : 'Delete objects'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-2 -mr-2 rounded-lg text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={(event) => void submit(event)} className="p-6 space-y-4">
          {!plan && !error && (
            <p id="delete-dialog-summary" className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              <Loader2 size={15} className="animate-spin" />
              Counting what this would delete…
            </p>
          )}

          {plan && (
            <>
              <div
                id="delete-dialog-summary"
                className="flex gap-2.5 p-3 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 text-sm text-red-700 dark:text-red-300"
              >
                <AlertTriangle size={16} className="flex-none mt-0.5" />
                <div className="space-y-1">
                  <p className="font-medium">
                    {plan.files === 0
                      ? 'No objects found under the selection; only folder markers will be removed.'
                      : `This permanently deletes ${plan.files.toLocaleString()} object${plan.files === 1 ? '' : 's'}` +
                        (plan.bytes > 0 ? ` (${formatBytes(plan.bytes)})` : '') + '.'}
                  </p>
                  {folderDelete && (
                    <p>
                      Everything inside {plan.folders.length === 1 ? 'this folder' : `these ${plan.folders.length} folders`},
                      including subfolders, is removed. It cannot be undone.
                    </p>
                  )}
                  <p className="text-xs text-red-600/80 dark:text-red-300/80">
                    In a versioned bucket S3 keeps older versions and adds delete markers.
                  </p>
                </div>
              </div>

              <ul className="max-h-40 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
                {shown.map(key => (
                  <li key={key} className="px-3 py-1.5 font-mono text-xs text-zinc-700 dark:text-zinc-300 truncate" title={key}>
                    {key}
                  </li>
                ))}
                {plan.keys.length > shown.length && (
                  <li className="px-3 py-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                    and {(plan.keys.length - shown.length).toLocaleString()} more
                  </li>
                )}
              </ul>

              {folderDelete && (
                <div>
                  <label htmlFor="delete-dialog-phrase" className="block text-sm text-zinc-700 dark:text-zinc-300 mb-1.5">
                    To confirm, type <span className="font-mono font-medium">{FOLDER_DELETE_PHRASE}</span>
                  </label>
                  <input
                    id="delete-dialog-phrase"
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    onPaste={(event) => event.preventDefault()}
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full px-3 py-2 font-mono text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 dark:text-zinc-100 disabled:opacity-60"
                  />
                </div>
              )}
            </>
          )}

          {error && (
            <p role="alert" className="p-3 text-sm rounded-lg border border-red-100 dark:border-red-900/30 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 break-words">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              autoFocus
              onClick={onClose}
              disabled={busy}
              className="px-4 py-2 rounded-lg text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!confirmed || busy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
              {plan && plan.files > 0 ? `Delete ${plan.files.toLocaleString()} object${plan.files === 1 ? '' : 's'}` : 'Delete'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
