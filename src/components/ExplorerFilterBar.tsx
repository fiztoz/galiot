import { useEffect, useRef, useState } from 'react';
import { Filter, X, SlidersHorizontal } from 'lucide-react';

export interface FilterPanelState {
  /** Minimum object size in megabytes. */
  minSizeMb: number | null;
  /** YYYY-MM-DD inclusive bounds on last_modified. */
  modifiedAfter: string | null;
  modifiedBefore: string | null;
  storageClass: string | null;
}

export const EMPTY_FILTER_PANEL: FilterPanelState = {
  minSizeMb: null,
  modifiedAfter: null,
  modifiedBefore: null,
  storageClass: null,
};

const STORAGE_CLASSES = [
  'STANDARD',
  'REDUCED_REDUNDANCY',
  'STANDARD_IA',
  'ONEZONE_IA',
  'INTELLIGENT_TIERING',
  'GLACIER',
  'DEEP_ARCHIVE',
];

const INPUT_CLASS =
  'w-full px-2.5 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-teal-500 dark:text-zinc-100';
const LABEL_CLASS =
  'block text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1';

interface ExplorerFilterBarProps {
  value: FilterPanelState;
  onChange: (next: FilterPanelState) => void;
}

export function activeFilterCount(value: FilterPanelState): number {
  return [
    value.minSizeMb !== null,
    value.modifiedAfter !== null,
    value.modifiedBefore !== null,
    value.storageClass !== null,
  ].filter(Boolean).length;
}

export function ExplorerFilterBar({ value, onChange }: ExplorerFilterBarProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const count = activeFilterCount(value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const set = <K extends keyof FilterPanelState>(key: K, next: FilterPanelState[K]) => {
    onChange({ ...value, [key]: next });
  };

  return (
    <div ref={wrapperRef} className="relative flex-none">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
          count > 0
            ? 'border-teal-500/60 bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300'
            : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
        }`}
      >
        <Filter size={13} />
        Filters
        {count > 0 && (
          <span className="ml-0.5 inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-teal-600 text-[10px] font-semibold text-white">
            {count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-200">
              <SlidersHorizontal size={13} className="text-teal-500" />
              Filters
            </span>
            <div className="flex items-center gap-1">
              {count > 0 && (
                <button
                  type="button"
                  onClick={() => onChange(EMPTY_FILTER_PANEL)}
                  className="text-[11px] font-medium text-zinc-500 hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400 transition-colors"
                >
                  Clear all
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-1 rounded text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-200"
                aria-label="Close filters"
              >
                <X size={13} />
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="filter-min-size" className={LABEL_CLASS}>
              Minimum size (MB)
            </label>
            <input
              id="filter-min-size"
              type="number"
              min={0}
              step="0.1"
              className={INPUT_CLASS}
              value={value.minSizeMb ?? ''}
              onChange={(e) =>
                set('minSizeMb', e.target.value === '' ? null : Number(e.target.value))
              }
              placeholder="e.g. 10"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="filter-after" className={LABEL_CLASS}>
                Modified after
              </label>
              <input
                id="filter-after"
                type="date"
                className={INPUT_CLASS}
                value={value.modifiedAfter ?? ''}
                onChange={(e) => set('modifiedAfter', e.target.value || null)}
              />
            </div>
            <div>
              <label htmlFor="filter-before" className={LABEL_CLASS}>
                Modified before
              </label>
              <input
                id="filter-before"
                type="date"
                className={INPUT_CLASS}
                value={value.modifiedBefore ?? ''}
                onChange={(e) => set('modifiedBefore', e.target.value || null)}
              />
            </div>
          </div>

          <div>
            <label htmlFor="filter-storage-class" className={LABEL_CLASS}>
              Storage class
            </label>
            <select
              id="filter-storage-class"
              className={INPUT_CLASS}
              value={value.storageClass ?? ''}
              onChange={(e) => set('storageClass', e.target.value || null)}
            >
              <option value="">Any</option>
              {STORAGE_CLASSES.map((sc) => (
                <option key={sc} value={sc}>
                  {sc}
                </option>
              ))}
            </select>
          </div>

          <p className="text-[10px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            Filters run as SQL over cached objects. While searching, they apply to matches across
            the whole connection instead of the current folder.
          </p>
        </div>
      )}
    </div>
  );
}
