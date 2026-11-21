import { useEffect, useId, type ReactNode } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useFocusTrap } from '../lib/useFocusTrap';

interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` for destructive confirmations, `primary` for neutral ones. */
  tone?: 'danger' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * In-app replacement for `window.confirm`, matching the DeleteDialog shell:
 * focus-trapped, Escape and backdrop cancel, and Cancel focused first so a
 * stray Enter cannot approve a destructive action.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>();
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={trapRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-md"
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <h2 id={titleId} className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            {title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="p-2 -mr-2 rounded-lg text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <p id={messageId} className="flex items-start gap-2.5 text-sm text-zinc-600 dark:text-zinc-300">
            <AlertTriangle
              size={16}
              className={`flex-none mt-0.5 ${tone === 'danger' ? 'text-amber-500' : 'text-teal-500'}`}
            />
            <span className="min-w-0 break-words">{message}</span>
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              autoFocus
              onClick={onCancel}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg text-white transition-colors ${
                tone === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-teal-600 hover:bg-teal-700'
              }`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
