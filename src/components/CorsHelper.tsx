import { useCallback, useEffect, useState } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  Loader2,
  Wand2,
  Copy,
  Check,
  Trash2,
  AlertTriangle,
} from 'lucide-react';
import { S3Client, type CorsConfiguration, type CorsRule } from '../s3/client';
import { corsRuleToXml, evaluateCors, type CorsVerdict } from '../s3/corsPolicy';
import { canUseVirtualHosting } from '../s3/url';
import type { CorsDiagnostic } from '../s3/diagnostics';
import type { CredentialPlaintext } from '../vault/protocol';
import { vaultService } from '../vault/vaultService';

interface CorsHelperProps {
  profile: { endpoint: string; region: string; bucket: string; pathStyle: boolean };
  credentials: CredentialPlaintext;
  /** Existing policy, if the wizard already fetched it. */
  initialConfig?: CorsConfiguration | null;
  /** Verdict from the connection attempt, when one has been made. */
  diagnosis?: CorsDiagnostic | null;
  onApplied?: () => void;
}

const VERDICT_COPY: Record<CorsVerdict, { title: string; detail: string; tone: 'ok' | 'warn' }> = {
  ok: {
    title: 'CORS looks good',
    detail: 'This bucket allows the methods Galiot needs and exposes ETag.',
    tone: 'ok',
  },
  none: {
    title: 'No CORS configuration',
    detail: 'The browser will block every request to this bucket. Apply the policy below.',
    tone: 'warn',
  },
  'origin-missing': {
    title: 'Origin not allowed',
    detail: 'No rule covers this app’s origin, so the browser will block requests.',
    tone: 'warn',
  },
  'methods-missing': {
    title: 'Some methods are missing',
    detail: 'Uploads, deletes and multipart completion would fail. Apply the policy below.',
    tone: 'warn',
  },
  'etag-hidden': {
    title: 'ETag is not exposed',
    detail:
      'Multipart uploads need to read the ETag response header. Without ExposeHeader, part uploads fail.',
    tone: 'warn',
  },
};

/**
 * Interactive CORS diagnostics + remediation (roadmap 5.1). Appending keeps
 * other applications' rules intact; removal is opt-in and explicit.
 */
