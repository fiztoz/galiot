// Fixed component scenarios on the sibling, synthetic fixture only. No OS input,
// external navigation, downloads, credentials, or connection to a running Galiot.
const frame = document.querySelector('iframe')!;
const start = document.querySelector<HTMLButtonElement>('#run')!;
const status = document.querySelector('#status')!;
const results = document.querySelector('#results')!;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(label: string, read: () => T | null | undefined | false): Promise<T> {
  for (let i = 0; i < 160; i++) { const result = read(); if (result) return result; await delay(50); }
  throw new Error(label);
}
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

start.onclick = async () => {
  start.disabled = true;
  results.replaceChildren();
  let step = 'initialise';
  const check = async (name: string, test: () => Promise<void>) => {
    step = name; status.textContent = name; await test();
    const item = document.createElement('li'); item.textContent = `PASS · ${name}`; results.append(item);
  };
  try {
    frame.width = '1440'; frame.height = '900';
    const doc = frame.contentDocument!;
    const win = doc.defaultView!;
    const q = <T extends HTMLElement = HTMLElement>(selector: string) => doc.querySelector<T>(selector);
    const by = <T extends HTMLElement = HTMLElement>(name: string) => q<T>(`[aria-label="${name}"]`);
    const button = (name: string) => Array.from(doc.querySelectorAll('button')).find(b => b.textContent?.trim() === name);
    const row = (name: string) => q(`[role="option"][aria-label="${name}"]`)!;
    const selected = () => Array.from(doc.querySelectorAll('[role="option"][aria-selected="true"]')).map(e => e.getAttribute('aria-label'));
    const box = (e: Element) => e.getBoundingClientRect();
    const hit = (e: Element) => { const b = box(e); return e.contains(doc.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); };
    const press = (el: Element, key: string, shiftKey = false) => el.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    const pdf = () => q('[role="dialog"][aria-label="report.pdf"]')!;
    const sep = () => by('Resize preview panel')!;
    const pdfPage = (n: number) => by(`report.pdf, page ${n} of 2`) && !by('Rendering page');

    await check('Desktop header and density', async () => {
      await until('fixture did not render its five rows', () => doc.querySelectorAll('[role="option"]').length === 5);
      const toggle = by('Toggle compact rows')!; assert(hit(toggle), 'density toggle is obscured');
      const h = box(row('report.pdf')).height; toggle.click();
      await until('density did not change row height', () => box(row('report.pdf')).height !== h);
      assert([28, 36].includes(h) && [28, 36].includes(box(row('report.pdf')).height), 'unexpected density');
    });
    await check('390px header, columns and native checkbox hit target', async () => {
      frame.width = '390'; await until('phone width', () => win.innerWidth === 390);
      const toggle = by('Toggle compact rows')!, path = by('Folder path')!;
      assert(hit(toggle) && box(toggle).right <= 390 && box(path).width > 0 && doc.documentElement.scrollWidth === 390, 'phone header clips or overflows');
      const size = Array.from(doc.querySelectorAll('span')).find(e => e.textContent === 'Size')!;
      const modified = size.nextElementSibling!; assert(!box(size).width && !box(modified).width, 'low-priority columns visible');
      const all = by<HTMLInputElement>('Select all objects in view')!, first = by<HTMLInputElement>('Select report.pdf')!;
      assert(box(first).width >= 16 && hit(first) && hit(all), 'checkbox is not its own visible hit target');
      first.click(); await until('single or mixed state', () => first.checked && all.indeterminate && selected().length === 1);
      all.click(); await until('select-all', () => all.checked && !all.indeterminate && selected().length === 5);
      all.click(); await until('clear-all', () => !all.checked && !all.indeterminate && selected().length === 0);
    });
    await check('Shift range, selection-aware palette, shortcuts and Escape', async () => {
      frame.width = '1440'; await until('desktop width', () => win.innerWidth === 1440);
      row('blob.bin').click(); row('photo.png').dispatchEvent(new MouseEvent('click', {bubbles:true, shiftKey:true}));
      await until('wrong selected range', () => selected().join(',') === 'blob.bin,notes,photo.png');
      by('Open command palette')!.click(); const input = await until('palette not open', () => by('Command palette'));
      const cmd = q('[role="dialog"] li:first-child button');
      assert(cmd?.textContent?.includes('Download selection') && cmd.textContent.includes('3 object'), 'download selection is not first with correct count');
      press(input,'Escape'); await until('palette not dismissed', () => !by('Command palette'));
      press(row('blob.bin'),'?'); const sheet = await until('shortcuts sheet not open', () => Array.from(doc.querySelectorAll('[role="dialog"]')).find(e=>e.textContent?.includes('Keyboard shortcuts')));
      press(sheet,'Escape'); await until('sheet not dismissed', () => !sheet.isConnected);
    });
    await check('Binary fallback and close', async () => {
      row('blob.bin').click();
      await until('binary row is not the sole selection', () => selected().join(',') === 'blob.bin' && button('Open'));
      press(row('blob.bin'),'Enter');
      await until('binary fallback absent', () => q('[role="dialog"][aria-label="blob.bin"]')?.textContent?.includes('No preview for this file type'));
      by('Close editor')!.click(); await until('binary preview not closed', () => !by('Close editor'));
    });
    await check('Extensionless text opens in the full-screen editor', async () => {
      row('notes').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));
      await until('text did not open in CodeMirror', () => q('[role="dialog"][aria-modal="true"] .cm-content')?.textContent?.includes('hello harness'));
      by('Close editor')!.click(); await until('text editor not closed', () => !by('Close editor'));
    });
    await check('Dock reflows table and leaves selection actions reachable', async () => {
      row('report.pdf').click(); await until('PDF not selected', () => selected().join(',') === 'report.pdf');
      row('report.pdf').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
      await until('first PDF page not rendered', () => pdfPage(1) && sep());
      const table = by('Objects in this folder')!, clear = by('Clear selection')!;
      assert(Math.abs(box(table).right - box(pdf()).left) <= 1 && box(clear).right <= box(pdf()).left && hit(clear), 'dock overlaps Explorer');
      const before = box(pdf()).width; sep().focus(); press(sep(), before >= 720 ? 'ArrowRight' : 'ArrowLeft');
      await until('splitter key did not resize/reflow', () => Math.abs(box(pdf()).width - before) === 40 && Math.abs(box(table).right - box(pdf()).left) <= 1);
      assert(Number(sep().getAttribute('aria-valuenow')) === box(pdf()).width && hit(sep()), 'splitter value or hit target incorrect');
    });
    await check('Pointer resize, release and intermediate-width columns', async () => {
      const handle = sep(), table = by('Objects in this folder')!;
      // Synthetic PointerEvents have no hardware capture session. Record only
      // that platform boundary; exercise the real React handlers and flex layout.
      let captured = 0;
      handle.setPointerCapture = id => { captured = id; };
      const move = (kind: string, width: number) => handle.dispatchEvent(new PointerEvent(kind, {
        bubbles: true, pointerId: 3, isPrimary: true, button: 0, clientX: win.innerWidth - width,
      }));
      try {
        move('pointerdown', box(pdf()).width); move('pointermove', 650);
        await until('pointer move did not resize both panes', () => captured === 3 && box(pdf()).width === 650 && box(table).width === 790);
        move('pointerup', 650); move('pointermove', 700); await delay(50);
        assert(box(pdf()).width === 650 && win.localStorage.getItem('galiot.previewWidth') === '650', 'release/persistence failed');
      } finally { Reflect.deleteProperty(handle, 'setPointerCapture'); }
      frame.width = '920'; await until('table not protected at intermediate width', () => box(table).width === 384 && box(pdf()).width === 536);
      const columns = row('report.pdf').children;
      assert(box(columns[2]!).width === 0 && box(columns[3]!).width === 0, 'columns still follow viewport instead of pane');
      frame.width = '1440'; await until('preferred width not restored', () => box(pdf()).width === 650 && box(columns[3]!).width > 0);
    });
    await check('Selectable PDF text and hit-tested internal page link', async () => {
      const text = await until('text layer missing', () => Array.from(doc.querySelectorAll('.textLayer span')).find(s=>s.textContent?.includes('quick brown fox') && box(s).width>5));
      const sel = win.getSelection()!, range = doc.createRange(); range.selectNodeContents(text); sel.removeAllRanges(); sel.addRange(range);
      assert(sel.toString().includes('quick brown fox') && win.getComputedStyle(text).userSelect !== 'none' && hit(text), 'text selection not reachable'); sel.removeAllRanges();
      const link = await until('internal PDF annotation has no clickable bounds', () => Array.from(doc.querySelectorAll<HTMLAnchorElement>('.annotationLayer a[href^="#"]')).find(hit));
      link.click(); await until('internal destination did not turn the page', () => pdfPage(2));
    });
    await check('Expand, focus trap, zoom, redock and phone preview', async () => {
      by('Expand preview to full screen')!.click(); await until('expand failed', () => pdf().getAttribute('aria-modal') === 'true' && box(pdf()).width === 1440);
      const focusables = Array.from(pdf().querySelectorAll<HTMLElement>('button:not([disabled]),input,a[href]')).filter(e=>box(e).width);
      focusables.at(-1)!.focus(); press(focusables.at(-1)!,'Tab'); assert(doc.activeElement === focusables[0], 'expanded panel does not trap Tab');
      by('Zoom in')!.click(); await until('zoom failed', () => pdf().textContent?.includes('125%'));
      by('Dock preview beside the table')!.click(); await until('redock failed', () => sep() && !pdf().hasAttribute('aria-modal') && pdfPage(2));
      frame.width='390'; await until('phone preview is not a full-width modal', () => pdf().getAttribute('aria-modal') === 'true' && box(pdf()).width === 390 && !sep());
      press(pdf(),'Escape'); await until('Escape failed to close phone preview', () => !by('Close editor'));
    });
    await check('Failed transfer count and exact aggregate retry requests', async () => {
      button('Transfers')!.click(); const retry = await until('retry action not found', () => q<HTMLButtonElement>('[title="Retry all failed downloads"]'));
      assert(retry.textContent?.trim() === 'Retry 2' && doc.body.textContent?.includes('2 failed'), 'incorrect failure or retry count');
      retry.click(); await until('retry did not request exactly the two failed downloads', () => (JSON.parse(doc.body.dataset.retried ?? '[]') as string[]).sort().join(',') === 'gone-one.bin,gone-two.bin');
    });
    status.textContent = `PASS · ${results.children.length} scenarios`;
  } catch (err) {
    status.textContent = `FAIL · ${step}: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    document.title = status.textContent ?? 'Explorer layout checks';
    status.scrollIntoView({block: 'start'});
  }
};
