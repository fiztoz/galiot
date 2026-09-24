import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileJson,
  Loader2,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import type { AppDB } from '../db/client';
import { vaultService } from '../vault/vaultService';
import { insertSealedConnections } from '../vault/repository';
import {
  MAX_IMPORT_FILE_BYTES,
  type GaleonImportPreview,
  type GaleonSkippedEntry,
} from '../vault/galeonImport';

interface GaleonImportDialogProps {
  db: AppDB;
  open: boolean;
  onClose: () => void;
  /** Called after a successful import so the list can refresh. */
  onImported?: (count: number) => void;
}

type Phase = 'choose' | 'preview' | 'done';

/**
 * Imports a Galeon profile export (`galeon.profiles`).
 *
 * The file is handed to the vault worker, which parses it and encrypts the
 * credentials; the main thread only ever sees the redacted preview and the
 * sealed rows. The file text is re-read from the File handle per call rather
 * than kept in React state, so plaintext keys are not parked in component
 * state (where devtools would happily show them).
 */
export function GaleonImportDialog({ db, open, onClose, onImported }: GaleonImportDialogProps) {
  const [phase, setPhase] = useState<Phase>('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GaleonImportPreview | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [importedSkipped, setImportedSkipped] = useState<GaleonSkippedEntry[]>([]);
  const fileRef = useRef<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPhase('choose');
      setBusy(false);
      setError(null);
      setPreview(null);
      setImportedCount(0);
      setImportedSkipped([]);
      fileRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose, open]);

  const readFile = useCallback(async (file: File): Promise<string> => {
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      throw new Error(
        `That file is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is 5 MB.`,
      );
    }
    return file.text();
  }, []);

  const loadPreview = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        const result = await vaultService.call('galeon.preview', { text: await readFile(file) });
        setPreview(result);
        setPhase('preview');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [readFile],
  );

  const handleFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      fileRef.current = file;
      void loadPreview(file);
    },
    [loadPreview],
  );

  const handleImport = useCallback(async () => {
    const file = fileRef.current;
    if (!file || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const prepared = await vaultService.call('galeon.prepare', {
        text: await readFile(file),
        expectedHash: preview.contentHash,
      });
      const count = await insertSealedConnections(db, prepared.rows);
      setImportedCount(count);
      setImportedSkipped(prepared.skipped);
      setPhase('done');
      onImported?.(count);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [db, onImported, preview, readFile]);

  if (!open) return null;

  const notes = preview?.importable.flatMap((entry) =>
    entry.notes.map((note) => `${entry.name}: ${note}`),
  ) ?? [];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 px-6 pt-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Import from Galeon
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
              Reads a Galeon profile export and brings its S3 connections across.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-2 -mr-2 -mt-1 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
            aria-label="Close import dialog"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {phase === 'choose' && (
            <>
              <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
                In Galeon, export your profiles with <strong>include credentials</strong> checked.
                Galeon omits the keys otherwise, and connections without keys cannot be imported.
              </p>

              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={busy}
                className="w-full flex flex-col items-center gap-2 py-8 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 hover:border-teal-500 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 size={20} className="animate-spin text-teal-600" />
                ) : (
                  <FileJson size={20} className="text-zinc-400" />
                )}
                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  {busy ? 'Reading the file…' : 'Choose a Galeon export (.json)'}
                </span>
              </button>
            </>
          )}

          {phase === 'preview' && preview && (
            <>
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium text-zinc-900 dark:text-zinc-50">
                  {preview.importable.length} of {preview.total} connection
                  {preview.total === 1 ? '' : 's'} ready to import
                </span>
                {preview.includesSecrets && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 text-[11px] font-medium">
                    contains credentials
                  </span>
                )}
              </div>

              {preview.importable.length > 0 && (
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800">
                  {preview.importable.map((entry) => (
                    <li key={`${entry.name}-${entry.bucket}`} className="px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                          {entry.name}
                        </span>
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                          {entry.pathStyle ? 'path-style' : 'virtual-hosted'}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs font-mono text-zinc-500 dark:text-zinc-400 truncate">
                        {entry.endpoint} · {entry.bucket} · {entry.region}
                      </p>
                      {entry.notes.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {entry.notes.map((note) => (
                            <li
                              key={note}
                              className="text-[11px] text-amber-600 dark:text-amber-400"
                            >
                              {note}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {preview.skipped.length > 0 && (
                <div className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50/60 dark:bg-amber-950/25 p-3">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-300">
                    <AlertTriangle size={13} />
                    {preview.skipped.length} connection
                    {preview.skipped.length === 1 ? '' : 's'} will be skipped
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {preview.skipped.map((entry) => (
                      <li key={`${entry.name}-${entry.reason}`} className="text-[11px]">
                        <span className="font-medium text-amber-800 dark:text-amber-300">
                          {entry.name}
                        </span>
                        <span className="text-amber-700/80 dark:text-amber-400/80">
                          {' — '}
                          {entry.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.importable.length === 0 && (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Nothing in this file can be imported. Re-export from Galeon with credentials
                  included, or add the connections manually.
                </p>
              )}

              {notes.length > 0 && (
                <p className="flex items-start gap-2 text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                  <AlertTriangle size={13} className="flex-none mt-0.5 text-amber-500" />
                  <span>{notes.length} field{notes.length === 1 ? '' : 's'} adjusted on import.</span>
                </p>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  disabled={busy}
                  className="px-3 py-2 text-xs font-medium rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
                >
                  Choose another file
                </button>
                <button
                  type="button"
                  onClick={() => void handleImport()}
                  disabled={busy || preview.importable.length === 0}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                  {busy
                    ? 'Importing…'
                    : `Import ${preview.importable.length} connection${preview.importable.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </>
          )}

          {phase === 'done' && (
            <div className="space-y-3">
              <p className="flex items-start gap-2 text-sm text-green-700 dark:text-green-400">
                <CheckCircle2 size={16} className="flex-none mt-0.5" />
                <span>
                  Imported {importedCount} connection{importedCount === 1 ? '' : 's'} into your
                  vault.
                </span>
              </p>

              {importedSkipped.length > 0 && (
                <ul className="space-y-1">
                  {importedSkipped.map((entry) => (
                    <li key={`${entry.name}-${entry.reason}`} className="text-[11px] text-zinc-500">
                      <span className="font-medium">{entry.name}</span> — {entry.reason}
                    </li>
                  ))}
                </ul>
              )}

              <p className="flex items-start gap-2 text-[11px] text-zinc-400 dark:text-zinc-500 leading-relaxed">
                <ShieldCheck size={13} className="flex-none mt-0.5" />
                Each connection was sealed by the vault worker. The keys in the Galeon file are not
                stored in plaintext anywhere in Galiot.
              </p>

              <button
                type="button"
                onClick={onClose}
                className="w-full px-3 py-2 text-xs font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors"
              >
                Done
              </button>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-2.5 text-xs rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400">
              <AlertTriangle size={14} className="flex-none mt-0.5" />
              <span className="break-words">{error}</span>
            </div>
          )}

          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleFile}
            aria-label="Select a Galeon profile export"
          />
        </div>
      </div>
    </div>
  );
}
