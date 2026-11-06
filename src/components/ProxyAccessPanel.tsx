import { useEffect, useState } from 'react';
import { clearProxyToken, enableProxyToken, getProxyToken, readProxyHealth } from '../server/session';

/**
 * Shown only when the app server demands a gate before it will forward S3
 * traffic. Loopback `bun run dev` / `bun run server` do not, so this stays hidden.
 */
export function ProxyAccessPanel() {
  const [required, setRequired] = useState(false);
  const [accepted, setAccepted] = useState(true);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readProxyHealth().then((health) => {
      if (cancelled || !health.reachable) return;
      setRequired(health.tokenRequired);
      setAccepted(health.tokenAccepted || !health.tokenRequired);
    });
    return () => {
      cancelled = true;
    };
  }, [accepted]);

  if (!required) return null;

  return (
    <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900" aria-labelledby="proxy-gate-heading">
      <h3 id="proxy-gate-heading" className="font-semibold text-zinc-900 dark:text-zinc-50">
        Server network gate
      </h3>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
        {accepted && getProxyToken()
          ? 'On for this tab. Server-network connections can leave through this Galiot server.'
          : 'This Galiot server will not forward S3 traffic until you enter the gate configured where it is running. It is not an S3 key.'}
      </p>
      {!(accepted && getProxyToken()) && (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            void enableProxyToken(draft)
              .then(() => {
                setAccepted(true);
                setDraft('');
              })
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : String(err));
              })
              .finally(() => setBusy(false));
          }}
        >
          <label className="block flex-1 min-w-48 text-sm font-medium text-zinc-700 dark:text-zinc-200">
            Server gate
            <input
              type="password"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoComplete="off"
              className="mt-1.5 w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? 'Checking…' : 'Use for this tab'}
          </button>
        </form>
      )}
      {accepted && getProxyToken() && (
        <button
          type="button"
          onClick={() => {
            clearProxyToken();
            setAccepted(false);
          }}
          className="mt-4 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Clear gate
        </button>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}
