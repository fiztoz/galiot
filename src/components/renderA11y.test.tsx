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
import { PGliteProvider } from '@electric-sql/pglite-react';
import { Window } from 'happy-dom';
import { act, type ReactElement } from 'react';
import type { Root } from 'react-dom/client';
import type { ConnectionRow } from '../db/client';
import { ObjectActionDialog } from './ObjectActionDialog';
import { ShareConnectionDialog } from './ShareConnectionDialog';
import { CommandPalette } from './CommandPalette';
import { BucketSearchDialog } from './BucketSearchDialog';
import { ConnectionDialog } from './ConnectionDialog';
import { GaleonImportDialog } from './GaleonImportDialog';
import { TransferDrawer } from './TransferDrawer';
import { LocalPane } from './LocalPane';
import { ExplorerFilterBar, EMPTY_FILTER_PANEL } from './ExplorerFilterBar';
import { CustomHeadersField } from './CustomHeadersField';
import type { AppDB } from '../db/client';
import type { TransferTaskRow } from '../transfer/manager';

const window = new Window();
// Minimal DOM globals for react-dom/client and the focus trap.
// Must run before loading react-dom/client so it detects DOM/input-event support.
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

const { createRoot } = await import('react-dom/client');

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

  test('ConnectionDialog is a labelled modal with associated fields and clears errors on edit or test', async () => {
    const el = render(
      <ConnectionDialog db={{} as AppDB} open={true} onClose={() => {}} />,
    );
    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const labelledby = dialog?.getAttribute('aria-labelledby');
    expect(labelledby).toBe('connection-title');
    expect(el.querySelector(`#${labelledby}`)?.textContent).toBe('Add connection');

    const bucketLabel = el.querySelector('label[for="conn-bucket"]');
    const bucketInput = el.querySelector<HTMLInputElement>('#conn-bucket');
    expect(bucketLabel?.id).toBe('conn-bucket-label');
    expect(bucketLabel?.textContent).toBe('Bucket');
    expect(bucketInput).not.toBeNull();
    expect(bucketInput?.getAttribute('aria-labelledby')).toBe('conn-bucket-label');

    const setInputValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    };

    act(() => {
      if (bucketInput) setInputValue(bucketInput, 'example-bucket');
    });
    expect(bucketInput?.value).toBe('example-bucket');
    expect(el.querySelector('label[for="conn-bucket"]')?.textContent).toBe('Bucket');
    if (bucketInput && 'labels' in bucketInput && bucketInput.labels) {
      expect(bucketInput.labels[0]?.textContent).toBe('Bucket');
    }

    const pathStyle = el.querySelector<HTMLInputElement>('#conn-path-style');
    expect(pathStyle?.className).toContain('accent-teal-600');

    const sessionTokenLabel = el.querySelector('label[for="conn-session-token"]');
    const sessionTokenInput = el.querySelector<HTMLInputElement>('#conn-session-token');
    expect(sessionTokenLabel?.textContent).toContain('Session Token');
    expect(sessionTokenInput).not.toBeNull();
    expect(sessionTokenInput?.type).toBe('password');

    const form = el.querySelector('form');
    const submitForm = () => {
      form?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
    };

    // Trigger validation error on Save.
    act(submitForm);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Connection name is required.');

    // Typing into #conn-name clears the error banner.
    const nameInput = el.querySelector<HTMLInputElement>('#conn-name');
    expect(nameInput).not.toBeNull();
    act(() => {
      if (nameInput) setInputValue(nameInput, 'Archive');
    });
    expect(el.querySelector('[role="alert"]')?.textContent ?? null).toBeNull();

    // Re-trigger validation error, then click Test connection: stale alert clears and never stacks.
    act(() => {
      if (nameInput) setInputValue(nameInput, '');
    });
    act(submitForm);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Connection name is required.');

    const testButton = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Test connection'),
    );
    expect(testButton).toBeDefined();
    await act(async () => {
      testButton?.click();
    });
    expect(el.querySelector('[role="alert"]')?.textContent ?? null).toBeNull();
    const matches = el.textContent?.match(/Connection name is required\./g) ?? [];
    expect(matches.length).toBe(1);
  });

  test('TransferDrawer exposes an accessible disclosure pill, empty state, and progressbar tasks', () => {
    const createMockDb = (tasks: TransferTaskRow[]): AppDB =>
      ({
        live: {
          query: async (
            sql: string,
            _params: unknown[] | undefined,
            cb: (res: { rows: unknown[]; fields: unknown[]; totalCount: number }) => void,
          ) => {
            const rows = sql.includes('transfer_tasks') ? tasks : [];
            cb({ rows, fields: [], totalCount: rows.length });
            return { unsubscribe: () => {} };
          },
        },
      }) as unknown as AppDB;

    const emptyDb = createMockDb([]);
    const emptyEl = render(
      <PGliteProvider db={emptyDb}>
        <TransferDrawer db={emptyDb} />
      </PGliteProvider>,
    );

    const pill = [...emptyEl.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Transfers'),
    );
    expect(pill).toBeDefined();
    expect(pill?.getAttribute('aria-expanded')).toBe('false');
    expect(pill?.getAttribute('aria-controls')).toBe('transfer-drawer-panel');
    expect(pill?.querySelector('.lucide-chevron-up')).not.toBeNull();
    expect(emptyEl.querySelector('#transfer-drawer-panel')?.id ?? null).toBeNull();

    act(() => pill?.click());
    expect(pill?.getAttribute('aria-expanded')).toBe('true');
    expect(pill?.querySelector('.lucide-chevron-down')).not.toBeNull();
    const panel = emptyEl.querySelector('#transfer-drawer-panel');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('No transfers yet');
    expect(panel?.textContent).toContain('Uploads and downloads appear here with progress and resume controls.');

    const collapseBtn = emptyEl.querySelector<HTMLButtonElement>('button[aria-label="Collapse transfers"]');
    expect(collapseBtn).not.toBeNull();
    act(() => collapseBtn?.click());
    expect(emptyEl.querySelector('#transfer-drawer-panel')?.id ?? null).toBeNull();
    expect(pill?.getAttribute('aria-expanded')).toBe('false');

    const taskDb = createMockDb([
      {
        id: 't1',
        profile_id: 'p1',
        direction: 'upload',
        remote_key: 'docs/report.txt',
        local_path: 'report.txt',
        file_size: 100,
        bytes_transferred: 40,
        status: 'paused',
        speed_bytes_sec: 0,
        upload_id: 'u1',
        error_message: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const taskEl = render(
      <PGliteProvider db={taskDb}>
        <TransferDrawer db={taskDb} />
      </PGliteProvider>,
    );
    const taskPill = [...taskEl.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Transfers'),
    );
    act(() => taskPill?.click());
    const progress = taskEl.querySelector('[role="progressbar"]');
    expect(progress).not.toBeNull();
    expect(progress?.getAttribute('aria-valuenow')).toBe('40');
    expect(progress?.getAttribute('aria-label')).toContain('docs/report.txt');
  });

  test('GaleonImportDialog is a labelled modal only rendered when open', () => {
    const el = render(
      <GaleonImportDialog db={{} as AppDB} open={true} onClose={() => {}} />,
    );
    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const labelledby = dialog?.getAttribute('aria-labelledby');
    expect(labelledby).toBe('galeon-import-title');
    expect(el.querySelector(`#${labelledby}`)?.textContent).toBe('Import from Galeon');
    expect(el.querySelector('button[aria-label="Close import dialog"]')).not.toBeNull();
  });
});
