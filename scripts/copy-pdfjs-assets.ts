/**
 * Copies PDF.js cMaps and standard fonts next to the app so PDF previews work
 * fully offline (CJK composite fonts, non-embedded standard fonts).
 *
 * The assets live in node_modules/pdfjs-dist; Vite serves public/ in dev and
 * copies it into dist/ on build, and the self-hosted server serves dist/.
 * Generated output — public/pdfjs/ is gitignored. Runs before dev and build.
 */
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'node_modules', 'pdfjs-dist');
const destination = resolve(root, 'public', 'pdfjs');

/**
 * A compromised dependency could ship symlinks pointing at operator files;
 * `cp` preserves them and the static host would serve the target. Refuse.
 */
async function assertNoSymlinks(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlinked pdfjs asset: ${full}`);
    if (entry.isDirectory()) await assertNoSymlinks(full);
  }
}

await mkdir(destination, { recursive: true });
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  await rm(resolve(destination, directory), { recursive: true, force: true });
  await cp(resolve(source, directory), resolve(destination, directory), { recursive: true });
}
await assertNoSymlinks(destination);
console.log(`pdfjs assets copied to ${destination}`);
