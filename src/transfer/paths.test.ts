import { describe, expect, test } from 'bun:test';
import { pathSegments, relativeKey, underFolder } from './paths';

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

describe('underFolder', () => {
  test('nests a folder child under the dropped folder name', () => {
    expect(underFolder('docs', 'docs/2024/a.txt', 'docs/')).toBe('docs/2024/a.txt');
  });

  test('a file at the folder root stays at the root', () => {
    expect(underFolder('docs', 'docs/a.txt', 'docs/')).toBe('docs/a.txt');
  });
});
