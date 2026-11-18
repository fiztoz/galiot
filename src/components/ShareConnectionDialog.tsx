import { useEffect, useState } from 'react';
import { Check, Copy, Download, Share2, X } from 'lucide-react';
import type { ConnectionRow } from '../db/client';
import { connectionShareText } from '../vault/share';
import { useFocusTrap } from '../lib/useFocusTrap';

interface ShareConnectionDialogProps {
  profile: ConnectionRow;
  onClose: () => void;
}

/** Exports one connection as secret-free JSON: copy it or save it as a file. */
export function ShareConnectionDialog({ profile, onClose }: ShareConnectionDialogProps) {
  const [copied, setCopied] = useState(false);
  const text = connectionShareText(profile);
  const trapRef = useFocusTrap<HTMLDivElement>();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (permissions, non-secure context); the
      // textarea below still allows manual copying.
    }
  };

  const download = () => {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${profile.name.replace(/[^\w.-]+/g, '-') || 'connection'}.galiot.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-connection-title"
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-lg"
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <h2 id="share-connection-title" className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
            <Share2 size={18} className="text-zinc-500" />
            Share connection
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 -mr-2 rounded-lg text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            This carries the endpoint, bucket, and settings — <span className="font-medium">no keys</span>.
            The recipient imports it and types their own credentials.
          </p>
          <textarea
            readOnly
            value={text}
            rows={10}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full px-3 py-2 font-mono text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-lg text-zinc-700 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-teal-500"
            aria-label="Connection JSON"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void copy()}
              className="flex-1 inline-flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-4 py-2.5 rounded-lg font-medium text-sm"
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Copied' : 'Copy JSON'}
            </button>
            <button
              type="button"
              onClick={download}
              className="flex-1 inline-flex items-center justify-center gap-2 border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 px-4 py-2.5 rounded-lg font-medium text-sm"
            >
              <Download size={15} />
              Save file
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
