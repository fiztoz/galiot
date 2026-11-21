import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Loader2, Search, X } from 'lucide-react';
import type { AppDB, ConnectionRow } from '../db/client';
import type { BucketSearchResult } from '../s3/client';
import { profileConfig, listingCredentials } from '../db/objects';
import { vaultService } from '../vault/vaultService';
import { formatBytes, formatDate } from '../lib/format';
import { useFocusTrap } from '../lib/useFocusTrap';

interface BucketSearchDialogProps {
  db: AppDB;
  profile: ConnectionRow;
  initialQuery: string;
  /** Jump to the folder that contains the chosen key. */
  onNavigate: (prefix: string) => void;
  onClose: () => void;
}

function parentPrefix(key: string): string {
  const slash = key.lastIndexOf('/');
  return slash === -1 ? '' : key.slice(0, slash + 1);
}

/**
 * Searches the whole bucket on the server, not just the cached folder. The
 * walk is capped; the dialog says so when it stopped early.
 */
export function BucketSearchDialog({ db, profile, initialQuery, onNavigate, onClose }: BucketSearchDialogProps) {
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<BucketSearchResult | null>(null);
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

  const run = useCallback(async () => {
    const needle = query.trim();
    if (!needle) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const sealed = await listingCredentials(db, profile);
      const found = await vaultService.call('s3.search', {
        profile: profileConfig(profile),
        credentials: { sealed },
        query: needle,
      });
      setResult(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [db, profile, query]);

  useEffect(() => {
    if (initialQuery.trim()) void run();
    // Run once for the query the explorer handed over; later edits use the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        aria-labelledby="bucket-search-title"
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-xl max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <h2 id="bucket-search-title" className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
            <Search size={18} className="text-zinc-500" />
            Search whole bucket
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 -mr-2 rounded-lg text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Close search"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Part of a key name…"
              autoFocus
              spellCheck={false}
              className="flex-1 px-3 py-2 text-sm bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 dark:text-zinc-100"
              aria-label="Search query"
            />
            <button
              type="submit"
              disabled={busy || query.trim() === ''}
              className="inline-flex items-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 rounded-lg font-medium text-sm disabled:opacity-60"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
              Search
            </button>
          </form>

          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400 break-words">{error}</p>
          )}

          {result && (
            <>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {result.objects.length} match{result.objects.length === 1 ? '' : 'es'} in {result.scanned.toLocaleString()} keys scanned
                {result.truncated ? ' — stopped early; narrow the query for complete results' : ''}.
              </p>
              {result.objects.length === 0 ? (
                <p className="text-sm text-zinc-600 dark:text-zinc-300">Nothing in this bucket matches that name.</p>
              ) : (
                <ul className="space-y-1.5">
                  {result.objects.map((object) => (
                    <li key={object.key}>
                      <button
                        type="button"
                        onClick={() => {
                          onNavigate(parentPrefix(object.key));
                          onClose();
                        }}
                        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 hover:border-teal-500/50 text-left transition-colors"
                        title="Open the folder containing this object"
                      >
                        <FolderOpen size={13} className="flex-none text-zinc-500" />
                        <span className="min-w-0 flex-1">
                          <span className="block font-mono text-xs text-zinc-800 dark:text-zinc-100 break-all">{object.key}</span>
                          <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                            {formatBytes(object.size)} · {formatDate(object.lastModified)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
