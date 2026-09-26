/** Browser download of the companion packages included with a site build. */

export const COMPANION_PACKAGES = [
  { id: 'darwin-arm64', label: 'macOS Apple Silicon' },
  { id: 'darwin-x64', label: 'macOS Intel' },
  { id: 'windows-x64', label: 'Windows x64' },
  { id: 'linux-x64', label: 'Linux x64' },
] as const;

export type CompanionPackageId = (typeof COMPANION_PACKAGES)[number]['id'];

interface PackagePart {
  file: string;
  size: number;
  integrity: string;
}

interface PackageEntry {
  id: CompanionPackageId;
  filename: string;
  size: number;
  parts: PackagePart[];
}

function validPackage(value: unknown, id: CompanionPackageId): value is PackageEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<PackageEntry>;
  return entry.id === id
    && typeof entry.filename === 'string'
    && /^galiot-bridge-[a-z0-9-]+\.zip$/.test(entry.filename)
    && Number.isSafeInteger(entry.size)
    && entry.size! > 0
    && entry.size! <= 200 * 1024 * 1024
    && Array.isArray(entry.parts)
    && entry.parts.length > 0
    && entry.parts.every((part) => part
      && /^[a-z0-9-]+\.part\d+$/.test(part.file)
      && Number.isSafeInteger(part.size)
      && part.size > 0
      && part.size <= 20 * 1024 * 1024
      && /^sha256-[A-Za-z0-9+/]{43}=$/.test(part.integrity))
    && entry.parts.reduce((total, part) => total + part.size, 0) === entry.size;
}

export async function downloadCompanion(
  id: CompanionPackageId,
  onProgress: (received: number, total: number) => void,
): Promise<void> {
  const manifestResponse = await fetch('/downloads/manifest.json', { cache: 'no-store' });
  if (!manifestResponse.ok) {
    throw new Error('Companion downloads are not included in this site build.');
  }
  const manifest = await manifestResponse.json() as { version?: unknown; packages?: unknown };
  const entry = Array.isArray(manifest.packages)
    ? manifest.packages.find((item: unknown) => (item as { id?: unknown } | null)?.id === id)
    : undefined;
  if (manifest.version !== 1 || !validPackage(entry, id)) {
    throw new Error('Companion download manifest is invalid or this platform is unavailable.');
  }

  const chunks: ArrayBuffer[] = [];
  let received = 0;
  for (const part of entry.parts) {
    const response = await fetch(`/downloads/${part.file}`, { integrity: part.integrity });
    if (!response.ok) throw new Error(`Could not download companion part ${part.file}.`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== part.size) throw new Error('A companion download part had the wrong size.');
    chunks.push(bytes);
    received += bytes.byteLength;
    onProgress(received, entry.size);
  }

  const url = URL.createObjectURL(new Blob(chunks, { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = entry.filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
