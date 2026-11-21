import { useEffect, useId } from 'react';
import { Keyboard, X } from 'lucide-react';
import { useFocusTrap } from '../lib/useFocusTrap';

interface ShortcutsDialogProps {
  onClose: () => void;
}

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Objects',
    rows: [
      ['↑ / ↓', 'Move selection'],
      ['Shift + ↑ / ↓', 'Extend selection'],
      ['Enter or double-click', 'Open file or folder'],
      ['Drag onto local pane', 'Download to the mounted folder'],
    ],
  },
  {
    title: 'Anywhere',
    rows: [
      ['⌘K / Ctrl K', 'Command palette'],
      ['?', 'This shortcuts sheet'],
      ['Esc', 'Close the top dialog or panel'],
    ],
  },
  {
    title: 'Preview & editor',
    rows: [
      ['← / →', 'Previous / next PDF page'],
      ['Esc', 'Close preview or editor (asks before discarding edits)'],
    ],
  },
];

/** GitHub-style `?` sheet: the shortcuts that actually exist, per view. */
export function ShortcutsDialog({ onClose }: ShortcutsDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>();
  const titleId = useId();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
        aria-labelledby={titleId}
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-md"
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <h2 id={titleId} className="inline-flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            <Keyboard size={16} className="text-teal-500" />
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="p-2 -mr-2 rounded-lg text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-6 space-y-5">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">
                {group.title}
              </h3>
              <dl className="space-y-1.5">
                {group.rows.map(([keys, action]) => (
                  <div key={keys} className="flex items-baseline justify-between gap-4 text-sm">
                    <dt className="flex-none">
                      <kbd className="px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
                        {keys}
                      </kbd>
                    </dt>
                    <dd className="text-right text-zinc-600 dark:text-zinc-300">{action}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
