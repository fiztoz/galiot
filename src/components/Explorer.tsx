import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  List,
  LayoutGrid,
  Sigma,
  Upload,
  AlertTriangle,
} from 'lucide-react';
import type { AppDB, ConnectionRow, ObjectRow } from '../db/client';
import { loadListing, deleteKeys, forgetCachedFolder, harvestFolderStats, listingCredentials, planDeletion, profileConfig, type DeletionPlan } from '../db/objects';
import { DeleteDialog } from './DeleteDialog';
import { vaultService } from '../vault/vaultService';
import { classifyConnectionFailure } from '../db/connectionDiagnostics';
import {
  buildObjectQuery,
  buildSubtreeSizeQuery,
  isFilterActive,
  type BuiltQuery,
  type ObjectFilters,
} from '../db/queries';
import {
  ExplorerFilterBar,
  EMPTY_FILTER_PANEL,
  activeFilterCount,
  type FilterPanelState,
} from './ExplorerFilterBar';
import { formatBytes, formatDate } from '../lib/format';
import { localFileExists, localFolder } from '../transfer/download';
import { scheduleListingRefresh } from '../transfer/listingRefresh';
import { transferManager } from '../transfer/manager';
import { LocalPane, REMOTE_OBJECT_MIME, type RemoteDropItem } from './LocalPane';
import { hasWritePermission } from '../localfs/localDirectory';
import { FolderOpen, PanelLeftClose, Pencil, Link2, FolderPlus, FolderUp, Files, Info, PencilLine, Snowflake } from 'lucide-react';
import { collectDroppedFiles } from '../localfs/dropEntries';
import { relativeNameOf, uploadKey } from '../transfer/paths';
import { CommandPalette, type PaletteCommand } from './CommandPalette';
import { isArchiveClass } from '../s3/client';
import { underFolder } from '../transfer/paths';
import { ObjectActionDialog } from './ObjectActionDialog';
import { ObjectDetailsDialog } from './ObjectDetailsDialog';
import { BucketSearchDialog } from './BucketSearchDialog';
import { isTextualFilename, mediaKind } from '../editor/filetypes';
import { ShareDialog } from './ShareDialog';
import { SHARE_TARGET_QUERY, shareTargetParams, type ShareTarget } from '../s3/links';

/**
 * Shown when the editor chunk cannot load. After a redeploy an open tab still
 * names the previous build's hashed chunk, which the server no longer has.
 */
