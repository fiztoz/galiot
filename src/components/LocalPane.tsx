import { localFolder } from '../transfer/download';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FolderOpen,
  Folder,
  FileText,
  HardDrive,
  ChevronRight,
  ArrowLeft,
  RefreshCw,
  X,
  Loader2,
  ShieldAlert,
} from 'lucide-react';
import {
  baseName,
  entriesFromListing,
  hasWritePermission,
  isDirectoryPickerSupported,
  joinPath,
  listDirectory,
  parentPath,
  pickDirectory,
  type LocalEntry,
  type LocalRoot,
} from '../localfs/localDirectory';
import { formatBytes, formatDate } from '../lib/format';

/** Payload the remote pane drops onto us: JSON list of {key,size,name,is_dir,storage_class}. */
export interface RemoteDropItem {
  key: string;
  name: string;
  size: number;
  is_dir?: boolean;
  storage_class?: string | null;
}

export const REMOTE_OBJECT_MIME = 'application/x-galiot-objects';

/** Chromium allows File objects in the drag payload; the DOM types do not model it. */
function setFiles(transfer: DataTransfer, files: File[]): void {
  transfer.setData('Files', files as unknown as string);
}

interface LocalPaneProps {
  /** Receives the mounted directory handle when the user granted write access. */
  onDownloadToLocal: (items: RemoteDropItem[], handle: FileSystemDirectoryHandle | null) => void;
  onError: (message: string) => void;
}

