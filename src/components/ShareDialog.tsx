import { useCallback, useEffect, useState } from 'react';
import { useLiveQuery } from '@electric-sql/pglite-react';
import {
  Link2,
  Copy,
  Check,
  Trash2,
  Loader2,
  AlertTriangle,
  X,
  Download,
  Upload,
  Clock,
} from 'lucide-react';
import type { AppDB, ConnectionRow, ObjectRow } from '../db/client';
import { bridgeTokenFor } from '../bridge/session';
import {
  EXPIRY_PRESETS,
  createLink,
  deleteLink,
  isExpired,
  purgeExpiredLinks,
  revocationHint,
  type LinkPermission,
  type PresignedRecord,
} from '../s3/links';

interface ShareDialogProps {
  db: AppDB;
  profile: ConnectionRow;
  file: ObjectRow;
  onClose: () => void;
}

export function ShareDialog({ db, profile, file, onClose }: ShareDialogProps) {
  const [permission, setPermission] = useState<LinkPermission>('read');
  const [expirySeconds, setExpirySeconds] = useState(EXPIRY_PRESETS[0]?.seconds ?? 3600);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const links = useLiveQuery<PresignedRecord>(
    `SELECT * FROM presigned_history WHERE profile_id = $1 AND key = $2
      ORDER BY created_at DESC LIMIT 20`,
    [profile.id, file.key],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleGenerate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await createLink(db, profile, file.key, permission, expirySeconds);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [db, profile, file.key, permission, expirySeconds]);

  const handleCopy = useCallback(async (link: PresignedRecord) => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopiedId(link.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      setError('Clipboard unavailable in this context.');
    }
  }, []);

  const rows = links?.rows ?? [];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 px-6 pt-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
              <Link2 size={18} className="text-teal-500" />
              Share link
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5 truncate" title={file.key}>
              {file.key}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 -mr-2 -mt-1 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Close share dialog"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {bridgeTokenFor(profile.id) && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Share links point directly to S3. The local companion does not serve them to recipients.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                Permission
              </label>
              <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setPermission('read')}
                  aria-pressed={permission === 'read'}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs transition-colors ${
                    permission === 'read'
                      ? 'bg-teal-600 text-white'
                      : 'text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                  }`}
                >
                  <Download size={12} />
                  Read
                </button>
                <button
                  type="button"
                  onClick={() => setPermission('write')}
                  aria-pressed={permission === 'write'}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs transition-colors ${
                    permission === 'write'
                      ? 'bg-teal-600 text-white'
                      : 'text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                  }`}
                >
                  <Upload size={12} />
                  Write
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="link-expiry"
                className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1"
              >
                Expires in
              </label>
              <select
                id="link-expiry"
                value={expirySeconds}
                onChange={(e) => setExpirySeconds(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-teal-500 dark:text-zinc-100"
              >
                {EXPIRY_PRESETS.map((preset) => (
                  <option key={preset.seconds} value={preset.seconds}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {permission === 'write' && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              Write links are signed with <code>Content-Type: application/octet-stream</code> — the
              uploader must send exactly that header.
            </p>
          )}

          {error && (
            <div className="flex items-start gap-2 p-2.5 text-xs rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400">
              <AlertTriangle size={14} className="flex-none mt-0.5" />
              <span className="break-words">{error}</span>
            </div>
          )}

          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={busy}
            className="w-full inline-flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-4 py-2.5 rounded-lg font-medium text-sm transition-colors disabled:opacity-60"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />}
            Generate {permission === 'read' ? 'download' : 'upload'} link
          </button>

          {rows.length > 0 && (
            <div className="border-t border-zinc-100 dark:border-zinc-800 pt-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
                  History ({rows.length})
                </h3>
                <button
                  type="button"
                  onClick={() => void purgeExpiredLinks(db)}
                  className="text-[11px] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  Purge expired
                </button>
              </div>

              <ul className="space-y-1.5 max-h-56 overflow-y-auto">
                {rows.map((link) => {
                  const expired = isExpired(link);
                  return (
                    <li
                      key={link.id}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40"
                    >
                      {link.permission === 'read' ? (
                        <Download size={12} className="text-zinc-400 flex-none" />
                      ) : (
                        <Upload size={12} className="text-zinc-400 flex-none" />
                      )}
                      <span
                        className={`text-[11px] tabular-nums flex-1 ${
                          expired ? 'text-zinc-400 line-through' : 'text-zinc-600 dark:text-zinc-300'
                        }`}
                      >
                        {new Date(link.expires_at).toLocaleString()}
                        {expired ? ' (expired)' : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleCopy(link)}
                        className="p-1.5 rounded text-zinc-400 hover:text-teal-600 dark:hover:text-teal-400"
                        title="Copy URL"
                        aria-label="Copy URL"
                      >
                        {copiedId === link.id ? (
                          <Check size={12} className="text-green-500" />
                        ) : (
                          <Copy size={12} />
                        )}
                      </button>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="p-1.5 rounded text-zinc-400 hover:text-teal-600 dark:hover:text-teal-400"
                        title="Open link"
                        aria-label="Open link"
                      >
                        <Link2 size={12} />
                      </a>
                      <DeleteLinkButton db={db} id={link.id} />
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <p className="flex items-start gap-2 text-[11px] text-zinc-400 dark:text-zinc-500 leading-relaxed">
            <Clock size={13} className="flex-none mt-0.5" />
            {revocationHint}
          </p>
        </div>
      </div>
    </div>
  );
}

function DeleteLinkButton({ db, id }: { db: AppDB; id: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await deleteLink(db, id);
        } finally {
          setBusy(false);
        }
      }}
      className="p-1.5 rounded text-zinc-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
      title="Forget this link"
      aria-label="Forget this link"
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
    </button>
  );
}