export function CorsHelper({
  profile,
  credentials,
  initialConfig,
  diagnosis,
  onApplied,
}: CorsHelperProps) {
  const origin = window.location.origin;
  const [config, setConfig] = useState<CorsConfiguration | null>(initialConfig ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await vaultService.call('s3.cors.get', { profile, credentials: { plain: credentials } });
      setConfig(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [profile, credentials]);

  useEffect(() => {
    if (initialConfig === undefined) void fetchConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialConfig]);

  const recommended = S3Client.recommendedCorsRule(origin);
  const evaluation = config ? evaluateCors(config, origin) : null;
  const verdict = evaluation?.verdict ?? null;

  const apply = useCallback(
    async (append: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const existing = config?.rules ?? [];
        const withoutGaliot = existing.filter(
          (rule) => !rule.allowedOrigins.includes(origin) || rule.allowedMethods.length === 0,
        );
        const next: CorsConfiguration = {
          rules: append ? [...withoutGaliot, recommended] : [recommended],
        };

        await vaultService.call('s3.cors.put', {
          profile,
          credentials: { plain: credentials },
          config: next,
        });
        setConfig(next);
        onApplied?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [config, credentials, onApplied, profile, recommended],
  );

  const remove = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await vaultService.call('s3.cors.delete', { profile, credentials: { plain: credentials } });
      setConfig({ rules: [] });
      setConfirmRemove(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [credentials, profile]);

  const copyXml = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(corsRuleToXml(recommended));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Clipboard unavailable in this context.');
    }
  }, [recommended]);

  const copy = VERDICT_COPY[verdict ?? 'none'];
  const needsPathStyle = !canUseVirtualHosting(profile.endpoint) && !profile.pathStyle;
  // Verified in a real browser: when CORS is broken the browser blocks the
  // PutBucketCors request too, so the one-click fix cannot bootstrap itself.
  const corsBlocksTheFix = diagnosis?.reason === 'cors-blocked' || verdict === 'none';

  return (
    <div className="p-3 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-200">
          {copy.tone === 'ok' ? (
            <ShieldCheck size={14} className="text-green-500" />
          ) : (
            <ShieldAlert size={14} className="text-amber-500" />
          )}
          CORS helper
        </span>
        <button
          type="button"
          onClick={() => void fetchConfig()}
          disabled={loading}
          className="text-[11px] text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          {loading ? <Loader2 size={12} className="animate-spin inline" /> : 'Re-check'}
        </button>
      </div>

      {diagnosis && diagnosis.reason !== 'ok' ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            {diagnosis.reason === 'cors-blocked'
              ? 'CORS is blocking this connection'
              : diagnosis.reason === 'host-unreachable'
                ? 'Cannot reach the endpoint'
                : 'Addressing problem'}
          </p>
          <p className="text-[11px] text-zinc-600 dark:text-zinc-300 leading-relaxed">
            {diagnosis.detail}
          </p>
          {diagnosis.hint && (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
              {diagnosis.hint}
            </p>
          )}
        </div>
      ) : (
        <p
          className={`text-xs leading-relaxed ${
            copy.tone === 'ok' ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'
          }`}
        >
          <strong className="font-semibold">{copy.title}.</strong> {copy.detail}
        </p>
      )}

      {needsPathStyle && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">
          This endpoint is an IP address, so the bucket cannot be part of the hostname. Tick
          &ldquo;Path-style addressing&rdquo; in the form above.
        </p>
      )}

      {evaluation && evaluation.missing.length > 0 && (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Missing: {evaluation.missing.join(', ')}
        </p>
      )}

      {config && config.rules.length > 0 && (
        <details className="text-[11px] text-zinc-500 dark:text-zinc-400">
          <summary className="cursor-pointer">
            Current policy ({config.rules.length} rule{config.rules.length === 1 ? '' : 's'})
          </summary>
          <pre className="mt-1.5 p-2 rounded bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 overflow-x-auto text-[10px] leading-relaxed">
            {config.rules
              .map(
                (rule: CorsRule) => `${rule.allowedOrigins.join(', ')} → ${rule.allowedMethods.join(' ')}`,
              )
              .join('\n')}
          </pre>
        </details>
      )}

      {error && (
        <div className="flex items-start gap-2 text-[11px] text-red-600 dark:text-red-400">
          <AlertTriangle size={12} className="flex-none mt-0.5" />
          <span className="break-words">
            {error} — the connection likely lacks s3:GetBucketCors / s3:PutBucketCors permission.
          </span>
        </div>
      )}

      {corsBlocksTheFix && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/25 p-2.5 space-y-2">
          <p className="text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed">
            Writing a CORS policy is itself a signed cross-origin request, so the browser blocks
            &ldquo;Apply&rdquo; until a policy exists. Set the rule once from a terminal or console,
            then reload Galiot.
          </p>
          <div className="space-y-1 text-[10px] font-mono text-zinc-600 dark:text-zinc-300">
            <p className="text-zinc-500 dark:text-zinc-400"># MinIO</p>
            <code className="block px-2 py-1 rounded bg-white dark:bg-zinc-950 border border-amber-200 dark:border-amber-900 break-all">
              mc cors set myminio/{profile.bucket} cors.xml
            </code>
            <p className="text-zinc-500 dark:text-zinc-400 pt-1"># AWS S3</p>
            <code className="block px-2 py-1 rounded bg-white dark:bg-zinc-950 border border-amber-200 dark:border-amber-900 break-all">
              aws s3api put-bucket-cors --bucket {profile.bucket} --cors-configuration file://cors.json
            </code>
            <p className="text-zinc-500 dark:text-zinc-400 pt-1"># Cloudflare R2 (dashboard → bucket → Settings → CORS)</p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void apply(true)}
          disabled={loading || verdict === 'ok' || corsBlocksTheFix}
          title={
            corsBlocksTheFix
              ? 'The browser blocks this request until a CORS policy exists — use a terminal instead.'
              : undefined
          }
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
          {verdict === 'ok'
            ? 'Policy applied'
            : corsBlocksTheFix
              ? 'Apply from a terminal'
              : 'Apply recommended policy'}
        </button>

        <button
          type="button"
          onClick={() => void copyXml()}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
            corsBlocksTheFix
              ? 'bg-teal-600 hover:bg-teal-700 text-white'
              : 'border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800'
          }`}
        >
          {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
          {corsBlocksTheFix ? 'Copy CORS XML' : 'Copy XML'}
        </button>

        {config && config.rules.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (confirmRemove) void remove();
              else setConfirmRemove(true);
            }}
            onBlur={() => setConfirmRemove(false)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              confirmRemove
                ? 'bg-red-600 border-red-600 text-white'
                : 'border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30'
            }`}
          >
            <Trash2 size={12} />
            {confirmRemove ? 'Delete all rules?' : 'Delete policy'}
          </button>
        )}
      </div>

      {corsBlocksTheFix && (
        <pre className="text-[10px] leading-relaxed p-2 rounded bg-zinc-950 text-zinc-300 border border-zinc-200 dark:border-zinc-800 overflow-x-auto">
          {corsRuleToXml(recommended)}
        </pre>
      )}

      <p className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-relaxed">
        “Apply” appends a rule for {origin} and keeps existing rules. Deleting removes the whole
        configuration, which may break other apps using this bucket.
      </p>
    </div>
  );
}