export function LocalPane({ onDownloadToLocal, onError }: LocalPaneProps) {
  const supported = useMemo(() => isDirectoryPickerSupported(), []);
  const [root, setRoot] = useState<LocalRoot | null>(null);
  const [rootName, setRootName] = useState('');
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const listingInputRef = useRef<HTMLInputElement>(null);

  /** Only the newest listing may land: a slow folder must not overwrite the one navigated to next. */
  const loadSeq = useRef(0);
  const loadEntries = useCallback(
    async (nextPath: string) => {
      if (!root) return;
      const seq = ++loadSeq.current;
      const current = () => seq === loadSeq.current;
      setLoading(true);
      try {
        if (root.kind === 'listing') {
          const tree = entriesFromListing(root.files);
          setEntries(tree.get(nextPath) ?? []);
          return;
        }

        let dir = root.handle;
        for (const segment of nextPath.split('/').filter(Boolean)) {
          dir = await dir.getDirectoryHandle(segment);
        }
        const listed = await listDirectory(dir);
        if (current()) setEntries(listed);
      } catch (err) {
        if (!current()) return;
        onError(err instanceof Error ? err.message : String(err));
        setEntries([]);
      } finally {
        if (current()) setLoading(false);
      }
    },
    [root, onError],
  );

  useEffect(() => {
    if (!root) {
      setEntries([]);
      return;
    }
    void loadEntries(path);
  }, [root, path, loadEntries]);

  const mount = useCallback(async () => {
    const handle = await pickDirectory();
    if (!handle) return;
    setRoot({ kind: 'directory', handle });
    setRootName(handle.name || 'Local');
    setPath('');
    setCanWrite(await hasWritePermission(handle, true));
  }, []);

  const mountListing = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = '';
      if (files.length === 0) return;
      const first = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
      const segments = (first ?? '').split('/').filter(Boolean);
      setRoot({ kind: 'listing', files });
      setRootName(segments[0] ?? 'Local');
      setPath('');
      setCanWrite(false);
    },
    [],
  );

  const navigate = useCallback((nextPath: string) => setPath(nextPath), []);

  const openEntry = useCallback(
    async (entry: LocalEntry) => {
      if (entry.kind === 'directory') {
        if (entry.handle) {
          navigate(joinPath(path, entry.name));
          return;
        }
        // Listing mode: the folder was synthesised from relative paths.
        navigate(joinPath(path, entry.name));
        return;
      }

      // Files can be dragged onto the remote pane; double-click opens nothing
      // in-browser, so we surface the path instead.
      onError(`Local file: ${joinPath(path, entry.name)}`);
    },
    [navigate, onError, path],
  );

  const handleFileDragStart = useCallback(
    (event: React.DragEvent, entry: LocalEntry) => {
      if (entry.kind !== 'file') return;
      event.dataTransfer.effectAllowed = 'copy';

      if (entry.file) {
        // Listing mode already has the File object.
        setFiles(event.dataTransfer, [entry.file]);
        event.dataTransfer.setData('text/plain', entry.name);
        return;
      }

      // Directory mode: resolve the handle to a File so the remote pane can
      // upload it. Async, so we optimistically set a placeholder payload.
      event.dataTransfer.setData('text/plain', entry.name);
      void (async () => {
        try {
          const file = await (entry.handle as FileSystemFileHandle).getFile();
          setFiles(event.dataTransfer, [file]);
        } catch {
          // Drag payload cannot be retrofitted reliably; the drop will no-op.
        }
      })();
    },
    [],
  );

  const handleRemoteDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      setDropActive(false);
      const payload = event.dataTransfer.getData(REMOTE_OBJECT_MIME);
      if (!payload) return;
      try {
        const items = JSON.parse(payload) as RemoteDropItem[];
        const handle = root?.kind === 'directory' && canWrite ? await localFolder(root.handle, path) : null;
        if (items.length > 0) onDownloadToLocal(items, handle);
      } catch {
        onError('Could not read the dropped items.');
      }
    },
    [onDownloadToLocal, onError, root, canWrite, path],
  );

  const eject = useCallback(() => {
    setRoot(null);
    setPath('');
    setEntries([]);
    setRootName('');
  }, []);

  if (!root) {
    return (
      <aside className="w-80 flex-none border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-col">
        <div className="flex-none px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 flex items-center gap-2">
            <HardDrive size={15} className="text-zinc-500" />
            Download folder
          </h3>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Files you download land here. This is not remote storage.
          </p>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
          <FolderOpen size={30} className="text-zinc-300 dark:text-zinc-600 mb-3" />
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Choose a folder</p>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
            Downloads from the bucket can be saved here. This folder is on this computer, not in S3.
          </p>

          {supported ? (
            <button
              type="button"
              onClick={() => void mount()}
              className="mt-4 px-4 py-2 text-sm font-medium rounded-lg border border-zinc-300 text-zinc-800 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-100 dark:hover:bg-zinc-800"
            >
              Choose folder…
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => listingInputRef.current?.click()}
                className="mt-4 px-4 py-2 text-sm font-medium rounded-lg border border-zinc-300 text-zinc-800 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-100 dark:hover:bg-zinc-800"
              >
                Choose folder…
              </button>
              <p className="mt-3 text-[11px] text-amber-600 dark:text-amber-400 max-w-[15rem] leading-relaxed">
                This browser has no File System Access API, so the folder is read-only: uploads
                work, saving downloads locally does not.
              </p>
            </>
          )}

          <input
            ref={listingInputRef}
            type="file"
            multiple
            className="hidden"
            // @ts-expect-error non-standard but widely supported attribute
            webkitdirectory=""
            onChange={mountListing}
            aria-label="Choose a local folder"
          />
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={`w-80 flex-none border-r dark:bg-zinc-900 flex flex-col transition-colors ${
        dropActive
          ? 'border-teal-500 bg-teal-50/60 dark:bg-teal-950/30'
          : 'border-zinc-200 bg-white'
      }`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(REMOTE_OBJECT_MIME)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setDropActive(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDropActive(false);
      }}
      onDrop={handleRemoteDrop}
    >
      <div className="flex-none px-3 py-2 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-2">
        <HardDrive size={15} className="text-zinc-500 flex-none" />
        <span className="min-w-0">
          <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">Download folder</span>
          <span className="block text-sm font-semibold text-zinc-800 dark:text-zinc-100 truncate">{rootName}</span>
        </span>
        {root.kind === 'listing' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400">
            read-only
          </span>
        )}
        {root.kind === 'directory' && !canWrite && (
          <span
            className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400"
            title="Saving downloads into this folder needs write permission"
          >
            <ShieldAlert size={10} />
            read-only
          </span>
        )}

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => void loadEntries(path)}
          className="p-1.5 rounded text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Refresh"
          aria-label="Refresh local folder"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          type="button"
          onClick={eject}
          className="p-1.5 rounded text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Unmount folder"
          aria-label="Unmount local folder"
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex-none flex items-center gap-1 px-3 py-1.5 text-[11px] border-b border-zinc-100 dark:border-zinc-800">
        <button
          type="button"
          onClick={() => setPath('')}
          className="px-1 py-0.5 rounded font-mono text-zinc-600 dark:text-zinc-300 hover:text-teal-600"
        >
          {rootName}
        </button>
        {path
          .split('/')
          .filter(Boolean)
          .map((segment, i, all) => (
            <span key={`${segment}-${i}`} className="flex items-center">
              <ChevronRight size={11} className="text-zinc-500" />
              <button
                type="button"
                onClick={() => setPath(all.slice(0, i + 1).join('/'))}
                className="px-1 py-0.5 rounded text-zinc-600 dark:text-zinc-300 hover:text-teal-600"
              >
                {segment}
              </button>
            </span>
          ))}
        <div className="flex-1" />
        {path && (
          <button
            type="button"
            onClick={() => setPath(parentPath(path))}
            className="p-1 rounded text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200"
            title="Up one level"
            aria-label="Up one level"
          >
            <ArrowLeft size={12} />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center p-6 text-center">
            {loading ? (
              <Loader2 size={18} className="animate-spin text-zinc-500" />
            ) : (
              <>
                <FolderOpen size={22} className="text-zinc-300 dark:text-zinc-600 mb-2" />
                <p className="text-xs text-zinc-500 dark:text-zinc-400">Empty folder</p>
              </>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
            {entries.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  draggable={entry.kind === 'file'}
                  onDragStart={(event) => handleFileDragStart(event, entry)}
                  onClick={() => void openEntry(entry)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60 cursor-pointer"
                >
                  {entry.kind === 'directory' ? (
                    <Folder size={14} className="text-teal-500 flex-none" />
                  ) : (
                    <FileText size={14} className="text-zinc-500 flex-none" />
                  )}
                  <span
                    className={`truncate text-xs flex-1 ${
                      entry.kind === 'directory'
                        ? 'font-medium text-zinc-800 dark:text-zinc-100'
                        : 'text-zinc-600 dark:text-zinc-300'
                    }`}
                    title={entry.name}
                  >
                    {entry.name}
                  </span>
                  {entry.kind === 'file' && (
                    <span className="text-[10px] text-zinc-500 dark:text-zinc-400 tabular-nums flex-none">
                      {entry.size !== undefined ? formatBytes(entry.size) : ''}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex-none px-3 py-1.5 text-[10px] text-zinc-500 dark:text-zinc-400 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
        <span>
          {entries.length} item{entries.length === 1 ? '' : 's'}
        </span>
        <span>{path ? formatDate(new Date()) : baseName(rootName) === rootName ? 'root' : ''}</span>
      </div>

      {dropActive && (
        <div className="absolute inset-0 z-20 pointer-events-none flex items-center justify-center">
          <div className="text-center">
            <FolderOpen size={24} className="mx-auto text-teal-600 dark:text-teal-400" />
            <p className="mt-2 text-xs font-medium text-teal-800 dark:text-teal-200">
              Drop to save here
            </p>
          </div>
        </div>
      )}
    </aside>
  );
}
