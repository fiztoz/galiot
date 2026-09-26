/** Build downloadable, standalone companion archives for static hosting. */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const root = resolve(import.meta.dir, '..');
const output = join(root, 'public', 'downloads');
const partLimit = 20 * 1024 * 1024; // Cloudflare's per-asset limit is 25 MiB.

const targets = [
  { id: 'darwin-arm64', label: 'macOS Apple Silicon', bunTarget: 'bun-darwin-arm64', executable: 'galiot-bridge' },
  { id: 'darwin-x64', label: 'macOS Intel', bunTarget: 'bun-darwin-x64', executable: 'galiot-bridge' },
  { id: 'windows-x64', label: 'Windows x64', bunTarget: 'bun-windows-x64', executable: 'galiot-bridge.exe' },
  { id: 'linux-x64', label: 'Linux x64', bunTarget: 'bun-linux-x64', executable: 'galiot-bridge' },
] as const;

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A deterministic one-file ZIP, including Unix executable permissions. */
function zipExecutable(filename: string, content: Buffer): Buffer {
  const name = Buffer.from(filename);
  const compressed = deflateRawSync(content, { level: 9 });
  const checksum = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0x21, 12); // 1980-01-01, fixed for reproducibility.
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);

  const centralOffset = local.length + name.length + compressed.length;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x031e, 4); // ZIP 3.0, created on Unix.
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100755 << 16) >>> 0, 38);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}

async function run(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit' });
  const code = await process.exited;
  if (code !== 0) throw new Error(`${command[1]} failed with exit code ${code}`);
}

const temporary = await mkdtemp(join(tmpdir(), 'galiot-bridge-build-'));
const staging = await mkdtemp(join(root, 'public', '.downloads-build-'));

try {
  const packages = [];
  for (const target of targets) {
    const executable = join(temporary, `${target.id}-${target.executable}`);
    await run([
      process.execPath,
      'build',
      '--compile',
      `--target=${target.bunTarget}`,
      join(root, 'scripts', 'bridge.ts'),
      '--outfile',
      executable,
    ], temporary);

    const archive = zipExecutable(target.executable, await readFile(executable));
    const sha256 = createHash('sha256').update(archive).digest('hex');
    const filename = `galiot-bridge-${target.id}.zip`;
    const parts = [];
    for (let offset = 0, index = 0; offset < archive.length; offset += partLimit, index++) {
      const file = `${target.id}-${sha256.slice(0, 16)}.part${index}`;
      const chunk = archive.subarray(offset, Math.min(offset + partLimit, archive.length));
      await writeFile(join(staging, file), chunk);
      parts.push({
        file,
        size: chunk.length,
        integrity: `sha256-${createHash('sha256').update(chunk).digest('base64')}`,
      });
    }
    packages.push({ id: target.id, label: target.label, filename, size: archive.length, sha256, parts });
    console.log(`${target.label}: ${(archive.length / 1048576).toFixed(1)} MiB in ${parts.length} asset(s)`);
  }

  await writeFile(join(staging, 'manifest.json'), JSON.stringify({ version: 1, packages }, null, 2) + '\n');
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
} finally {
  await rm(temporary, { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
}
