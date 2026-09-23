import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from '@electric-sql/pglite-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FileText,
  RefreshCw,
  Search,
  X,
  Download,
  Trash2,
  Copy,
  Check,
  Loader2,
  ArrowUp,
} from 'lucide-react';
import type { AppDB, ConnectionRow, ObjectRow } from '../db/client';
import { loadListing, deleteKeys, presignDownload } from '../db/objects';
import { formatBytes, formatDate, escapeLike } from '../lib/format';

interface ExplorerProps {
  db: AppDB;
  profile: ConnectionRow;
  onBack: () => void;
}

interface Crumb {
  name: string;
  path: string;
}

function toCrumbs(prefix: string): Crumb[] {
  if (!prefix) return [];
  const parts = prefix.split('/').filter(Boolean);
  let acc = '';
  return parts.map((part) => {
    acc += `${part}/`;
    return { name: part, path: acc };
  });
}

function lastSegment(key: string): string {
  const trimmed = key.endsWith('/') ? key.slice(0, -1) : key;
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

const ROW_HEIGHT = 36;

export function Explorer({ db, profile, onBack }: ExplorerProps) {
  const [prefix, setPrefix] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busyAction, setBusyAction] = useState<'delete' | 'download' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const anchorKeyRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Primitive profile values — identity of `profile` changes with every live
  // query refresh; depending on primitives avoids reload loops.
  const { id: profileId, bucket, endpoint, region, path_style: pathStyle } = profile;

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), 200);
    return () => clearTimeout(handle);
  }, [search]);

  // Network refresh of the current folder (also runs on first mount).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    loadListing(db, profile, prefix)
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, profileId, bucket, endpoint, region, pathStyle, prefix, reloadNonce]);

  // Live query: current folder when browsing, profile-wide fuzzy match when searching.
  const params = useMemo(() => {
    if (debouncedSearch) {
      return [profileId, bucket, escapeLike(debouncedSearch)];
    }
    return [profileId, bucket, prefix];
  }, [debouncedSearch, profileId, bucket, prefix]);

  const query = useMemo(() => {
    const filter = debouncedSearch
      ? `filename ILIKE '%' || $3 || '%' ESCAPE '\\'`
      : `prefix = $3`;
    return (
      `SELECT id, profile_id, bucket, key, prefix, filename, is_dir, size, etag, ` +
      `last_modified, storage_class, content_type FROM objects_cache ` +
      `WHERE profile_id = $1 AND bucket = $2 AND ${filter} ` +
      `ORDER BY is_dir DESC, filename ASC`
    );
  }, [debouncedSearch]);

  const liveRows = useLiveQuery<ObjectRow>(query, params);
  const rows = liveRows?.rows ?? [];

  // Roll-up of cached descendants for the single selected folder (roadmap 2.4).
  const singleDirKey = useMemo(() => {
    if (selected.size !== 1) return '';
    const key = [...selected][0];
    if (!key) return '';
    const row = rows.find((r) => r.key === key);
    return row?.is_dir ? key : '';
  }, [selected, rows]);

  const dirSizeLive = useLiveQuery<{ total: number | string }>(
    `SELECT COALESCE(SUM(size), 0) AS total FROM objects_cache ` +
      `WHERE profile_id = $1 AND bucket = $2 AND key LIKE $3 ESCAPE '\\' AND NOT is_dir`,
    [profileId, bucket, escapeLike(singleDirKey)],
  );
  const dirCachedSize = singleDirKey ? Number(dirSizeLive?.rows[0]?.total ?? 0) : null;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Reset selection and scroll when the view context changes.
  useEffect(() => {
    setSelected(new Set());
    anchorKeyRef.current = null;
    setConfirmDelete(false);
    setNotice(null);
  }, [prefix, debouncedSearch]);

  const navigateTo = useCallback((nextPrefix: string) => {
    setPrefix(nextPrefix);
    setSearch('');
    setDebouncedSearch('');
  }, []);

  const handleRowClick = useCallback(
    (event: React.MouseEvent, row: ObjectRow, index: number) => {
      if (event.shiftKey && anchorKeyRef.current) {
        const anchorIndex = rows.findIndex((r) => r.key === anchorKeyRef.current);
        if (anchorIndex !== -1) {
          const start = Math.min(anchorIndex, index);
          const end = Math.max(anchorIndex, index);
          setSelected(new Set(rows.slice(start, end + 1).map((r) => r.key)));
          return;
        }
      }

      if (event.metaKey || event.ctrlKey) {
        const next = new Set(selected);
        if (next.has(row.key)) {
          next.delete(row.key);
        } else {
          next.add(row.key);
        }
        anchorKeyRef.current = row.key;
        setSelected(next);
        return;
      }

      anchorKeyRef.current = row.key;
      setSelected(new Set([row.key]));
    },
    [rows, selected],
  );

  const handleRefresh = useCallback(() => {
    setReloadNonce((n) => n + 1);
  }, []);

  const handleDownload = useCallback(
    async (keys: ReadonlySet<string>) => {
      const fileKeys = [...keys].filter((k) => !k.endsWith('/'));
      if (fileKeys.length === 0) {
        setNotice('Select at least one file to download.');
        return;
      }
      setBusyAction('download');
      setNotice(null);
      try {
        for (const key of fileKeys) {
          const url = await presignDownload(db, profile, key);
          triggerDownload(url, lastSegment(key));
        }
        setNotice(`Presigned ${fileKeys.length} download${fileKeys.length === 1 ? '' : 's'} (1 h validity).`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyAction(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, profileId, bucket, endpoint, region, pathStyle],
  );

  const handleRowDoubleClick = useCallback(
    (row: ObjectRow) => {
      if (row.is_dir) {
        navigateTo(row.key);
        return;
      }
      void handleDownload(new Set([row.key]));
    },
    [navigateTo, handleDownload],
  );

  const handleDelete = useCallback(async () => {
    setBusyAction('delete');
    setError(null);
    try {
      const result = await deleteKeys(db, profile, [...selected]);
      if (result.errors.length > 0) {
        setError(`Some keys failed to delete: ${result.errors.map((e) => `${e.key} (${e.message})`).join(', ')}`);
      }
      setSelected(new Set());
      anchorKeyRef.current = null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
      setConfirmDelete(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, profileId, selected]);

  const handleCopyUri = useCallback(async () => {
    const uriList = [...selected].map((key) => `s3://${bucket}/${key}`).join('\n');
    try {
      await navigator.clipboard.writeText(uriList);
      setNotice(`Copied ${selected.size} S3 URI${selected.size === 1 ? '' : 's'}.`);
    } catch {
      setNotice('Clipboard unavailable in this context.');
    }
  }, [bucket, selected]);

  const crumbs = useMemo(() => toCrumbs(prefix), [prefix]);
  const totalVisibleSize = useMemo(
    () => rows.reduce((sum, r) => (r.is_dir ? sum : sum + r.size), 0),
    [rows],
  );
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.key)), [rows, selected]);
  const selectedSize = selectedRows.reduce((sum, r) => (r.is_dir ? sum : sum + r.size), 0);

  const isSearching = debouncedSearch.length > 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Toolbar */}
      <div className="flex-none border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="p-2 rounded-lg text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          aria-label="Back to connections"
          title="Back to connections"
        >
          <ArrowLeft size={16} />
        </button>

        <nav
          className="flex items-center gap-0.5 text-sm min-w-0 flex-1 overflow-x-auto whitespace-nowrap"
          aria-label="Folder path"
        >
          <button
            type="button"
            onClick={() => navigateTo('')}
            className={`px-1.5 py-1 rounded font-medium transition-colors ${
              prefix === ''
                ? 'text-teal-700 dark:text-teal-400'
                : 'text-zinc-600 dark:text-zinc-300 hover:text-teal-600 dark:hover:text-teal-400'
            }`}
          >
            <span className="font-mono text-xs">{bucket}</span>
          </button>
          {crumbs.map((crumb, i) => (
            <span key={crumb.path} className="flex items-center">
              <ChevronRight size={13} className="flex-none text-zinc-400 mx-0.5" />
              <button
                type="button"
                onClick={() => navigateTo(crumb.path)}
                className={`px-1.5 py-1 rounded text-xs font-medium transition-colors ${
                  i === crumbs.length - 1
                    ? 'text-teal-700 dark:text-teal-400'
                    : 'text-zinc-600 dark:text-zinc-300 hover:text-teal-600 dark:hover:text-teal-400'
                }`}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>

        <div className="relative flex-none w-44 sm:w-56">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isSearching ? 'Searching cache…' : 'Search objects…'}
            className="w-full pl-8 pr-7 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-teal-500 dark:text-zinc-100"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
              aria-label="Clear search"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={handleRefresh}
          disabled={loading}
          className="p-2 rounded-lg text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
          aria-label="Refresh listing"
          title="Refresh listing"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex-none px-4 py-2.5 bg-red-50 dark:bg-red-950/40 border-b border-red-100 dark:border-red-900/40 text-sm text-red-700 dark:text-red-400 flex items-start justify-between gap-3">
          <span className="break-words">
            {error}
            <span className="block text-xs text-red-500 dark:text-red-400/80 mt-0.5">
              Browsers require bucket CORS to allow origin {window.location.origin} with methods
              GET, HEAD, PUT, POST, DELETE.
            </span>
          </span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="flex-none p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/40"
            aria-label="Dismiss error"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Selection action bar */}
      {selected.size > 0 && (
        <div className="flex-none px-3 py-2 bg-teal-50/70 dark:bg-teal-950/30 border-b border-teal-100 dark:border-teal-900/40 flex items-center gap-2 text-xs">
          <span className="font-medium text-teal-800 dark:text-teal-300">
            {selected.size} selected{selectedSize > 0 ? ` · ${formatBytes(selectedSize)}` : ''}
            {dirCachedSize !== null ? ` · ≈${formatBytes(dirCachedSize)} cached in folder` : ''}
          </span>

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => void handleDownload(selected)}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white dark:bg-zinc-900 border border-teal-200 dark:border-teal-800 text-teal-700 dark:text-teal-300 hover:bg-teal-50 dark:hover:bg-teal-900/40 font-medium transition-colors disabled:opacity-50"
          >
            {busyAction === 'download' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            Download
          </button>

          <button
            type="button"
            onClick={() => void handleCopyUri()}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white dark:bg-zinc-900 border border-teal-200 dark:border-teal-800 text-teal-700 dark:text-teal-300 hover:bg-teal-50 dark:hover:bg-teal-900/40 font-medium transition-colors disabled:opacity-50"
          >
            <Copy size={13} />
            Copy URI
          </button>

          <button
            type="button"
            onClick={() => {
              if (confirmDelete) {
                void handleDelete();
              } else {
                setConfirmDelete(true);
              }
            }}
            disabled={busyAction !== null}
            onBlur={() => setConfirmDelete(false)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md font-medium transition-colors disabled:opacity-50 ${
              confirmDelete
                ? 'bg-red-600 hover:bg-red-700 text-white border border-red-600'
                : 'bg-white dark:bg-zinc-900 border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40'
            }`}
          >
            {busyAction === 'delete' ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            {confirmDelete ? `Delete ${selected.size}?` : 'Delete'}
          </button>

          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="p-1.5 rounded-md text-teal-700 dark:text-teal-300 hover:bg-teal-100 dark:hover:bg-teal-900/40 transition-colors"
            aria-label="Clear selection"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Notice */}
      {notice && (
        <div className="flex-none px-4 py-2 bg-teal-50/70 dark:bg-teal-950/30 border-b border-teal-100 dark:border-teal-900/40 text-xs text-teal-800 dark:text-teal-300 flex items-center justify-between gap-3">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="p-1 rounded hover:bg-teal-100 dark:hover:bg-teal-900/40"
            aria-label="Dismiss notice"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Column header */}
      <div className="flex-none grid grid-cols-[1fr_110px_150px] gap-2 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 select-none">
        <span>{isSearching ? 'Path' : 'Name'}</span>
        <span className="text-right">Size</span>
        <span>Modified</span>
      </div>

      {/* Virtualized list */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto relative">
        {rows.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8">
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-teal-600"></div>
                <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Loading listing…</p>
              </>
            ) : isSearching ? (
              <>
                <Search size={28} className="text-zinc-300 dark:text-zinc-600 mb-3" />
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">No cached objects match “{debouncedSearch}”</p>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
                  Search runs over objects already loaded — browse folders to cache more.
                </p>
              </>
            ) : (
              <>
                <Folder size={28} className="text-zinc-300 dark:text-zinc-600 mb-3" />
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">This folder is empty</p>
                <button
                  type="button"
                  onClick={handleRefresh}
                  className="mt-3 text-xs font-medium text-teal-600 dark:text-teal-400 hover:underline"
                >
                  Refresh
                </button>
              </>
            )}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;

              const isSelected = selected.has(row.key);
              const isLast = virtualRow.index === rows.length - 1;

              return (
                <div
                  key={row.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className={`absolute left-0 top-0 w-full grid grid-cols-[1fr_110px_150px] gap-2 items-center px-4 cursor-default select-none transition-colors ${
                    isSelected
                      ? 'bg-teal-50 dark:bg-teal-950/40'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                  } ${isLast ? '' : 'border-b border-zinc-100 dark:border-zinc-800/60'}`}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                  onClick={(e) => handleRowClick(e, row, virtualRow.index)}
                  onDoubleClick={() => handleRowDoubleClick(row)}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {row.is_dir ? (
                      <Folder
                        size={15}
                        className={`flex-none ${isSelected ? 'text-teal-600 dark:text-teal-400' : 'text-teal-500'}`}
                      />
                    ) : (
                      <FileText size={15} className="flex-none text-zinc-400" />
                    )}
                    <span
                      className={`truncate text-[13px] ${
                        row.is_dir
                          ? 'font-medium text-zinc-800 dark:text-zinc-150'
                          : 'text-zinc-600 dark:text-zinc-300'
                      } ${isSearching ? 'font-mono text-xs' : ''}`}
                      title={isSearching ? row.key : undefined}
                    >
                      {isSearching ? row.key : row.filename}
                    </span>
                  </span>

                  <span className="text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                    {row.is_dir ? '—' : formatBytes(row.size)}
                  </span>

                  <span className="text-xs tabular-nums text-zinc-400 dark:text-zinc-500 truncate">
                    {formatDate(row.last_modified)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex-none border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-1.5 flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>
          {rows.length} item{rows.length === 1 ? '' : 's'}
          {!isSearching && rows.length > 0 ? ` · ${formatBytes(totalVisibleSize)}` : ''}
          {selected.size > 0 ? ` · ${selected.size} selected` : ''}
          {liveRows === undefined ? ' · syncing…' : ''}
        </span>
        <span className="flex items-center gap-1.5">
          {selected.size === 1 && selectedRows[0]?.is_dir && dirCachedSize !== null ? (
            <>
              <ArrowUp size={11} className="text-teal-500" />
              folder ≈ {formatBytes(dirCachedSize)} (cached objects)
            </>
          ) : (
            <>
              <Check size={11} className="text-teal-500" />
              SQL-driven live view · double-click to open
            </>
          )}
        </span>
      </div>
    </div>
  );
}
