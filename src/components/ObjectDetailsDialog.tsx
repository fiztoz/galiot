import { useCallback, useEffect, useState } from 'react';
import { BRAND } from '../branding';
import { Download, History, Info, Loader2, Lock, RotateCcw, Snowflake, Trash2, X } from 'lucide-react';
import type { AppDB, ConnectionRow, ObjectRow } from '../db/client';
import { isArchiveClass, isRestored, type ObjectMeta, type ObjectVersion } from '../s3/client';
import { profileConfig } from '../db/objects';
import { getSealedCredentials } from '../vault/repository';
import { vaultService } from '../vault/vaultService';
import { formatBytes, formatDate } from '../lib/format';
import { useFocusTrap } from '../lib/useFocusTrap';

interface ObjectDetailsDialogProps {
  db: AppDB;
  profile: ConnectionRow;
  file: ObjectRow;
  onClose: () => void;
}

/** What the bucket itself says about one object, read with HeadObject. */
export function ObjectDetailsDialog({ db, profile, file, onClose }: ObjectDetailsDialogProps) {
  const [meta, setMeta] = useState<ObjectMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<ObjectVersion[] | null>(null);
  const [unversioned, setUnversioned] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [versionBusy, setVersionBusy] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const [restoreDays, setRestoreDays] = useState(1);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreNote, setRestoreNote] = useState<string | null>(null);
  const trapRef = useFocusTrap<HTMLDivElement>();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const loadVersions = useCallback(async () => {
    const sealed = await getSealedCredentials(db, profile.id);
    const result = await vaultService.call('s3.listVersions', {
      profile: profileConfig(profile),
      credentials: { sealed },
      key: file.key,
    });
    setVersions(result.versions);
    setUnversioned(result.unversioned);
  }, [db, profile, file.key]);

  const loadMeta = useCallback(async () => {
    const sealed = await getSealedCredentials(db, profile.id);
    const result = await vaultService.call('s3.head', {
      profile: profileConfig(profile),
      credentials: { sealed },
      key: file.key,
    });
    setMeta(result);
  }, [db, profile, file.key]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await loadMeta();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
      try {
        await loadVersions();
      } catch (err) {
        if (!cancelled) setVersionError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMeta, loadVersions]);

  const requestRestore = useCallback(async () => {
    setRestoreBusy(true);
    setRestoreNote(null);
    setVersionError(null);
    try {
      const sealed = await getSealedCredentials(db, profile.id);
      await vaultService.call('s3.restore', {
        profile: profileConfig(profile),
        credentials: { sealed },
        key: file.key,
        days: restoreDays,
      });
      setRestoreNote(`Restore requested for ${restoreDays} day${restoreDays === 1 ? '' : 's'}. It can take minutes to hours; reload Details to see progress.`);
      await loadMeta();
    } catch (err) {
      setVersionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoreBusy(false);
    }
  }, [db, profile, file.key, restoreDays, loadMeta]);

  const versionAction = useCallback(
    async (version: ObjectVersion, action: 'download' | 'restore' | 'purge') => {
      setVersionBusy(`${action}:${version.versionId}`);
      setVersionError(null);
      try {
        const sealed = await getSealedCredentials(db, profile.id);
        const common = { profile: profileConfig(profile), credentials: { sealed }, key: file.key, versionId: version.versionId };
        if (action === 'download') {
          const { url } = await vaultService.call('s3.versionUrl', common);
          window.open(url, '_blank', 'noopener');
        } else if (action === 'restore') {
          await vaultService.call('s3.restoreVersion', common);
          await loadVersions();
        } else {
          await vaultService.call('s3.deleteVersion', common);
          setConfirmPurge(null);
          await loadVersions();
        }
      } catch (err) {
        setVersionError(err instanceof Error ? err.message : String(err));
      } finally {
        setVersionBusy(null);
      }
    },
    [db, profile, file.key, loadVersions],
  );

  const rows: { label: string; value: string }[] = [
    { label: 'Key', value: file.key },
    { label: 'Bucket', value: profile.bucket },
    ...(meta
      ? [
          { label: 'Size', value: formatBytes(meta.contentLength) },
          { label: 'Type', value: meta.contentType },
          { label: 'Last modified', value: meta.lastModified ? formatDate(meta.lastModified) : '—' },
          { label: 'ETag', value: meta.eTag || '—' },
          { label: 'Storage class', value: meta.storageClass ?? 'STANDARD' },
        ]
      : []),
  ];

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
        aria-labelledby="object-details-title"
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <h2 id="object-details-title" className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
            <Info size={18} className="text-zinc-500" />
            Object details
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 -mr-2 rounded-lg text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Close details"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-6">
          {error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400 break-words">{error}</p>
          ) : !meta ? (
            <p className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
              <Loader2 size={15} className="animate-spin" />
              Asking the bucket…
            </p>
          ) : (
            <dl className="space-y-2.5">
              {rows.map((row) => (
                <div key={row.label} className="grid grid-cols-[7rem_1fr] gap-3 text-sm">
                  <dt className="text-zinc-500 dark:text-zinc-400">{row.label}</dt>
                  <dd className="font-mono text-xs text-zinc-800 dark:text-zinc-100 break-all">{row.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {meta && isArchiveClass(meta.storageClass) && (
            <div className="mt-5 border-t border-zinc-100 dark:border-zinc-800 pt-4">
              <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 flex items-center gap-2">
                <Snowflake size={14} className="text-sky-500" />
                {meta.storageClass}
              </h3>
              <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
                {meta.restore
                  ? isRestored(meta.restore)
                    ? `A restored copy is readable. ${meta.restore}`
                    : `Restore in progress. ${meta.restore}`
                  : 'Archived objects cannot be downloaded until a restore completes.'}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <select
                  value={restoreDays}
                  onChange={(event) => setRestoreDays(Number(event.target.value))}
                  disabled={restoreBusy}
                  className="px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-lg text-zinc-700 dark:text-zinc-200"
                  aria-label="Restore days"
                >
                  <option value={1}>1 day</option>
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                </select>
                <button
                  type="button"
                  onClick={() => void requestRestore()}
                  disabled={restoreBusy}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-medium disabled:opacity-60"
                >
                  {restoreBusy && <Loader2 size={12} className="animate-spin" />}
                  Restore
                </button>
              </div>
              {restoreNote && <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">{restoreNote}</p>}
            </div>
          )}

          {meta && (meta.objectLockMode || meta.retainUntil || meta.legalHold) && (
            <div className="mt-5 border-t border-zinc-100 dark:border-zinc-800 pt-4">
              <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 flex items-center gap-2">
                <Lock size={14} className="text-amber-600 dark:text-amber-400" />
                Object lock
              </h3>
              <dl className="mt-2 space-y-1.5 text-xs">
                {meta.objectLockMode && (
                  <div className="grid grid-cols-[7rem_1fr] gap-3">
                    <dt className="text-zinc-500 dark:text-zinc-400">Mode</dt>
                    <dd className="font-mono text-zinc-800 dark:text-zinc-100">{meta.objectLockMode}</dd>
                  </div>
                )}
                {meta.retainUntil && (
                  <div className="grid grid-cols-[7rem_1fr] gap-3">
                    <dt className="text-zinc-500 dark:text-zinc-400">Retain until</dt>
                    <dd className="font-mono text-zinc-800 dark:text-zinc-100">{formatDate(meta.retainUntil)}</dd>
                  </div>
                )}
                {meta.legalHold && (
                  <div className="grid grid-cols-[7rem_1fr] gap-3">
                    <dt className="text-zinc-500 dark:text-zinc-400">Legal hold</dt>
                    <dd className="font-mono text-zinc-800 dark:text-zinc-100">{meta.legalHold}</dd>
                  </div>
                )}
              </dl>
              <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">
                While retention or a legal hold is active, the provider refuses overwrites and
                deletes. {BRAND.name} checks this before single-object rename, copy-over, and delete.
              </p>
            </div>
          )}

          {versions !== null && !unversioned && versions.length > 0 && (
            <div className="mt-5 border-t border-zinc-100 dark:border-zinc-800 pt-4">
              <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 flex items-center gap-2">
                <History size={14} className="text-zinc-500" />
                Versions ({versions.length})
              </h3>
              <ul className="mt-2 space-y-1.5 max-h-48 overflow-y-auto">
                {versions.map((version) => (
                  <li
                    key={version.versionId}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 text-xs"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-zinc-700 dark:text-zinc-200">
                        {version.lastModified ? formatDate(version.lastModified) : version.versionId}
                        {version.isLatest && <span className="ml-1.5 text-teal-700 dark:text-teal-400 font-medium">latest</span>}
                        {version.isDeleteMarker && <span className="ml-1.5 text-amber-700 dark:text-amber-400 font-medium">delete marker</span>}
                      </span>
                      {!version.isDeleteMarker && (
                        <span className="block text-zinc-500 dark:text-zinc-400">{formatBytes(version.size)}</span>
                      )}
                    </span>
                    {!version.isDeleteMarker && (
                      <>
                        <button
                          type="button"
                          disabled={versionBusy !== null}
                          onClick={() => void versionAction(version, 'download')}
                          className="p-1.5 rounded text-zinc-500 hover:text-teal-700 dark:hover:text-teal-400 disabled:opacity-50"
                          title="Download this version"
                          aria-label="Download this version"
                        >
                          {versionBusy === `download:${version.versionId}` ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                        </button>
                        {!version.isLatest && (
                          <button
                            type="button"
                            disabled={versionBusy !== null}
                            onClick={() => void versionAction(version, 'restore')}
                            className="p-1.5 rounded text-zinc-500 hover:text-teal-700 dark:hover:text-teal-400 disabled:opacity-50"
                            title="Make this the current version (copies it over the key)"
                            aria-label="Restore this version"
                          >
                            {versionBusy === `restore:${version.versionId}` ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                          </button>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      disabled={versionBusy !== null}
                      onClick={() => {
                        if (confirmPurge === version.versionId) {
                          void versionAction(version, 'purge');
                        } else {
                          setConfirmPurge(version.versionId);
                        }
                      }}
                      onBlur={() => setConfirmPurge(null)}
                      className={`p-1.5 rounded disabled:opacity-50 ${
                        confirmPurge === version.versionId
                          ? 'bg-red-600 text-white'
                          : 'text-zinc-500 hover:text-red-600 dark:hover:text-red-400'
                      }`}
                      title={confirmPurge === version.versionId ? 'Click again to permanently delete this version' : 'Permanently delete this version'}
                      aria-label="Permanently delete this version"
                    >
                      {versionBusy === `purge:${version.versionId}` ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                Restore copies an old version over the key as a new version. Delete here is permanent.
              </p>
            </div>
          )}
          {versionError && (
            <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400 break-words">{versionError}</p>
          )}
        </div>
      </div>
    </div>
  );
}
