import { describe, expect, test } from 'bun:test';
import { pathSegments, relativeKey, relativeNameOf, underFolder, uploadKey } from './paths';

describe('relativeKey', () => {
  test('strips the folder prefix', () => {
    expect(relativeKey('docs/2024/a.txt', 'docs/')).toBe('2024/a.txt');
  });

  test('keys outside the prefix keep their full name', () => {
    expect(relativeKey('other/a.txt', 'docs/')).toBe('other/a.txt');
    expect(relativeKey('a.txt', '')).toBe('a.txt');
  });
});

describe('pathSegments', () => {
  test('drops empty and traversal segments', () => {
    expect(pathSegments('a//b/../c.txt')).toEqual(['a', 'b', 'c.txt']);
    expect(pathSegments('/leading/slash.txt')).toEqual(['leading', 'slash.txt']);
  });
});

describe('uploadKey', () => {
  test('keeps folder structure under the target prefix', () => {
    expect(uploadKey('docs/', 'docs/2024/a.txt')).toBe('docs/docs/2024/a.txt');
    expect(uploadKey('', 'a.txt')).toBe('a.txt');
  });

  test('drops traversal and empty segments', () => {
    expect(uploadKey('docs/', '../secret/a.txt')).toBe('docs/secret/a.txt');
    expect(uploadKey('docs/', '/leading//b.txt')).toBe('docs/leading/b.txt');
  });
});

describe('relativeNameOf', () => {
  test('prefers the picker relative path, falls back to the name', () => {
    expect(relativeNameOf({ name: 'a.txt', webkitRelativePath: 'folder/a.txt' })).toBe('folder/a.txt');
    expect(relativeNameOf({ name: 'a.txt', webkitRelativePath: '' })).toBe('a.txt');
    expect(relativeNameOf({ name: 'a.txt' })).toBe('a.txt');
  });
});

describe('underFolder', () => {
  test('nests a folder child under the dropped folder name', () => {
    expect(underFolder('docs', 'docs/2024/a.txt', 'docs/')).toBe('docs/2024/a.txt');
  });

  test('a file at the folder root stays at the root', () => {
    expect(underFolder('docs', 'docs/a.txt', 'docs/')).toBe('docs/a.txt');
  });
});
