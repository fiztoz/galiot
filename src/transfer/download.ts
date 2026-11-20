import { sha256Hex } from '../lib/hash';
import { sessionCacheKey } from './session';
import { STAGING_DIR } from './checkpoint';
import type { DownloadDestination, DownloadJob } from './protocol';

function segments(path: string): string[] {
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error('The object name cannot be represented safely in this folder.');
  }
  return parts;
}

export async function localFolder(root: FileSystemDirectoryHandle, path: string, create = false) {
  let dir = root;
  for (const segment of path ? segments(path) : []) {
    dir = await dir.getDirectoryHandle(segment, { create });
  }
  return dir;
}

async function destinationParent(root: FileSystemDirectoryHandle, path: string, create: boolean) {
  const parts = segments(path);
  const name = parts.pop()!;
  const dir = await localFolder(root, parts.join('/'), create);
  return { dir, name };
}

export async function localFileExists(root: FileSystemDirectoryHandle, path: string) {
  try {
    const { dir, name } = await destinationParent(root, path, false);
    await dir.getFileHandle(name);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return false;
    throw error;
  }
}

export async function publishLocal(file: File, destination: Extract<DownloadDestination, { kind: 'directory' }>, signal: AbortSignal) {
  const publish = async () => publishToDirectory(file, destination, signal);
  const locks = globalThis.navigator?.locks;
  if (locks) {
    await locks.request('galiot-local-download-publication', { signal }, publish);
  } else {
    await publish();
  }
}

async function publishToDirectory(file: File, destination: Extract<DownloadDestination, { kind: 'directory' }>, signal: AbortSignal) {
  const existed = await localFileExists(destination.handle, destination.filename);
  if (!destination.replace && existed) {
    throw new Error('A file already exists at the download destination. Select it again to confirm replacement.');
  }
  signal.throwIfAborted();
  const { dir, name } = await destinationParent(destination.handle, destination.filename, true);
  const handle = await dir.getFileHandle(name, { create: true });
  const initial = existed ? undefined : await handle.getFile();
  try {
    const output = await handle.createWritable();
    await file.stream().pipeTo(output, { signal });
  } catch (error) {
    // A failed first publication may leave a zero-byte directory entry. Remove
    // only our untouched placeholder so a resumed task can publish normally.
    if (initial?.size === 0) {
      const current = await dir.getFileHandle(name);
      const fileNow = await current.getFile();
      if (fileNow.size === 0 && fileNow.lastModified === initial.lastModified && await current.isSameEntry(handle)) {
        await dir.removeEntry(name);
      }
    }
    throw error;
  }
}

function assertRawEncoding(headers: Headers) {
  const encoding = headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') {
    throw new Error('The server did not return raw object bytes. Update the Galiot server and retry the download.');
  }
}

type RequestObject = (method: 'HEAD' | 'GET', headers?: Record<string, string>) => Promise<Response>;

/** The mounted destination is opened only after the staged object has been verified. */
export async function downloadFile(
  job: DownloadJob, request: RequestObject, signal: AbortSignal,
  progress: (bytes: number) => void, paused: () => boolean, storage = globalThis.navigator?.storage,
): Promise<File> {
  const head = await request('HEAD');
  // Some gateways allow GET but disable HEAD. A full GET still works, with
  // checkpoint reuse disabled when a current revision cannot be established.
  if (!head.ok && ![403, 405, 501].includes(head.status)) {
    throw new Error(`Download metadata failed: HTTP ${head.status}`);
  }
  const metadata = head.ok ? head.headers : new Headers();
  assertRawEncoding(metadata);
  const etag = metadata.get('etag');
  const version = metadata.get('x-amz-version-id');
  const stableTag = etag && !etag.startsWith('W/') ? etag : null;
  const stableVersion = version && version !== 'null' ? version : null;
  const length = metadata.get('content-length');
  let size = length !== null && /^\d+$/.test(length) ? Number(length) : job.expectedSize;
  if (!storage?.getDirectory) throw new Error('Browser download staging is unavailable.');
  const root = await storage.getDirectory();
  const staging = await root.getDirectoryHandle(STAGING_DIR, { create: true });
  const dir = await staging.getDirectoryHandle(`task-${job.taskId}`, { create: true });
  const target = sessionCacheKey({ ...job.target, profileId: job.profileId, credentials: job.credentials });
  const identity = await sha256Hex(JSON.stringify([target, job.key, stableTag, stableVersion, size]));
  const handle = await dir.getFileHandle(identity, { create: true });
  const existing = await handle.getFile();
  let offset = (stableTag || stableVersion) && (size === null || existing.size <= size) ? existing.size : 0;
  signal.throwIfAborted();
  if (offset > 0 && offset === size) {
    progress(offset);
    return existing;
  }

  const response = await request('GET', offset ? { Range: `bytes=${offset}-` } : {});
  let output: FileSystemWritableFileStream | undefined;
  let sync: FileSystemSyncAccessHandle | undefined;
  let flushedAt = offset;
  const reader = response.body?.getReader();
  try {
    if (!response.ok || !reader) throw new Error(`Download failed: HTTP ${response.status}`);
    assertRawEncoding(response.headers);
    if ((stableTag && response.headers.get('etag') !== stableTag) ||
        (stableVersion && response.headers.get('x-amz-version-id') !== stableVersion)) {
      throw new Error('The remote file changed during download. Retry to get its current revision.');
    }
    if (response.status === 200) offset = 0;
    else {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      if (response.status !== 206 || !range || Number(range[1]) !== offset ||
          Number(range[2]) + 1 !== Number(range[3]) || (size !== null && Number(range[3]) !== size)) {
        throw new Error('The server returned an inconsistent download range.');
      }
      size = Number(range[3]);
    }
    signal.throwIfAborted();
    const syncHandle = handle as FileSystemFileHandle & {
      createSyncAccessHandle?: () => Promise<FileSystemSyncAccessHandle>;
    };
    if (syncHandle.createSyncAccessHandle) {
      sync = await syncHandle.createSyncAccessHandle();
      if (!offset) sync.truncate(0);
    } else {
      output = await handle.createWritable({ keepExistingData: offset > 0 });
      if (offset) await output.seek(offset);
    }
    progress(offset);
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (size !== null && offset + value.length > size) throw new Error('Download exceeds the expected object size.');
      if (sync) {
        let written = 0;
        while (written < value.length) {
          const count = sync.write(value.subarray(written) as BufferSource, { at: offset + written });
          if (!count) throw new Error('Staging storage could not write the download.');
          written += count;
        }
        if (offset + written - flushedAt >= 8 * 1024 * 1024) {
          sync.flush();
          flushedAt = offset + written;
        }
      } else if (output) {
        await output.write(value as BufferSource);
      }
      offset += value.length;
      progress(value.length);
    }
    if (size !== null && offset !== size) throw new Error(`Size mismatch: received ${offset} of ${size} bytes`);
    if (sync) {
      sync.flush();
      sync.close();
      sync = undefined;
    } else if (output) {
      await output.close();
      output = undefined;
    }
    return await handle.getFile();
  } finally {
    sync?.close();
    await reader?.cancel().catch(() => undefined);
    if (output) {
      if (paused() && (stableTag || stableVersion)) await output.close();
      else await output.abort();
    }
  }
}
