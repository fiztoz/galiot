import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';

/**
 * Headless lifecycle coverage for the PDF pane: document load, page/zoom
 * controls, error fallback and teardown. Rasterisation itself needs a real
 * browser; everything around it is exercised here against a mocked pdfjs.
 */

const state = { destroyed: 0, renders: 0, fail: false };

class FakeTextLayer {
  async render() {}
  cancel() {}
}
class FakeAnnotationLayer {
  async render() {}
  destroy() {}
}
const fakePage = () => ({
  getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale, scale, userUnit: 1 }),
  render: () => {
    state.renders += 1;
    return { promise: Promise.resolve(), cancel() {} };
  },
  streamTextContent: () => new ReadableStream({ start(controller) { controller.close(); } }),
  getAnnotations: async () => [],
  cleanup() {},
});
const fakeDoc = {
  numPages: 2,
  getPage: async () => fakePage(),
  getDestination: async () => null,
  getPageIndex: async () => 0,
};

mock.module('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({
    promise: state.fail ? Promise.reject(new Error('boom')) : Promise.resolve(fakeDoc),
    destroy: async () => {
      state.destroyed += 1;
    },
  }),
  TextLayer: FakeTextLayer,
  AnnotationLayer: FakeAnnotationLayer,
}));
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/worker.mjs' }));

async function withDom(run: (container: HTMLElement, window: Window) => Promise<void>) {
  const window = new Window({ url: 'https://example.com' });
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, {
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      constructor(private readonly cb: (entries: { contentRect: { width: number } }[]) => void) {}
      observe() {
        // Async like the real observer: happy-dom reports clientWidth 0, so
        // the synchronous fallback must not overwrite this measurement.
        queueMicrotask(() => this.cb([{ contentRect: { width: 800 } }]));
      }
      disconnect() {}
      unobserve() {}
    },
  });
  window.HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as typeof window.HTMLCanvasElement.prototype.getContext;
  const container = document.createElement('div');
  document.body.appendChild(container);
  try {
    await run(container, window);
  } finally {
    container.remove();
    for (const key of Object.keys(globalThis)) {
      if (!(key in previous)) delete (globalThis as Record<string, unknown>)[key];
    }
    Object.defineProperties(globalThis, previous);
  }
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) {
    await act(async () => {
      await Bun.sleep(5);
    });
  }
  expect(predicate()).toBe(true);
}

test('PdfPreview loads, turns pages, zooms and destroys its document on unmount', async () => {
  state.destroyed = 0;
  state.renders = 0;
  state.fail = false;
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const { PdfPreview } = await import('./PdfPreview');
    const root = createRoot(container);
    await act(async () => root.render(<PdfPreview url="/api/s3/media/aaa" filename="a.pdf" />));
    await waitFor(() => container.textContent?.includes('of 2') === true);
    expect(state.renders).toBeGreaterThan(0);

    const byLabel = (label: string) =>
      [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label)!;
    await act(async () => byLabel('Next page').click());
    expect((container.querySelector('input[aria-label="Page number"]') as HTMLInputElement).value).toBe('2');
    expect(byLabel('Next page').disabled).toBe(true);
    await act(async () => byLabel('Previous page').click());
    expect((container.querySelector('input[aria-label="Page number"]') as HTMLInputElement).value).toBe('1');

    await act(async () => byLabel('Zoom in').click());
    expect(container.textContent).toContain('125%');
    await act(async () => byLabel('Reset zoom to fit width').click());
    expect(container.textContent).toContain('100%');

    // The selectable-text and link layers exist over the canvas.
    expect(container.querySelector('.textLayer')).not.toBeNull();
    expect(container.querySelector('.annotationLayer')).not.toBeNull();

    await act(async () => root.unmount());
    expect(state.destroyed).toBeGreaterThan(0);
  });
});

test('PdfPreview shows a download fallback when the document cannot load', async () => {
  state.fail = true;
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const { PdfPreview } = await import('./PdfPreview');
    const root = createRoot(container);
    await act(async () => root.render(<PdfPreview url="/api/s3/media/bbb" filename="b.pdf" />));
    await waitFor(() => container.textContent?.includes('boom') === true);
    const fallback = container.querySelector('a[download="b.pdf"]');
    expect(fallback?.textContent).toContain('Download instead');
    await act(async () => root.unmount());
  });
  state.fail = false;
});
