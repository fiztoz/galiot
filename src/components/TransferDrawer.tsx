import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from '@electric-sql/pglite-react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pause,
  Play,
  Trash2,
  X,
  RotateCcw,
  ListX,
} from 'lucide-react';
import type { AppDB, ConnectionRow } from '../db/client';
import { transferManager, type TransferTaskRow } from '../transfer/manager';
import { formatBytes } from '../lib/format';
import { etaSeconds, formatEta } from '../transfer/planner';

interface TransferDrawerProps {
  db: AppDB;
}


const PROFILE_COLUMNS = `id, name, protocol, endpoint, region, bucket, path_style, network, storage_class, custom_headers, created_at, updated_at`;

const ACTIVE_STATUSES = new Set(['queued', 'transferring']);

function isFinished(task: TransferTaskRow): boolean {
  return task.status === 'completed' || task.status === 'failed';
}

export function TransferDrawer(_props: TransferDrawerProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingResumeRef = useRef<TransferTaskRow | null>(null);
  const previousActiveRef = useRef(0);
  const [graphs, setGraphs] = useState<Map<string, number[]>>(() => new Map());
  const GRAPH_POINTS = 60;

  const tasks = useLiveQuery<TransferTaskRow>(
    `SELECT id, profile_id, direction, remote_key, local_path, file_size, bytes_transferred,
            status, speed_bytes_sec, upload_id, error_message, created_at, updated_at
       FROM transfer_tasks
      ORDER BY created_at DESC
      LIMIT 50`,
  );

  const profiles = useLiveQuery<ConnectionRow>(
    `SELECT ${PROFILE_COLUMNS} FROM profiles`,
  );

  const profileById = useMemo(
    () => new Map((profiles?.rows ?? []).map((p) => [p.id, p] as const)),
    [profiles],
  );

  const rows = tasks?.rows ?? [];
  const activeCount = rows.filter((t) => ACTIVE_STATUSES.has(t.status)).length;

  // Reveal the drawer the moment work starts.
  useEffect(() => {
    if (activeCount > previousActiveRef.current) {
      setOpen(true);
    }
    previousActiveRef.current = activeCount;
  }, [activeCount]);

  // Rolling byte-progress samples power the bandwidth sparkline per task.
  useEffect(
    () =>
      transferManager.subscribe((event) => {
        if (event.type === 'progress' || event.type === 'done' || event.type === 'paused') {
          const bytes =
            event.type === 'progress'
              ? event.bytesTransferred
              : event.type === 'paused'
                ? event.bytesTransferred
                : event.totalBytes;
          setGraphs((prev) => {
            const next = new Map(prev);
            const series = [...(next.get(event.taskId) ?? []), bytes];
            if (series.length > GRAPH_POINTS) series.shift();
            next.set(event.taskId, series);
            return next;
          });
        }
      }),
    [],
  );

  const run = useCallback(async (fn: () => Promise<void> | void) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handlePickForResume = useCallback(
    (task: TransferTaskRow) => {
      const profile = profileById.get(task.profile_id);
      if (!profile) {
        setError('Connection for this transfer is no longer available.');
        return;
      }
      pendingResumeRef.current = task;
      fileInputRef.current?.click();
    },
    [profileById],
  );

  const handleResume = useCallback(
    (task: TransferTaskRow) => {
      const profile = profileById.get(task.profile_id);
      if (!profile) {
        setError('Connection for this transfer is no longer available.');
        return;
      }

      if (task.direction === 'upload') {
        handlePickForResume(task);
        return;
      }

      void run(() => transferManager.resumeDownload(profile, task));
    },
    [handlePickForResume, profileById, run],
  );

  const handleFilePicked = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      const task = pendingResumeRef.current;
      pendingResumeRef.current = null;
      event.target.value = '';
      if (!file || !task) return;

      const profile = profileById.get(task.profile_id);
      if (!profile) {
        setError('Connection for this transfer is no longer available.');
        return;
      }
      void run(() => transferManager.resumeUpload(profile, task, file));
    },
    [profileById, run],
  );

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFilePicked}
        aria-label="Select file to resume upload"
      />

      <div className="fixed bottom-4 right-4 z-40 w-[min(24rem,calc(100vw-2rem))] flex flex-col items-end gap-2">
        {error && (
          <div className="w-full flex items-start justify-between gap-2 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/60 px-3 py-2 text-xs text-red-700 dark:text-red-400">
            <span className="break-words">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="flex-none p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/40"
              aria-label="Dismiss"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {open && (
          <div
            id="transfer-drawer-panel"
            className="w-full max-h-[60vh] overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-100 dark:border-zinc-800 sticky top-0 bg-white dark:bg-zinc-900">
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
                Transfers
                {activeCount > 0 && (
                  <span className="ml-1.5 text-teal-600 dark:text-teal-400">{activeCount} active</span>
                )}
              </span>
              <div className="flex items-center gap-1">
                {rows.some(isFinished) && (
                  <button
                    type="button"
                    onClick={() => void run(() => transferManager.clearFinished())}
                    className="p-1 rounded text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300"
                    title="Clear finished"
                    aria-label="Clear finished"
                  >
                    <ListX size={13} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="p-1 rounded text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300"
                  aria-label="Collapse transfers"
                >
                  <ChevronDown size={13} />
                </button>
              </div>
            </div>

            {rows.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <p className="text-xs font-medium text-zinc-700 dark:text-zinc-200">
                  No transfers yet
                </p>
                <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                  Uploads and downloads appear here with progress and resume controls.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((task) => {
                const total = Number(task.file_size);
                const done = Number(task.bytes_transferred);
                const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
                const isActive = ACTIVE_STATUSES.has(task.status);
                const eta = isActive
                  ? etaSeconds(Math.max(0, total - done), Number(task.speed_bytes_sec))
                  : null;

                return (
                  <li key={task.id} className="px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 flex-none text-zinc-500">
                        {task.direction === 'upload' ? (
                          <ArrowUpFromLine size={14} />
                        ) : (
                          <ArrowDownToLine size={14} />
                        )}
                      </span>

                      <div className="min-w-0 flex-1">
                        <p
                          className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-100"
                          title={task.remote_key}
                        >
                          {task.remote_key}
                        </p>

                        <div
                          className="mt-1 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden"
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={percent}
                          aria-label={`Transfer progress for ${task.remote_key}`}
                        >
                          <div
                            className={`h-full rounded-full transition-all ${
                              task.status === 'failed'
                                ? 'bg-red-500'
                                : task.status === 'completed'
                                  ? 'bg-green-500'
                                  : 'bg-teal-500'
                            }`}
                            style={{ width: `${percent}%` }}
                          />
                        </div>

                        {isActive && (graphs.get(task.id)?.length ?? 0) > 1 && (
                          <div className="mt-1" title="Throughput over the last few updates">
                            <Sparkline values={graphs.get(task.id) ?? []} />
                          </div>
                        )}

                        <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-zinc-500 dark:text-zinc-400">
                          <span className="tabular-nums">
                            {formatBytes(done)} / {formatBytes(total)}
                            {isActive && Number(task.speed_bytes_sec) > 0
                              ? ` · ${formatBytes(Number(task.speed_bytes_sec))}/s`
                              : ''}
                            {isActive && eta !== null ? ` · ${formatEta(eta)}` : ''}
                          </span>
                          <span
                            className={
                              task.status === 'failed'
                                ? 'text-red-500'
                                : task.status === 'completed'
                                  ? 'text-green-600 dark:text-green-500'
                                  : ''
                            }
                          >
                            {task.status === 'failed' && task.error_message
                              ? task.error_message
                              : task.status}
                          </span>
                          {task.status === 'failed' && /InvalidObjectState/i.test(task.error_message ?? '') && (
                            <span className="block text-[10px] text-sky-600 dark:text-sky-400">
                              Archived object — restore it from Details, then retry.
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex-none flex items-center gap-0.5">
                        {task.status === 'transferring' && (
                          <button
                            type="button"
                            onClick={() => transferManager.pause(task.id)}
                            className="p-1 rounded text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                            title="Pause"
                            aria-label="Pause transfer"
                          >
                            <Pause size={13} />
                          </button>
                        )}

                        {task.status === 'paused' && (
                          <button
                            type="button"
                            onClick={() => handleResume(task)}
                            className="p-1 rounded text-zinc-500 hover:text-teal-600 dark:hover:text-teal-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                            title={task.direction === 'upload' ? 'Re-select file to resume' : 'Resume'}
                            aria-label="Resume transfer"
                          >
                            <Play size={13} />
                          </button>
                        )}

                        {task.status === 'failed' && task.upload_id && (
                          <button
                            type="button"
                            onClick={() => handleResume(task)}
                            className="p-1 rounded text-zinc-500 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                            title="Retry with the same file"
                            aria-label="Retry transfer"
                          >
                            <RotateCcw size={13} />
                          </button>
                        )}

                        {isActive && (
                          <button
                            type="button"
                            onClick={() => transferManager.cancel(task.id)}
                            className="p-1 rounded text-zinc-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                            title="Cancel"
                            aria-label="Cancel transfer"
                          >
                            <X size={13} />
                          </button>
                        )}

                        {isFinished(task) && (
                          <button
                            type="button"
                            onClick={() => void run(() => transferManager.removeTask(task.id))}
                            className="p-1 rounded text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                            title="Remove from list"
                            aria-label="Remove transfer"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="transfer-drawer-panel"
          className="inline-flex items-center gap-2 rounded-full border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-300 shadow-lg hover:border-teal-500/60 transition-colors"
        >
          {activeCount > 0 ? (
            <Loader2 size={13} className="animate-spin text-teal-500" />
          ) : (
            <ArrowUpFromLine size={13} className="text-teal-500" />
          )}
          {activeCount > 0 ? `${activeCount} transfer${activeCount === 1 ? '' : 's'} running` : 'Transfers'}
          {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </button>
      </div>
    </>
  );
}

/** Tiny inline throughput graph: cumulative bytes over recent updates. */
function Sparkline({ values }: { values: number[] }) {
  const width = 100;
  const height = 18;

  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  const span = Math.max(1, last - first);
  const step = values.length > 1 ? width / (values.length - 1) : width;

  const points = values
    .map((value, i) => {
      const x = i * step;
      const y = height - ((value - first) / span) * (height - 2) - 1;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="w-full h-[18px] block"
      aria-hidden="true"
    >
      <polyline
        points={`0,${height} ${points} ${width},${height}`}
        className="fill-teal-500/10 stroke-none"
      />
      <polyline
        points={points}
        fill="none"
        className="stroke-teal-500"
        strokeWidth="1.25"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}
