import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Maximize2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { AnnotationLayer, PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';

/** The subset of the viewer's link service the annotation layer actually calls. */
type LinkService = ConstructorParameters<typeof AnnotationLayer>[0]['linkService'];

/**
 * PDF preview rendered with vendored PDF.js onto a canvas.
 *
 * The previous `<iframe sandbox="">` could never work: an empty sandbox
 * disables the browser's PDF plugin, and browsers configured to download
 * PDFs refuse to display them in frames at all. Rendering the pages ourselves
 * keeps the preview inside the app's theme and toolbar, independent of any
 * browser PDF setting. The library and its worker load on demand so the main
 * bundle stays lean; cMaps, standard fonts and wasm image decoders are copied
 * next to the app by `scripts/copy-pdfjs-assets.ts` (no CDN, per the security
 * rules).
 *
 * Over the canvas sit two DOM layers from the same library: a TextLayer with
 * transparent, selectable text (browser find-in-page works on it, and it is
 * the accessible path for a canvas render) and an AnnotationLayer with
 * clickable links. Form JavaScript stays inert: pdf.sandbox.mjs is only loaded
 * by the full viewer component, never by the bare API used here.
 */

const ASSET_BASE = `${import.meta.env.BASE_URL}pdfjs/`;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

interface PdfPreviewProps {
  url: string;
  filename: string;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'PasswordException') return 'This PDF is password-protected and cannot be previewed.';
    if (err.name === 'InvalidPDFException') return 'This file is not a readable PDF.';
    return err.message;
  }
  return String(err);
}

/**
 * Minimal link service for the annotation layer. External URLs are allowed
 * only over http(s) — a bucket object must not be able to navigate the app to
 * javascript: or data: URLs. Internal destinations turn pages in place.
 */
class PreviewLinkService {
  constructor(
    private readonly doc: PDFDocumentProxy,
    private readonly goTo: (page: number) => void,
    private readonly currentPage: number,
  ) {}

  getAnchorUrl(url: string): string {
    return safeExternalUrl(url) ?? '#';
  }

  getDestinationHash(destination: unknown): string {
    return `#pdfdest=${encodeURIComponent(JSON.stringify(destination))}`;
  }

  addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow?: boolean): void {
    const safe = safeExternalUrl(url);
    link.href = safe ?? '#';
    if (safe) {
      link.target = newWindow === false ? '_self' : '_blank';
      link.rel = 'noopener noreferrer';
    } else {
      link.onclick = (event) => event.preventDefault();
    }
  }

  async goToDestination(destination: unknown): Promise<void> {
    try {
      const explicit =
        typeof destination === 'string' ? await this.doc.getDestination(destination) : destination;
      if (!Array.isArray(explicit) || explicit.length === 0) return;
      const target = explicit[0];
      const index =
        typeof target === 'number'
          ? target
          : await this.doc.getPageIndex(target as { num: number; gen: number });
      this.goTo(index + 1);
    } catch {
      // Broken destination in the object: stay on the current page.
    }
  }

  executeNamedAction(action: string): void {
    if (action === 'NextPage') this.goTo(this.currentPage + 1);
    else if (action === 'PrevPage') this.goTo(this.currentPage - 1);
    else if (action === 'FirstPage') this.goTo(1);
    else if (action === 'LastPage') this.goTo(Number.MAX_SAFE_INTEGER);
  }
}

function safeExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function PdfPreview({ url, filename }: PdfPreviewProps) {
  const [lib, setLib] = useState<typeof import('pdfjs-dist') | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [cssSize, setCssSize] = useState({ width: 0, height: 0 });
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const annRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const textLayerRef = useRef<{ cancel: () => void } | null>(null);
  const annLayerRef = useRef<{ destroy: () => void } | null>(null);

  // Load the document (and the library) on demand.
  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        loadingTask = pdfjs.getDocument({
          url,
          cMapUrl: `${ASSET_BASE}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
          wasmUrl: `${ASSET_BASE}wasm/`,
        });
        const loaded = await loadingTask.promise;
        if (cancelled) return;
        setLib(pdfjs);
        setDoc(loaded);
        setNumPages(loaded.numPages);
        setPage(1);
        setPageInput('1');
        setError(null);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(messageOf(err));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      void loadingTask?.destroy().catch(() => {});
    };
  }, [url]);

  // Track the pane width so "100%" means fit-to-width.
  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(pane);
    setWidth(pane.clientWidth);
    return () => observer.disconnect();
  }, [loading, error]);

  const goTo = useCallback(
    (next: number) => {
      const clamped = Math.min(Math.max(1, next), Math.max(1, numPages));
      setPage(clamped);
      setPageInput(String(clamped));
      scrollRef.current?.scrollTo({ top: 0 });
    },
    [numPages],
  );

  // Render the current page whenever document, page, zoom or width changes.
  useEffect(() => {
    if (!doc || !lib || width === 0) return;
    let cancelled = false;
    void (async () => {
      setRendering(true);
      try {
        const pdfPage: PDFPageProxy = await doc.getPage(page);
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const natural = pdfPage.getViewport({ scale: 1 });
        const fit = Math.max(0.1, (width - 32) / natural.width);
        const viewport = pdfPage.getViewport({ scale: fit * zoom });
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const cssWidth = Math.floor(viewport.width);
        const cssHeight = Math.floor(viewport.height);
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        setCssSize({ width: cssWidth, height: cssHeight });
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D rendering is unavailable in this browser.');
        renderTaskRef.current?.cancel();
        const task = pdfPage.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
          background: '#ffffff',
        });
        renderTaskRef.current = task;
        await task.promise;
        if (cancelled) return;

        // Selectable/searchable text over the canvas.
        const textContainer = textRef.current;
        if (textContainer) {
          textLayerRef.current?.cancel();
          textContainer.replaceChildren();
          textContainer.style.setProperty('--scale-factor', String(viewport.scale));
          const textLayer = new lib.TextLayer({
            textContentSource: pdfPage.streamTextContent(),
            container: textContainer,
            viewport,
          });
          textLayerRef.current = textLayer;
          await textLayer.render();
        }
        if (cancelled) return;

        // Clickable links (internal destinations and safe external URLs).
        const annContainer = annRef.current;
        if (annContainer) {
          annLayerRef.current?.destroy();
          annContainer.replaceChildren();
          const linkService = new PreviewLinkService(doc, goTo, page) as unknown as LinkService;
          const annotations = await pdfPage.getAnnotations();
          if (cancelled) return;
          const layer = new lib.AnnotationLayer({
            div: annContainer,
            accessibilityManager: null,
            annotationCanvasMap: null,
            annotationEditorUIManager: null,
            page: pdfPage,
            viewport,
            structTreeLayer: null,
            commentManager: null,
            linkService,
            annotationStorage: null,
          });
          annLayerRef.current = layer;
          await layer.render({
            viewport,
            div: annContainer,
            annotations,
            page: pdfPage,
            linkService,
            renderForms: false,
          });
        }
        if (cancelled) return;
        // PDFs without /Contents leave unnamed links; name them for AT users.
        for (const anchor of annContainer?.querySelectorAll('a') ?? []) {
          if (anchor.getAttribute('aria-label') || anchor.textContent?.trim()) continue;
          const href = anchor.getAttribute('href') ?? '';
          const external = safeExternalUrl(href);
          anchor.setAttribute(
            'aria-label',
            external ? `Link to ${new URL(external).host}` : 'Link inside this document',
          );
        }
        // Free page-level resources; the next zoom/page change re-fetches them.
        pdfPage.cleanup();
        setRendering(false);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'RenderingCancelledException') return;
        setError(messageOf(err));
        setRendering(false);
      }
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      textLayerRef.current?.cancel();
      annLayerRef.current?.destroy();
    };
  }, [doc, lib, page, zoom, width, goTo]);

  // Page turning with the arrow keys — but never over a focused control, and
  // never after another handler claimed the key. PageUp/PageDown stay with
  // the scroll pane so zoomed pages can still be paged normally.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, a, [role="listbox"]')) return;
      if (event.key === 'ArrowRight') goTo(page + 1);
      else if (event.key === 'ArrowLeft') goTo(page - 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goTo, page]);

  const commitPageInput = () => {
    const parsed = Number.parseInt(pageInput, 10);
    goTo(Number.isFinite(parsed) ? parsed : page);
  };

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertTriangle size={24} className="text-red-500" />
        <p className="text-sm text-red-600 dark:text-red-400 max-w-md break-words">{error}</p>
        <a
          href={url}
          download={filename}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors"
        >
          <Download size={13} />
          Download instead
        </a>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-zinc-500" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-none flex flex-wrap items-center gap-1 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500">
        <button
          type="button"
          onClick={() => goTo(page - 1)}
          disabled={page <= 1}
          className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Previous page"
        >
          <ChevronLeft size={14} />
        </button>
        <input
          value={pageInput}
          onChange={(event) => setPageInput(event.target.value.replace(/[^\d]/g, ''))}
          onBlur={commitPageInput}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitPageInput();
          }}
          inputMode="numeric"
          aria-label="Page number"
          className="w-10 px-1 py-0.5 text-center tabular-nums rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 text-zinc-700 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-teal-500"
        />
        <span className="tabular-nums">of {numPages}</span>
        <button
          type="button"
          onClick={() => goTo(page + 1)}
          disabled={page >= numPages}
          className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Next page"
        >
          <ChevronRight size={14} />
        </button>

        <span className="w-px h-4 mx-1.5 bg-zinc-200 dark:bg-zinc-700" aria-hidden="true" />

        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(MIN_ZOOM, +(z - 0.25).toFixed(2)))}
          disabled={zoom <= MIN_ZOOM}
          className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Zoom out"
        >
          <ZoomOut size={14} />
        </button>
        <span className="tabular-nums w-12 text-center">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(MAX_ZOOM, +(z + 0.25).toFixed(2)))}
          disabled={zoom >= MAX_ZOOM}
          className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Zoom in"
        >
          <ZoomIn size={14} />
        </button>
        <button
          type="button"
          onClick={() => setZoom(1)}
          className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label="Reset zoom to fit width"
        >
          <Maximize2 size={14} />
        </button>

        <span className="flex-1" />
        {rendering && <Loader2 size={13} className="animate-spin text-zinc-400" aria-label="Rendering page" />}
        <span className="hidden md:inline text-zinc-400 dark:text-zinc-500">← → pages · select text to copy</span>
        <a
          href={url}
          download={filename}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <Download size={13} />
          Download
        </a>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto bg-zinc-100 dark:bg-zinc-900 p-4">
        <div
          className="relative mx-auto shadow-lg rounded-sm bg-white"
          style={{ width: cssSize.width || undefined, height: cssSize.height || undefined }}
        >
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`${filename}, page ${page} of ${numPages}`}
            className="block rounded-sm"
          />
          <div ref={textRef} className="textLayer" />
          <div ref={annRef} className="annotationLayer" />
        </div>
      </div>
    </div>
  );
}
