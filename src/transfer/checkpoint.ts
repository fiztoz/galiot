import { sha256Hex } from '../lib/hash';

/** Hash fixed-size chunks, then hash their ordered digests. Memory is bounded for multipart files. */
export async function uploadFingerprint(file: Blob, signal: AbortSignal): Promise<string> {
  const chunks: string[] = [];
  const chunkSize = 8 * 1024 * 1024;
  for (let at = 0; at < file.size; at += chunkSize) {
    signal.throwIfAborted();
    const bytes = await file.slice(at, at + chunkSize).arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    chunks.push(Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''));
  }
  signal.throwIfAborted();
  return sha256Hex(JSON.stringify([file.size, chunks]));
}

export const STAGING_DIR = 'galiot-transfers';
export const TRANSFER_LOCK = 'galiot-transfer-writers';

/** Only remove Galiot's dedicated transfer staging tree. Surface permission and I/O failures. */
export async function removeStaging(taskId?: string, storage = globalThis.navigator?.storage): Promise<void> {
  if (!storage?.getDirectory) return;
  try {
    const root = await storage.getDirectory();
    if (!taskId) {
      await root.removeEntry(STAGING_DIR, { recursive: true });
      return;
    }
    const dir = await root.getDirectoryHandle(STAGING_DIR);
    for (const name of [`task-${taskId}`, `download-${taskId}`]) {
      try {
        await dir.removeEntry(name, { recursive: true });
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err;
      }
    }
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err;
  }
}
