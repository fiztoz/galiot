import { useEffect, useMemo, useRef, useState } from 'react';
import { Command } from 'lucide-react';
import { useFocusTrap } from '../lib/useFocusTrap';

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface CommandPaletteProps {
  commands: PaletteCommand[];
  onClose: () => void;
}

/** ⌘K palette over the actions that already exist. No new surface, just reach. */
export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const trapRef = useFocusTrap<HTMLDivElement>();

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter(
      (command) =>
        command.label.toLowerCase().includes(needle) ||
        (command.hint ?? '').toLowerCase().includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((index) => Math.min(matches.length - 1, index + 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((index) => Math.max(0, index - 1));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const command = matches[active];
        if (command) {
          onClose();
          command.run();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [matches, active, onClose]);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] flex items-start justify-center pt-[15vh] p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-100 dark:border-zinc-800">
          <Command size={15} className="text-zinc-500 flex-none" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a command…"
            autoFocus
            className="flex-1 bg-transparent text-sm text-zinc-800 dark:text-zinc-100 focus:outline-none placeholder:text-zinc-500"
            aria-label="Command palette"
          />
          <kbd className="text-[10px] text-zinc-500 border border-zinc-200 dark:border-zinc-700 rounded px-1">esc</kbd>
        </div>
        <ul ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {matches.length === 0 ? (
            <li className="px-3 py-3 text-sm text-zinc-500 dark:text-zinc-400">No command matches.</li>
          ) : (
            matches.map((command, index) => (
              <li key={command.id}>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    command.run();
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors ${
                    index === active
                      ? 'bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-200'
                      : 'text-zinc-700 dark:text-zinc-200'
                  }`}
                >
                  <span>{command.label}</span>
                  {command.hint && <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{command.hint}</span>}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
