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
  Download,
  Pencil,
  Plug,
} from 'lucide-react';
import type { AppDB, ConnectionRow } from '../db/client';
import { deleteConnection } from '../vault/repository';
import { ConnectionDialog } from './ConnectionDialog';
import { GaleonImportDialog } from './GaleonImportDialog';
import { VaultSettings } from './VaultSettings';
import { Explorer } from './Explorer';
import { bridgeTokenFor, disableBridgeFor, enableBridgeFor } from '../bridge/session';
import { isLocalHostname } from '../bridge/environment';
import { COMPANION_PACKAGES, downloadCompanion, type CompanionPackageId } from '../bridge/download';

interface ConnectionsViewProps {
  db: AppDB;
}

const CONNECTION_COLUMNS = `id, name, protocol, endpoint, region, bucket, path_style, storage_class, custom_headers, created_at, updated_at`;

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
  const [bridgeDraftId, setBridgeDraftId] = useState<string | null>(null);
  const [bridgeToken, setBridgeToken] = useState('');
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [, refreshBridge] = useState(0);
  const [downloadDraftId, setDownloadDraftId] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadedPlatform, setDownloadedPlatform] = useState<CompanionPackageId | null>(null);

  const connections = useLiveQuery<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM profiles ORDER BY name ASC`,
  );

  const rows = connections?.rows ?? [];
  const active = activeId ? rows.find((r) => r.id === activeId) ?? null : null;
  const editing = editingId ? rows.find((r) => r.id === editingId) ?? null : null;
  const bridgeCommand = isLocalHostname(window.location.hostname)
    ? 'bun run bridge'
    : `GALIOT_BRIDGE_ORIGINS=${window.location.origin} bun run bridge`;
  const companionCommand = isLocalHostname(window.location.hostname)
    ? './galiot-bridge'
    : `GALIOT_BRIDGE_ORIGINS=${window.location.origin} ./galiot-bridge`;
  const companionWindowsCommand = isLocalHostname(window.location.hostname)
    ? '.\\galiot-bridge.exe'
    : `$env:GALIOT_BRIDGE_ORIGINS='${window.location.origin}'; .\\galiot-bridge.exe`;

  const handleDelete = useCallback(
    async (id: string) => {
      setDeleteError(null);
      try {
        await deleteConnection(db, id);
        disableBridgeFor(id);
        setPendingDeleteId(null);
      } catch (err) {
        setDeleteError(err instanceof Error ? err.message : String(err));
        setPendingDeleteId(null);
      }
    },
    [db],
  );

  const handleEnableBridge = useCallback(async (id: string) => {
    setBridgeBusy(true);
    setBridgeError(null);
    try {
      await enableBridgeFor(id, bridgeToken);
      setBridgeDraftId(null);
      setBridgeToken('');
      refreshBridge((value) => value + 1);
    } catch (err) {
      setBridgeError(err instanceof Error ? err.message : String(err));
    } finally {
      setBridgeBusy(false);
    }
  }, [bridgeToken]);

  const handleDownload = useCallback(async (id: CompanionPackageId) => {
    setDownloadBusy(true);
    setDownloadError(null);
    setDownloadProgress('Starting download…');
    setDownloadedPlatform(null);
    try {
      await downloadCompanion(id, (received, total) => {
        setDownloadProgress(`Downloading… ${Math.round((received / total) * 100)}%`);
      });
      setDownloadProgress('Download ready. Extract the ZIP, then run the companion.');
      setDownloadedPlatform(id);
    } catch (err) {
      setDownloadProgress(null);
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadBusy(false);
    }
  }, []);

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
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Connections</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              {rows.length === 0
                ? 'Add an S3-compatible connection to start exploring your buckets.'
                : `${rows.length} connection${rows.length === 1 ? '' : 's'} · credentials sealed in your vault`}
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
            {rows.length > 0 && (
              <button
                type="button"
                onClick={() => setDialogOpen(true)}
                className="inline-flex items-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-4 py-2.5 rounded-lg font-medium text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-950"
              >
                <Plus size={16} />
                Add Connection
              </button>
            )}
          </div>
        </div>

        {deleteError && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm rounded-lg border border-red-100 dark:border-red-900/30">
            {deleteError}
          </div>
        )}

        {rows.length === 0 ? (
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-12 flex flex-col items-center text-center">
            <div className="w-16 h-16 bg-zinc-100 dark:bg-zinc-800 rounded-full flex items-center justify-center mb-6">
              <Sailboat size={32} className="text-zinc-400 dark:text-zinc-500" />
            </div>
            <h3 className="text-xl font-semibold mb-2">No connections yet</h3>
            <p className="text-zinc-500 dark:text-zinc-400 mb-8 max-w-md">
              Add an S3-compatible cloud storage connection to get started managing your buckets and
              objects — 100% client-side, credentials never leave this browser.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setDialogOpen(true)}
                className="inline-flex items-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-5 py-2.5 rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-900"
              >
                <Plus size={18} />
                Add Connection
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
                className="group bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-5 hover:border-teal-500/60 dark:hover:border-teal-500/40 hover:shadow-sm transition-all"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => setActiveId(row.id)}
                      className="text-left font-semibold text-zinc-900 dark:text-zinc-50 hover:text-teal-600 dark:hover:text-teal-400 transition-colors flex items-center gap-1.5"
                    >
                      <span className="truncate">{row.name}</span>
                      <ChevronRight size={15} className="flex-none text-zinc-400 group-hover:text-teal-500 transition-colors" />
                    </button>
                    <p className="mt-1 text-xs font-mono text-zinc-500 dark:text-zinc-400 truncate">
                      {hostOf(row.endpoint)}
                    </p>
                  </div>

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
                        onClick={() => setEditingId(row.id)}
                        className="p-2 -mt-1 rounded-md text-zinc-400 hover:text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-900/20 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all"
                        aria-label={`Edit ${row.name}`}
                        title="Edit connection"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDeleteId(row.id)}
                        className="p-2 -mt-1 -mr-1 rounded-md text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all"
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

                <div className="mt-4 border-t border-zinc-100 dark:border-zinc-800 pt-3 text-xs">
                  <button type="button"
                    onClick={() => { setDownloadDraftId(downloadDraftId === row.id ? null : row.id); setDownloadError(null); setDownloadProgress(null); setDownloadedPlatform(null); }}
                    aria-expanded={downloadDraftId === row.id}
                    className="mb-3 inline-flex items-center gap-1.5 font-medium text-teal-700 hover:text-teal-900 dark:text-teal-400 dark:hover:text-teal-300">
                    <Download size={14} /> Download companion
                  </button>
                  {downloadDraftId === row.id && (
                    <div className="mb-3 space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/50">
                      <p className="text-zinc-600 dark:text-zinc-300">
                        Choose your computer. Extract the ZIP and run the companion on the computer that can reach this S3 endpoint.
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        {COMPANION_PACKAGES.map((item) => (
                          <button key={item.id} type="button" disabled={downloadBusy}
                            onClick={() => void handleDownload(item.id)}
                            className="rounded-md border border-zinc-300 bg-white px-2.5 py-2 text-left font-medium text-zinc-700 hover:border-teal-500 hover:text-teal-700 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:text-teal-300">
                            {item.label}
                          </button>
                        ))}
                      </div>
                      {downloadProgress && <p role="status" className="text-teal-700 dark:text-teal-400">{downloadProgress}</p>}
                      {downloadedPlatform && (
                        <p className="text-zinc-600 dark:text-zinc-300">
                          Run from the extracted folder: <code className="block mt-1 select-all break-all rounded bg-zinc-200/70 p-2 dark:bg-zinc-900">{downloadedPlatform === 'windows-x64' ? companionWindowsCommand : companionCommand}</code>
                        </p>
                      )}
                      {downloadError && <p role="alert" className="text-red-600 dark:text-red-400">{downloadError}</p>}
                    </div>
                  )}
                  {bridgeTokenFor(row.id) ? (
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-teal-700 dark:text-teal-400">
                        <Plug size={13} /> Local companion enabled for this tab
                      </span>
                      <button type="button" onClick={() => { disableBridgeFor(row.id); refreshBridge((value) => value + 1); }}
                        className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
                        Disable
                      </button>
                    </div>
                  ) : bridgeDraftId === row.id ? (
                    <div className="space-y-2">
                      <p className="text-zinc-500 dark:text-zinc-400">
                        Download and run the companion above, or run <code className="select-all">{bridgeCommand}</code> from the source checkout. Paste the token it prints. Galiot will route this connection through the companion until you lock the vault or close this tab.
                      </p>
                      <input type="password" value={bridgeToken} onChange={(event) => setBridgeToken(event.target.value)}
                        placeholder="Companion token" aria-label="Companion token"
                        className="w-full px-2.5 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 dark:text-zinc-100" />
                      {bridgeError && <p role="alert" className="text-red-600 dark:text-red-400">{bridgeError}</p>}
                      <div className="flex gap-3">
                        <button type="button" disabled={bridgeBusy} onClick={() => void handleEnableBridge(row.id)}
                          className="font-medium text-teal-700 dark:text-teal-400 disabled:opacity-50">
                          {bridgeBusy ? 'Checking…' : 'Enable companion'}
                        </button>
                        <button type="button" onClick={() => { setBridgeDraftId(null); setBridgeToken(''); setBridgeError(null); }}
                          className="text-zinc-500">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" onClick={() => { setBridgeDraftId(row.id); setBridgeError(null); }}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2.5 text-left text-sm font-semibold text-teal-800 transition-colors hover:bg-teal-100 dark:border-teal-800/60 dark:bg-teal-950/40 dark:text-teal-300 dark:hover:bg-teal-950/70">
                      <span className="inline-flex items-center gap-2">
                        <Plug size={16} /> Enable local companion
                      </span>
                      <ChevronRight size={16} aria-hidden="true" />
                    </button>
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
        }}
        editing={editing}
        onSaved={() => setEditingId(null)}
      />

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
