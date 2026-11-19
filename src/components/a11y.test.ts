import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (name: string) => readFileSync(join(ROOT, 'components', name), 'utf8');

/**
 * Source-level guard, same pattern as signing.test.ts: these properties are
 * cheap to lose in a refactor and invisible to the unit suite (no DOM env).
 */
const DIALOGS = [
  'ObjectActionDialog.tsx',
  'ObjectDetailsDialog.tsx',
  'BucketSearchDialog.tsx',
  'ShareDialog.tsx',
  'ShareConnectionDialog.tsx',
  'ConnectionDialog.tsx',
  'GaleonImportDialog.tsx',
  'CommandPalette.tsx',
];

describe('dialog accessibility wiring', () => {
  for (const name of DIALOGS) {
    test(`${name} is a labelled modal with a focus trap`, () => {
      const source = read(name);
      expect(source).toContain('useFocusTrap');
      expect(source).toContain('role="dialog"');
      expect(source).toContain('aria-modal="true"');
      expect(source).toMatch(/aria-labelledby="|aria-label="/);
    });
  }

  test('the inline vault-settings modal traps focus only while open', () => {
    const source = read('ConnectionsView.tsx');
    expect(source).toContain('useFocusTrap<HTMLDivElement>(settingsOpen)');
    expect(source).toContain('aria-labelledby="vault-settings-title"');
  });

  test('open-controlled dialogs only activate the focus trap when open', () => {
    expect(read('GaleonImportDialog.tsx')).toContain('useFocusTrap<HTMLDivElement>(open)');
    expect(read('ConnectionDialog.tsx')).toContain('useFocusTrap<HTMLDivElement>(open)');
  });

  test('the object list exposes selection to assistive tech', () => {
    const source = read('Explorer.tsx');
    expect(source).toContain('role="listbox"');
    expect(source).toContain('aria-multiselectable="true"');
    expect(source).toContain('aria-selected={isSelected}');
  });

  test('transfer progress is a progressbar', () => {
    expect(read('TransferDrawer.tsx')).toContain('role="progressbar"');
  });

  test('vault gate errors and notices are announced', () => {
    const source = read('VaultGate.tsx');
    expect(source).toContain('role="alert"');
    expect(source).toContain('role="status"');
  });
});

describe('contrast and motion', () => {
  test('no light-mode zinc-400 text remains in components', () => {
    for (const name of [...DIALOGS, 'Explorer.tsx', 'ConnectionsView.tsx', 'VaultGate.tsx', 'LocalPane.tsx', 'TransferDrawer.tsx', 'ExplorerFilterBar.tsx', 'CustomHeadersField.tsx', 'VaultSettings.tsx']) {
      const source = read(name);
      expect(/(?<!dark:)text-zinc-400/.test(source), `${name} still has light zinc-400 text`).toBe(false);
    }
  });

  test('reduced motion is honoured globally', () => {
    const css = readFileSync(join(ROOT, 'app.css'), 'utf8');
    expect(css).toContain('prefers-reduced-motion: reduce');
  });
});

describe('responsive layout guards (pixel-pass regressions)', () => {
  test('connections toolbar wraps so Add connection is never clipped at 390px', () => {
    const source = read('ConnectionsView.tsx');
    expect(source).toContain('flex flex-wrap items-center justify-between gap-3 mb-6');
    expect(source).toContain('flex flex-wrap items-center gap-2');
    // Galeon import collapses to an icon with an accessible name on phones.
    expect(source).toContain('aria-label="Import from Galeon"');
  });

  test('explorer breadcrumb keeps a readable minimum width instead of collapsing', () => {
    const source = read('Explorer.tsx');
    expect(source).toContain('min-w-40 flex-1 overflow-x-auto whitespace-nowrap');
  });

  test('explorer status bar reserves space so the floating Transfers pill cannot overlap it', () => {
    const source = read('Explorer.tsx');
    expect(source).toContain('pt-1.5 pb-14 sm:pb-1.5 sm:pr-48');
  });
});
