import { useCallback, useEffect, useState } from 'react';
import { BRAND } from '../branding';
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
import type { AppDB, ObjectRow } from '../db/client';
import { useFocusTrap } from '../lib/useFocusTrap';
import {
  EXPIRY_PRESETS,
  createLink,
  deleteLink,
  isExpired,
  isServerLink,
  purgeExpiredLinks,
  revocationHint,
  serverLinkHint,
  serverWriteHint,
  type LinkPermission,
  type PresignedRecord,
  type ShareTarget,
} from '../s3/links';

interface ShareDialogProps {
  db: AppDB;
  target: ShareTarget;
  currentIdentity: string | undefined;
  file: ObjectRow | null;
  onClose: () => void;
}

export function ShareDialog({ db, target, currentIdentity, file, onClose }: ShareDialogProps) {
  const [permission, setPermission] = useState<LinkPermission>('read');
  const [via, setVia] = useState<'server' | 's3'>('server');
  const [maxBytes, setMaxBytes] = useState(100 * 1024 * 1024);
  const [expirySeconds, setExpirySeconds] = useState(EXPIRY_PRESETS[0]?.seconds ?? 3600);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const trapRef = useFocusTrap<HTMLDivElement>();

  const links = useLiveQuery<PresignedRecord>(
    file
      ? `SELECT * FROM presigned_history WHERE profile_id = $1 AND target_identity = $2 AND key = $3
         ORDER BY created_at DESC LIMIT 20`
      : 'SELECT * FROM presigned_history WHERE profile_id = $1 ORDER BY created_at DESC',
    file ? [target.profile_id, target.target_identity, file.key] : [target.profile_id],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleGenerate = useCallback(async () => {
    if (!file || currentIdentity !== target.target_identity) return;
    setBusy(true);
    setError(null);
    try {
      await createLink(db, target, file.key, permission, expirySeconds, via, maxBytes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [db, target, currentIdentity, file, permission, expirySeconds, via, maxBytes]);

  const handleCopy = useCallback(async (link: PresignedRecord) => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopiedId(link.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      setError('Clipboard unavailable in this context.');
    }
  }, []);

  const stale = file !== null && currentIdentity !== target.target_identity;
  // A live query can retain its last result while subscribing with new parameters.
  const rows = stale ? [] : (links?.rows ?? []).filter(link =>
    link.profile_id === target.profile_id && (!file || (link.key === file.key && link.target_identity === target.target_identity)));

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between gap-3 px-6 pt-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <div className="min-w-0">
            <h2 id="share-title" className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
              <Link2 size={18} className="text-teal-500" />
              {file ? 'Share link' : 'Connection link history'}
            </h2>
            {file && <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5 truncate" title={file.key}>
              {file.key}
            </p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 -mr-2 -mt-1 rounded-lg text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Close share dialog"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {stale && <p role="alert">Connection changed. Close this dialog and select the object again.</p>}
          {file && !stale && <>
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

          <div>
              <label className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                Link route
              </label>
              <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setVia('server')}
                  aria-pressed={via === 'server'}
                  className={`flex-1 px-2 py-1.5 text-xs transition-colors ${
                    via === 'server'
                      ? 'bg-teal-600 text-white'
                      : 'text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                  }`}
                >
                  Through this server
                </button>
                <button
                  type="button"
                  onClick={() => setVia('s3')}
                  aria-pressed={via === 's3'}
                  className={`flex-1 px-2 py-1.5 text-xs transition-colors ${
                    via === 's3'
                      ? 'bg-teal-600 text-white'
                      : 'text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                  }`}
                >
                  Direct S3
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                {via === 'server'
                  ? permission === 'read'
                    ? `Streams from this ${BRAND.name} host. Works for people who cannot reach S3, and can be revoked here.`
                    : `Accepts one bounded PUT through this ${BRAND.name} host. Works for people who cannot reach S3, and can be revoked here.`
                  : permission === 'read'
                    ? 'A presigned S3 URL. The recipient must be able to reach the bucket themselves.'
                    : 'A presigned S3 PUT signed with Content-Type: application/octet-stream — the uploader must reach S3 and send exactly that header.'}
              </p>
          </div>

          {permission === 'write' && via === 'server' && (
            <div>
              <label className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                Upload cap
              </label>
              <select
                value={maxBytes}
                onChange={(event) => setMaxBytes(Number(event.target.value))}
                className="w-full px-2.5 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-lg text-zinc-700 dark:text-zinc-200"
                aria-label="Upload cap"
              >
                <option value={10 * 1024 * 1024}>10 MiB</option>
                <option value={100 * 1024 * 1024}>100 MiB</option>
                <option value={1024 * 1024 * 1024}>1 GiB</option>
              </select>
              <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                The recipient uploads with a single PUT, e.g.{' '}
                <code className="break-all">curl -X PUT --data-binary @file URL</code>. Larger bodies
                are refused; the key is fixed to this object.
              </p>
            </div>
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
          </>}

          {!file && links && !rows.length && <p>No links in this connection’s history.</p>}
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
                      {!file && <div className="min-w-0 flex-1 break-all text-xs">
                        <p>{link.bucket}/{link.key}</p>
                        <p>{link.permission === 'read' ? 'Read' : 'Write'} · {link.target_identity === null
                          ? 'Unverified legacy target' : link.target_identity === currentIdentity ? 'Current target' : 'Earlier target'}</p>
                      </div>}
                      {link.permission === 'read' ? (
                        <Download size={12} className="text-zinc-500 flex-none" />
                      ) : (
                        <Upload size={12} className="text-zinc-500 flex-none" />
                      )}
                      <span
                        className={`text-[11px] tabular-nums flex-1 ${
                          expired ? 'text-zinc-500 line-through' : 'text-zinc-600 dark:text-zinc-300'
                        }`}
                      >
                        {new Date(link.expires_at).toLocaleString()}
                        {expired ? ' (expired)' : ''}
                      </span>
                      <span className="flex-none text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
                        {isServerLink(link.url) ? 'server' : 'S3'}
                      </span>
                      {file && <>
                      <button
                        type="button"
                        onClick={() => void handleCopy(link)}
                        className="p-1.5 rounded text-zinc-500 hover:text-teal-600 dark:hover:text-teal-400"
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
                        className="p-1.5 rounded text-zinc-500 hover:text-teal-600 dark:hover:text-teal-400"
                        title="Open link"
                        aria-label="Open link"
                      >
                        <Link2 size={12} />
                      </a>
                      </>}
                      <DeleteLinkButton db={db} link={link} />
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {file && !stale && <p className="flex items-start gap-2 text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
            <Clock size={13} className="flex-none mt-0.5" />
            {rows.some((link) => isServerLink(link.url))
              ? permission === 'write' && via === 'server'
                ? serverWriteHint
                : serverLinkHint
              : revocationHint}
          </p>}
        </div>
      </div>
    </div>
  );
}

function DeleteLinkButton({ db, link }: { db: AppDB; link: PresignedRecord }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const server = isServerLink(link.url);
  return (
    <span className="relative flex-none">
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        setError(null);
        try {
          await deleteLink(db, link.id);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
      className="p-1.5 rounded text-zinc-500 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
      title={server ? 'Revoke this link now' : 'Forget this link'}
      aria-label={server ? 'Revoke this link now' : 'Forget this link'}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
    </button>
    {error && (
      <span role="alert" className="absolute right-0 top-full z-10 mt-1 w-48 rounded-lg border border-red-200 bg-red-50 p-2 text-[10px] text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
        {error}
      </span>
    )}
    </span>
  );
}
