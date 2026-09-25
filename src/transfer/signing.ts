import { parseStoredHeaders, withCustomHeaders } from '../s3/customHeaders';

/**
 * Assembles the headers to sign for a request whose headers arrive from two
 * places: the connection's stored custom headers, and the call itself.
 *
 * Both halves matter and neither is visible from a call site, which is why this
 * is a named function rather than an inline expression in the worker:
 *
 *  - `parseStoredHeaders` re-screens the stored headers. They cross the
 *    main→worker boundary as cleartext, they outlive schema upgrades, and a rule
 *    added later has to hold for rows written before it existed. The worker is
 *    the trust boundary, so it screens rather than trusts.
 *  - `withCustomHeaders` puts the per-call headers last, so a resumed download's
 *    `Range` and an upload's `Content-Type` cannot be displaced by a stored row.
 *    Those two are part of what the signature covers.
 *
 * Used by the transfer-signing path and the local-bridge path, which are the two
 * request routes that do not go through `S3Client`.
 */
export function mergeScreenedHeaders(
  customHeaders: Record<string, string> | undefined,
  callHeaders: Record<string, string>,
): Record<string, string> {
  return withCustomHeaders(parseStoredHeaders(parseable(customHeaders)), callHeaders);
}

/** `parseStoredHeaders` accepts unknown; this keeps the call sites honest. */
function parseable(headers: Record<string, string> | undefined): unknown {
  return headers ?? null;
}
