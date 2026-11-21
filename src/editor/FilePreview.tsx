import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, ZoomIn, ZoomOut, Maximize2, AlertTriangle, Download, FileQuestion } from 'lucide-react';
import type { AppDB, ConnectionRow, ObjectRow } from '../db/client';
import { profileConfig, listingCredentials } from '../db/objects';
import { vaultService } from '../vault/vaultService';
import type { PreviewKind } from './filetypes';
import { formatBytes } from '../lib/format';
import { PdfPreview } from './PdfPreview';

interface FilePreviewProps {
  db: AppDB;
  profile: ConnectionRow;
  file: ObjectRow;
  kind: PreviewKind;
}

/** Same-origin media URL. The Galiot server streams the object, so the browser need not reach S3. */
async function previewUrl(db: AppDB, profile: ConnectionRow, key: string): Promise<string> {
  const sealed = await listingCredentials(db, profile);
  const { url } = await vaultService.call('s3.mediaUrl', {
    profile: profileConfig(profile),
    credentials: { sealed },
    key,
  });
  return url;
}

export function FilePreview({ db, profile, file, kind }: FilePreviewProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const signed = await previewUrl(db, profile, file.key);
        if (!cancelled) {
          urlRef.current = signed;
          setUrl(signed);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      // The preview grant is session-bound; hand it back when the pane closes
      // so its credential snapshot does not linger for the full TTL.
      const owned = urlRef.current;
      urlRef.current = null;
      if (owned) {
        void (async () => {
          const sealed = await listingCredentials(db, profile);
          await vaultService.call('s3.revokeMedia', {
            profile: profileConfig(profile),
            credentials: { sealed },
            token: owned.split('/').pop() ?? '',
          });
        })().catch(() => {});
      }
    };
  }, [db, profile, file.key]);

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPanning({ x: drag.originX + (event.clientX - drag.x), y: drag.originY + (event.clientY - drag.y) });
  }, []);

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center">
        <AlertTriangle size={24} className="text-red-500 mb-3" />
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      </div>
    );
  }

  if (!url) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-zinc-500" />
      </div>
    );
  }

  if (kind === 'pdf') {
    return <PdfPreview url={url} filename={file.filename} />;
  }

  if (kind === 'binary') {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
        <FileQuestion size={32} className="text-zinc-400 dark:text-zinc-500" />
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">No preview for this file type</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-sm break-words">
          {file.filename} · {formatBytes(Number(file.size))} — the content is neither text nor a
          previewable media format. Download it to open with a local application.
        </p>
        <a
          href={url}
          download={file.filename}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors"
        >
          <Download size={13} />
          Download file
        </a>
      </div>
    );
  }

  if (kind === 'audio') {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 p-8">
        <p className="text-sm text-zinc-600 dark:text-zinc-300">{file.filename}</p>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio src={url} controls className="w-full max-w-xl" />
      </div>
    );
  }

  if (kind === 'video') {
    return (
      <div className="h-full flex items-center justify-center bg-black">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={url} controls className="max-h-full max-w-full" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-none flex items-center gap-1 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.1, +(z - 0.25).toFixed(2)))}
          className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label="Zoom out"
        >
          <ZoomOut size={14} />
        </button>
        <span className="tabular-nums w-12 text-center">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(10, +(z + 0.25).toFixed(2)))}
          className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label="Zoom in"
        >
          <ZoomIn size={14} />
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            setPanning({ x: 0, y: 0 });
          }}
          className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label="Reset zoom"
        >
          <Maximize2 size={14} />
        </button>
        <span className="ml-2 text-zinc-500">drag to pan when zoomed</span>
      </div>

      <div
        className="flex-1 min-h-0 overflow-auto bg-zinc-100 dark:bg-zinc-900"
        style={{ cursor: zoom > 1 ? (dragRef.current ? 'grabbing' : 'grab') : 'default' }}
        onPointerDown={(event) => {
          if (zoom <= 1) return;
          dragRef.current = {
            x: event.clientX,
            y: event.clientY,
            originX: panning.x,
            originY: panning.y,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerLeave={() => {
          dragRef.current = null;
        }}
      >
        <img
          src={url}
          alt={file.filename}
          draggable={false}
          className="block select-none"
          style={{
            transform: `translate(${panning.x}px, ${panning.y}px) scale(${zoom})`,
            transformOrigin: 'top left',
            imageRendering: zoom > 2 ? 'pixelated' : 'auto',
          }}
        />
      </div>
    </div>
  );
}
