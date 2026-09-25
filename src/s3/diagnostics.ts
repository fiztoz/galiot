/**
 * CORS diagnostics that tell the truth.
 *
 * A signed S3 request carries `Authorization` and `x-amz-*` headers, so the
 * browser always preflights it — and a failed preflight is reported as the
 * useless `TypeError: Failed to fetch`. The old check tried to reproduce that
 * preflight by hand, which could never succeed and so always reported failure
 * even for correctly configured buckets.
 *
 * This module separates the two causes instead:
 *  - can we reach the host at all? (DNS, port, TLS, http vs https)
 *  - if we can, the remaining failure is a CORS policy problem
 */

import { canUseVirtualHosting } from './url';

export type CorsVerdictReason =
  | 'ok'
  | 'host-unreachable'
  | 'cors-blocked'
  | 'request-rejected'
  | 'addressing-unsupported'
  | 'unknown';

export interface CorsDiagnostic {
  /** A no-cors probe reached the endpoint (or did not). */
  reachable: boolean;
  reason: CorsVerdictReason;
  /** Human-readable explanation, safe to show in the UI. */
  detail: string;
  /** Concrete next step for the user. */
  hint?: string;
  /** The URL that was probed. */
  probedUrl: string;
}

/**
 * Whether a failure means the browser refused to hand us the response, as
 * opposed to the server sending one we did not like.
 *
 * A CORS block is a network-level `TypeError: Failed to fetch` — the response
 * never reaches script. An HTTP error (403, 404, 400…) arrives intact, status
 * and all, because the CORS headers were present. Conflating the two sent users
 * with a wrong key or a missing bucket off to fix CORS, which cannot help.
 *
 * With no error text at all we keep the conservative CORS verdict, which is
 * what an opaque failure has always meant.
 */
export function isBlockedByBrowser(error?: string | null): boolean {
  if (error === undefined || error === null || error === '') return true;
  return /typeerror|failed to fetch|load failed|networkerror/i.test(error);
}

/**
 * Probes an endpoint without triggering CORS so reachability can be judged on
 * its own. `mode: 'no-cors'` with a simple GET yields an opaque response when
 * the host answers and a TypeError when it does not.
 *
 * Do not pass `redirect: 'manual'`: Chrome rejects that combination in no-cors
 * mode with a TypeError, which would report every host as unreachable.
 */
export async function probeReachability(url: string): Promise<{ reachable: boolean; error?: string }> {
  try {
    await fetch(url, { method: 'GET', mode: 'no-cors', redirect: 'manual' });
    return { reachable: true };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface DiagnoseInput {
  /** Bucket URL to probe (already built by the client). */
  probeUrl: string;
  /** Result of the real signed request, when one was attempted. */
  requestSucceeded?: boolean;
  /**
   * The error text from the failed request. This is what separates "the browser
   * blocked the response" (CORS) from "the server answered and refused"
   * (wrong key, missing bucket, denied permission).
   */
  requestError?: string;
  /** Endpoint, used to check whether virtual-hosting is even possible. */
  endpoint?: string;
  /** How the user typed the endpoint (may lack a scheme). */
  rawEndpoint?: string;
  pathStyle?: boolean;
}

/**
 * Turns a failed (or successful) connection attempt into an actionable verdict.
 * Pure — no network — so it is directly unit-testable.
 */
export function diagnoseCors(input: DiagnoseInput, reachable: boolean): CorsDiagnostic {
  const { probeUrl, requestSucceeded, requestError, endpoint, rawEndpoint, pathStyle } = input;

  // 1. Addressing mistakes produce wrong URLs; catch them before blaming CORS.
  if (endpoint && !canUseVirtualHosting(endpoint) && !pathStyle) {
    return {
      reachable,
      reason: 'addressing-unsupported',
      detail:
        'This endpoint is an IP address, so a bucket cannot be added to the hostname. The request was built without the bucket in the path.',
      hint: 'Turn on "Path-style addressing" — it is required for IP/local endpoints such as MinIO.',
      probedUrl: probeUrl,
    };
  }

  // 2. A missing scheme is the classic cause of an unreachable local endpoint.
  if (!reachable && rawEndpoint && !/^https?:\/\//i.test(rawEndpoint.trim())) {
    return {
      reachable,
      reason: 'host-unreachable',
      detail: 'The endpoint has no http:// or https:// scheme, so the browser cannot resolve it.',
      hint: 'Prefix the endpoint with a scheme. Local MinIO usually needs http:// (e.g. http://127.0.0.1:9000).',
      probedUrl: probeUrl,
    };
  }

  if (!reachable) {
    return {
      reachable,
      reason: 'host-unreachable',
      detail:
        'The endpoint did not respond at all, so the request never reached the bucket. This is a network, DNS, port or TLS problem — not CORS.',
      hint: 'Check the host and port, and whether the endpoint needs http:// instead of https:// (common for self-hosted MinIO).',
      probedUrl: probeUrl,
    };
  }

  if (requestSucceeded === false) {
    // The host answered, so the failure is either a browser block (the response
    // never reached us) or a real HTTP error we can actually read. Only the
    // former is CORS.
    if (isBlockedByBrowser(requestError)) {
      return {
        reachable: true,
        reason: 'cors-blocked',
        detail:
          'The endpoint answered, but the browser blocked the response. Signed requests preflight because they carry Authorization and x-amz-* headers, so the bucket must allow those headers as well as the methods.',
        hint: 'Apply the recommended CORS policy below, or add AllowedHeaders "*" and ExposeHeader "ETag" for this origin.',
        probedUrl: probeUrl,
      };
    }

    return {
      reachable: true,
      reason: 'request-rejected',
      detail: `The bucket received the request and refused it${
        requestError ? `: ${requestError}` : ''
      }. The browser did not block anything, so this is not a CORS problem.`,
      hint: 'Check the access key and secret, that the bucket name is correct, and that the key is allowed to list it.',
      probedUrl: probeUrl,
    };
  }

  if (requestSucceeded === true) {
    return {
      reachable: true,
      reason: 'ok',
      detail: 'The bucket answered a signed request from this origin.',
      probedUrl: probeUrl,
    };
  }

  return {
    reachable,
    reason: 'unknown',
    detail: 'The endpoint is reachable, but no signed request has been attempted yet.',
    hint: 'Run "Test connection" to check credentials and CORS together.',
    probedUrl: probeUrl,
  };
}
