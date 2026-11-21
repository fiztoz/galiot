import { useCallback, useEffect, useState } from 'react';
import { PRESETS } from '../presets';
import { X, Loader2, Plug, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import type { AppDB, ConnectionRow } from '../db/client';
import type { Credentials } from '../vault/protocol';
import { createConnection, getSealedCredentials, updateConnection } from '../vault/repository';
import { vaultService } from '../vault/vaultService';
import { CustomHeadersField } from './CustomHeadersField';
import {
  normalizeCustomHeaders,
  parseStoredHeaders,
  type HeaderDraft,
} from '../s3/customHeaders';
import { diagnoseConnection } from '../s3/connectionDiagnosis';
import { normalizeEndpoint } from '../s3/url';
import { assertConnectionEndpoint } from '../s3/endpoint';
import { getProxyToken } from '../server/session';
import type { ConnectionShare } from '../vault/share';
import { useFocusTrap } from '../lib/useFocusTrap';

interface ConnectionDialogProps {
  db: AppDB;
  open: boolean;
  onClose: () => void;
  /** When set, the dialog edits this connection instead of creating one. */
  editing?: ConnectionRow | null;
  /** Prefill for an imported secret-free connection share. Keys stay blank. */
  draft?: ConnectionShare | null;
  /** Called after an edit is saved. */
  onSaved?: () => void;
}

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; message: string }
  | { status: 'fail'; message: string };

type DiagnosisState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; message: string }
  | { status: 'fail'; message: string };

const INPUT_CLASS =
  'w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent dark:text-zinc-100 transition-shadow text-sm';
const LABEL_CLASS = 'block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5';

interface FormState {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  pathStyle: boolean;
  /** Extra request headers, as editable rows. Validated on save and on test. */
  headers: HeaderDraft[];
}

const EMPTY_FORM: FormState = {
  name: '',
  // Deployment presets (company S3) pre-fill new connections; still editable.
  endpoint: PRESETS.endpoint,
  region: PRESETS.region || 'us-east-1',
  bucket: '',
  accessKeyId: '',
  secretAccessKey: '',
  sessionToken: '',
  pathStyle: PRESETS.pathStyle,
  headers: [],
};

