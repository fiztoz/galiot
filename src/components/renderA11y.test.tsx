/**
 * Rendered-DOM accessibility checks for vault-gated dialogs.
 *
 * The interactive browser cannot create a vault (it refuses to type a master
 * password), so pixel-level checks stop at the gate. These tests close the gap
 * for the dialogs by actually mounting them in a DOM (happy-dom) and asserting
 * the accessibility contract: dialog role, modality, labelled heading, associated
 * input labels, and named actions. No credentials, no network, no browser.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ConnectionRow } from '../db/client';
import { ObjectActionDialog } from './ObjectActionDialog';
import { ShareConnectionDialog } from './ShareConnectionDialog';
import { CommandPalette } from './CommandPalette';
import { BucketSearchDialog } from './BucketSearchDialog';
import { LocalPane } from './LocalPane';
import { ExplorerFilterBar, EMPTY_FILTER_PANEL } from './ExplorerFilterBar';
import { CustomHeadersField } from './CustomHeadersField';
import type { AppDB } from '../db/client';

const window = new Window();
// Minimal DOM globals for react-dom/client and the focus trap.
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  SVGElement: window.SVGElement,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const roots: Root[] = [];
function render(element: ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  return container;
}

afterAll(() => {
  for (const root of roots) act(() => root.unmount());
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT']) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

const profile = {
  id: 'p1',
  name: 'Archive',
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'archive',
  path_style: true,
  custom_headers: null,
} as unknown as ConnectionRow;

describe('rendered dialog accessibility', () => {
  test('ObjectActionDialog is a labelled modal with an associated input', () => {
    const el = render(
      <ObjectActionDialog
        title="Rename or move"
        label="Destination key"
        initialValue="a.txt"
        confirmLabel="Rename"
        onSubmit={async () => {}}
        onClose={() => {}}
      />,
    );
    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const labelledby = dialog?.getAttribute('aria-labelledby');
    expect(labelledby).toBe('object-action-title');
    expect(el.querySelector(`#${labelledby}`)?.textContent).toBe('Rename or move');
    const input = el.querySelector<HTMLInputElement>('#object-action-key');
    expect(input).not.toBeNull();
    expect(el.querySelector('label[for="object-action-key"]')?.textContent).toBe('Destination key');
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Rename'))).toBe(true);
  });

  test('ShareConnectionDialog is a labelled modal with named copy/save actions', () => {
    const el = render(<ShareConnectionDialog profile={profile} onClose={() => {}} />);
    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(el.querySelector('#share-connection-title')?.textContent).toContain('Share connection');
    expect(el.querySelector('textarea')?.getAttribute('aria-label')).toBe('Connection JSON');
    const names = [...el.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(names.some((n) => n.includes('Copy JSON'))).toBe(true);
    expect(names.some((n) => n.includes('Save file'))).toBe(true);
    // The payload must not carry key material.
    expect((el.querySelector('textarea') as HTMLTextAreaElement).value).not.toContain('secret');
  });

  test('CommandPalette is a labelled modal with a searchable command list', () => {
    const el = render(
      <CommandPalette
        commands={[
          { id: 'upload', label: 'Upload files', run: () => {} },
          { id: 'refresh', label: 'Refresh listing', run: () => {} },
        ]}
        onClose={() => {}}
      />,
    );
    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-label')).toBe('Command palette');
    expect(el.querySelector('input')?.getAttribute('aria-label')).toBe('Command palette');
    const labels = [...el.querySelectorAll('li button')].map((b) => b.textContent ?? '');
    expect(labels.some((n) => n.includes('Upload files'))).toBe(true);
    expect(labels.some((n) => n.includes('Refresh listing'))).toBe(true);
  });

  test('BucketSearchDialog is a labelled modal with a named query field', () => {
    const el = render(
      <BucketSearchDialog
        db={{} as AppDB}
        profile={profile}
        initialQuery=""
        onNavigate={() => {}}
        onClose={() => {}}
      />,
    );
    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(el.querySelector('#bucket-search-title')?.textContent).toContain('Search whole bucket');
    expect(el.querySelector('input')?.getAttribute('aria-label')).toBe('Search query');
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Search'))).toBe(true);
  });

  test('LocalPane frames the local folder as a download destination, not storage', () => {
    const el = render(<LocalPane onDownloadToLocal={() => {}} onError={() => {}} />);
    expect(el.textContent).toContain('Download folder');
    expect(el.textContent).toContain('This is not remote storage');
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Choose folder'))).toBe(true);
  });

  test('ExplorerFilterBar toggles an accessible panel with labelled inputs', () => {
    const el = render(<ExplorerFilterBar value={EMPTY_FILTER_PANEL} onChange={() => {}} />);
    const trigger = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Filters'));
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    act(() => trigger?.click());
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('#filter-min-size')).not.toBeNull();
    expect(el.querySelector('label[for="filter-min-size"]')?.textContent).toContain('Minimum size');
    const close = el.querySelector<HTMLButtonElement>('button[aria-label="Close filters"]');
    act(() => close?.click());
    expect(el.querySelector('#filter-min-size')).toBeNull();
  });

  test('CustomHeadersField offers an add action and warns against secrets', () => {
    const el = render(
      <CustomHeadersField rows={[]} onChange={() => {}} inputClass="" labelClass="" />,
    );
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Add header'))).toBe(true);
    expect(el.textContent).toContain('Not for secrets');
  });
});
