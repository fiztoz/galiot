import { useCallback, useEffect, useState } from 'react';
import { X, Loader2, Plug, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import type { AppDB, ConnectionRow } from '../db/client';
import type { S3ProfileConfig, Credentials } from '../vault/protocol';
import { createConnection, getSealedCredentials, updateConnection } from '../vault/repository';
import { vaultService } from '../vault/vaultService';
import { CorsHelper } from './CorsHelper';
import { CustomHeadersField } from './CustomHeadersField';
import {
  normalizeCustomHeaders,
  parseStoredHeaders,
  type HeaderDraft,
} from '../s3/customHeaders';
import { diagnoseCors, type CorsDiagnostic } from '../s3/diagnostics';
import { normalizeEndpoint } from '../s3/url';
import { bridgeTokenFor } from '../bridge/session';

interface ConnectionDialogProps {
  db: AppDB;
  open: boolean;
  onClose: () => void;
  /** When set, the dialog edits this connection instead of creating one. */
  editing?: ConnectionRow | null;
  /** Called after an edit is saved. */
  onSaved?: () => void;
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

interface FormState {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  /** Extra request headers, as editable rows. Validated on save and on test. */
  headers: HeaderDraft[];
}

const EMPTY_FORM: FormState = {
  name: '',
  endpoint: '',
  region: 'us-east-1',
  bucket: '',
  accessKeyId: '',
  secretAccessKey: '',
  pathStyle: false,
  headers: [],
};

export function ConnectionDialog({ db, open, onClose, editing, onSaved }: ConnectionDialogProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const [cors, setCors] = useState<CorsState>({ status: 'idle' });
  const [testedTarget, setTestedTarget] = useState<S3ProfileConfig | null>(null);
  const [diagnosis, setDiagnosis] = useState<CorsDiagnostic | null>(null);
  // The credentials the last test actually used, so the CORS helper works on
  // an edit without ever needing the plaintext keys.
  const [credentialsForTest, setCredentialsForTest] = useState<Credentials | null>(null);
  const [saving, setSaving] = useState(false);

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
            pathStyle: editing.path_style,
            // Read through the same screening the request path uses, so a row
            // written before a rule existed is not shown back as editable.
            headers: Object.entries(parseStoredHeaders(editing.custom_headers)).map(
              ([name, value]) => ({ name, value }),
            ),
          }
        : EMPTY_FORM,
    );
    setError(null);
    setTest({ status: 'idle' });
    setCors({ status: 'idle' });
    setTestedTarget(null);
    setDiagnosis(null);
    setCredentialsForTest(null);
    setSaving(false);
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
    setTest({ status: 'idle' });
    setCors({ status: 'idle' });
  }, []);

  const buildPayload = useCallback(():
    | { ok: true; headers: Record<string, string> }
    | { ok: false; error: string } => {
    if (!form.name.trim()) return { ok: false, error: 'Connection name is required.' };
    if (!form.endpoint.trim()) return { ok: false, error: 'Endpoint is required.' };
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

    if (isEdit) {
      // Blank means "keep the stored keys". Half-typed is always a mistake:
      // saving it would replace a working pair with a broken one.
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

  const handleTest = useCallback(async () => {
    const check = buildPayload();
    if (!check.ok) {
      setTest({ status: 'fail', message: check.error });
      return;
    }

    setTest({ status: 'testing' });
    setCors({ status: 'idle' });
    setDiagnosis(null);

    const rawEndpoint = form.endpoint.trim();
    const profile = {
      endpoint: normalizeEndpoint(rawEndpoint),
      region: form.region.trim() || 'us-east-1',
      bucket: form.bucket.trim(),
      pathStyle: form.pathStyle,
      // Included so "Test" exercises the connection as it will actually be
      // used. A header the gateway requires is exactly the kind of thing that
      // only shows up on a real signed request.
      headers: check.headers,
      bridgeToken: editing ? bridgeTokenFor(editing.id) : undefined,
    };
    const typedKeys = {
      accessKeyId: form.accessKeyId.trim(),
      secretAccessKey: form.secretAccessKey.trim(),
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

    // Remember the target either way: the CORS helper is most useful exactly
    // when the connection test fails.
    setTestedTarget(profile);
    setCredentialsForTest(credentials);

    // 1. Can we reach the host at all? This probe is CORS-free, so it separates
    //    DNS/port/TLS problems from browser CORS blocks. It also tries the other
    //    addressing form, so a bucket-subdomain that does not resolve is
    //    reported as the addressing problem it is, not as a dead network.
    let reachable = true;
    let probeUrl = profile.endpoint;
    let alternateReachable: boolean | undefined;
    let alternateUrl: string | undefined;
    try {
      const probe = await vaultService.call('s3.probe', { profile });
      reachable = probe.reachable;
      probeUrl = probe.url;
      alternateReachable = probe.alternateReachable;
      alternateUrl = probe.alternateUrl;
    } catch {
      reachable = false;
    }

    // 2. Real signed request.
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

    // 3. Turn the two signals into one actionable verdict.
    const verdict = diagnoseCors(
      {
        probeUrl,
        requestSucceeded,
        // Distinguishes "the browser blocked it" from "the bucket refused it".
        requestError: failureMessage ?? undefined,
        endpoint: profile.endpoint,
        rawEndpoint,
        pathStyle: form.pathStyle,
        alternateReachable,
        alternateUrl,
      },
      reachable,
    );
    setDiagnosis(verdict);

    if (verdict.reason === 'cors-blocked' || verdict.reason === 'host-unreachable') {
      setCors({ status: 'fail', message: `${verdict.detail}${verdict.hint ? ` ${verdict.hint}` : ''}` });
    } else if (verdict.reason === 'request-rejected') {
      // The bucket answered and said no. Showing CORS remediation here would
      // send the user after a policy that is not the problem.
      setCors({
        status: 'fail',
        message: `${verdict.detail}${verdict.hint ? ` ${verdict.hint}` : ''}`,
      });
    } else {
      // For addressing problems, try to repair automatically: an IP endpoint
      // simply cannot use virtual-hosted addressing.
      if (verdict.reason === 'addressing-unsupported') {
        setField('pathStyle', true);
        setCors({ status: 'fail', message: `${verdict.detail} Switching to path-style addressing — test again.` });
      } else {
        setCors({ status: 'idle' });
      }
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
          await updateConnection(db, editing.id, {
            ...shared,
            ...(accessKeyId && secretAccessKey
              ? { credentials: { accessKeyId, secretAccessKey } }
              : {}),
          });
          onSaved?.();
        } else {
          await createConnection(db, {
            ...shared,
            accessKeyId: form.accessKeyId.trim(),
            secretAccessKey: form.secretAccessKey.trim(),
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

  // Either the keys are typed, or this is an edit where blank means "keep the
  // stored ones" — both give the helper something usable to work with.
  const hasUsableCredentials =
    (form.accessKeyId.trim() !== '' && form.secretAccessKey.trim() !== '') ||
    (isEdit && form.accessKeyId.trim() === '' && form.secretAccessKey.trim() === '');

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
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              {isEdit ? 'Edit Connection' : 'Add Connection'}
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
              {isEdit
                ? 'Change anything — the stored keys are kept unless you replace them.'
                : 'S3-compatible endpoint — R2, MinIO, AWS S3, B2, Spaces…'}
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
              <label htmlFor="conn-access-key" className={LABEL_CLASS}>
                Access Key ID
                {isEdit && (
                  <span className="ml-1.5 font-normal text-zinc-400 dark:text-zinc-500">
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
                  <span className="ml-1.5 font-normal text-zinc-400 dark:text-zinc-500">
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

          <CustomHeadersField
            rows={form.headers}
            onChange={(headers) => setField('headers', headers)}
            inputClass={INPUT_CLASS}
            labelClass={LABEL_CLASS}
          />

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

          {testedTarget && hasUsableCredentials && (
            <CorsHelper
              profile={testedTarget}
              credentials={credentialsForTest ?? { plain: { accessKeyId: '', secretAccessKey: '' } }}
              onApplied={() => setCors({ status: 'ok', message: 'CORS policy applied — run the test again to confirm.' })}
              diagnosis={diagnosis}
            />
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
              {isEdit ? 'Save changes' : 'Save connection'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