export function ConnectionDialog({ db, open, onClose, editing, draft, onSaved }: ConnectionDialogProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const [diagnosis, setDiagnosis] = useState<DiagnosisState>({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [buckets, setBuckets] = useState<string[] | null>(null);
  const [bucketsBusy, setBucketsBusy] = useState(false);
  const [bucketsError, setBucketsError] = useState<string | null>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open);

  const isEdit = editing !== null && editing !== undefined;
  // Keyed on the id, not the object: the connections list re-renders with fresh
  // row objects on every live-query tick, and depending on those would wipe the
  // user's half-typed edits while they type.
  const editingId = editing?.id ?? null;

  useEffect(() => {
    if (!open) return;
    // Keys are deliberately left blank when editing: the sealed ones are never
    // decrypted here, so "blank" means "keep what is stored".
    setForm(
      editing
        ? {
            name: editing.name,
            endpoint: editing.endpoint,
            region: editing.region,
            bucket: editing.bucket,
            accessKeyId: '',
            secretAccessKey: '',
            sessionToken: '',
            pathStyle: editing.path_style,
            // Read through the same screening the request path uses, so a row
            // written before a rule existed is not shown back as editable.
            headers: Object.entries(parseStoredHeaders(editing.custom_headers)).map(
              ([name, value]) => ({ name, value }),
            ),
          }
        : draft
          ? {
              ...EMPTY_FORM,
              name: draft.name,
              endpoint: draft.endpoint,
              region: draft.region,
              bucket: draft.bucket,
              pathStyle: draft.pathStyle,
              headers: Object.entries(draft.headers).map(([name, value]) => ({ name, value })),
            }
          : EMPTY_FORM,
    );
    setError(null);
    setTest({ status: 'idle' });
    setDiagnosis({ status: 'idle' });
    setSaving(false);
    setBuckets(null);
    setBucketsError(null);
    setAdvancedOpen(
      Boolean(editing?.path_style) ||
        Object.keys(parseStoredHeaders(editing?.custom_headers)).length > 0 ||
        Boolean(draft?.pathStyle) ||
        Object.keys(draft?.headers ?? {}).length > 0 ||
        (!editing && PRESETS.pathStyle),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingId]);

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
    setError(null);
    setTest({ status: 'idle' });
    setDiagnosis({ status: 'idle' });
  }, []);

  const buildPayload = useCallback(():
    | { ok: true; headers: Record<string, string> }
    | { ok: false; error: string } => {
    if (!form.name.trim()) return { ok: false, error: 'Connection name is required.' };
    if (!form.endpoint.trim()) return { ok: false, error: 'Endpoint is required.' };
    try {
      assertConnectionEndpoint(normalizeEndpoint(form.endpoint));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Invalid endpoint.' };
    }
    if (!form.bucket.trim()) return { ok: false, error: 'Bucket name is required.' };

    // Validated here so neither Save nor Test can proceed with a header the
    // repository would refuse. The field shows the reason while typing; this is
    // the gate that makes it impossible to submit anyway.
    const normalized = normalizeCustomHeaders(form.headers);
    if (!normalized.ok) {
      const first = normalized.issues[0];
      return {
        ok: false,
        error: `Custom header "${first?.name}" was refused — ${first?.reason}.`,
      };
    }
    const headers = normalized.headers;

    const accessKey = form.accessKeyId.trim();
    const secretKey = form.secretAccessKey.trim();
    const sessionToken = form.sessionToken.trim();

    if (isEdit) {
      // Blank means "keep the stored keys". Half-typed is always a mistake:
      // saving it would replace a working pair with a broken one.
      if (sessionToken && (!accessKey || !secretKey)) {
        return {
          ok: false,
          error: 'Enter access key ID and secret access key too when setting a session token, or clear all three to keep the stored keys.',
        };
      }
      if (accessKey && !secretKey) {
        return { ok: false, error: 'Enter a secret access key too, or clear both to keep the stored keys.' };
      }
      if (secretKey && !accessKey) {
        return { ok: false, error: 'Enter an access key ID too, or clear both to keep the stored keys.' };
      }
      return { ok: true, headers };
    }

    if (!accessKey) return { ok: false, error: 'Access key ID is required.' };
    if (!secretKey) return { ok: false, error: 'Secret access key is required.' };
    return { ok: true, headers };
  }, [form, isEdit]);

  /** ListBuckets through the server, so a typed bucket name is not the only way in. */
  const handleBrowseBuckets = useCallback(async () => {
    setBucketsBusy(true);
    setBucketsError(null);
    setBuckets(null);
    try {
      const rawEndpoint = form.endpoint.trim();
      if (!rawEndpoint) throw new Error('Enter the endpoint first.');
      const typed = {
        accessKeyId: form.accessKeyId.trim(),
        secretAccessKey: form.secretAccessKey.trim(),
        sessionToken: form.sessionToken.trim() || undefined,
      };
      let credentials: Credentials;
      if (typed.accessKeyId && typed.secretAccessKey) {
        credentials = { plain: typed };
      } else if (isEdit && editing) {
        credentials = { sealed: await getSealedCredentials(db, editing.id) };
      } else {
        throw new Error('Enter both keys, or edit a stored connection, to list buckets.');
      }
      const result = await vaultService.call('s3.listBuckets', {
        profile: {
          endpoint: normalizeEndpoint(rawEndpoint),
          region: form.region.trim() || 'us-east-1',
          bucket: form.bucket.trim() || 'list',
          pathStyle: form.pathStyle,
          network: 'server',
          proxyToken: getProxyToken(),
        },
        credentials,
      });
      setBuckets(result.buckets);
      if (result.buckets.length === 0) {
        setBucketsError('The key can list buckets, but this endpoint returned none.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setBucketsError(
        /AccessDenied/i.test(message)
          ? 'This key cannot list buckets. Type the bucket name.'
          : message,
      );
    } finally {
      setBucketsBusy(false);
    }
  }, [form, isEdit, editing, db]);

  const handleTest = useCallback(async () => {
    setError(null);
    const check = buildPayload();
    if (!check.ok) {
      setTest({ status: 'fail', message: check.error });
      return;
    }

    setTest({ status: 'testing' });
    setDiagnosis({ status: 'idle' });

    const rawEndpoint = form.endpoint.trim();
    const profile = {
      endpoint: normalizeEndpoint(rawEndpoint),
      region: form.region.trim() || 'us-east-1',
      bucket: form.bucket.trim(),
      pathStyle: form.pathStyle,
      network: 'server' as const,
      proxyToken: getProxyToken(),
      // Included so "Test" exercises the connection as it will actually be
      // used. A header the gateway requires is exactly the kind of thing that
      // only shows up on a real signed request.
      headers: check.headers,
    };
    const typedKeys = {
      accessKeyId: form.accessKeyId.trim(),
      secretAccessKey: form.secretAccessKey.trim(),
      sessionToken: form.sessionToken.trim() || undefined,
    };

    // Editing without retyping: use the sealed credentials already in the vault,
    // so the test exercises the connection exactly as it is stored.
    let credentials: Credentials;
    if (typedKeys.accessKeyId && typedKeys.secretAccessKey) {
      credentials = { plain: typedKeys };
    } else if (isEdit && editing) {
      try {
        credentials = { sealed: await getSealedCredentials(db, editing.id) };
      } catch (err) {
        setTest({ status: 'fail', message: err instanceof Error ? err.message : String(err) });
        return;
      }
    } else {
      // buildPayload already rejected this; belt and braces.
      setTest({ status: 'fail', message: 'Credentials are required.' });
      return;
    }

    // Test the server route directly; this browser may have no route to S3.
    let requestSucceeded: boolean | undefined;
    let failureMessage: string | null = null;
    try {
      const result = await vaultService.call('s3.test', { profile, credentials });
      if (result.ok) {
        requestSucceeded = true;
        setTest({
          status: 'ok',
          message: `Connected — bucket reachable (${result.objectCount ?? 0} keys in first page).`,
        });
      } else {
        requestSucceeded = false;
        failureMessage = result.error ?? null;
        setTest({ status: 'fail', message: failureMessage ?? 'The bucket rejected the request.' });
      }
    } catch (err) {
      requestSucceeded = false;
      failureMessage = err instanceof Error ? err.message : String(err);
      setTest({ status: 'fail', message: failureMessage });
    }

    // Diagnose the request that actually ran on the server.
    const verdict = diagnoseConnection({
      requestSucceeded,
      requestError: failureMessage ?? undefined,
      endpoint: profile.endpoint,
      pathStyle: form.pathStyle,
    });
    if (verdict.reason === 'addressing-unsupported') {
      // An IP endpoint simply cannot use virtual-hosted addressing: repair it.
      setField('pathStyle', true);
      setAdvancedOpen(true);
      setDiagnosis({ status: 'fail', message: 'This endpoint needs path-style addressing. Turned it on — test again.' });
    } else if (verdict.reason === 'host-unreachable' || verdict.reason === 'request-rejected') {
      setDiagnosis({ status: 'fail', message: `${verdict.detail}${verdict.hint ? ` ${verdict.hint}` : ''}` });
    } else {
      setDiagnosis({ status: 'idle' });
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
        const shared = {
          name: form.name.trim(),
          endpoint: normalizeEndpoint(form.endpoint),
          region: form.region.trim() || 'us-east-1',
          bucket: form.bucket.trim(),
          pathStyle: form.pathStyle,
          customHeaders: check.headers,
        };

        if (isEdit && editing) {
          // Credentials are optional on edit: blank keeps the sealed blob, so
          // re-pointing a connection never requires retyping a secret.
          const accessKeyId = form.accessKeyId.trim();
          const secretAccessKey = form.secretAccessKey.trim();
          const sessionToken = form.sessionToken.trim() || undefined;
          await updateConnection(db, editing.id, {
            ...shared,
            ...(accessKeyId && secretAccessKey
              ? { credentials: { accessKeyId, secretAccessKey, sessionToken } }
              : {}),
          });
          onSaved?.();
        } else {
          await createConnection(db, {
            ...shared,
            accessKeyId: form.accessKeyId.trim(),
            secretAccessKey: form.secretAccessKey.trim(),
            sessionToken: form.sessionToken.trim() || undefined,
          });
        }

        // Plaintext credentials are no longer needed — wipe the form state.
        setForm(EMPTY_FORM);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [buildPayload, db, editing, form, isEdit, onClose, onSaved],
  );

  if (!open) return null;

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
        aria-labelledby="connection-title"
        className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden"
      >
        <div className="flex-none flex items-center justify-between px-6 pt-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <div>
            <h2 id="connection-title" className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              {isEdit ? 'Edit connection' : 'Add connection'}
            </h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-300 mt-0.5">
              {isEdit
                ? 'Stored keys stay unless you replace both of them.'
                : 'The server running Galiot connects to this bucket. Your browser does not.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 -mr-2 rounded-lg text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSave} className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
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
                placeholder="https://s3.example.com"
                spellCheck={false}
              />
            </div>

            <div className="col-span-2">
              <div className="flex items-center justify-between">
                <label id="conn-bucket-label" htmlFor="conn-bucket" className={LABEL_CLASS}>Bucket</label>
                <button
                  type="button"
                  onClick={() => void handleBrowseBuckets()}
                  disabled={bucketsBusy}
                  className="text-xs font-medium text-teal-700 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 disabled:opacity-50"
                >
                  {bucketsBusy ? 'Listing…' : 'Browse buckets'}
                </button>
              </div>
              <input
                id="conn-bucket"
                aria-labelledby="conn-bucket-label"
                className={INPUT_CLASS}
                value={form.bucket}
                onChange={(e) => setField('bucket', e.target.value)}
                placeholder="archive"
                spellCheck={false}
              />
              {buckets && buckets.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {buckets.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setField('bucket', name)}
                      className={`px-2 py-1 rounded-md border font-mono text-xs transition-colors ${
                        form.bucket === name
                          ? 'border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300'
                          : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
              {bucketsError && (
                <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">{bucketsError}</p>
              )}
            </div>

            <div className="col-span-2">
              <label htmlFor="conn-access-key" className={LABEL_CLASS}>
                Access Key ID
                {isEdit && (
                  <span className="ml-1.5 font-normal text-zinc-500 dark:text-zinc-400">
                    {form.accessKeyId.trim() ? 'will be replaced' : 'keeping the stored key'}
                  </span>
                )}
              </label>
              <input
                id="conn-access-key"
                className={`${INPUT_CLASS} font-mono text-xs`}
                value={form.accessKeyId}
                onChange={(e) => setField('accessKeyId', e.target.value)}
                placeholder={isEdit ? 'unchanged — type to replace' : 'AKIA…'}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="col-span-2">
              <label htmlFor="conn-secret-key" className={LABEL_CLASS}>
                Secret Access Key
                {isEdit && (
                  <span className="ml-1.5 font-normal text-zinc-500 dark:text-zinc-400">
                    {form.secretAccessKey.trim() ? 'will be replaced' : 'keeping the stored key'}
                  </span>
                )}
              </label>
              <input
                id="conn-secret-key"
                type="password"
                className={`${INPUT_CLASS} font-mono text-xs`}
                value={form.secretAccessKey}
                onChange={(e) => setField('secretAccessKey', e.target.value)}
                placeholder={isEdit ? 'unchanged — type to replace' : undefined}
                autoComplete="new-password"
                spellCheck={false}
              />
            </div>
          </div>

          <details
            className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2"
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Advanced settings
            </summary>
            <div className="mt-3 space-y-4">
              <div>
                <label htmlFor="conn-region" className={LABEL_CLASS}>Region</label>
                <input
                  id="conn-region"
                  className={INPUT_CLASS}
                  value={form.region}
                  onChange={(e) => setField('region', e.target.value)}
                  placeholder="us-east-1"
                  spellCheck={false}
                />
              </div>
              <div>
                <label htmlFor="conn-session-token" className={LABEL_CLASS}>
                  Session Token
                  <span className="ml-1.5 font-normal text-zinc-500 dark:text-zinc-400">optional</span>
                </label>
                <input
                  id="conn-session-token"
                  type="password"
                  className={`${INPUT_CLASS} font-mono text-xs`}
                  value={form.sessionToken}
                  onChange={(e) => setField('sessionToken', e.target.value)}
                  placeholder="AWS STS / SSO session token"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <label htmlFor="conn-path-style" className="flex items-start gap-2.5 text-sm text-zinc-600 dark:text-zinc-300 cursor-pointer">
                <input
                  id="conn-path-style"
                  type="checkbox"
                  checked={form.pathStyle}
                  onChange={(e) => setField('pathStyle', e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-zinc-300 dark:border-zinc-600 accent-teal-600 text-teal-600 focus:ring-teal-500"
                />
                <span>
                  Path-style addressing
                  <span className="block text-zinc-500 dark:text-zinc-400">
                    Required for most MinIO and on-premises endpoints.
                  </span>
                </span>
              </label>
              <CustomHeadersField
                rows={form.headers}
                onChange={(headers) => setField('headers', headers)}
                inputClass={INPUT_CLASS}
                labelClass={LABEL_CLASS}
              />
            </div>
          </details>

          {error && (
            <div role="alert" className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm rounded-lg border border-red-100 dark:border-red-900/30">
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

          {diagnosis.status !== 'idle' && (
            <div
              className={`p-3 text-sm rounded-lg border flex items-start gap-2 ${
                diagnosis.status === 'ok'
                  ? 'bg-zinc-50 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700'
                  : diagnosis.status === 'fail'
                    ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-100 dark:border-amber-900/40'
                    : 'bg-zinc-50 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border-zinc-100 dark:border-zinc-700'
              }`}
            >
              {diagnosis.status === 'testing' ? (
                <>
                  <Loader2 size={15} className="flex-none mt-0.5 animate-spin" />
                  Checking whether this server can reach the bucket…
                </>
              ) : diagnosis.status === 'ok' ? (
                <>
                  <CheckCircle2 size={15} className="flex-none mt-0.5" />
                  <span className="break-words">{diagnosis.message}</span>
                </>
              ) : (
                <>
                  <AlertTriangle size={15} className="flex-none mt-0.5" />
                  <span className="break-words">{diagnosis.message}</span>
                </>
              )}
            </div>
          )}
          </div>

          <div className="flex-none flex items-center justify-between px-6 py-4 border-t border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900">
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
              {isEdit ? 'Save changes' : 'Save connection'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
