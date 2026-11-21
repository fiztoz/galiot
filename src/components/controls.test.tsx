import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { Select } from './Select';
import { Checkbox } from './Checkbox';
import { ConfirmDialog } from './ConfirmDialog';
import { ExplorerFilterBar, EMPTY_FILTER_PANEL } from './ExplorerFilterBar';
import { ShortcutsDialog } from './ShortcutsDialog';

/** Mounts into a fresh happy-dom window, restoring globals afterwards. */
async function withDom(run: (container: HTMLElement, window: Window) => Promise<void>) {
  const window = new Window({ url: 'https://example.com' });
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await run(container, window);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    for (const key of Object.keys(globalThis)) {
      if (!(key in previous)) delete (globalThis as Record<string, unknown>)[key];
    }
    Object.defineProperties(globalThis, previous);
  }
}

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

test('Select opens a themed listbox and commits clicks and keys', async () => {
  await withDom(async (container, window) => {
    const picked: string[] = [];
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    const render = (value: string) =>
      act(async () => root.render(<Select value={value} onChange={(next) => picked.push(next)} options={OPTIONS} ariaLabel="Class" />));
    await render('b');

    const trigger = container.querySelector('button')!;
    expect(trigger.textContent).toContain('Beta');
    expect(container.querySelector('[role=listbox]')).toBeNull();

    await act(async () => trigger.click());
    const list = container.querySelector('[role=listbox]')!;
    expect(list.querySelectorAll('[role=option]')).toHaveLength(3);
    expect(list.querySelector('[aria-selected=true]')?.textContent).toContain('Beta');

    await act(async () => (list.querySelectorAll('[role=option]')[2] as HTMLElement).click());
    expect(picked).toEqual(['c']);
    expect(container.querySelector('[role=listbox]')).toBeNull();

    // Keyboard: open, move down, commit with Enter.
    await act(async () => trigger.click());
    trigger.focus();
    const key = (k: string) =>
      act(async () => {
        trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }) as unknown as Event);
      });
    await key('ArrowDown');
    await key('Enter');
    expect(picked).toEqual(['c', 'c']);

    // Escape closes without committing.
    await act(async () => trigger.click());
    await key('Escape');
    expect(container.querySelector('[role=listbox]')).toBeNull();
    expect(picked).toEqual(['c', 'c']);
    await act(async () => root.unmount());
  });
});

test('Checkbox keeps native semantics behind a themed box', async () => {
  await withDom(async (container) => {
    const changes: boolean[] = [];
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(
      <Checkbox checked={false} onChange={(next) => changes.push(next)}>Include headers</Checkbox>,
    ));
    const input = container.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(container.textContent).toContain('Include headers');
    await act(async () => input.click());
    expect(changes).toEqual([true]);

    await act(async () => root.render(
      <Checkbox checked onChange={(next) => changes.push(next)}>Include headers</Checkbox>,
    ));
    expect((container.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(true);
    // The themed box is teal when checked, neutral otherwise.
    expect((container.querySelector('label > span') as HTMLElement).className).toContain('bg-teal-600');
    await act(async () => root.unmount());
  });
});

test('Escape dismisses an open Select without closing the host filter panel', async () => {
  await withDom(async (container, window) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(
      <ExplorerFilterBar value={EMPTY_FILTER_PANEL} onChange={() => {}} />,
    ));
    const filters = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Filters'))!;
    await act(async () => filters.click());
    const trigger = container.querySelector('#filter-storage-class') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    await act(async () => trigger.click());
    expect(container.querySelector('[role=listbox]')).not.toBeNull();

    const escape = () => act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) as unknown as Event);
    });
    await escape();
    expect(container.querySelector('[role=listbox]')).toBeNull();
    // The panel itself must survive the first Escape.
    expect(container.querySelector('#filter-storage-class')).not.toBeNull();
    await escape();
    expect(container.querySelector('#filter-storage-class')).toBeNull();
    await act(async () => root.unmount());
  });
});

test('Checkbox exposes the indeterminate select-all state', async () => {
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(
      <Checkbox checked={false} indeterminate onChange={() => {}} ariaLabel="Select all" />,
    ));
    const input = container.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(input.indeterminate).toBe(true);
    expect(input.getAttribute('aria-label')).toBe('Select all');
    await act(async () => root.render(
      <Checkbox checked indeterminate onChange={() => {}} ariaLabel="Select all" />,
    ));
    expect((container.querySelector('input[type=checkbox]') as HTMLInputElement).indeterminate).toBe(false);
    await act(async () => root.unmount());
  });
});

test('ShortcutsDialog lists real shortcuts and escapes', async () => {
  await withDom(async (container, window) => {
    const events: string[] = [];
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(<ShortcutsDialog onClose={() => events.push('close')} />));
    expect(container.textContent).toContain('Command palette');
    expect(container.textContent).toContain('Extend selection');
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(events).toEqual(['close']);
    await act(async () => root.unmount());
  });
});

test('ConfirmDialog confirms, cancels and escapes like a modal', async () => {
  await withDom(async (container, window) => {
    const events: string[] = [];
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    await act(async () => root.render(
      <ConfirmDialog
        title="Replace existing files?"
        message="Replace 2 existing file(s)?"
        confirmLabel="Replace"
        tone="danger"
        onConfirm={() => events.push('confirm')}
        onCancel={() => events.push('cancel')}
      />,
    ));
    const dialog = container.querySelector('[role=alertdialog]')!;
    expect(dialog.textContent).toContain('Replace 2 existing file(s)?');
    const buttons = [...dialog.querySelectorAll('button')];
    const cancel = buttons.find((button) => button.textContent === 'Cancel')!;
    const confirm = buttons.find((button) => button.textContent === 'Replace')!;
    // Cancel is focused first so a stray Enter cannot approve.
    expect(document.activeElement).toBe(cancel);

    await act(async () => confirm.click());
    expect(events).toEqual(['confirm']);

    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(events).toEqual(['confirm', 'cancel']);
    await act(async () => root.unmount());
  });
});