function EditorLoadFailed({ onClose }: { onClose: () => void }) {
  return (
    <div role="alertdialog" aria-modal="true" aria-label="Editor unavailable"
      className="fixed inset-0 z-50 bg-zinc-50 dark:bg-zinc-950 flex items-center justify-center p-6">
      <div className="max-w-sm text-center space-y-3">
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          The editor could not load. The server was probably updated since this tab opened.
        </p>
        <div className="flex justify-center gap-2">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium rounded-lg text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            Close
          </button>
          <button type="button" autoFocus onClick={() => window.location.reload()}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white">
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}

// CodeMirror and the language packages are heavy; keep them out of the
// first-load bundle and fetch them when a file is actually opened.
const EditorPanel = lazy(() =>
  import('../editor/EditorPanel').then(
    (m) => ({ default: m.EditorPanel }),
    (error: unknown) => {
      console.error('Editor chunk failed to load:', error);
      return { default: EditorLoadFailed as typeof import('../editor/EditorPanel').EditorPanel };
    },
  ),
);

interface ExplorerProps {
  db: AppDB;
  profile: ConnectionRow;
  onBack: () => void;
}

interface Crumb {
  name: string;
  path: string;
}

type ViewMode = 'list' | 'grid';
type BusyAction = 'delete' | 'download' | 'stats' | null;

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

const ROW_HEIGHT = 36;
const GRID_ROW_HEIGHT = 104;
const GRID_MIN_CELL_WIDTH = 180;
const GRID_MAX_COLUMNS = 6;

interface LassoState {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function Explorer({ db, profile, onBack }: ExplorerProps) {
  const [prefix, setPrefix] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filters, setFilters] = useState<FilterPanelState>(EMPTY_FILTER_PANEL);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  /** Keys snapshotted when Delete was pressed; the dialog confirms exactly these. */
  const [deleteSelection, setDeleteSelection] = useState<string[] | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [lasso, setLasso] = useState<LassoState | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [showLocal, setShowLocal] = useState(false);
  const [editing, setEditing] = useState<ObjectRow | null>(null);
  const [sharing, setSharing] = useState<{ file: ObjectRow | null; target: ShareTarget } | null>(null);
  const shareTarget = useLiveQuery<ShareTarget>(SHARE_TARGET_QUERY, shareTargetParams(profile))?.rows[0];
  const [details, setDetails] = useState<ObjectRow | null>(null);
  const [action, setAction] = useState<{ kind: 'rename' | 'copy' | 'folder'; row: ObjectRow | null } | null>(null);
  const [bucketSearch, setBucketSearch] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const anchorKeyRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lassoOriginRef = useRef<{ x: number; y: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const breadcrumbNavRef = useRef<HTMLElement>(null);

  // Primitive profile values — `profile` identity changes with every live
  // query refresh; depending on primitives avoids reload loops.
  const { id: profileId, bucket, endpoint, region, path_style: pathStyle } = profile;
  const profileRevision = new Date(profile.updated_at).getTime();

  useEffect(() => {
    const nav = breadcrumbNavRef.current;
    if (nav) nav.scrollLeft = nav.scrollWidth;
  }, [prefix]);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), 200);
    return () => clearTimeout(handle);
  }, [search]);

  // Network refresh of the current folder (also runs on first mount).
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    loadListing(db, profile, prefix, controller.signal)
      .catch(async (err: unknown) => {
        if (cancelled) return;
        // A raw `Failed to fetch` tells the user nothing; classify it so the
        // banner can say whether this is CORS, addressing or reachability.
        try {
          const diagnosis = await classifyConnectionFailure(profile, err);
          if (!cancelled) {
            setError(
              [diagnosis.detail, diagnosis.hint].filter(Boolean).join(' '),
            );
          }
        } catch {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, profileId, bucket, endpoint, region, pathStyle, prefix, profileRevision, reloadNonce]);

  // Track list width for the responsive grid layout.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    setContainerWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const objectFilters = useMemo<ObjectFilters>(
    () => ({
      search: debouncedSearch,
      minSize:
        filters.minSizeMb !== null && filters.minSizeMb > 0
          ? Math.round(filters.minSizeMb * 1024 * 1024)
          : null,
      modifiedAfter: filters.modifiedAfter ? `${filters.modifiedAfter}T00:00:00.000Z` : null,
      modifiedBefore: filters.modifiedBefore ? `${filters.modifiedBefore}T23:59:59.999Z` : null,
      storageClass: filters.storageClass,
    }),
    [debouncedSearch, filters],
  );

  const listSql = useMemo(
    () => buildObjectQuery({ profileId, bucket, prefix, filters: objectFilters }),
    [profileId, bucket, prefix, objectFilters],
  );
  const liveRows = useLiveQuery<ObjectRow>(listSql.query, listSql.params);
  const rows = liveRows?.rows ?? [];

  // Recursive CTE roll-up for the single selected folder (roadmap 2.4).
  // Resolved from the cache, not the filtered view, so hiding a folder with a
  // filter does not drop its stats.
  const selectedKey = selected.size === 1 ? ([...selected][0] ?? '') : '';
  const selectedRowLive = useLiveQuery<{ is_dir: boolean }>(
    `SELECT is_dir FROM objects_cache WHERE profile_id = $1 AND bucket = $2 AND key = $3`,
    [profileId, bucket, selectedKey],
  );
  const singleDirKey = selectedRowLive?.rows[0]?.is_dir ? selectedKey : '';

  const subtreeSql = useMemo<BuiltQuery>(
    () =>
      singleDirKey
        ? buildSubtreeSizeQuery({ profileId, bucket, rootKey: singleDirKey })
        : { query: 'SELECT 0::bigint AS total, 0::bigint AS file_count WHERE FALSE', params: [] },
    [profileId, bucket, singleDirKey],
  );
  const subtreeLive = useLiveQuery<{ total: number | string; file_count: number | string }>(
    subtreeSql.query,
    subtreeSql.params,
  );
  const subtreeSize = singleDirKey ? Number(subtreeLive?.rows[0]?.total ?? 0) : null;
  const subtreeFileCount = singleDirKey ? Number(subtreeLive?.rows[0]?.file_count ?? 0) : null;

  const gridColumns = Math.max(
    1,
    Math.min(GRID_MAX_COLUMNS, Math.floor(containerWidth / GRID_MIN_CELL_WIDTH) || 1),
  );
  const virtualRowCount =
    viewMode === 'grid' ? Math.ceil(rows.length / gridColumns) : rows.length;

  const virtualizer = useVirtualizer({
    count: virtualRowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (viewMode === 'grid' ? GRID_ROW_HEIGHT : ROW_HEIGHT),
    overscan: 8,
  });

  useEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, gridColumns, rows.length]);

  // Reset selection, lasso and scroll when the view context changes.
  useEffect(() => {
    setSelected(new Set());
    anchorKeyRef.current = null;
    lassoOriginRef.current = null;
    setLasso(null);
    setDeleteSelection(null);
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

  const handleDownload = useCallback(
    async (targets: ObjectRow[]) => {
      if (targets.length === 0) {
        setNotice('Select at least one file or folder to download.');
        return;
      }
      setNotice(null);
      try {
        const { files, archived } = await expandForDownload(
          targets.map((row) => ({
            key: row.key,
            size: row.size,
            name: row.filename,
            isDir: row.is_dir,
            storageClass: row.storage_class,
          })),
        );
        if (files.length === 0) {
          setNotice('Nothing to download in that selection.');
          return;
        }
        for (const file of files) {
          await transferManager.enqueueDownload(profile, file.key, file.size, { kind: 'staged' }, file.name);
        }
        setNotice(
          `Queued ${files.length} download${files.length === 1 ? '' : 's'} — progress is in the transfer panel.` +
            (archived > 0
              ? ` ${archived} archived object${archived === 1 ? '' : 's'} included; if one fails, restore it from Details first.`
              : ''),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, profileId, bucket, endpoint, region, pathStyle, profileRevision],
  );

  const handleRowDoubleClick = useCallback(
    (row: ObjectRow) => {
      if (row.is_dir) {
        navigateTo(row.key);
        return;
      }
      // Double-click opens a text file in the editor (or a media preview);
      // binaries are left to the Download action.
      if (isTextualFilename(row.filename) || mediaKind(row.filename, row.content_type)) {
        setEditing(row);
        return;
      }
      void handleDownload([row]);
    },
    [navigateTo, handleDownload],
  );

  const handleRefresh = useCallback(() => {
    setReloadNonce((n) => n + 1);
  }, []);

  /** Arrow-key selection over the visible rows; shift extends from the anchor. */
  const moveSelection = useCallback(
    (delta: number, extend: boolean) => {
      if (rows.length === 0) return;
      const current = [...selected].pop() ?? null;
      const currentIdx = current ? rows.findIndex((row) => row.key === current) : -1;
      const from = currentIdx === -1 ? (delta > 0 ? -1 : 0) : currentIdx;
      const nextIdx = Math.min(rows.length - 1, Math.max(0, from + delta));
      const nextKey = rows[nextIdx]?.key;
      if (!nextKey) return;
      if (extend) {
        const anchor = anchorKeyRef.current ?? nextKey;
        anchorKeyRef.current = anchor;
        const anchorIdx = rows.findIndex((row) => row.key === anchor);
        const [lo, hi] = anchorIdx <= nextIdx ? [anchorIdx, nextIdx] : [nextIdx, anchorIdx];
        setSelected(new Set(rows.slice(lo, hi + 1).map((row) => row.key)));
      } else {
        anchorKeyRef.current = nextKey;
        setSelected(new Set([nextKey]));
      }
      if (viewMode === 'list') virtualizer.scrollToIndex(nextIdx, { align: 'auto' });
    },
    [rows, selected, viewMode, virtualizer],
  );

  const dialogOpen = paletteOpen || action !== null || details !== null || sharing !== null || bucketSearch !== null || editing !== null ||
    deleteSelection !== null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        // Never open the palette behind another dialog (the full-screen editor
        // would hide it while its focus trap takes the keyboard).
        if (dialogOpen && !paletteOpen) return;
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (typing || dialogOpen) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveSelection(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey);
      } else if (event.key === 'Enter' && selected.size === 1) {
        const row = rows.find((candidate) => selected.has(candidate.key));
        if (row) {
          event.preventDefault();
          handleRowDoubleClick(row);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dialogOpen, paletteOpen, moveSelection, rows, selected, handleRowDoubleClick]);


  /** Rename, copy, and new folder all run inside S3, on the server. */
  const runObjectAction = useCallback(
    async (value: string) => {
      if (!action) return;
      const sealed = await listingCredentials(db, profile);
      const config = profileConfig(profile);
      const credentials = { sealed };
      if (action.kind === 'folder') {
        const name = value.trim().replace(/\/+$/, '');
        if (!name || name.includes('/')) throw new Error('A folder name cannot contain /.');
        await vaultService.call('s3.createFolder', { profile: config, credentials, key: `${prefix}${name}/` });
      } else if (action.row) {
        if (!action.row.is_dir) await assertNotLocked(action.row.key);
        let dest = value.trim();
        if (!dest) throw new Error('Enter a destination key.');
        if (action.row.is_dir && !dest.endsWith('/')) dest += '/';
        if (dest === action.row.key) throw new Error('Destination is the same as the source.');
        if (action.kind === 'rename') {
          await vaultService.call('s3.rename', { profile: config, credentials, sourceKey: action.row.key, destKey: dest });
        } else {
          await vaultService.call('s3.copy', { profile: config, credentials, sourceKey: action.row.key, destKey: dest });
        }
      }
      setAction(null);
      setSelected(new Set());
      handleRefresh();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [action, db, profileId, bucket, endpoint, region, pathStyle, prefix, profileRevision, handleRefresh],
  );

  /** Queues dropped or picked files as uploads into the current folder. */
  const enqueueFiles = useCallback(
    async (files: File[], relativePaths?: string[]) => {
      if (files.length === 0) return;
      try {
        const ids = await transferManager.enqueueUploads(profile, prefix, files, {
          relativePaths: relativePaths?.map((path) => uploadKey('', path)),
        });
        setNotice(
          `Queued ${ids.length} upload${ids.length === 1 ? '' : 's'} — progress is in the transfer panel.`,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, profileId, bucket, endpoint, region, pathStyle, prefix, profileRevision],
  );

  const handleFileInput = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = '';
      void enqueueFiles(files, files.map((file) => relativeNameOf(file)));
    },
    [enqueueFiles],
  );

  /** Providers refuse changes to locked objects; say so before trying. */
  const assertNotLocked = useCallback(
    async (key: string) => {
      const sealed = await listingCredentials(db, profile);
      const meta = await vaultService.call('s3.head', {
        profile: profileConfig(profile),
        credentials: { sealed },
        key,
      });
      if (meta.legalHold === 'ON') {
        throw new Error('This object has a legal hold; the provider will refuse changes until it is removed.');
      }
      if (meta.retainUntil && new Date(meta.retainUntil).getTime() > Date.now()) {
        throw new Error(
          `This object is under ${meta.objectLockMode ?? 'retention'} until ${new Date(meta.retainUntil).toLocaleString()}; the provider will refuse changes until then.`,
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, profileId, bucket, endpoint, region, pathStyle, profileRevision],
  );

  // Keep the cached listing fresh when a transfer lands in this bucket.
  useEffect(
    () => scheduleListingRefresh(transferManager, profileId, bucket, prefix, handleRefresh),
    [profileId, bucket, prefix, handleRefresh],
  );

  const planSelectedDeletion = useCallback(() => {
    const keys = deleteSelection ?? [];
    const sizes = new Map(rows.filter(row => !row.is_dir).map(row => [row.key, Number(row.size)]));
    return planDeletion(db, profile, keys, sizes);
    // The snapshot, not the live rows, decides what is planned.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, profile, deleteSelection]);

  const handleDelete = useCallback(async (plan: DeletionPlan) => {
    setBusyAction('delete');
    setError(null);
    try {
      const files = plan.keys.filter(key => !key.endsWith('/'));
      if (plan.folders.length === 0 && files.length === 1) await assertNotLocked(files[0] ?? '');
      const result = await deleteKeys(db, profile, plan.keys);
      // Cached subfolder rows only go once nothing under that folder failed.
      for (const folder of plan.folders) {
        if (!result.errors.some(e => e.key.startsWith(folder))) await forgetCachedFolder(db, profile, folder);
      }
      if (result.errors.length > 0) {
        setError(
          `Some keys failed to delete: ${result.errors.slice(0, 20).map((e) => `${e.key} (${e.message})`).join(', ')}` +
            (result.errors.length > 20 ? ` and ${result.errors.length - 20} more` : ''),
        );
      } else {
        setNotice(`Deleted ${result.deleted.filter(key => !key.endsWith('/')).length.toLocaleString()} object(s).`);
      }
      setSelected(new Set());
      anchorKeyRef.current = null;
      setDeleteSelection(null);
    } finally {
      setBusyAction(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, profile]);

  const handleCopyUri = useCallback(async () => {
    const uriList = [...selected].map((key) => `s3://${bucket}/${key}`).join('\n');
    try {
      await navigator.clipboard.writeText(uriList);
      setNotice(`Copied ${selected.size} S3 URI${selected.size === 1 ? '' : 's'}.`);
    } catch {
      setNotice('Clipboard unavailable in this context.');
    }
  }, [bucket, selected]);

  /** Walks the remote subtree so the roll-up becomes exact (cache-aware, capped). */
  const handleComputeFolderSize = useCallback(async () => {
    if (!singleDirKey) return;
    setBusyAction('stats');
    setError(null);
    try {
      const result = await harvestFolderStats(db, profile, singleDirKey);
      setNotice(
        result.truncated
          ? `Scanned ${result.entryCount.toLocaleString()} entries before the safety cap — the size shown is a lower bound.`
          : `Scanned ${result.entryCount.toLocaleString()} entries — exact subtree size computed.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, profileId, bucket, endpoint, region, pathStyle, singleDirKey]);

  // Lasso selection (list view): drag on empty space to rubber-band rows.
  const handleLassoStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || viewMode !== 'list') return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    lassoOriginRef.current = { x: event.clientX, y: event.clientY };
    setLasso({ left: 0, top: 0, width: 0, height: 0 });
  }, [viewMode]);

  const handleLassoMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const origin = lassoOriginRef.current;
    const el = scrollRef.current;
    if (!origin || !el) return;

    const rect = el.getBoundingClientRect();
    const left = Math.min(origin.x, event.clientX) - rect.left;
    const top = Math.min(origin.y, event.clientY) - rect.top + el.scrollTop;

    setLasso({
      left,
      top,
      width: Math.abs(event.clientX - origin.x),
      height: Math.abs(event.clientY - origin.y),
    });
  }, []);

  const handleLassoEnd = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const origin = lassoOriginRef.current;
      const el = scrollRef.current;
      lassoOriginRef.current = null;
      setLasso(null);
      if (!origin || !el) return;

      const rect = el.getBoundingClientRect();
      const top = Math.min(origin.y, event.clientY) - rect.top + el.scrollTop;
      const bottom = Math.max(origin.y, event.clientY) - rect.top + el.scrollTop;
      if (bottom <= top) return;

      const first = Math.max(0, Math.floor(top / ROW_HEIGHT));
      const last = Math.min(rows.length - 1, Math.ceil(bottom / ROW_HEIGHT) - 1);
      if (last < first) return;

      const picked = rows.slice(first, last + 1);
      if (picked.length === 0) return;

      setSelected((current) => {
        if (!(event.metaKey || event.ctrlKey)) {
          return new Set(picked.map((r) => r.key));
        }
        const next = new Set(current);
        for (const row of picked) next.add(row.key);
        return next;
      });
      anchorKeyRef.current = picked[picked.length - 1]?.key ?? null;
    },
    [rows],
  );

  const crumbs = useMemo(() => toCrumbs(prefix), [prefix]);
  const totalVisibleSize = useMemo(
    () => rows.reduce((sum, r) => (r.is_dir ? sum : sum + r.size), 0),
    [rows],
  );
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.key)), [rows, selected]);

  const paletteCommands = useMemo<PaletteCommand[]>(
    () => [
      { id: 'upload', label: 'Upload files', hint: 'into this folder', run: () => fileInputRef.current?.click() },
      { id: 'new-folder', label: 'New folder', run: () => setAction({ kind: 'folder', row: null }) },
      { id: 'search-bucket', label: 'Search whole bucket', run: () => setBucketSearch(search) },
      { id: 'refresh', label: 'Refresh listing', run: handleRefresh },
      { id: 'view', label: viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view', run: () => setViewMode(viewMode === 'list' ? 'grid' : 'list') },
      { id: 'local', label: showLocal ? 'Hide download folder' : 'Show download folder', run: () => setShowLocal((value) => !value) },
      { id: 'download', label: 'Download selection', run: () => void handleDownload(selectedRows) },
      { id: 'back', label: 'Back to buckets', run: onBack },
    ],
    [search, handleRefresh, viewMode, showLocal, handleDownload, selectedRows, onBack],
  );
  const selectedSize = selectedRows.reduce((sum, r) => (r.is_dir ? sum : sum + r.size), 0);

  /**
   * Expands folders into one entry per object, keeping relative names so a
   * folder download preserves its structure. Archived objects are counted, not
   * hidden: the notice tells the user what may need a restore.
   */
  const expandForDownload = useCallback(
    async (
      entries: { key: string; size: number; name: string; isDir: boolean; storageClass: string | null }[],
    ) => {
      const files: { key: string; size: number; name: string }[] = [];
      const directories = new Set<string>();
      let archived = 0;
      const sealed = await listingCredentials(db, profile);
      const config = profileConfig(profile);
      for (const entry of entries) {
        if (!entry.isDir) {
          if (isArchiveClass(entry.storageClass)) archived += 1;
          files.push({ key: entry.key, size: entry.size, name: entry.name });
          continue;
        }
        const tree = await vaultService.call('s3.listTree', {
          profile: config,
          credentials: { sealed },
          prefix: entry.key,
        });
        for (const object of tree.objects) {
          if (object.key.endsWith('/') && object.size === 0) {
            directories.add(underFolder(entry.name, object.key, entry.key).replace(/\/$/, ''));
            continue;
          }
          if (isArchiveClass(object.storageClass)) archived += 1;
          files.push({
            key: object.key,
            size: object.size,
            name: underFolder(entry.name, object.key, entry.key),
          });
        }
      }
      return { files, directories, archived };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, profileId, bucket, endpoint, region, pathStyle, profileRevision],
  );

  /** Payload for dragging remote objects onto the local pane. */
  const makeRemotePayload = useCallback(
    (row: ObjectRow) => {
      const group = selected.has(row.key) && selectedRows.length > 1 ? selectedRows : [row];
      return JSON.stringify(
        group.map((r) => ({
          key: r.key,
          name: lastSegment(r.key),
          size: r.size,
          is_dir: r.is_dir,
          storage_class: r.storage_class,
        })),
      );
    },
    [selected, selectedRows],
  );

  /** Saves dropped remote objects into the mounted local folder. */
  const handleDownloadToLocal = useCallback(
    async (items: RemoteDropItem[], handle: FileSystemDirectoryHandle | null) => {
      if (!handle) {
        setError('Mount a folder with write access before saving files locally.');
        return;
      }
      if (!(await hasWritePermission(handle, true))) {
        setError('Write permission was denied for the local folder.');
        return;
      }

      try {
        const { files, directories, archived } = await expandForDownload(
          items.map((item) => ({
            key: item.key,
            size: item.size,
            name: item.name,
            isDir: item.is_dir === true,
            storageClass: item.storage_class ?? null,
          })),
        );
        for (const directory of directories) await localFolder(handle, directory, true);
        const collisions = new Set<string>();
        const names = new Set<string>();
        for (const file of files) {
          if (names.has(file.name)) throw new Error(`Multiple objects have the local name ${file.name}. Download them separately.`);
          names.add(file.name);
          if (await localFileExists(handle, file.name)) collisions.add(file.name);
        }
        if (collisions.size && !window.confirm(`Replace ${collisions.size} existing file(s) in this download folder?`)) return;
        for (const file of files) {
          await transferManager.enqueueDownload(
            profile,
            file.key,
            file.size,
            { kind: 'directory', handle, filename: file.name, replace: collisions.has(file.name) },
            file.name,
          );
        }
        setNotice(
          `Saving ${files.length} file${files.length === 1 ? '' : 's'} into the local folder…` +
            (archived > 0
              ? ` ${archived} archived object${archived === 1 ? '' : 's'} included; if one fails, restore it from Details first.`
              : ''),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, profileId, bucket, endpoint, region, pathStyle, profileRevision],
  );


  const isSearching = debouncedSearch.length > 0;
  const filtersActive = isFilterActive(objectFilters);
  const showNoMatchState = !loading && rows.length === 0 && (isSearching || filtersActive);

  return (
    <>
    <div className="flex-1 min-h-0 flex">
      {showLocal && (
        <LocalPane
          onDownloadToLocal={(items, handle) => void handleDownloadToLocal(items, handle)}
          onError={(message) => setError(message)}
        />
      )}

      <div className="flex-1 min-w-0 flex flex-col">
      {/* Toolbar */}
      <div className="flex-none border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="px-3 py-1.5 flex items-center gap-2 border-b border-zinc-100 dark:border-zinc-800/70">
          <button
            type="button"
            onClick={onBack}
            className="flex-none p-2 rounded-lg text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="Back to connections"
            title="Back to connections"
          >
            <ArrowLeft size={16} />
          </button>

          <nav
            ref={breadcrumbNavRef}
            className="flex items-center gap-0.5 text-sm min-w-40 flex-1 overflow-x-auto whitespace-nowrap"
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
                <ChevronRight size={13} className="flex-none text-zinc-500 mx-0.5" />
                <button
                  type="button"
                  onClick={() => navigateTo(crumb.path)}
                  className={`px-1.5 py-1 rounded text-xs transition-colors ${
                    i === crumbs.length - 1
                      ? 'font-semibold text-teal-700 dark:text-teal-400'
                      : 'font-medium text-zinc-600 dark:text-zinc-300 hover:text-teal-700 dark:hover:text-teal-400'
                  }`}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>

          <button
            type="button"
            disabled={!shareTarget}
            onClick={() => shareTarget && setSharing({ file: null, target: shareTarget })}
            className="flex-none p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Connection link history"
            title="Connection link history"
          >
            <Link2 size={15} />
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loading}
            className="flex-none p-2 rounded-lg text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
            aria-label="Refresh listing"
            title="Refresh listing"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        <div className="px-3 py-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex flex-none items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-teal-600 bg-teal-600 text-white hover:bg-teal-700"
            title="Upload files to this folder"
          >
            <Upload size={13} />
            Upload
          </button>

          <button
            type="button"
            onClick={() => setAction({ kind: 'folder', row: null })}
            className="inline-flex flex-none items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            title="Create a folder in this prefix"
          >
            <FolderPlus size={13} />
            <span className="hidden md:inline">New folder</span>
          </button>

          <button
            type="button"
            onClick={() => folderInputRef.current?.click()}
            className="inline-flex flex-none items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            title="Upload a whole folder, keeping its structure"
          >
            <FolderUp size={13} />
            <span className="hidden md:inline">Upload folder</span>
          </button>

          <input
            ref={folderInputRef}
            type="file"
            multiple
            className="hidden"
            // @ts-expect-error non-standard but widely supported attribute
            webkitdirectory=""
            onChange={handleFileInput}
            aria-label="Select a folder to upload"
          />

          <div className="flex items-center gap-1 order-last w-full sm:order-none sm:w-auto sm:flex-none">
            <div className="relative flex-1 sm:w-56">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
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
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300"
                  aria-label="Clear search"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => setBucketSearch(search)}
              className="flex-none p-2 rounded-lg text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              title="Search the whole bucket on the server"
              aria-label="Search the whole bucket"
            >
              <Search size={15} />
            </button>
          </div>

          <ExplorerFilterBar value={filters} onChange={setFilters} />

          <button
            type="button"
            onClick={() => setShowLocal((v) => !v)}
            aria-pressed={showLocal}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
              showLocal
                ? 'border-zinc-300 bg-zinc-100 text-zinc-800 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100'
                : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
            }`}
            title="Choose a folder on this computer for downloads"
          >
            {showLocal ? <PanelLeftClose size={13} /> : <FolderOpen size={13} />}
            <span className="hidden md:inline">Download folder</span>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInput}
            aria-label="Select files to upload"
          />

          <div className="hidden sm:flex items-center rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              aria-pressed={viewMode === 'list'}
              className={`p-1.5 transition-colors ${
                viewMode === 'list'
                  ? 'bg-teal-600 text-white'
                  : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
              title="List view"
            >
              <List size={14} />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              aria-pressed={viewMode === 'grid'}
              className={`p-1.5 transition-colors ${
                viewMode === 'grid'
                  ? 'bg-teal-600 text-white'
                  : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
              title="Grid view"
            >
              <LayoutGrid size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex-none px-4 py-2.5 bg-red-50 dark:bg-red-950/40 border-b border-red-100 dark:border-red-900/40 text-sm text-red-700 dark:text-red-400 flex items-start justify-between gap-3">
          <span className="break-words">
            {error}
            <span className="block text-xs text-red-600 dark:text-red-300 mt-0.5">
              Requests go through your Galiot server. Check that it is running and can reach the endpoint.
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

      {/* Column header (list view only) */}
      {viewMode === 'list' && (
        <div className="flex-none grid grid-cols-[1fr_110px_150px] gap-2 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 select-none">
          <span>{isSearching ? 'Path' : 'Name'}</span>
          <span className="text-right">Size</span>
          <span>Modified</span>
        </div>
      )}

      {/* Virtualized body */}
      <div
        ref={scrollRef}
        className={`flex-1 min-h-0 overflow-y-auto relative ${
          viewMode === 'list' ? 'cursor-crosshair' : ''
        }`}
        onMouseDown={handleLassoStart}
        onMouseMove={handleLassoMove}
        onMouseUp={handleLassoEnd}
        onMouseLeave={handleLassoEnd}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            setDraggingFiles(true);
          }
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDraggingFiles(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDraggingFiles(false);
          void (async () => {
            const { files, truncated } = await collectDroppedFiles(event.dataTransfer);
            if (truncated) {
              setNotice('The drop was capped at 2000 files; drop the rest separately.');
            }
            await enqueueFiles(files.map((entry) => entry.file), files.map((entry) => entry.path));
          })();
        }}
      >
        {rows.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8">
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-teal-600"></div>
                <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Loading listing…</p>
              </>
            ) : error ? (
              <>
                <AlertTriangle size={28} className="text-red-500 dark:text-red-400 mb-3" />
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
                  Could not load this folder
                </p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                  Check the error above, then try again.
                </p>
                <button
                  type="button"
                  onClick={handleRefresh}
                  className="mt-3 text-xs font-medium text-teal-600 dark:text-teal-400 hover:underline"
                >
                  Try again
                </button>
              </>
            ) : showNoMatchState ? (
              <>
                <Search size={28} className="text-zinc-300 dark:text-zinc-600 mb-3" />
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
                  {isSearching
                    ? `No cached objects match “${debouncedSearch}”`
                    : 'No objects match the current filters'}
                </p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                  {isSearching
                    ? 'This search only covers objects already loaded from this folder.'
                    : 'Adjust or clear the filters to see more.'}
                </p>
                {isSearching && (
                  <button
                    type="button"
                    onClick={() => setBucketSearch(debouncedSearch)}
                    className="mt-3 text-xs font-medium text-teal-600 dark:text-teal-400 hover:underline"
                  >
                    Search the whole bucket
                  </button>
                )}
                {activeFilterCount(filters) > 0 && (
                  <button
                    type="button"
                    onClick={() => setFilters(EMPTY_FILTER_PANEL)}
                    className="mt-3 text-xs font-medium text-teal-600 dark:text-teal-400 hover:underline"
                  >
                    Clear filters
                  </button>
                )}
              </>
            ) : (
              <>
                <Folder size={28} className="text-zinc-300 dark:text-zinc-600 mb-3" />
                <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
                  This folder is empty
                </p>
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
          <div
            role="listbox"
            aria-multiselectable="true"
            aria-label="Objects in this folder"
            style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              if (viewMode === 'list') {
                const row = rows[virtualRow.index];
                if (!row) return null;
                const isSelected = selected.has(row.key);
                const isLast = virtualRow.index === rows.length - 1;

                return (
                  <div
                    key={row.key}
                    role="option"
                    aria-selected={isSelected}
                    aria-label={row.is_dir ? `${isSearching ? row.key : row.filename} (folder)` : (isSearching ? row.key : row.filename)}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'copy';
                      e.dataTransfer.setData(REMOTE_OBJECT_MIME, makeRemotePayload(row));
                    }}
                    onClick={(e) => handleRowClick(e, row, virtualRow.index)}
                    onDoubleClick={() => handleRowDoubleClick(row)}
                    className={`absolute left-0 top-0 w-full grid grid-cols-[1fr_110px_150px] gap-2 items-center px-4 cursor-default select-none transition-colors ${
                      isSelected
                        ? 'bg-teal-50 dark:bg-teal-950/40'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                    } ${isLast ? '' : 'border-b border-zinc-100 dark:border-zinc-800/60'}`}
                    style={{ height: ROW_HEIGHT, transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      {row.is_dir ? (
                        <Folder
                          size={15}
                          className={`flex-none ${isSelected ? 'text-teal-600 dark:text-teal-400' : 'text-teal-500'}`}
                        />
                      ) : (
                        <FileText size={15} className="flex-none text-zinc-500" />
                      )}
                      <span
                        className={`truncate text-[13px] ${
                          row.is_dir
                            ? 'font-medium text-zinc-800 dark:text-zinc-100'
                            : 'text-zinc-600 dark:text-zinc-300'
                        } ${isSearching ? 'font-mono text-xs' : ''}`}
                        title={isSearching ? row.key : undefined}
                      >
                        {isSearching ? row.key : row.filename}
                      </span>
                      {isArchiveClass(row.storage_class) && (
                        <Snowflake
                          size={11}
                          className="flex-none text-sky-500"
                          aria-label={`${row.storage_class} — archived`}
                        />
                      )}
                    </span>

                    <span className="text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                      {row.is_dir ? '—' : formatBytes(row.size)}
                    </span>

                    <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400 truncate">
                      {formatDate(row.last_modified)}
                    </span>
                  </div>
                );
              }

              // Grid view: a virtual row is a strip of `gridColumns` cells.
              const cells = [];
              for (let c = 0; c < gridColumns; c++) {
                const index = virtualRow.index * gridColumns + c;
                const row = rows[index];
                if (!row) continue;
                const isSelected = selected.has(row.key);

                cells.push(
                  <button
                    key={row.key}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    aria-label={row.is_dir ? `${isSearching ? row.key : row.filename} (folder)` : (isSearching ? row.key : row.filename)}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'copy';
                      e.dataTransfer.setData(REMOTE_OBJECT_MIME, makeRemotePayload(row));
                    }}
                    onClick={(e) => handleRowClick(e, row, index)}
                    onDoubleClick={() => handleRowDoubleClick(row)}
                    className={`mx-1.5 my-1.5 flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left transition-colors overflow-hidden ${
                      isSelected
                        ? 'border-teal-500 bg-teal-50 dark:bg-teal-950/40'
                        : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                    }`}
                    style={{ width: `calc(${100 / gridColumns}% - 12px)` }}
                  >
                    <span className="flex items-center gap-1.5 w-full min-w-0">
                      {row.is_dir ? (
                        <Folder size={15} className="flex-none text-teal-500" />
                      ) : (
                        <FileText size={15} className="flex-none text-zinc-500" />
                      )}
                      <span
                        className={`truncate text-xs ${
                          row.is_dir ? 'font-medium text-zinc-800 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-300'
                        }`}
                        title={isSearching ? row.key : row.filename}
                      >
                        {isSearching ? row.key : row.filename}
                      </span>
                      {isArchiveClass(row.storage_class) && (
                        <Snowflake
                          size={11}
                          className="flex-none text-sky-500"
                          aria-label={`${row.storage_class} — archived`}
                        />
                      )}
                    </span>
                    <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                      {row.is_dir ? 'Folder' : formatBytes(row.size)} ·{' '}
                      {formatDate(row.last_modified)}
                    </span>
                  </button>,
                );
              }

              return (
                <div
                  key={`grid-row-${virtualRow.index}`}
                  className="absolute left-0 top-0 w-full flex flex-wrap content-start"
                  style={{
                    height: GRID_ROW_HEIGHT,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {cells}
                </div>
              );
            })}
          </div>
        )}

        {lasso && lasso.width > 2 && lasso.height > 2 && (
          <div
            className="absolute border border-teal-500 bg-teal-500/10 pointer-events-none rounded-sm"
            style={{ left: lasso.left, top: lasso.top, width: lasso.width, height: lasso.height }}
          />
        )}

        {draggingFiles && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-teal-50/80 dark:bg-teal-950/50 border-2 border-dashed border-teal-500 pointer-events-none">
            <div className="text-center">
              <Upload size={26} className="mx-auto text-teal-600 dark:text-teal-400" />
              <p className="mt-2 text-sm font-medium text-teal-800 dark:text-teal-200">
                Drop to upload into {prefix || bucket}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Selection action bar */}
      {selected.size > 0 && (
        <div className="flex-none px-3 py-2 bg-teal-50/70 dark:bg-teal-950/30 border-t border-teal-100 dark:border-teal-900/40 flex items-center gap-2 text-xs flex-wrap sm:pr-48">
          <span className="font-medium text-teal-800 dark:text-teal-300">
            {selected.size} selected{selectedSize > 0 ? ` · ${formatBytes(selectedSize)}` : ''}
          </span>

          {singleDirKey && subtreeSize !== null && (
            <span className="inline-flex items-center gap-1.5 text-teal-700 dark:text-teal-400">
              <Sigma size={12} />
              {formatBytes(subtreeSize)} cached
              {subtreeFileCount !== null ? ` · ${subtreeFileCount} files` : ''}
            </span>
          )}

          {singleDirKey && (
            <button
              type="button"
              onClick={() => void handleComputeFolderSize()}
              disabled={busyAction !== null}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white dark:bg-zinc-900 border border-teal-200 dark:border-teal-800 text-teal-700 dark:text-teal-300 hover:bg-teal-50 dark:hover:bg-teal-900/40 font-medium transition-colors disabled:opacity-50"
              title="Walk the remote subtree for an exact size"
            >
              {busyAction === 'stats' ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <ArrowUp size={13} />
              )}
              Exact size
            </button>
          )}

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => void handleDownload(selectedRows)}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800 font-medium transition-colors disabled:opacity-50"
          >
            {busyAction === 'download' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Download size={13} />
            )}
            Download
          </button>

          {selectedRows.length === 1 && !selectedRows[0]?.is_dir && (
            <>
            <button
              type="button"
              onClick={() => selectedRows[0] && setEditing(selectedRows[0])}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white dark:bg-zinc-900 border border-teal-200 dark:border-teal-800 text-teal-700 dark:text-teal-300 hover:bg-teal-50 dark:hover:bg-teal-900/40 font-medium transition-colors"
            >
              <Pencil size={13} />
              Open
            </button>

            <button
              type="button"
              disabled={!shareTarget || shareTarget.bucket !== selectedRows[0]?.bucket}
              onClick={() => {
                const file = selectedRows[0];
                if (file && shareTarget && file.profile_id === shareTarget.profile_id && file.bucket === shareTarget.bucket) {
                  setSharing({ file, target: shareTarget });
                }
              }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white dark:bg-zinc-900 border border-teal-200 dark:border-teal-800 text-teal-700 dark:text-teal-300 hover:bg-teal-50 dark:hover:bg-teal-900/40 font-medium transition-colors"
            >
              <Link2 size={13} />
              Share
            </button>

            <button
              type="button"
              onClick={() => selectedRows[0] && setDetails(selectedRows[0])}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 font-medium transition-colors"
            >
              <Info size={13} />
              Details
            </button>
            </>
          )}

          {selectedRows.length === 1 && (
            <>
            <button
              type="button"
              onClick={() => selectedRows[0] && setAction({ kind: 'rename', row: selectedRows[0] })}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 font-medium transition-colors"
            >
              <PencilLine size={13} />
              Rename
            </button>

            <button
              type="button"
              onClick={() => selectedRows[0] && setAction({ kind: 'copy', row: selectedRows[0] })}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 font-medium transition-colors"
            >
              <Files size={13} />
              Copy to
            </button>
            </>
          )}

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
            onClick={() => setDeleteSelection([...selected])}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md font-medium transition-colors disabled:opacity-50 bg-white dark:bg-zinc-900 border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
          >
            {busyAction === 'delete' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Trash2 size={13} />
            )}
            Delete…
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

      {/* Status bar */}
      <div className="flex-none border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 pt-1.5 pb-14 sm:pb-1.5 sm:pr-48 flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>
          {rows.length} item{rows.length === 1 ? '' : 's'}
          {!isSearching && !filtersActive && rows.length > 0 ? ` · ${formatBytes(totalVisibleSize)}` : ''}
          {selected.size > 0 ? ` · ${selected.size} selected` : ''}
          {filtersActive ? ` · ${activeFilterCount(filters)} filter(s)` : ''}
          {liveRows === undefined ? ' · syncing…' : ''}
        </span>
        <span className="flex items-center gap-1.5">
          {singleDirKey && subtreeSize !== null ? (
            <>
              <Sigma size={11} className="text-teal-500" />
              {formatBytes(subtreeSize)} in {subtreeFileCount} cached file{subtreeFileCount === 1 ? '' : 's'}
            </>
          ) : viewMode === 'list' ? (
            <>
              <Check size={11} className="text-teal-500" />
              SQL-driven live view · shift/cmd-click, drag to lasso
            </>
          ) : (
            <>
              <Check size={11} className="text-teal-500" />
              SQL-driven grid view · {gridColumns} columns
            </>
          )}
        </span>
      </div>
      </div>
    </div>

    {sharing && (
      <ShareDialog db={db} target={sharing.target} file={sharing.file}
        currentIdentity={shareTarget?.target_identity} onClose={() => setSharing(null)} />
    )}

    {details && (
      <ObjectDetailsDialog db={db} profile={profile} file={details} onClose={() => setDetails(null)} />
    )}

    {paletteOpen && (
      <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
    )}

    {bucketSearch !== null && (
      <BucketSearchDialog
        db={db}
        profile={profile}
        initialQuery={bucketSearch}
        onNavigate={navigateTo}
        onClose={() => setBucketSearch(null)}
      />
    )}

      {action && (
        <ObjectActionDialog
          title={action.kind === 'rename' ? 'Rename or move' : action.kind === 'copy' ? 'Copy to' : 'New folder'}
          label={action.kind === 'folder' ? 'Folder name' : 'Destination key'}
          initialValue={action.kind === 'folder' ? '' : action.row?.key ?? ''}
          confirmLabel={action.kind === 'rename' ? 'Rename' : action.kind === 'copy' ? 'Copy' : 'Create'}
          hint={
            action.kind === 'folder'
              ? `Created under ${prefix || 'the bucket root'}.`
              : 'The copy happens inside S3. A different prefix moves the object.'
          }
          onSubmit={runObjectAction}
          onClose={() => setAction(null)}
        />
    )}

    {deleteSelection && (
      <DeleteDialog
        plan={planSelectedDeletion}
        onConfirm={handleDelete}
        onClose={() => setDeleteSelection(null)}
      />
    )}

    {editing && (
      <Suspense
        fallback={
          <div className="fixed inset-0 z-50 bg-zinc-50 dark:bg-zinc-950 flex items-center justify-center">
            <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <Loader2 size={16} className="animate-spin" />
              Loading editor…
            </div>
          </div>
        }
      >
        <EditorPanel
          db={db}
          profile={profile}
          file={editing}
          onClose={() => setEditing(null)}
          onSaved={handleRefresh}
        />
      </Suspense>
    )}
    </>
  );
}
