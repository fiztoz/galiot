/**
 * Directory-aware drag & drop.
 *
 * `DataTransfer.files` flattens directories to nothing useful; the entry API
 * is the only way to walk a dropped folder. The walk is capped so one drop
 * cannot queue an unbounded number of transfers.
 */

export const MAX_DROP_ENTRIES = 2000;

export interface DroppedFile {
  file: File;
  /** Path relative to the drop target, including the dropped folder's name. */
  path: string;
}

export async function collectDroppedFiles(
  transfer: DataTransfer,
  cap = MAX_DROP_ENTRIES,
): Promise<{ files: DroppedFile[]; truncated: boolean }> {
  const items = Array.from(transfer.items ?? []);
  const roots = items
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);

  // No entry API (or a plain file drop): fall back to the flat file list.
  if (roots.length === 0) {
    const files = Array.from(transfer.files).slice(0, cap).map((file) => ({ file, path: file.name }));
    return { files, truncated: transfer.files.length > cap };
  }

  const files: DroppedFile[] = [];
  let truncated = false;

  const walk = async (entry: FileSystemEntry, base: string): Promise<void> => {
    if (files.length >= cap) {
      truncated = true;
      return;
    }
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      files.push({ file, path: `${base}${entry.name}` });
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (batch.length === 0) break;
        for (const child of batch) {
          if (files.length >= cap) {
            truncated = true;
            return;
          }
          await walk(child, `${base}${entry.name}/`);
        }
      }
    }
  };

  for (const root of roots) {
    if (files.length >= cap) {
      truncated = true;
      break;
    }
    await walk(root, '');
  }
  return { files, truncated };
}
