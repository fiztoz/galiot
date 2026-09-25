import type { ConnectionRow } from '../db/client';
import { profileConfig } from './objects';
import { diagnoseCors, type CorsDiagnostic } from '../s3/diagnostics';
import { vaultService } from '../vault/vaultService';

/**
 * Turns a failed bucket request into an actionable explanation instead of the
 * browser's opaque `TypeError: Failed to fetch`, which is all a CORS block or
 * a wrong endpoint looks like from script.
 */
export async function classifyConnectionFailure(
  profile: ConnectionRow,
  error: unknown,
): Promise<CorsDiagnostic> {
  let reachable = true;
  let probeUrl = profile.endpoint;

  try {
    // A CORS-free probe: this succeeds whenever the host answers at all.
    const probe = await vaultService.call('s3.probe', { profile: profileConfig(profile) });
    reachable = probe.reachable;
    probeUrl = probe.url;
  } catch {
    reachable = false;
  }

  const diagnosis = diagnoseCors(
    {
      probeUrl,
      requestSucceeded: false,
      // The real error is what separates a CORS block from a bucket that
      // answered and said no (403 AccessDenied, 404 NoSuchBucket, …).
      requestError: error instanceof Error ? error.message : String(error ?? ''),
      endpoint: profile.endpoint,
      rawEndpoint: profile.endpoint,
      pathStyle: profile.path_style,
    },
    reachable,
  );

  // Keep the original error text for the (rare) case the diagnosis is 'unknown'.
  if (diagnosis.reason === 'unknown' && error instanceof Error) {
    return { ...diagnosis, detail: diagnosis.detail, hint: error.message };
  }
  return diagnosis;
}
