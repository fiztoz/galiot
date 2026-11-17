import { useCallback, useState } from 'react';
import { useLiveQuery } from '@electric-sql/pglite-react';
import {
  Plus,
  Sailboat,
  Trash2,
  HardDrive,
  MapPin,
  ChevronRight,
  X,
  Settings,
  FileDown,
  Pencil,
  Share2,
  FileUp,
} from 'lucide-react';
import { useRef } from 'react';
import { ShareConnectionDialog } from './ShareConnectionDialog';
import { parseConnectionShare, type ConnectionShare } from '../vault/share';
import type { AppDB, ConnectionRow } from '../db/client';
import { deleteConnection } from '../vault/repository';
import { ConnectionDialog } from './ConnectionDialog';
import { ProxyAccessPanel } from './ProxyAccessPanel';
import { GaleonImportDialog } from './GaleonImportDialog';
import { VaultSettings } from './VaultSettings';
import { Explorer } from './Explorer';

interface ConnectionsViewProps {
  db: AppDB;
}

const CONNECTION_COLUMNS = `id, name, protocol, endpoint, region, bucket, path_style, network, storage_class, custom_headers, created_at, updated_at`;

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

export function ConnectionsView({ db }: ConnectionsViewProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConnectionShare | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const connectionFileRef = useRef<HTMLInputElement>(null);

  const connections = useLiveQuery<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM profiles ORDER BY name ASC`,
  );

  const rows = connections?.rows ?? [];
  const active = activeId ? rows.find((r) => r.id === activeId) ?? null : null;
  const editing = editingId ? rows.find((r) => r.id === editingId) ?? null : null;
  const sharing = sharingId ? rows.find((r) => r.id === sharingId) ?? null : null;

  const handleConnectionFile = useCallback(async (file: File) => {
    setImportError(null);
    try {
      const parsed = parseConnectionShare(await file.text());
      setDraft(parsed);
      setDialogOpen(true);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      setDeleteError(null);
      try {
        await deleteConnection(db, id);
        setPendingDeleteId(null);
      } catch (err) {
        setDeleteError(err instanceof Error ? err.message : String(err));
        setPendingDeleteId(null);
      }
    },
    [db],
  );

  if (active) {
    return <Explorer db={db} profile={active} onBack={() => setActiveId(null)} />;
  }

  if (!connections) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal-600"></div>
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400 font-medium">Loading connections…</p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-5xl w-full mx-auto p-6 md:p-12">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Buckets</h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-300 mt-1">
              {rows.length === 0
                ? 'Add an S3 bucket. This server connects to it.'
                : `${rows.length} bucket${rows.length === 1 ? '' : 's'}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="p-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              title="Vault settings"
              aria-label="Vault settings"
            >
              <Settings size={16} />
            </button>
            <button
              type="button"
              onClick={() => connectionFileRef.current?.click()}
              className="inline-flex items-center gap-2 px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
              title="Import a shared Galiot connection file (no keys included)"
            >
              <FileUp size={15} />
              <span className="hidden sm:inline">Import connection</span>
            </button>
            {rows.length > 0 && (
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className="inline-flex items-center gap-2 px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
              >
                <FileDown size={15} />
                Import from Galeon
              </button>
            )}
            <input
              ref={connectionFileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              aria-label="Choose a Galiot connection file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleConnectionFile(file);
                event.target.value = '';
              }}
            />
            {rows.length > 0 && (
              <button
                type="button"
                onClick={() => setDialogOpen(true)}
                className="inline-flex items-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-4 py-2.5 rounded-lg font-medium text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-950"
              >
                <Plus size={16} />
                Add connection
              </button>
            )}
          </div>
        </div>

        {(deleteError || importError) && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm rounded-lg border border-red-100 dark:border-red-900/30">
            {deleteError ?? importError}
          </div>
        )}

        <ProxyAccessPanel />

        {rows.length === 0 ? (
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-12 flex flex-col items-center text-center">
            <div className="w-16 h-16 bg-zinc-100 dark:bg-zinc-800 rounded-full flex items-center justify-center mb-6">
              <Sailboat size={32} className="text-zinc-400 dark:text-zinc-500" />
            </div>
            <h3 className="text-xl font-semibold mb-2">No buckets yet</h3>
            <p className="text-zinc-600 dark:text-zinc-300 mb-8 max-w-md">
              Add an S3 bucket. Galiot's server connects to it, so the machine running Galiot must be able to reach the endpoint.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setDialogOpen(true)}
                className="inline-flex items-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-5 py-2.5 rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-900"
              >
                <Plus size={18} />
                Add connection
              </button>
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 font-medium transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800"
              >
                <FileDown size={16} />
                Import from Galeon
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {rows.map((row) => (
              <div
                key={row.id}
                className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-5 hover:border-teal-500/60 dark:hover:border-teal-500/40 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setActiveId(row.id)}
                    className="min-w-0 flex-1 text-left rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500"
                  >
                    <span className="font-semibold text-zinc-900 dark:text-zinc-50 hover:text-teal-700 dark:hover:text-teal-400 flex items-center gap-1.5">
                      <span className="truncate">{row.name}</span>
                      <ChevronRight size={15} className="flex-none text-zinc-400" />
                    </span>
                    <span className="mt-1 block text-xs font-mono text-zinc-600 dark:text-zinc-300 truncate">
                      {hostOf(row.endpoint)}
                    </span>
                  </button>

                  {pendingDeleteId === row.id ? (
                    <div className="flex items-center gap-1.5 flex-none">
                      <button
                        type="button"
                        onClick={() => void handleDelete(row.id)}
                        className="px-2.5 py-1.5 text-xs font-medium rounded-md bg-red-600 hover:bg-red-700 text-white transition-colors"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDeleteId(null)}
                        className="p-1.5 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        aria-label="Cancel delete"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 flex-none">
                      <button
                        type="button"
                        onClick={() => setSharingId(row.id)}
                        className="p-2 -mt-1 rounded-md text-zinc-500 hover:text-teal-700 hover:bg-teal-50 dark:hover:bg-teal-900/20"
                        aria-label={`Share ${row.name}`}
                        title="Share connection (no keys)"
                      >
                        <Share2 size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(row.id)}
                        className="p-2 -mt-1 rounded-md text-zinc-500 hover:text-teal-700 hover:bg-teal-50 dark:hover:bg-teal-900/20"
                        aria-label={`Edit ${row.name}`}
                        title="Edit connection"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDeleteId(row.id)}
                        className="p-2 -mt-1 -mr-1 rounded-md text-zinc-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                        aria-label={`Delete ${row.name}`}
                        title="Delete connection"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  )}
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-400 font-medium">
                    <HardDrive size={12} />
                    <span className="font-mono">{row.bucket}</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                    <MapPin size={12} />
                    {row.region}
                  </span>
                  {row.path_style && (
                    <span className="px-2.5 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
                      path-style
                    </span>
                  )}
                </div>

              </div>
            ))}
          </div>
        )}
      </div>

      <ConnectionDialog
        db={db}
        open={dialogOpen || editing !== null}
        onClose={() => {
          setDialogOpen(false);
          setEditingId(null);
          setDraft(null);
        }}
        editing={editing}
        draft={draft}
        onSaved={() => {
          setEditingId(null);
          setDraft(null);
        }}
      />

      {sharing && (
        <ShareConnectionDialog profile={sharing} onClose={() => setSharingId(null)} />
      )}

      <GaleonImportDialog db={db} open={importOpen} onClose={() => setImportOpen(false)} />

      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSettingsOpen(false);
          }}
        >
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                  Vault settings
                </h2>
                <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
                  Backup, restore and lock your local vault.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="p-2 -mr-2 -mt-1 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                aria-label="Close settings"
              >
                <X size={18} />
              </button>
            </div>

            {/* The vault worker broadcasts 'locked'; VaultGate re-locks on its
                own, so closing the modal is all that is needed here. */}
            <VaultSettings
              db={db}
              onLocked={() => setSettingsOpen(false)}
              onDeleted={() => {
                setSettingsOpen(false);
                setActiveId(null);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
