/**
 * Copies PDF.js cMaps and standard fonts next to the app so PDF previews work
 * fully offline (CJK composite fonts, non-embedded standard fonts).
 *
 * The assets live in node_modules/pdfjs-dist; Vite serves public/ in dev and
 * copies it into dist/ on build, and the self-hosted server serves dist/.
 * Generated output — public/pdfjs/ is gitignored. Runs before dev and build.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'node_modules', 'pdfjs-dist');
const destination = resolve(root, 'public', 'pdfjs');

await mkdir(destination, { recursive: true });
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  await rm(resolve(destination, directory), { recursive: true, force: true });
  await cp(resolve(source, directory), resolve(destination, directory), { recursive: true });
}
console.log(`pdfjs assets copied to ${destination}`);
