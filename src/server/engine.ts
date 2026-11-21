import { s3ClientForProfile, type S3Client, type S3Dispatch } from '../s3/client.ts';
import type { CredentialPlaintext, S3ProfileConfig } from '../vault/protocol.ts';
import type { SessionView } from './sessions.ts';
import { resolveProxyAddresses, type ProxyLookup } from './target.ts';
import { forwardRequest } from './upstream.ts';

/**
 * Signs in this process and connects only to addresses checked for this request.
 * The browser never supplies the upstream URL.
 */
export function pinnedDispatch(lookup?: ProxyLookup, forward = forwardRequest): S3Dispatch {
  return async (signed, signal) => {
    const url = new URL(signed.url);
    const headers = new Headers(signed.headers);
    const addresses = await resolveProxyAddresses(url, lookup);
    const request = new Request(signed, signal ? { signal } : undefined);
    return forward(url, addresses, request, headers);
  };
}

export function clientForSession(
  session: SessionView,
  lookup?: ProxyLookup,
  forward = forwardRequest,
): S3Client {
  const profile: S3ProfileConfig = {
    endpoint: session.endpoint,
    region: session.region,
    bucket: session.bucket,
    pathStyle: session.pathStyle,
    headers: session.headers,
  };
  const creds: CredentialPlaintext = {
    accessKeyId: session.accessKeyId,
    secretAccessKey: session.secretAccessKey,
    sessionToken: session.sessionToken,
  };
  return s3ClientForProfile(profile, creds, { dispatch: pinnedDispatch(lookup, forward) });
}
