import { useCallback, useEffect, useState } from 'react';
import { X, Loader2, Plug, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import type { AppDB } from '../db/client';
import { createConnection } from '../vault/repository';
import { vaultService } from '../vault/vaultService';

interface ConnectionDialogProps {
  db: AppDB;
  open: boolean;
  onClose: () => void;
}

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; message: string }
  | { status: 'fail'; message: string };

type CorsState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; message: string }
  | { status: 'fail'; message: string };

const INPUT_CLASS =
  'w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent dark:text-zinc-100 transition-shadow text-sm';
const LABEL_CLASS = 'block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5';

/** Adds a scheme if missing and strips trailing slashes. */
export function normalizeEndpoint(raw: string): string {
  let endpoint = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(endpoint)) {
    endpoint = `https://${endpoint}`;
  }
  return endpoint;
}

interface FormState {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  endpoint: '',
  region: 'us-east-1',
  bucket: '',
  accessKeyId: '',
  secretAccessKey: '',
  pathStyle: false,
};

export function ConnectionDialog({ db, open, onClose }: ConnectionDialogProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const [cors, setCors] = useState<CorsState>({ status: 'idle' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      setError(null);
      setTest({ status: 'idle' });
      setCors({ status: 'idle' });
      setSaving(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const setField = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTest({ status: 'idle' });
    setCors({ status: 'idle' });
  }, []);

  const buildPayload = useCallback((): { ok: true } | { ok: false; error: string } => {
    if (!form.name.trim()) return { ok: false, error: 'Connection name is required.' };
    if (!form.endpoint.trim()) return { ok: false, error: 'Endpoint is required.' };
    if (!form.bucket.trim()) return { ok: false, error: 'Bucket name is required.' };
    if (!form.accessKeyId.trim()) return { ok: false, error: 'Access key ID is required.' };
    if (!form.secretAccessKey.trim()) return { ok: false, error: 'Secret access key is required.' };
    return { ok: true };
  }, [form]);

  const handleTest = useCallback(async () => {
    const check = buildPayload();
    if (!check.ok) {
      setTest({ status: 'fail', message: check.error });
      return;
    }

    setTest({ status: 'testing' });
    setCors({ status: 'testing' });

    const profile = {
      endpoint: normalizeEndpoint(form.endpoint),
      region: form.region.trim() || 'us-east-1',
      bucket: form.bucket.trim(),
      pathStyle: form.pathStyle,
    };
    const credentials = {
      plain: {
        accessKeyId: form.accessKeyId.trim(),
        secretAccessKey: form.secretAccessKey.trim(),
      },
    };

    try {
      const result = await vaultService.call('s3.test', { profile, credentials });

      if (result.ok) {
        setTest({
          status: 'ok',
          message: `Connected — bucket reachable (${result.objectCount ?? 0} keys in first page).`,
        });
      } else {
        setTest({
          status: 'fail',
          message: result.error ?? 'The bucket rejected the request (check credentials and policy).',
        });
      }

      // CORS preflight runs in parallel with the credentialed test above.
      void (async () => {
        try {
          const corsResult = await vaultService.call('s3.cors', { profile });
          if (corsResult.allowed) {
            setCors({
              status: 'ok',
              message: `CORS preflight passed — allowed methods: ${corsResult.methods.join(', ') || 'not reported'}.`,
            });
          } else {
            setCors({
              status: 'fail',
              message:
                'CORS preflight rejected this origin. Add a CORS policy allowing ' +
                `${window.location.origin} with methods GET, HEAD, PUT, POST, DELETE, ` +
                'expose header ETag, and allowed headers * — otherwise the browser blocks all requests.',
            });
          }
        } catch (err) {
          setCors({
            status: 'fail',
            message: `CORS preflight failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      })();
    } catch (err) {
      setTest({ status: 'fail', message: err instanceof Error ? err.message : String(err) });
      setCors({ status: 'idle' });
    }
  }, [buildPayload, form]);

  const handleSave = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      const check = buildPayload();
      if (!check.ok) {
        setError(check.error);
        return;
      }

      setSaving(true);
      try {
        await createConnection(db, {
          name: form.name.trim(),
          endpoint: normalizeEndpoint(form.endpoint),
          region: form.region.trim() || 'us-east-1',
          bucket: form.bucket.trim(),
          pathStyle: form.pathStyle,
          accessKeyId: form.accessKeyId.trim(),
          secretAccessKey: form.secretAccessKey.trim(),
        });
        // Plaintext credentials are no longer needed — wipe the form state.
        setForm(EMPTY_FORM);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [buildPayload, db, form, onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Add Connection</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
              S3-compatible endpoint — R2, MinIO, AWS S3, B2, Spaces…
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 -mr-2 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label htmlFor="conn-name" className={LABEL_CLASS}>Name</label>
              <input
                id="conn-name"
                className={INPUT_CLASS}
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder="Production R2"
                autoFocus
              />
            </div>

            <div className="col-span-2">
              <label htmlFor="conn-endpoint" className={LABEL_CLASS}>Endpoint</label>
              <input
                id="conn-endpoint"
                className={`${INPUT_CLASS} font-mono text-xs`}
                value={form.endpoint}
                onChange={(e) => setField('endpoint', e.target.value)}
                placeholder="https://accountId.r2.cloudflarestorage.com"
                spellCheck={false}
              />
            </div>

            <div>
              <label htmlFor="conn-region" className={LABEL_CLASS}>Region</label>
              <input
                id="conn-region"
                className={INPUT_CLASS}
                value={form.region}
                onChange={(e) => setField('region', e.target.value)}
                placeholder="auto"
                spellCheck={false}
              />
            </div>

            <div>
              <label htmlFor="conn-bucket" className={LABEL_CLASS}>Bucket</label>
              <input
                id="conn-bucket"
                className={INPUT_CLASS}
                value={form.bucket}
                onChange={(e) => setField('bucket', e.target.value)}
                placeholder="my-bucket"
                spellCheck={false}
              />
            </div>

            <div className="col-span-2">
              <label htmlFor="conn-access-key" className={LABEL_CLASS}>Access Key ID</label>
              <input
                id="conn-access-key"
                className={`${INPUT_CLASS} font-mono text-xs`}
                value={form.accessKeyId}
                onChange={(e) => setField('accessKeyId', e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="col-span-2">
              <label htmlFor="conn-secret-key" className={LABEL_CLASS}>Secret Access Key</label>
              <input
                id="conn-secret-key"
                type="password"
                className={`${INPUT_CLASS} font-mono text-xs`}
                value={form.secretAccessKey}
                onChange={(e) => setField('secretAccessKey', e.target.value)}
                autoComplete="new-password"
                spellCheck={false}
              />
            </div>
          </div>

          <label className="flex items-start gap-2.5 text-sm text-zinc-600 dark:text-zinc-400 cursor-pointer">
            <input
              type="checkbox"
              checked={form.pathStyle}
              onChange={(e) => setField('pathStyle', e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-zinc-300 dark:border-zinc-600 text-teal-600 focus:ring-teal-500"
            />
            <span>
              Path-style addressing{' '}
              <span className="text-zinc-400 dark:text-zinc-500">
                (required for MinIO, LocalStack and most self-hosted endpoints)
              </span>
            </span>
          </label>

          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm rounded-lg border border-red-100 dark:border-red-900/30">
              {error}
            </div>
          )}

          {test.status !== 'idle' && (
            <div
              className={`p-3 text-sm rounded-lg border flex items-start gap-2 ${
                test.status === 'ok'
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-100 dark:border-green-900/30'
                  : test.status === 'fail'
                    ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-100 dark:border-red-900/30'
                    : 'bg-zinc-50 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border-zinc-100 dark:border-zinc-700'
              }`}
            >
              {test.status === 'testing' ? (
                <>
                  <Loader2 size={15} className="flex-none mt-0.5 animate-spin" />
                  Testing connection…
                </>
              ) : test.status === 'ok' ? (
                <>
                  <CheckCircle2 size={15} className="flex-none mt-0.5" />
                  {test.message}
                </>
              ) : (
                <>
                  <XCircle size={15} className="flex-none mt-0.5" />
                  <span className="break-words">{test.message}</span>
                </>
              )}
            </div>
          )}

          {cors.status !== 'idle' && (
            <div
              className={`p-3 text-sm rounded-lg border flex items-start gap-2 ${
                cors.status === 'ok'
                  ? 'bg-zinc-50 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700'
                  : cors.status === 'fail'
                    ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-100 dark:border-amber-900/40'
                    : 'bg-zinc-50 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border-zinc-100 dark:border-zinc-700'
              }`}
            >
              {cors.status === 'testing' ? (
                <>
                  <Loader2 size={15} className="flex-none mt-0.5 animate-spin" />
                  Running CORS preflight…
                </>
              ) : cors.status === 'ok' ? (
                <>
                  <CheckCircle2 size={15} className="flex-none mt-0.5" />
                  <span className="break-words">{cors.message}</span>
                </>
              ) : (
                <>
                  <AlertTriangle size={15} className="flex-none mt-0.5" />
                  <span className="break-words">{cors.message}</span>
                </>
              )}
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={test.status === 'testing' || saving}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
            >
              <Plug size={15} />
              Test connection
            </button>

            <button
              type="submit"
              disabled={saving || test.status === 'testing'}
              className="inline-flex items-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-5 py-2.5 text-sm font-medium rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {saving && <Loader2 size={15} className="animate-spin" />}
              Save connection
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
