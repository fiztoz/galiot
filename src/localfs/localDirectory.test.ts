import { describe, expect, test } from 'bun:test';
import {
  joinPath,
  parentPath,
  baseName,
  normalizeRelativePath,
  entriesFromListing,
} from './localDirectory';

describe('path helpers', () => {
  test('joinPath collapses separators and drops empties', () => {
    expect(joinPath('a', 'b', 'c.txt')).toBe('a/b/c.txt');
    expect(joinPath('', 'photos', '', '2024')).toBe('photos/2024');
    expect(joinPath('a//b', 'c')).toBe('a/b/c');
  });

  test('parentPath and baseName walk the tree', () => {
    expect(parentPath('a/b/c.txt')).toBe('a/b');
    expect(parentPath('c.txt')).toBe('');
    expect(parentPath('')).toBe('');
    expect(baseName('a/b/c.txt')).toBe('c.txt');
    expect(baseName('c.txt')).toBe('c.txt');
    expect(baseName('a/b/')).toBe('b');
  });
});

describe('normalizeRelativePath', () => {
  test('keeps normal relative paths', () => {
    expect(normalizeRelativePath('photos/2024/beach.jpg')).toBe('photos/2024/beach.jpg');
    expect(normalizeRelativePath('./a/b.txt')).toBe('a/b.txt');
  });

  test('cannot escape the mounted directory', () => {
    expect(normalizeRelativePath('../../etc/passwd')).toBe('etc/passwd');
    expect(normalizeRelativePath('a/../../b.txt')).toBe('a/b.txt');
    expect(normalizeRelativePath('a/./../b.txt')).toBe('a/b.txt');
    expect(normalizeRelativePath('..')).toBe('');
  });

  test('strips absolute prefixes', () => {
    expect(normalizeRelativePath('/etc/passwd')).toBe('etc/passwd');
    expect(normalizeRelativePath('C:\\Windows\\system32')).toBe('Windows/system32');
    expect(normalizeRelativePath('\\\\server\\share\\file.txt')).toBe('server/share/file.txt');
  });

  test('backslashes are treated as separators', () => {
    expect(normalizeRelativePath('a\\b\\c.txt')).toBe('a/b/c.txt');
  });
});

describe('entriesFromListing (webkitdirectory fallback)', () => {
  const file = (relativePath: string, size: number): File => {
    const f = new File([new Uint8Array(size)], relativePath.split('/').pop() as string);
    Object.defineProperty(f, 'webkitRelativePath', { value: relativePath });
    return f;
  };

  test('builds a navigable tree from flat input', () => {
    const tree = entriesFromListing([
      file('root/a.txt', 1),
      file('root/sub/b.txt', 2),
      file('root/sub/deeper/c.txt', 3),
    ]);

    // Rooted inside the picked folder: the 'root' segment is the mount point.
    expect([...tree.keys()].sort()).toEqual(['', 'sub', 'sub/deeper']);
    expect(tree.get('')?.map((e) => e.name)).toEqual(['sub', 'a.txt']);
    expect(tree.get('sub')?.map((e) => e.name)).toEqual(['deeper', 'b.txt']);

    const leaf = tree.get('sub/deeper')?.[0];
    expect(leaf?.kind).toBe('file');
    expect(leaf?.size).toBe(3);
  });

  test('ignores entries that normalize away completely', () => {
    const tree = entriesFromListing([file('..', 1)]);
    expect(tree.size).toBe(0);
  });
});
