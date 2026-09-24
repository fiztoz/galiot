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
  Cable,
} from 'lucide-react';
import { S3Client, type CorsConfiguration, type CorsRule } from '../s3/client';
import {
  corsConfigToAwsJson,
  corsRuleToXml,
  evaluateCors,
  type CorsVerdict,
} from '../s3/corsPolicy';
import { buildCorsRemediation, type RemediationOption } from '../s3/corsRemediation';
import { canUseVirtualHosting } from '../s3/url';
import type { CorsDiagnostic } from '../s3/diagnostics';
import { shouldOfferBridge } from '../bridge/environment';
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
  const [bridgeToken, setBridgeToken] = useState('');
  const [bridgeStatus, setBridgeStatus] = useState<
    | { state: 'unknown' | 'checking' | 'up' | 'down'; message?: string }
  >({ state: 'unknown' });
  // Remediation command state. The presigned URL is fetched on demand: it
  // expires, and a stale one would only produce a confusing 403.
  const [remediation, setRemediation] = useState<RemediationOption[] | null>(null);
  const [remediationBusy, setRemediationBusy] = useState(false);
  const [activeOption, setActiveOption] = useState<RemediationOption['id']>('curl');
  const [copiedScript, setCopiedScript] = useState(false);

  // Derived before the callbacks below, which depend on them.
  const recommended = S3Client.recommendedCorsRule(origin);
  const evaluation = config ? evaluateCors(config, origin) : null;
  const verdict = evaluation?.verdict ?? null;

  /**
   * Builds the copy-paste commands. Each one is self-contained: no `mc alias
   * set`, no `aws configure`, no hand-written policy file. A user cannot
   * configure those tools before they have a profile, and cannot get a profile
   * until CORS is fixed — so the commands carry everything themselves.
   */
  const buildRemediation = useCallback(
    async (withSecrets: boolean) => {
      setRemediationBusy(true);
      setError(null);
      try {
        const { url } = await vaultService.call('s3.cors.presign', {
          profile,
          credentials: { plain: credentials },
          expiresIn: 3600,
        });

        setRemediation(
          buildCorsRemediation({
            endpoint: profile.endpoint,
            region: profile.region,
            bucket: profile.bucket,
            config: { rules: [recommended] },
            presignedUrl: url,
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            includeSecrets: withSecrets,
            shell: /windows/i.test(navigator.userAgent) ? 'powershell' : 'posix',
          }),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRemediationBusy(false);
      }
    },
    [credentials, profile, recommended],
  );

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

  const checkBridge = useCallback(async () => {
    setBridgeStatus({ state: 'checking' });
    try {
      const health = await vaultService.call('bridge.health', {
        origin: window.location.origin,
        token: bridgeToken,
      });
      setBridgeStatus(
        health.reachable
          ? { state: 'up' }
          : { state: 'down', message: 'The bridge is not running on 127.0.0.1:8787.' },
      );
    } catch (err) {
      setBridgeStatus({
        state: 'down',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [bridgeToken]);

  /** Applies the policy from the machine, where CORS does not apply. */
  const applyViaBridge = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const existing = config?.rules ?? [];
      const next: CorsConfiguration = {
        rules: [
          ...existing.filter((rule) => !rule.allowedOrigins.includes(origin)),
          recommended,
        ],
      };

      const result = await vaultService.call('s3.cors.putViaBridge', {
        profile,
        credentials: { plain: credentials },
        config: next,
        origin: window.location.origin,
        token: bridgeToken,
      });

      if (result.applied) {
        setConfig(next);
        setBridgeStatus({ state: 'up' });
        onApplied?.();
      } else {
        setBridgeStatus({
          state: 'down',
          message: `The bridge could not apply the policy (HTTP ${result.status}). ${result.body ?? ''}`.trim(),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [bridgeToken, config, credentials, onApplied, profile, recommended]);

  const copyXml = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(corsRuleToXml(recommended));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Clipboard unavailable in this context.');
    }
  }, [recommended]);

  /** Copies a generated remediation block, with its own copied-flag. */
  const copyScript = useCallback(async (script: string) => {
    try {
      await navigator.clipboard.writeText(script);
      setCopiedScript(true);
      setTimeout(() => setCopiedScript(false), 1500);
    } catch {
      setError('Clipboard unavailable in this context.');
    }
  }, []);

  const copy = VERDICT_COPY[verdict ?? 'none'];
  const needsPathStyle = !canUseVirtualHosting(profile.endpoint) && !profile.pathStyle;
  // Verified in a real browser: when CORS is broken the browser blocks the
  // PutBucketCors request too, so the one-click fix cannot bootstrap itself.
  const corsBlocksTheFix = diagnosis?.reason === 'cors-blocked' || verdict === 'none';
  // Local development only: a deployed build's visitors have no bridge to use.
  const bridgeOffered = corsBlocksTheFix && shouldOfferBridge();

  // Build the safe variant (no secret in the command) the first time the
  // commands are needed, since the presigned URL expires.
  useEffect(() => {
    if (corsBlocksTheFix && remediation === null && !remediationBusy) {
      void buildRemediation(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corsBlocksTheFix, remediation, remediationBusy]);

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
            &ldquo;Apply&rdquo; until a policy exists. Pick whichever of these you already have — each
            one is a complete command, so nothing needs configuring first.
          </p>

          <div className="flex flex-wrap gap-1" role="tablist" aria-label="CORS remediation method">
            {(remediation ?? []).map((option) => (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={activeOption === option.id}
                onClick={() => setActiveOption(option.id)}
                className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors ${
                  activeOption === option.id
                    ? 'bg-teal-600 text-white'
                    : 'bg-white dark:bg-zinc-950 border border-amber-200 dark:border-amber-900 text-zinc-600 dark:text-zinc-300 hover:bg-amber-50 dark:hover:bg-zinc-900'
                }`}
              >
                {option.label}
              </button>
            ))}
            {remediationBusy && (
              <span className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] text-zinc-500">
                <Loader2 size={11} className="animate-spin" />
                Preparing…
              </span>
            )}
          </div>

          {remediation
            ?.filter((option) => option.id === activeOption)
            .map((option) => (
              <div key={option.id} className="space-y-1.5">
                <p className="text-[10px] text-zinc-500 dark:text-zinc-400">{option.requires}</p>

                {option.id === 'dashboard' ? (
                  <>
                    <pre className="p-2 rounded bg-white dark:bg-zinc-950 border border-amber-200 dark:border-amber-900 overflow-x-auto text-[10px] leading-relaxed">
                      {corsConfigToAwsJson({ rules: [recommended] })}
                    </pre>
                    <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
                      Paste into your provider&rsquo;s CORS settings (R2: bucket → Settings → CORS
                      rules). The AWS CLI JSON shape is what every S3-compatible console accepts.
                    </p>
                  </>
                ) : (
                  <>
                    <pre className="p-2 rounded bg-white dark:bg-zinc-950 border border-amber-200 dark:border-amber-900 overflow-x-auto text-[10px] leading-relaxed whitespace-pre-wrap break-all">
                      {option.script}
                    </pre>
                    {option.id === 'curl' && (
                      <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
                        Paste the whole block into a terminal and run it. The URL carries a signature
                        for this one request, valid for an hour — no keys, no configuration, and
                        nothing to install.
                      </p>
                    )}
                  </>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      void copyScript(
                        option.id === 'dashboard'
                          ? corsConfigToAwsJson({ rules: [recommended] })
                          : option.script,
                      )
                    }
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md border border-amber-300 dark:border-amber-800 text-zinc-700 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-900 transition-colors"
                  >
                    {copiedScript ? <Check size={11} /> : <Copy size={11} />}
                    {copiedScript ? 'Copied' : 'Copy'}
                  </button>

                  {option.id !== 'curl' && option.id !== 'dashboard' && (
                    <label className="inline-flex items-center gap-1.5 text-[10px] text-zinc-500 dark:text-zinc-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={option.containsSecret}
                        onChange={(e) => void buildRemediation(e.target.checked)}
                        disabled={remediationBusy}
                        className="h-3 w-3 rounded border-zinc-300 dark:border-zinc-600 text-teal-600 focus:ring-teal-500"
                      />
                      Fill in my keys
                    </label>
                  )}
                </div>

                {option.containsSecret && (
                  <p className="flex items-start gap-1.5 text-[10px] text-amber-700 dark:text-amber-400">
                    <AlertTriangle size={11} className="flex-none mt-0.5" />
                    <span>
                      This command now contains your secret key, and your shell saves commands in
                      its history. Leave it unticked to be prompted for the keys instead.
                    </span>
                  </p>
                )}
              </div>
            ))}
        </div>
      )}

      {bridgeOffered && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40 p-2.5 space-y-2">
          <p className="text-[11px] text-zinc-600 dark:text-zinc-300 leading-relaxed">
            Or let the local bridge do it for you: it signs the request in the vault worker and
            sends it from this machine, where the browser&rsquo;s CORS rules do not apply.
          </p>

          <ol className="text-[11px] text-zinc-500 dark:text-zinc-400 list-decimal pl-4 space-y-1">
            <li>
              Start the bridge in your project:{' '}
              <code className="font-mono px-1 py-0.5 rounded bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700">
                bun run bridge
              </code>
            </li>
            <li>Paste the token it prints below.</li>
          </ol>

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={bridgeToken}
              onChange={(e) => {
                setBridgeToken(e.target.value.trim());
                setBridgeStatus({ state: 'unknown' });
              }}
              placeholder="Bridge token"
              aria-label="Bridge token"
              className="flex-1 px-2.5 py-1.5 text-xs font-mono bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-teal-500 dark:text-zinc-100"
            />
            <button
              type="button"
              onClick={() => void checkBridge()}
              disabled={bridgeToken.length === 0 || bridgeStatus.state === 'checking'}
              className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800 transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {bridgeStatus.state === 'checking' ? 'Checking…' : 'Check bridge'}
            </button>
          </div>

          {bridgeStatus.state === 'up' && (
            <p className="text-[11px] text-green-600 dark:text-green-400">Bridge is running.</p>
          )}
          {bridgeStatus.state === 'down' && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400 break-words">
              {bridgeStatus.message}
            </p>
          )}

          <button
            type="button"
            onClick={() => void applyViaBridge()}
            disabled={loading || bridgeStatus.state !== 'up'}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Cable size={12} />}
            Apply CORS policy via bridge
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void apply(true)}
          disabled={loading || verdict === 'ok' || bridgeOffered}
          title={
            corsBlocksTheFix
              ? 'The browser blocks this request until a CORS policy exists — use the bridge or a terminal.'
              : undefined
          }
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
          {verdict === 'ok'
            ? 'Policy applied'
            : bridgeOffered
              ? 'Use the bridge below'
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

      {corsBlocksTheFix && !bridgeOffered && (
        <pre className="text-[10px] leading-relaxed p-2 rounded bg-zinc-950 text-zinc-300 border border-zinc-200 dark:border-zinc-800 overflow-x-auto">
          {corsRuleToXml(recommended)}
        </pre>
      )}

      <p className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-relaxed">
        {bridgeOffered
          ? 'The bridge is a local development tool and is only offered while Galiot runs on this machine.'
          : `“Apply” appends a rule for ${origin} and keeps existing rules. Deleting removes the whole configuration, which may break other apps using this bucket.`}
      </p>
    </div>
  );
}
