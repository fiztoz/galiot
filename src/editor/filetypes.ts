/**
 * File-type detection for the editor and preview panes.
 *
 * Deliberately dependency-free: the Explorer imports this on first load, and
 * pulling CodeMirror language packages in here would bloat the main bundle.
 * The heavy language wiring lives in `languages.ts`.
 */

/** Media the preview pane can render natively (images, PDF, audio, video). */
export type MediaKind = 'image' | 'pdf' | 'audio' | 'video';

/** Everything the preview pane may be asked to show, including opaque binaries. */
export type PreviewKind = MediaKind | 'binary';

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

const TEXTUAL_EXTENSION = /\.(txt|log|csv)$/i;

/**
 * Grammar hints from the first bytes of a file, for objects whose name gives
 * nothing away (no extension, or an unrecognised one). Only strong signals:
 * a shebang, a diff header, JSON/HTML/XML/YAML opening markers.
 */
function languageFromContent(sample: string): EditorLanguage | null {
  const head = sample.slice(0, 4096).replace(/^\uFEFF/, '').trimStart();
  const firstLine = head.split('\n', 1)[0] ?? '';

  if (firstLine.startsWith('#!')) {
    if (/python/.test(firstLine)) return 'python';
    if (/\b(node|deno|bun)\b/.test(firstLine)) return 'javascript';
    if (/\bruby\b/.test(firstLine)) return 'ruby';
    return 'shell';
  }
  if (/^diff --git /m.test(head) || /^--- .*\r?\n\+\+\+ /m.test(head)) return 'diff';
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (/^<!doctype html/i.test(head) || /^<html[\s>]/i.test(head)) return 'html';
  if (head.startsWith('<?xml') || /^<svg[\s>]/i.test(head)) return 'html';
  if (head.startsWith('---\n') || head.startsWith('---\r\n')) return 'yaml';
  return null;
}

export function detectLanguage(filename: string, contentSample?: string): EditorLanguage {
  const lower = filename.toLowerCase();
  const base = lower.split('/').pop() ?? lower;

  const byName = BY_FILENAME[base];
  if (byName) return byName;

  if (base.startsWith('dockerfile')) return 'dockerfile';

  const dot = base.lastIndexOf('.');
  const byExtension = dot === -1 ? 'text' : (BY_EXTENSION[base.slice(dot + 1)] ?? 'text');
  if (byExtension !== 'text') return byExtension;

  // An explicit .txt/.log/.csv stays plain text even if the content looks like
  // code; only nameless files fall back to content hints.
  if (TEXTUAL_EXTENSION.test(base)) return 'text';
  if (contentSample !== undefined) return languageFromContent(contentSample) ?? 'text';
  return 'text';
}

/** Files worth opening in the text editor rather than as an image/PDF/media file. */
export function isTextualFilename(filename: string): boolean {
  return detectLanguage(filename) !== 'text' || TEXTUAL_EXTENSION.test(filename);
}

/**
 * Whether the name alone already tells us how to open the object. When false
 * (no extension, or one nobody recognises) the editor sniffs the first bytes
 * instead of guessing — or worse, dumping binary into the text editor.
 */
export function hasTypeClue(filename: string): boolean {
  return (
    detectLanguage(filename) !== 'text' ||
    TEXTUAL_EXTENSION.test(filename.toLowerCase()) ||
    mediaKind(filename, null) !== null
  );
}

export function mediaKind(
  filename: string,
  contentType: string | null,
): MediaKind | null {
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
