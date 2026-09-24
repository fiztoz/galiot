/**
 * File-type detection for the editor and preview panes.
 *
 * Deliberately dependency-free: the Explorer imports this on first load, and
 * pulling CodeMirror language packages in here would bloat the main bundle.
 * The heavy language wiring lives in `languages.ts`.
 */

export type EditorLanguage =
  | 'javascript'
  | 'json'
  | 'markdown'
  | 'python'
  | 'html'
  | 'css'
  | 'sql'
  | 'yaml'
  | 'shell'
  | 'toml'
  | 'ini'
  | 'dockerfile'
  | 'rust'
  | 'ruby'
  | 'diff'
  | 'text';

const BY_EXTENSION: Record<string, EditorLanguage> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'javascript', tsx: 'javascript', mts: 'javascript',
  json: 'json', jsonc: 'json', webmanifest: 'json',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  py: 'python', pyi: 'python',
  html: 'html', htm: 'html', vue: 'html', svg: 'html', xml: 'html',
  css: 'css', scss: 'css', less: 'css',
  sql: 'sql',
  yaml: 'yaml', yml: 'yaml',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  toml: 'toml',
  ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini',
  dockerfile: 'dockerfile',
  rs: 'rust',
  rb: 'ruby',
  diff: 'diff', patch: 'diff',
  txt: 'text', log: 'text', csv: 'text',
};

const BY_FILENAME: Record<string, EditorLanguage> = {
  dockerfile: 'dockerfile',
  makefile: 'ini',
  '.env': 'ini',
  '.gitignore': 'ini',
  '.npmrc': 'ini',
  '.babelrc': 'json',
};

export function detectLanguage(filename: string): EditorLanguage {
  const lower = filename.toLowerCase();
  const base = lower.split('/').pop() ?? lower;

  const byName = BY_FILENAME[base];
  if (byName) return byName;

  if (base.startsWith('dockerfile')) return 'dockerfile';

  const dot = base.lastIndexOf('.');
  if (dot === -1) return 'text';

  return BY_EXTENSION[base.slice(dot + 1)] ?? 'text';
}

/** Files worth opening in the text editor rather than as an image/PDF/media file. */
export function isTextualFilename(filename: string): boolean {
  return detectLanguage(filename) !== 'text' || /\.(txt|log|csv)$/i.test(filename);
}

export function mediaKind(
  filename: string,
  contentType: string | null,
): 'image' | 'pdf' | 'audio' | 'video' | null {
  const type = (contentType ?? '').toLowerCase();
  const ext = filename.toLowerCase().split('.').pop() ?? '';

  if (
    type.startsWith('image/') ||
    ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico'].includes(ext)
  ) {
    return 'image';
  }
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) {
    return 'audio';
  }
  if (type.startsWith('video/') || ['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) {
    return 'video';
  }
  return null;
}
