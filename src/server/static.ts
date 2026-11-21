import { resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlib, gzip } from 'node:zlib';

/**
 * Resolves a URL path under `root`, or null when it would escape the root.
 * `/` maps to `index.html`. Missing files are the caller's problem.
 */
export function resolveStaticPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (!relative || relative.endsWith('/')) return null;
  const rootResolved = resolve(root);
  const file = resolve(rootResolved, relative);
  if (file !== rootResolved && !file.startsWith(rootResolved + sep)) return null;
  // A symlink inside the root must not point outside it. Missing files throw
  // here and stay the caller's 404; only existing paths are realpath-checked.
  try {
    const real = realpathSync(file);
    const realRoot = realpathSync(rootResolved);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  } catch {
    // fall through: nonexistent path, nothing to disclose
  }
  return file;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // Module workers (PDF.js) are refused by browsers unless the MIME is JavaScript.
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

export function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Text and WebAssembly shrink well; images and fonts are already compressed. */
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.wasm', '.data', '.txt', '.map']);

export type AssetEncoding = 'br' | 'gzip';

export function isCompressible(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  return dot !== -1 && COMPRESSIBLE.has(filePath.slice(dot).toLowerCase());
}

/** Brotli when the client takes it, else gzip, else none. A q=0 entry refuses. */
export function pickEncoding(acceptEncoding: string | null): AssetEncoding | null {
  const accepted = new Set<string>();
  for (const part of (acceptEncoding ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';').map(token => token.trim());
    if (!name || params.some(param => /^q=0(\.0*)?$/.test(param))) continue;
    accepted.add(name);
  }
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip')) return 'gzip';
  return null;
}

/**
 * Compresses each hashed asset once per encoding, on first request, off the
 * event loop. Hashed names are immutable, so the cache never goes stale.
 */
export class CompressedAssets {
  private readonly cache = new Map<string, Promise<Uint8Array>>();

  get(filePath: string, encoding: AssetEncoding, read: () => Promise<ArrayBuffer>): Promise<Uint8Array> {
    const key = `${encoding}:${filePath}`;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = read().then(async bytes => new Uint8Array(encoding === 'br'
        ? await brotliAsync(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength } })
        : await gzipAsync(bytes, { level: 9 })));
      pending.catch(() => this.cache.delete(key));
      this.cache.set(key, pending);
    }
    return pending;
  }
}
