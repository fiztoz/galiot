/**
 * Local folder access for dual-pane mode (roadmap 3.3).
 *
 * Primary path: `window.showDirectoryPicker()` (Chromium). Where that is
 * unavailable we fall back to `<input type="file" webkitdirectory>`, which
 * gives a read-only listing that can still be uploaded (see
 * docs/FEASIBILITY_AND_RISKS.md §10 for the support matrix).
 */

export interface LocalEntry {
  name: string;
  kind: 'file' | 'directory';
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  size?: number;
  modifiedAt?: number;
  /** Only populated in `webkitdirectory` listing mode, where no handle exists. */
  file?: File;
}

/** Handle flavours we can accept for a local root. */
export type LocalRoot =
  | { kind: 'directory'; handle: FileSystemDirectoryHandle }
  | { kind: 'listing'; files: File[] };

/** Permission descriptor support varies; typed loosely on purpose. */
type PermissionCapableHandle = FileSystemHandle & {
  queryPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
};

/** `showDirectoryPicker` is not in the TS DOM lib yet. */
type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
};

export function isDirectoryPickerSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function'
  );
}

/** Joins path segments with single separators, dropping empties. */
export function joinPath(...segments: string[]): string {
  return segments
    .filter((segment) => segment.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

/** Parent directory of a relative path ('' for the root). */
export function parentPath(path: string): string {
  const clean = path.replace(/\/+$/, '');
  const slash = clean.lastIndexOf('/');
  return slash === -1 ? '' : clean.slice(0, slash);
}

export function baseName(path: string): string {
  const clean = path.replace(/\/+$/, '');
  const slash = clean.lastIndexOf('/');
  return slash === -1 ? clean : clean.slice(slash + 1);
}

/**
 * Normalizes an untrusted relative path used for writes inside the mounted
 * folder. Strips leading slashes, drive letters and any `..` segment so a
 * crafted name can never escape the mounted directory.
 */
export function normalizeRelativePath(path: string): string {
  const withoutRoot = path.replace(/^([a-zA-Z]:)?[\\/]+/, '');
  return withoutRoot
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .join('/');
}

/** Resolves a relative path inside a directory handle, creating subfolders. */
export async function resolveInDirectory(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<FileSystemFileHandle> {
  const segments = normalizeRelativePath(relativePath).split('/').filter(Boolean);
  const filename = segments.pop();
  if (!filename) throw new Error('A file name is required');

  let dir = root;
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  return dir.getFileHandle(filename, { create: true });
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!isDirectoryPickerSupported()) return null;
  try {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) return null;
    return await picker({ mode: 'readwrite' });
  } catch {
    // User cancelled, or the gesture was not allowed.
    return null;
  }
}

/** Reads a directory's immediate children (no recursion). */
export async function listDirectory(handle: FileSystemDirectoryHandle): Promise<LocalEntry[]> {
  const entries: LocalEntry[] = [];

  for await (const [name, child] of (
    handle as unknown as AsyncIterable<[string, FileSystemHandle]>
  )) {
    if (child.kind === 'directory') {
      entries.push({ name, kind: 'directory', handle: child as FileSystemDirectoryHandle });
      continue;
    }

    const fileHandle = child as FileSystemFileHandle;
    let size: number | undefined;
    let modifiedAt: number | undefined;
    try {
      const file = await fileHandle.getFile();
      size = file.size;
      modifiedAt = file.lastModified;
    } catch {
      // Entry vanished between listing and stat — still show the name.
    }
    entries.push({ name, kind: 'file', handle: fileHandle, size, modifiedAt });
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  return entries;
}

export async function hasWritePermission(
  handle: FileSystemHandle,
  request = false,
): Promise<boolean> {
  const capable = handle as PermissionCapableHandle;
  if (typeof capable.queryPermission !== 'function') return false;

  try {
    let state = await capable.queryPermission({ mode: 'readwrite' });
    if (state === 'prompt' && request && typeof capable.requestPermission === 'function') {
      state = await capable.requestPermission({ mode: 'readwrite' });
    }
    return state === 'granted';
  } catch {
    return false;
  }
}

/** Derives a listing-root view from a `webkitdirectory` file input. */
export function entriesFromListing(files: File[]): Map<string, LocalEntry[]> {
  const tree = new Map<string, LocalEntry[]>();
  const listFor = (key: string): LocalEntry[] => {
    const existing = tree.get(key);
    if (existing) return existing;
    const created: LocalEntry[] = [];
    tree.set(key, created);
    return created;
  };

  for (const file of files) {
    const relative = normalizeRelativePath(
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    );
    const segments = relative.split('/').filter(Boolean);
    // The first segment is the picked folder itself — the tree is rooted
    // *inside* it, so that segment is not a child entry.
    segments.shift();
    const filename = segments.pop();
    if (!filename) continue;

    // Remaining segments are directories: register each one in its parent's
    // listing (listing mode has no real handles, so they are navigation-only).
    let current = '';
    for (const segment of segments) {
      const parent = listFor(current);
      const alreadyListed = parent.some(
        (entry) => entry.kind === 'directory' && entry.name === segment,
      );
      if (!alreadyListed) {
        parent.push({
          name: segment,
          kind: 'directory',
          handle: null as unknown as FileSystemDirectoryHandle,
        });
      }
      current = joinPath(current, segment);
      listFor(current);
    }

    listFor(current).push({
      name: filename,
      kind: 'file',
      handle: null as unknown as FileSystemFileHandle,
      size: file.size,
      modifiedAt: file.lastModified,
      file,
    });
  }

  for (const [path, list] of tree) {
    list.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    tree.set(path, list);
  }

  return tree;
}
