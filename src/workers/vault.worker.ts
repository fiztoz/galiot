/// <reference lib="webworker" />
import { VaultManager } from '../vault/vault';
import { S3Client } from '../s3/client';
import { AwsClient } from '../lib/aws4fetch';
import { presignGetUrl, presignPutUrl } from '../s3/presign';
import {
  buildGaleonPreview,
  prepareGaleonImport,
} from '../vault/galeonImport';
import type { EncryptedPayload } from '../vault/crypto';
import type { CorsConfiguration } from '../s3/client';
import type { SignRequest, SignResponse } from '../transfer/protocol';
import { BRIDGE_DEFAULT_PORT, BRIDGE_TOKEN_HEADER } from '../bridge/policy';
import {
  VAULT_CHANNEL,
  VAULT_EVENT_CHANNEL,
  VAULT_RESPONSE_CHANNEL,
  type Credentials,
  type CredentialPlaintext,
  type S3ProfileConfig,
  type VaultRequest,
  type VaultResponse,
  type VaultMethod,
  type FolderStatsResult,
} from '../vault/protocol';

/** Minimal byte formatter for worker-side error messages. */
function formatBytesForWorker(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}


/** Signs a request with a client that already holds credentials. */
async function signWith(
  client: AwsClient,
  method: string,
  url: URL,
  headers: Record<string, string>,
): Promise<{ url: string; method: string; headers: Record<string, string> }> {
  const signed = await client.sign(url, { method, headers: new Headers(headers) });
  const out: Record<string, string> = {};
  signed.headers.forEach((value, name) => {
    out[name] = value;
  });
  return { url: signed.url, method: signed.method, headers: out };
}

