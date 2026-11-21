import type { ConnectionRow } from '../db/client';
import { diagnoseConnection, type ConnectionDiagnosis } from '../s3/connectionDiagnosis';

/** Turns a failed bucket request into an actionable explanation for the listing banner. */
export async function classifyConnectionFailure(
  profile: ConnectionRow,
  error: unknown,
): Promise<ConnectionDiagnosis> {
  const diagnosis = diagnoseConnection({
    requestSucceeded: false,
    // The real error separates "never arrived" from a bucket that answered and
    // said no (403 AccessDenied, 404 NoSuchBucket, …).
    requestError: error instanceof Error ? error.message : String(error ?? ''),
    endpoint: profile.endpoint,
    pathStyle: profile.path_style,
  });

  // Keep the original error text for the (rare) case the diagnosis is 'unknown'.
  if (diagnosis.reason === 'unknown' && error instanceof Error) {
    return { ...diagnosis, hint: error.message };
  }
  return diagnosis;
}
