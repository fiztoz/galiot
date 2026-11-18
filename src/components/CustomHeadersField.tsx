import { Plus, X, Info } from 'lucide-react';
import {
  MAX_CUSTOM_HEADERS,
  rejectReason,
  rejectText,
  type HeaderDraft,
} from '../s3/customHeaders';

interface CustomHeadersFieldProps {
  rows: HeaderDraft[];
  onChange: (rows: HeaderDraft[]) => void;
  /** Shared with the dialog so the inputs look like every other field. */
  inputClass: string;
  labelClass: string;
}

/**
 * The per-row problem, or null when the row is fine.
 *
 * A completely empty row is the "next one to fill in" and must not shout at the
 * user; a row with a value but no name is a real mistake and is reported.
 */
function rowProblem(row: HeaderDraft): string | null {
  const name = row.name.trim();
  const value = row.value.trim();
  if (name.length === 0 && value.length === 0) return null;
  const rejection = rejectReason(name, value);
  return rejection ? rejectText(rejection) : null;
}

/**
 * Extra headers sent on every request to this connection.
 *
 * Validation is the same `rejectReason` the repository enforces, so the dialog
 * cannot offer to save something that will be refused on the way in — and the
 * user finds out while typing rather than from an error after pressing save.
 */
export function CustomHeadersField({
  rows,
  onChange,
  inputClass,
  labelClass,
}: CustomHeadersFieldProps) {
  const update = (index: number, patch: Partial<HeaderDraft>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const remove = (index: number) => {
    onChange(rows.filter((_, i) => i !== index));
  };

  const add = () => {
    if (rows.length >= MAX_CUSTOM_HEADERS) return;
    onChange([...rows, { name: '', value: '' }]);
  };

  const atCap = rows.length >= MAX_CUSTOM_HEADERS;

  return (
    <div className="col-span-2">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className={labelClass.replace('mb-1.5', '')}>Custom headers</span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
          {rows.length}/{MAX_CUSTOM_HEADERS}
        </span>
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2.5 leading-relaxed">
        Sent on every signed request to this endpoint — for a gateway or proxy that
        needs a tenant id, a routing hint or a tracing tag. They are included in the
        SigV4 signature, so the server sees them as part of the authenticated request.
      </p>

      {rows.length === 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2.5 italic">
          None. Requests go out with only the headers Galiot computes itself.
        </p>
      )}

      <div className="space-y-2">
        {rows.map((row, index) => {
          const problem = rowProblem(row);
          return (
            <div key={index}>
              <div className="flex items-start gap-2">
                <input
                  aria-label={`Header ${index + 1} name`}
                  className={`${inputClass} flex-[2] font-mono text-xs ${
                    problem ? 'border-red-300 dark:border-red-800 focus:ring-red-400' : ''
                  }`}
                  value={row.name}
                  onChange={(e) => update(index, { name: e.target.value })}
                  placeholder="x-tenant-id"
                  spellCheck={false}
                  autoComplete="off"
                />
                <input
                  aria-label={`Header ${index + 1} value`}
                  className={`${inputClass} flex-[3] font-mono text-xs ${
                    problem ? 'border-red-300 dark:border-red-800 focus:ring-red-400' : ''
                  }`}
                  value={row.value}
                  onChange={(e) => update(index, { value: e.target.value })}
                  placeholder="acme"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => remove(index)}
                  aria-label={`Remove header ${index + 1}`}
                  className="flex-none mt-2 p-1.5 rounded-md text-zinc-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                >
                  <X size={15} />
                </button>
              </div>
              {problem && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400 leading-relaxed">
                  <span className="font-mono">{row.name.trim()}</span> — {problem}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={add}
        disabled={atCap}
        className="mt-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-teal-700 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <Plus size={13} />
        Add header
      </button>

      <div className="mt-3 p-2.5 bg-zinc-50 dark:bg-zinc-800/60 rounded-lg border border-zinc-200 dark:border-zinc-700 flex gap-2">
        <Info size={14} className="flex-none mt-0.5 text-zinc-500 dark:text-zinc-400" />
        <div className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed space-y-1">
          <p>
            <span className="font-medium text-zinc-600 dark:text-zinc-300">Not for secrets.</span>{' '}
            These are stored unencrypted, unlike your access keys, so a name like{' '}
            <span className="font-mono">x-api-key</span> or{' '}
            <span className="font-mono">authorization</span> is refused outright.
          </p>
          <p>
            The server sends these on listing, transfer, edit, and preview. Share links are
            presigned S3 URLs and cannot carry them.
          </p>
        </div>
      </div>
    </div>
  );
}