function serializeCorsConfig(config: { rules: CorsConfiguration['rules'] }): string {
  const escape = (value: string): string =>
    value.replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch] ?? ch,
    );

  const rules = config.rules
    .map((rule) => {
      const list = (items: string[], tag: string): string =>
        items.map((item) => `<${tag}>${escape(item)}</${tag}>`).join('');
      return (
        '<CORSRule>' +
        list(rule.allowedOrigins, 'AllowedOrigin') +
        list(rule.allowedMethods, 'AllowedMethod') +
        list(rule.allowedHeaders, 'AllowedHeader') +
        list(rule.exposeHeaders, 'ExposeHeader') +
        `<MaxAgeSeconds>${rule.maxAgeSeconds}</MaxAgeSeconds>` +
        '</CORSRule>'
      );
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration>${rules}</CORSConfiguration>`;
}

function bridgeUrl(path: string): string {
  return `http://127.0.0.1:${BRIDGE_DEFAULT_PORT}${path}`;
}

async function probeBridge(
  origin: string,
  token: string,
): Promise<{ reachable: boolean; error?: string }> {
  try {
    const res = await fetch(bridgeUrl('/health'), {
      headers: { Origin: origin, [BRIDGE_TOKEN_HEADER]: token },
    });
    if (!res.ok) return { reachable: false, error: `bridge responded ${res.status}` };
    return { reachable: true };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function forwardViaBridge(
  origin: string,
  token: string,
  payload: { target: string; method: string; headers: Record<string, string>; body: string },
): Promise<{ ok: boolean; status: number; body?: string }> {
  try {
    const res = await fetch(bridgeUrl('/forward'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        [BRIDGE_TOKEN_HEADER]: token,
      },
      body: JSON.stringify(payload),
    });

    const data = (await res.json()) as {
      ok?: boolean;
      status?: number;
      body?: string;
      error?: string;
    };
    return { ok: data.ok === true, status: data.status ?? res.status, body: data.error ?? data.body };
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}

let vault: VaultManager | null = null;
/** Direct channel to the transfer worker for signing. */
let transferPort: MessagePort | null = null;
/** AwsClient cache per profile, wiped whenever the vault locks. */
const signerCache = new Map<string, AwsClient>();

function emitLocked(): void {
  postMessage({ channel: VAULT_EVENT_CHANNEL, event: 'locked' });
}

function requireUnlocked(): VaultManager {
  if (!vault || !vault.isUnlocked()) {
    throw new Error('Vault is locked');
  }
  return vault;
}

async function resolveCredentials(credentials: Credentials): Promise<CredentialPlaintext> {
  if ('plain' in credentials) {
    return credentials.plain;
  }
  return requireUnlocked().decryptCredentials(credentials.sealed);
}

/**
 * Resolves a signing client for a profile from the sealed credential blob the
 * transfer worker forwards. Credentials are decrypted here and never leave this
 * worker — the transfer worker only ever receives signed requests.
 */
async function getSigner(profileId: string, sealed: EncryptedPayload): Promise<AwsClient> {
  const cached = signerCache.get(profileId);
  if (cached) return cached;

  const creds = await requireUnlocked().decryptCredentials(sealed);
  const client = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    // Region/endpoint live on the (non-secret) target the transfer worker holds;
    // SigV4 needs the region, which the worker passes per request when known.
    region: undefined,
    service: 's3',
  });
  signerCache.set(profileId, client);
  return client;
}

/** Signs one request for the transfer worker. */
async function handleSignRequest(request: SignRequest): Promise<void> {
  if (!transferPort || request.type !== 'sign') return;

  try {
    const signer = await getSigner(request.profileId, request.credentials);
    const headers = new Headers(request.headers);
    const signed = await signer.sign(new URL(request.url), {
      method: request.method,
      headers,
      body: request.body,
      // Region is per-connection and non-secret: the transfer worker passes it.
      aws: { region: request.region },
    });

    const signedHeaders: Record<string, string> = {};
    signed.headers.forEach((value, key) => {
      signedHeaders[key] = value;
    });

    const response: SignResponse = {
      type: 'signed',
      id: request.id,
      url: signed.url,
      method: signed.method,
      headers: signedHeaders,
    };
    transferPort.postMessage(response);
  } catch (err) {
    const response: SignResponse = {
      type: 'sign-error',
      id: request.id,
      error: err instanceof Error ? err.message : String(err),
    };
    transferPort.postMessage(response);
  }
}

function makeS3Client(profile: S3ProfileConfig, creds: CredentialPlaintext): S3Client {
  return new S3Client({
    endpoint: profile.endpoint,
    region: profile.region,
    bucket: profile.bucket,
    pathStyle: profile.pathStyle,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  });
}

/**
 * Walks a folder subtree depth-first with delimiter listing, collecting every
 * directory and file entry for an exact roll-up (roadmap 2.4). Capped so a
 * single click can never run away on a huge bucket.
 */
async function collectFolderStats(
  client: S3Client,
  rootKey: string,
  maxEntries: number,
): Promise<FolderStatsResult> {
  const directories: string[] = [];
  const files: FolderStatsResult['files'] = [];
  const stack: string[] = [rootKey];

  let entryCount = 0;
  let truncated = false;

  while (stack.length > 0 && !truncated) {
    const prefix = stack.pop() as string;
    let continuationToken: string | undefined;

    do {
      const page = await client.listObjects(prefix, {
        delimiter: '/',
        maxKeys: 1000,
        continuationToken,
      });

      for (const childPrefix of page.prefixes) {
        entryCount += 1;
        if (entryCount > maxEntries) {
          truncated = true;
          break;
        }
        directories.push(childPrefix);
        stack.push(childPrefix);
      }

      for (const object of page.objects) {
        entryCount += 1;
        if (entryCount > maxEntries) {
          truncated = true;
          break;
        }
        files.push({
          key: object.key,
          size: object.size,
          lastModified: object.lastModified,
          eTag: object.eTag,
          storageClass: object.storageClass,
        });
      }

      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken && !truncated);
  }

  return { directories, files, truncated, entryCount };
}

async function dispatch<M extends VaultMethod>(
  method: M,
  params: VaultRequest<M>['params'],
): Promise<unknown> {
  switch (method) {
    case 'vault.create': {
      const p = params as { passphrase: string };
      vault?.lock();
      const { vault: created, sealed } = await VaultManager.create(p.passphrase, emitLocked);
      vault = created;
      return sealed;
    }

    case 'vault.unlock': {
      const p = params as { passphrase: string; salt: string; wrappedDek: string };
      vault?.lock();
      vault = await VaultManager.unlock(p.passphrase, { salt: p.salt, wrappedDek: p.wrappedDek }, emitLocked);
      return { unlocked: true as const };
    }

    case 'vault.lock': {
      signerCache.clear();
      vault?.lock();
      vault = null;
      return { locked: true as const };
    }

    case 'vault.status': {
      return { unlocked: vault?.isUnlocked() ?? false };
    }

    case 'vault.verify': {
      const p = params as { passphrase: string; salt: string; wrappedDek: string };
      const valid = await VaultManager.verify(p.passphrase, { salt: p.salt, wrappedDek: p.wrappedDek });
      return { valid };
    }

    case 'vault.attachTransferPort': {
      // A port arrives here directly from the main thread; the other end lives
      // in the transfer worker. From now on this worker signs for it.
      const p = params as { port: MessagePort };
      transferPort = p.port;
      transferPort.onmessage = (event: MessageEvent<SignRequest>) => {
        void handleSignRequest(event.data);
      };
      return { attached: true as const };
    }

    case 'creds.encrypt': {
      const p = params as { credentials: CredentialPlaintext };
      const payload = await requireUnlocked().encryptCredentials(p.credentials);
      return { payload };
    }

    // Galeon import. The file text arrives from a file the user picked, it is
    // parsed here, and the credentials are encrypted here — so the plaintext
    // keys exist in this worker and nowhere else. The preview the main thread
    // renders is built from the secret-free entries only.
    case 'galeon.preview': {
      const p = params as { text: string };
      return buildGaleonPreview(p.text);
    }

    case 'galeon.prepare': {
      const p = params as { text: string; expectedHash: string };
      const manager = requireUnlocked();
      return prepareGaleonImport(p.text, p.expectedHash, (credentials) =>
        manager.encryptCredentials(credentials),
      );
    }

    case 's3.test': {
      const p = params as { profile: S3ProfileConfig; credentials: Credentials };
      try {
        const creds = await resolveCredentials(p.credentials);
        const client = makeS3Client(p.profile, creds);
        const listing = await client.listObjects('', { delimiter: '/', maxKeys: 5 });
        return {
          ok: true,
          objectCount: listing.objects.length,
          commonPrefixes: listing.prefixes,
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    case 's3.probe': {
      const p = params as { profile: S3ProfileConfig };
      // No credentials needed: this only asks whether the host answers.
      const client = makeS3Client(p.profile, { accessKeyId: '', secretAccessKey: '' });
      return client.probeReachable();
    }

    case 's3.cors.get': {
      const p = params as NonNullable<VaultRequest<'s3.cors.get'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return makeS3Client(p.profile, creds).getBucketCors();
    }

    case 's3.cors.put': {
      const p = params as NonNullable<VaultRequest<'s3.cors.put'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      await makeS3Client(p.profile, creds).putBucketCors(p.config);
      return { applied: true as const };
    }

    case 'bridge.health': {
      const p = params as { origin: string; token: string };
      return probeBridge(p.origin, p.token);
    }

    case 's3.cors.putViaBridge': {
      const p = params as NonNullable<VaultRequest<'s3.cors.putViaBridge'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const client = makeS3Client(p.profile, creds);
      const signer = new AwsClient({
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
        region: p.profile.region,
        service: 's3',
      });

      // Sign here, forward there: the DEK and secret never leave this worker,
      // and the bridge only ever sees a normal SigV4-signed S3 request.
      const url = client.objectUrl(undefined, { cors: '' });
      const signed = await signWith(signer, 'PUT', url, { 'content-type': 'application/xml' });
      const body = serializeCorsConfig(p.config);

      const result = await forwardViaBridge(p.origin, p.token, {
        target: signed.url,
        method: signed.method,
        headers: signed.headers,
        body,
      });

      return {
        applied: result.ok && result.status >= 200 && result.status < 300,
        status: result.status,
        body: result.body?.slice(0, 500),
        via: 'bridge' as const,
      };
    }

    case 's3.cors.delete': {
      const p = params as NonNullable<VaultRequest<'s3.cors.delete'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      await makeS3Client(p.profile, creds).deleteBucketCors();
      return { deleted: true as const };
    }

    case 's3.list': {
      const p = params as NonNullable<VaultRequest<'s3.list'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const client = makeS3Client(p.profile, creds);
      return client.listObjects(p.prefix, {
        delimiter: p.delimiter ?? '/',
        maxKeys: p.maxKeys,
        continuationToken: p.continuationToken,
      });
    }

    case 's3.folderStats': {
      const p = params as NonNullable<VaultRequest<'s3.folderStats'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const client = makeS3Client(p.profile, creds);
      return collectFolderStats(client, p.rootKey, p.maxEntries ?? 20000);
    }

    case 's3.delete': {
      const p = params as NonNullable<VaultRequest<'s3.delete'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const client = makeS3Client(p.profile, creds);
      return client.deleteObjects(p.keys);
    }

    case 's3.getText': {
      const p = params as NonNullable<VaultRequest<'s3.getText'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const client = makeS3Client(p.profile, creds);
      const maxBytes = p.maxBytes ?? 2 * 1024 * 1024;
      const res = await client.getObject(p.key);
      if (!res.ok) throw new Error(`GetObject failed: ${res.status} ${res.statusText}`);

      const declared = parseInt(res.headers.get('content-length') ?? '0', 10);
      if (declared > maxBytes) {
        throw new Error(
          `File is ${formatBytesForWorker(declared)} — the editor opens files up to 2 MB. Use Download instead.`,
        );
      }

      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        throw new Error('File is too large for the in-browser editor.');
      }

      return {
        text: new TextDecoder('utf-8', { fatal: false }).decode(buffer),
        size: buffer.byteLength,
        contentType: res.headers.get('content-type'),
        eTag: res.headers.get('etag'),
      };
    }

    case 's3.putText': {
      const p = params as NonNullable<VaultRequest<'s3.putText'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const client = makeS3Client(p.profile, creds);
      const result = await client.putObject(p.key, p.body, p.contentType);
      return { eTag: result.eTag };
    }

    case 's3.presignGet': {
      const p = params as NonNullable<VaultRequest<'s3.presignGet'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const aws = new AwsClient({
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
        region: p.profile.region,
        service: 's3',
      });
      const target = {
        endpoint: p.profile.endpoint,
        bucket: p.profile.bucket,
        pathStyle: p.profile.pathStyle,
      };
      const url = await presignGetUrl(aws, target, p.key, p.expiresIn ?? 3600);
      return { url };
    }

    case 's3.presignPut': {
      const p = params as NonNullable<VaultRequest<'s3.presignPut'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const aws = new AwsClient({
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
        region: p.profile.region,
        service: 's3',
      });
      const target = {
        endpoint: p.profile.endpoint,
        bucket: p.profile.bucket,
        pathStyle: p.profile.pathStyle,
      };
      const url = await presignPutUrl(aws, target, p.key, p.contentType, p.expiresIn ?? 3600);
      return { url };
    }

    default: {
      throw new Error(`Unknown vault method: ${String(method)}`);
    }
  }
}

addEventListener('message', (event: MessageEvent<VaultRequest>) => {
  const msg = event.data;
  // Ignore PGlite/other protocol traffic; only handle our channel.
  if (!msg || msg.channel !== VAULT_CHANNEL || typeof msg.id !== 'number') {
    return;
  }

  void (async () => {
    try {
      const result = await dispatch(msg.method, msg.params);
      const response: VaultResponse = {
        channel: VAULT_RESPONSE_CHANNEL,
        id: msg.id,
        ok: true,
        result: result as never,
      };
      postMessage(response);
    } catch (err) {
      const response: VaultResponse = {
        channel: VAULT_RESPONSE_CHANNEL,
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      postMessage(response);
    }
  })();
});
