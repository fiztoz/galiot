/**
 * Path helpers for folder downloads.
 *
 * A folder download enqueues one transfer per object; the name carried into
 * the local folder (or the ledger) is the key relative to the folder, so the
 * structure survives. Pure, so the naming is unit-testable outside workers.
 */

/** Key relative to a folder prefix; keys outside the prefix keep their name. */
export function relativeKey(key: string, prefix: string): string {
  return prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/** Directory segments of a relative name, without empty or dot segments. */
export function pathSegments(name: string): string[] {
  return name.split('/').filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** Join a folder name and a relative key into one local relative path. */
export function underFolder(folderName: string, key: string, prefix: string): string {
  const relative = relativeKey(key, prefix);
  return folderName ? `${folderName}/${relative}` : relative;
}

/**
 * Remote key for an uploaded file. Folder picks and directory drops carry a
 * relative path; plain picks carry only a name. Traversal and empty segments
 * are dropped so a crafted relative path cannot escape the target prefix.
 */
export function uploadKey(prefix: string, relativePath: string): string {
  return `${prefix}${pathSegments(relativePath).join('/')}`;
}

/** A file's relative path when the picker/drop provides one, else its name. */
export function relativeNameOf(file: { name: string; webkitRelativePath?: string }): string {
  const relative = file.webkitRelativePath ?? '';
  return relative.length > 0 ? relative : file.name;
}
