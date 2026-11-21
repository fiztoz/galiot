/**
 * Explains a connection test or a failed listing in terms the user can act on.
 *
 * Every S3 request is signed and sent by the Galiot server, so what matters is
 * whether that server reached the endpoint and what the endpoint answered.
 * Bucket CORS and the browser's own reachability are not involved.
 */

import { canUseVirtualHosting } from './url';
import { BRAND } from '../branding';

export type ConnectionVerdictReason =
  | 'ok'
  | 'host-unreachable'
  | 'request-rejected'
  | 'addressing-unsupported'
  | 'unknown';

export interface ConnectionDiagnosis {
  reason: ConnectionVerdictReason;
  /** Human-readable explanation, safe to show in the UI. */
  detail: string;
  /** Concrete next step for the user. */
  hint?: string;
}

export interface DiagnoseInput {
  /** Result of the signed request through the server, when one was attempted. */
  requestSucceeded?: boolean;
  /**
   * The error text from the failed request. It separates "the request never
   * arrived" (network) from "the endpoint answered and refused" (key, bucket,
   * permission).
   */
  requestError?: string;
  /** Endpoint, used to check whether virtual-hosting is even possible. */
  endpoint?: string;
  pathStyle?: boolean;
}

/**
 * Whether the request failed before any S3 answer: the browser could not reach
 * the Galiot server, or the server could not reach the endpoint. With no error
 * text at all, assume the network.
 */
export function isNetworkFailure(error?: string | null): boolean {
  if (!error) return true;
  return /typeerror|failed to fetch|load failed|networkerror|could not reach|\b502\b|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo/i
    .test(error);
}

/** Turns a connection attempt into an actionable verdict. Pure, so directly testable. */
export function diagnoseConnection(input: DiagnoseInput): ConnectionDiagnosis {
  const { requestSucceeded, requestError, endpoint, pathStyle } = input;

  // An IP endpoint cannot carry the bucket as a subdomain: a provable
  // misconfiguration, so it is reported before anything that merely failed.
  if (endpoint && !canUseVirtualHosting(endpoint) && !pathStyle) {
    return {
      reason: 'addressing-unsupported',
      detail:
        'This endpoint is an IP address, so a bucket cannot be added to the hostname. The request was built without the bucket in the path.',
      hint: 'Turn on "Path-style addressing" — it is required for IP/local endpoints such as MinIO.',
    };
  }

  if (requestSucceeded === true) {
    return {
      reason: 'ok',
      detail: `The bucket answered through the ${BRAND.name} server, which signed the request and called S3.`,
    };
  }

  if (requestSucceeded === false) {
    if (isNetworkFailure(requestError)) {
      return {
        reason: 'host-unreachable',
        detail: `The ${BRAND.name} server could not reach the endpoint.`,
        hint: `The machine running ${BRAND.name} must be able to reach the endpoint, including DNS, the port, and whether it needs http:// instead of https://.`,
      };
    }
    return {
      reason: 'request-rejected',
      detail: `The endpoint received the request and refused it${requestError ? `: ${requestError}` : ''}.`,
      hint: 'Check the server access gate, the S3 credentials, the bucket name, and the key\'s permission for this request.',
    };
  }

  return {
    reason: 'unknown',
    detail: `No signed request has been attempted through the ${BRAND.name} server yet.`,
    hint: 'Run "Test connection" to check the server route and credentials.',
  };
}
