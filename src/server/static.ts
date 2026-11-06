import { resolve, sep } from 'node:path';

export interface HeaderRule {
  path: string;
  headers: Record<string, string>;
}

/** Parses a `_headers` file (path block, then `Name: value` lines). */
export function parseHeadersFile(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('/')) {
      current = { path: line, headers: {} };
      rules.push(current);
      continue;
    }
    const sepIndex = line.indexOf(':');
    if (!current || sepIndex === -1) continue;
    current.headers[line.slice(0, sepIndex).trim()] = line.slice(sepIndex + 1).trim();
  }
  return rules;
}

function ruleMatches(pattern: string, pathname: string): boolean {
  if (pattern === '/*') return true;
  if (pattern.endsWith('/*')) return pathname.startsWith(pattern.slice(0, -1));
  return pathname === pattern;
}

export function headersForPath(rules: HeaderRule[], pathname: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const rule of rules) {
    if (ruleMatches(rule.path, pathname)) Object.assign(headers, rule.headers);
  }
  return headers;
}

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
  return file;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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
