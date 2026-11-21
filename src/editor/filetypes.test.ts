import { describe, expect, test } from 'bun:test';
import { detectLanguage, hasTypeClue, isTextualFilename, mediaKind } from './filetypes';

describe('detectLanguage', () => {
  test('maps common extensions', () => {
    expect(detectLanguage('app.js')).toBe('javascript');
    expect(detectLanguage('types.tsx')).toBe('javascript');
    expect(detectLanguage('package.json')).toBe('json');
    expect(detectLanguage('README.md')).toBe('markdown');
    expect(detectLanguage('main.py')).toBe('python');
    expect(detectLanguage('styles.scss')).toBe('css');
    expect(detectLanguage('query.sql')).toBe('sql');
    expect(detectLanguage('config.yaml')).toBe('yaml');
    expect(detectLanguage('deploy.sh')).toBe('shell');
    expect(detectLanguage('Cargo.toml')).toBe('toml');
    expect(detectLanguage('app.ini')).toBe('ini');
  });

  test('handles nested paths and mixed case', () => {
    expect(detectLanguage('src/lib/deep/Util.JS')).toBe('javascript');
    expect(detectLanguage('a/b/c/ENV.YML')).toBe('yaml');
  });

  test('detects files without an extension', () => {
    expect(detectLanguage('Dockerfile')).toBe('dockerfile');
    expect(detectLanguage('dockerfile.prod')).toBe('dockerfile');
    expect(detectLanguage('Makefile')).toBe('ini');
    expect(detectLanguage('LICENSE')).toBe('text');
    expect(detectLanguage('weird.unknownext')).toBe('text');
  });

  test('dotfiles map to ini or json', () => {
    expect(detectLanguage('.env')).toBe('ini');
    expect(detectLanguage('.gitignore')).toBe('ini');
    expect(detectLanguage('.babelrc')).toBe('json');
  });

  test('nameless files fall back to content hints', () => {
    expect(detectLanguage('LICENSE', '{"a": 1}')).toBe('json');
    expect(detectLanguage('run', '#!/bin/bash\necho hi\n')).toBe('shell');
    expect(detectLanguage('script', '#!/usr/bin/env python3\n')).toBe('python');
    expect(detectLanguage('page', '<!DOCTYPE html>\n<html>')).toBe('html');
    expect(detectLanguage('feed', '<?xml version="1.0"?>')).toBe('html');
    expect(detectLanguage('patch', 'diff --git a/x b/x\n')).toBe('diff');
    expect(detectLanguage('conf', '---\nkey: value\n')).toBe('yaml');
    expect(detectLanguage('plain', 'just words')).toBe('text');
  });

  test('explicit text extensions and known extensions ignore content hints', () => {
    expect(detectLanguage('notes.txt', '{"a": 1}')).toBe('text');
    expect(detectLanguage('app.js', '#!/bin/bash')).toBe('javascript');
  });
});

describe('hasTypeClue', () => {
  test('names that already say how to open', () => {
    expect(hasTypeClue('a.pdf')).toBe(true);
    expect(hasTypeClue('a.png')).toBe(true);
    expect(hasTypeClue('a.txt')).toBe(true);
    expect(hasTypeClue('Dockerfile')).toBe(true);
    expect(hasTypeClue('app.js')).toBe(true);
  });

  test('nameless or unknown extensions need content sniffing', () => {
    expect(hasTypeClue('LICENSE')).toBe(false);
    expect(hasTypeClue('blob.qqq')).toBe(false);
    expect(hasTypeClue('folder/object')).toBe(false);
  });
});

describe('isTextualFilename', () => {
  test('text formats open in the editor', () => {
    expect(isTextualFilename('notes.txt')).toBe(true);
    expect(isTextualFilename('server.py')).toBe(true);
    expect(isTextualFilename('data.csv')).toBe(true);
  });

  test('binaries do not', () => {
    expect(isTextualFilename('photo.jpg')).toBe(false);
    expect(isTextualFilename('archive.zip')).toBe(false);
    expect(isTextualFilename('blob.qqq')).toBe(false);
  });
});

describe('mediaKind', () => {
  test('classifies by extension when content type is missing', () => {
    expect(mediaKind('a/b.png', null)).toBe('image');
    expect(mediaKind('images/sailboat.svg', null)).toBe('image');
    expect(mediaKind('doc.pdf', null)).toBe('pdf');
    expect(mediaKind('song.mp3', null)).toBe('audio');
    expect(mediaKind('clip.webm', null)).toBe('video');
  });

  test('classifies by content type first', () => {
    expect(mediaKind('no-extension', 'image/webp')).toBe('image');
    expect(mediaKind('no-extension', 'application/pdf')).toBe('pdf');
    expect(mediaKind('no-extension', 'audio/mpeg')).toBe('audio');
    expect(mediaKind('no-extension', 'video/mp4')).toBe('video');
  });

  test('returns null for anything else', () => {
    expect(mediaKind('archive.zip', 'application/zip')).toBeNull();
    expect(mediaKind('unknown.bin', null)).toBeNull();
  });
});
