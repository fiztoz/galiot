import { describe, expect, test } from 'bun:test';
import { canMountEditor, type EditorMountState } from './EditorPanel';
import { languageSupport } from './languages';
import { detectLanguage } from './filetypes';

/**
 * Regression guard for a dead-editor bug found against a real bucket.
 *
 * The mount effect used to wait for `langSupport !== undefined`, but plain text
 * has no grammar, so `languageSupport('text')` resolves to `undefined` on
 * purpose. Every `.txt`, `.log`, `.csv` and unknown-extension file therefore
 * opened a panel with no editor, no spinner and no error — the gate was
 * indistinguishable from "still loading".
 */

const ready: EditorMountState = {
  loading: false,
  error: null,
  media: null,
  langResolved: true,
};

describe('canMountEditor', () => {
  test('mounts once loading has finished, even with no language grammar', () => {
    // Plain text resolves to no extension, which must not block mounting.
    expect(canMountEditor(ready)).toBe(true);
  });

  test('waits while the file is still loading', () => {
    expect(canMountEditor({ ...ready, loading: true })).toBe(false);
  });

  test('waits while language resolution has not finished', () => {
    // The distinction that was missing: "not resolved yet" is not the same as
    // "resolved to nothing".
    expect(canMountEditor({ ...ready, langResolved: false })).toBe(false);
  });

  test('does not mount over an error', () => {
    expect(canMountEditor({ ...ready, error: 'GetObject failed' })).toBe(false);
  });

  test('does not mount an editor for media, which uses its own preview', () => {
    for (const media of ['image', 'pdf', 'audio', 'video'] as const) {
      expect(canMountEditor({ ...ready, media })).toBe(false);
    }
  });

  test('a language that resolves later still ends up mounting', () => {
    const during = canMountEditor({ ...ready, langResolved: false });
    const after = canMountEditor({ ...ready, langResolved: true });
    expect(during).toBe(false);
    expect(after).toBe(true);
  });
});

describe('languageSupport for plain text', () => {
  test('plain text intentionally has no grammar', async () => {
    expect(detectLanguage('notes.txt')).toBe('text');
    expect(await languageSupport('text')).toBeUndefined();
  });

  test('so the two states must be modelled separately', async () => {
    // The exact pair the old code conflated.
    const support = await languageSupport('text');
    expect(support).toBeUndefined();
    expect(canMountEditor({ ...ready, langResolved: true })).toBe(true);
  });

  test('recognises the extensions that route to plain text', () => {
    for (const name of ['notes.txt', 'server.log', 'report.csv', 'LICENSE', 'noextension']) {
      expect(detectLanguage(name)).toBe('text');
    }
  });
});
