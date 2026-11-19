/// <reference lib="webworker" />
import { VaultManager } from '../vault/vault';
import { RemoteS3, RemoteS3Error, closeServerSession, listBucketsFromServer, openServerSession, probeFromServer } from '../s3/remote';
import {
  buildGaleonPreview,
  prepareGaleonImport,
} from '../vault/galeonImport';
import type { SessionRequest, SessionResponse } from '../transfer/protocol';
import {
  VAULT_CHANNEL,
  VAULT_EVENT_CHANNEL,
  VAULT_RESPONSE_CHANNEL,
  type Credentials,
  type CredentialPlaintext,
  type S3ProfileConfig,
  type VaultEvent,
  type VaultLockReason,
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


let vault: VaultManager | null = null;
/** Direct channel to the transfer worker for server sessions. */
let transferPort: MessagePort | null = null;
/** Server sessions opened by this worker, closed when the vault locks. */
const openSessions = new Map<string, string | undefined>();

function emitLocked(reason: VaultLockReason): void {
  void closeSessions();
  const event: VaultEvent = { channel: VAULT_EVENT_CHANNEL, event: 'locked', reason };
  postMessage(event);
}

async function closeSessions(): Promise<void> {
  const open = [...openSessions];
  openSessions.clear();
  await Promise.all(open.map(([id, token]) => closeServerSession(id, token)));
  // The transfer worker caches session ids; tell it they are all dead.
  transferPort?.postMessage({ type: 'sessions-closed' });
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

/** Opens a server session. Credentials go to the self-hosted origin, not the main thread. */
async function sessionClient(profile: S3ProfileConfig, creds: CredentialPlaintext): Promise<RemoteS3> {
  const sessionId = await openServerSession(profile, creds, profile.proxyToken);
  openSessions.set(sessionId, profile.proxyToken);
  return new RemoteS3(sessionId, profile.proxyToken);
}

/** Gives the transfer worker a session id. It never receives the secret. */
async function handleSessionRequest(request: SessionRequest): Promise<void> {
  if (!transferPort || request.type !== 'session') return;
  try {
    const creds = await requireUnlocked().decryptCredentials(request.credentials);
    const sessionId = await openServerSession(
      {
        endpoint: request.endpoint,
        region: request.region,
        bucket: request.bucket,
        pathStyle: request.pathStyle,
        headers: request.headers,
        proxyToken: request.accessToken,
      },
      creds,
      request.accessToken,
    );
    openSessions.set(sessionId, request.accessToken);
    const response: SessionResponse = { type: 'session', id: request.id, sessionId };
    transferPort.postMessage(response);
  } catch (err) {
    const response: SessionResponse = {
      type: 'session-error',
      id: request.id,
      error: err instanceof Error ? err.message : String(err),
    };
    transferPort.postMessage(response);
  }
}

/**
 * Walks a folder subtree depth-first with delimiter listing, collecting every
 * directory and file entry for an exact roll-up (roadmap 2.4). Capped so a
 * single click can never run away on a huge bucket.
 */
async function collectFolderStats(
  client: RemoteS3,
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
      vault?.lock('manual');
      const { vault: created, sealed } = await VaultManager.create(p.passphrase, emitLocked);
      vault = created;
      return sealed;
    }

    case 'vault.unlock': {
      const p = params as { passphrase: string; salt: string; wrappedDek: string };
      vault?.lock('manual');
      vault = await VaultManager.unlock(p.passphrase, { salt: p.salt, wrappedDek: p.wrappedDek }, emitLocked);
      return { unlocked: true as const };
    }

    case 'vault.lock': {
      await closeSessions();
      vault?.lock('manual');
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
      transferPort.onmessage = (event: MessageEvent<SessionRequest>) => {
        void handleSessionRequest(event.data);
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
        const client = await sessionClient(p.profile, creds);
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
      return probeFromServer(p.profile, p.profile.proxyToken);
    }

    case 's3.cors.get': {
      const p = params as NonNullable<VaultRequest<'s3.cors.get'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).getBucketCors();
    }

    case 's3.cors.put': {
      const p = params as NonNullable<VaultRequest<'s3.cors.put'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      try {
        await (await sessionClient(p.profile, creds)).putBucketCors(p.config);
        return { applied: true as const };
      } catch (err) {
        // MinIO answers 501 NotImplemented. That is not a permissions problem.
        if (err instanceof RemoteS3Error) {
          return {
            applied: false,
            error: err.message,
            status: err.status,
            code: err.code,
            unsupported: err.unsupported,
          };
        }
        throw err;
      }
    }

    case 's3.cors.presign': {
      const p = params as NonNullable<VaultRequest<'s3.cors.presign'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const expiresIn = p.expiresIn ?? 3600;
      const { url } = await (await sessionClient(p.profile, creds)).presignCors(expiresIn);
      return { url, expiresIn };
    }

    case 's3.cors.delete': {
      const p = params as NonNullable<VaultRequest<'s3.cors.delete'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      await (await sessionClient(p.profile, creds)).deleteBucketCors();
      return { deleted: true as const };
    }

    case 's3.list': {
      const p = params as NonNullable<VaultRequest<'s3.list'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const client = await sessionClient(p.profile, creds);
      return client.listObjects(p.prefix, {
        delimiter: p.delimiter ?? '/',
        maxKeys: p.maxKeys,
        continuationToken: p.continuationToken,
      });
    }

    case 's3.folderStats': {
      const p = params as NonNullable<VaultRequest<'s3.folderStats'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const client = await sessionClient(p.profile, creds);
      return collectFolderStats(client, p.rootKey, p.maxEntries ?? 20000);
    }

    case 's3.delete': {
      const p = params as NonNullable<VaultRequest<'s3.delete'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const client = await sessionClient(p.profile, creds);
      return client.deleteObjects(p.keys);
    }

    case 's3.getText': {
      const p = params as NonNullable<VaultRequest<'s3.getText'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const client = await sessionClient(p.profile, creds);
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
      const client = await sessionClient(p.profile, creds);
      const result = await client.putObject(p.key, p.body, p.contentType);
      return { eTag: result.eTag };
    }

    case 's3.presignGet': {
      const p = params as NonNullable<VaultRequest<'s3.presignGet'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).presignGet(p.key, p.expiresIn ?? 3600);
    }

    case 's3.presignPut': {
      const p = params as NonNullable<VaultRequest<'s3.presignPut'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).presignPut(p.key, p.contentType, p.expiresIn ?? 3600);
    }

    case 's3.mediaUrl': {
      const p = params as NonNullable<VaultRequest<'s3.mediaUrl'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).mediaUrl(p.key);
    }

    case 's3.head': {
      const p = params as NonNullable<VaultRequest<'s3.head'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).head(p.key);
    }

    case 's3.createFolder': {
      const p = params as NonNullable<VaultRequest<'s3.createFolder'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).createFolder(p.key);
    }

    case 's3.copy': {
      const p = params as NonNullable<VaultRequest<'s3.copy'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).copy(p.sourceKey, p.destKey);
    }

    case 's3.rename': {
      const p = params as NonNullable<VaultRequest<'s3.rename'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).rename(p.sourceKey, p.destKey);
    }

    case 's3.shareLink': {
      const p = params as NonNullable<VaultRequest<'s3.shareLink'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).shareLink(p.key, p.expiresIn);
    }

    case 's3.shareWrite': {
      const p = params as NonNullable<VaultRequest<'s3.shareWrite'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).shareWrite(p.key, p.expiresIn, p.maxBytes);
    }

    case 's3.listBuckets': {
      const p = params as NonNullable<VaultRequest<'s3.listBuckets'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const buckets = await listBucketsFromServer(p.profile, creds, p.profile.proxyToken);
      return { buckets };
    }

    case 's3.listVersions': {
      const p = params as NonNullable<VaultRequest<'s3.listVersions'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).listVersions(p.key);
    }

    case 's3.deleteVersion': {
      const p = params as NonNullable<VaultRequest<'s3.deleteVersion'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).deleteVersion(p.key, p.versionId);
    }

    case 's3.restoreVersion': {
      const p = params as NonNullable<VaultRequest<'s3.restoreVersion'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).restoreVersion(p.key, p.versionId);
    }

    case 's3.versionUrl': {
      const p = params as NonNullable<VaultRequest<'s3.versionUrl'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).mediaUrl(p.key, p.versionId);
    }

    case 's3.search': {
      const p = params as NonNullable<VaultRequest<'s3.search'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).search(p.query, p.prefix);
    }

    case 's3.listTree': {
      const p = params as NonNullable<VaultRequest<'s3.listTree'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).listTree(p.prefix);
    }

    case 's3.restore': {
      const p = params as NonNullable<VaultRequest<'s3.restore'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).restore(p.key, p.days);
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
