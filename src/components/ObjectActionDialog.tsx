import { useCallback, useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useFocusTrap } from '../lib/useFocusTrap';

interface ObjectActionDialogProps {
  title: string;
  label: string;
  initialValue: string;
  confirmLabel: string;
  hint?: string;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
}

/** One text field and one action: rename, copy-to, or new folder. */
export function ObjectActionDialog({
  title,
  label,
  initialValue,
  confirmLabel,
  hint,
  onSubmit,
  onClose,
}: ObjectActionDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trapRef = useFocusTrap<HTMLDivElement>();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      try {
        await onSubmit(value);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onSubmit, value],
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="object-action-title"
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-md"
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <h2 id="object-action-title" className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 -mr-2 rounded-lg text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>
        <form onSubmit={submit} className="p-6 space-y-4">
          <div>
            <label htmlFor="object-action-key" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              {label}
            </label>
            <input
              id="object-action-key"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={busy}
              autoFocus
              spellCheck={false}
              className="w-full px-3 py-2 font-mono text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 dark:text-zinc-100 disabled:opacity-60"
            />
            {hint && <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>}
          </div>
          {error && (
            <p role="alert" className="p-3 text-sm rounded-lg border border-red-100 dark:border-red-900/30 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 break-words">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || value.trim() === ''}
            className="w-full inline-flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-4 py-2.5 rounded-lg font-medium text-sm disabled:opacity-60"
          >
            {busy && <Loader2 size={15} className="animate-spin" />}
            {confirmLabel}
          </button>
        </form>
      </div>
    </div>
  );
}
