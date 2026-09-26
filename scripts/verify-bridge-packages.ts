/** Check every site-hosted companion archive before a deployment can ship. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const directory = join(resolve(import.meta.dir, '..'), 'dist', 'downloads');
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
  version: number;
  packages: {
    id: string;
    filename: string;
    size: number;
    sha256: string;
    parts: { file: string; size: number; integrity: string }[];
  }[];
};

if (manifest.version !== 1 || manifest.packages.length !== 4) {
  throw new Error('The companion download manifest is incomplete.');
}

for (const entry of manifest.packages) {
  const chunks = [];
  for (const part of entry.parts) {
    const bytes = await readFile(join(directory, part.file));
    if (bytes.length !== part.size || bytes.length > 20 * 1024 * 1024) {
      throw new Error(`${entry.id}: invalid static part size`);
    }
    const integrity = `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
    if (integrity !== part.integrity) throw new Error(`${entry.id}: part hash mismatch`);
    chunks.push(bytes);
  }

  const archive = Buffer.concat(chunks);
  if (archive.length !== entry.size) throw new Error(`${entry.id}: archive size mismatch`);
  if (createHash('sha256').update(archive).digest('hex') !== entry.sha256) {
    throw new Error(`${entry.id}: archive hash mismatch`);
  }
  if (archive.readUInt32LE(0) !== 0x04034b50 || archive.readUInt16LE(8) !== 8) {
    throw new Error(`${entry.id}: invalid ZIP header`);
  }

  const nameLength = archive.readUInt16LE(26);
  const name = archive.subarray(30, 30 + nameLength).toString();
  const expectedName = entry.id.startsWith('windows-') ? 'galiot-bridge.exe' : 'galiot-bridge';
  if (name !== expectedName) throw new Error(`${entry.id}: unexpected ZIP entry`);

  const compressedLength = archive.readUInt32LE(18);
  const binary = inflateRawSync(archive.subarray(30 + nameLength, 30 + nameLength + compressedLength));
  if (binary.length !== archive.readUInt32LE(22)) throw new Error(`${entry.id}: invalid executable size`);
  if (crc32(binary) !== archive.readUInt32LE(14)) throw new Error(`${entry.id}: invalid ZIP checksum`);
  const centralOffset = 30 + nameLength + compressedLength;
  if (archive.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error(`${entry.id}: missing ZIP directory`);
  if (!entry.id.startsWith('windows-') && (archive.readUInt32LE(centralOffset + 38) >>> 16 & 0o111) !== 0o111) {
    throw new Error(`${entry.id}: executable permission is missing`);
  }
  const magic = entry.id.startsWith('windows-') ? '4d5a' : entry.id.startsWith('linux-') ? '7f454c46' : 'cffaedfe';
  if (!binary.subarray(0, magic.length / 2).toString('hex').startsWith(magic)) {
    throw new Error(`${entry.id}: executable format does not match platform`);
  }
  console.log(`${entry.id}: ${entry.parts.length} verified part(s), ${name}`);
}
