import { expect, spyOn, test } from 'bun:test';
import { EditorView } from '@codemirror/view';
import { Window } from 'happy-dom';
import { act } from 'react';
import { EditorPanel } from './EditorPanel';
import type { AppDB, ConnectionRow, ObjectRow } from '../db/client';
import { vaultService } from '../vault/vaultService';

test('Diff edits survive mode switches and a failed save, then use the reviewed revision on retry', async () => {
  const window = new Window();
  const globals = {
    window, document: window.document, navigator: window.navigator, MutationObserver: window.MutationObserver,
    HTMLElement: window.HTMLElement, Node: window.Node, Window: window.Window,
    getComputedStyle: window.getComputedStyle.bind(window), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, globals);
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const rpc = spyOn(vaultService, 'call');
  const baseline = { text: 'one\r\ntwo', size: 8, contentType: 'application/json', eTag: '"read"', conditionalPut: true };
  rpc.mockResolvedValueOnce(baseline).mockRejectedValueOnce(new Error('remote changed'))
    .mockResolvedValueOnce({ ...baseline, text: 'latest', eTag: '"reviewed"' }).mockResolvedValueOnce({ eTag: '"saved"' });
  const db = { query: async () => ({ rows: [{ encrypted_credentials: {} }] }) } as unknown as AppDB;
  const profile = { id: 'profile', bucket: 'archive' } as ConnectionRow;
  const file = { key: 'doc.txt', size: 8 } as ObjectRow;
  const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label)!;
  const draft = () => EditorView.findFromDOM(container.querySelector('[aria-label="Local edits"]')!)!;
  try {
    await act(async () => { root.render(<EditorPanel db={db} profile={profile} file={file} onSaved={() => {}} onClose={() => {}} />); });
    await act(async () => { button('Diff').click(); });
    await act(async () => { draft().dispatch({ changes: { from: draft().state.doc.length, insert: '!' } }); });
    await act(async () => { button('Edit').click(); });
    expect(draft().state.sliceDoc()).toBe('one\r\ntwo!');
    await act(async () => { button('Save & upload').click(); });
    expect(container.textContent).toContain('remote changed');
    expect(button('Save & upload').disabled).toBe(false);
    expect(draft().state.sliceDoc()).toBe('one\r\ntwo!');
    await act(async () => { button('Compare with latest').click(); });
    expect(EditorView.findFromDOM(container.querySelector('[aria-label="Remote version"]')!)!.state.sliceDoc()).toBe('latest');
    await act(async () => { button('Save & upload').click(); });
    expect(rpc.mock.calls.at(-1)).toMatchObject(['s3.putText', { body: 'one\r\ntwo!', eTag: '"reviewed"', contentType: 'application/json' }]);
    expect(button('Save & upload').disabled).toBe(true);
  } finally {
    act(() => root.unmount());
    rpc.mockRestore();
    await window.happyDOM.close();
    for (const name of Object.keys(globals)) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
