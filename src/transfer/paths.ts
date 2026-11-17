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
