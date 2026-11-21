/// <reference lib="webworker" />
import { openManifest, sealManifest } from '../vault/exportFormat';
import { VaultManager } from '../vault/vault';
import { MAX_EDITOR_BYTES, RemoteS3, RemoteS3Error, closeServerSession, listBucketsFromServer, openServerSession, probeFromServer, readEditorText } from '../s3/remote';
import {
  MAX_IMPORT_FILE_BYTES,
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
let epoch = 0;
let generation: string | null = null;
/** Direct channel to the transfer worker for server sessions. */
let transferPort: MessagePort | null = null;
/** Server sessions opened by this worker, closed when the vault locks. */
const openSessions = new Map<string, string | undefined>();
/**
 * One reusable server session per connection target and sealed credential.
 * Without it every call would post the secret again and leave another live
 * copy on the server, crowding out other users' sessions.
 */
const sessionCache = new Map<string, { owner: VaultManager; id: Promise<string>; token: string | undefined }>();
const MAX_CACHED_SESSIONS = 16;

function emitLocked(reason: VaultLockReason): void {
  epoch++;
  generation = null;
  closeSessions();
  const event: VaultEvent = { channel: VAULT_EVENT_CHANNEL, event: 'locked', reason };
  postMessage(event);
}

function closeSessions(): void {
  const open = [...openSessions];
  openSessions.clear();
  sessionCache.clear();
  // The transfer worker caches session ids; tell it they are all dead.
  transferPort?.postMessage({ type: 'sessions-closed' });
  for (const [id, token] of open) void closeServerSession(id, token);
}

function invalidate(): void {
  // Also cancel any unlock or create which is still deriving a key.
  vault?.lock('manual');
  epoch++;
  vault = null;
  generation = null;
}

// Receive replacements in the worker even when the UI thread is busy.
if (typeof BroadcastChannel !== 'undefined') {
  const changes = new BroadcastChannel('galiot-vault-changes');
  changes.onmessage = ({ data }) => {
    if (typeof data?.generation === 'string' && data.generation === generation) invalidate();
  };
}

async function readGaleon(file: File): Promise<string> {
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('The Galeon import limit is 5 MB.');
  return file.text();
}

function requireUnlocked(): VaultManager {
  if (!vault || !vault.isUnlocked()) {
    throw new Error('Vault is locked');
  }
  return vault;
}

interface SessionCredentials {
  owner: VaultManager;
  material: CredentialPlaintext;
  /** Sealed ciphertext identity; plain (unsaved) credentials are never cached. */
  identity?: string;
}

function assertOwner(owner: VaultManager): void {
  if (owner !== vault || !owner.isUnlocked()) throw new Error('Vault session changed');
}

async function resolveCredentials(credentials: Credentials): Promise<SessionCredentials> {
  const owner = requireUnlocked();
  const material = 'plain' in credentials ? credentials.plain : await owner.decryptCredentials(credentials.sealed);
  assertOwner(owner);
  const identity = 'sealed' in credentials ? `${credentials.sealed.iv}:${credentials.sealed.ciphertext}` : undefined;
  return { material, owner, identity };
}

async function trackedSession(profile: S3ProfileConfig, creds: SessionCredentials): Promise<string> {
  assertOwner(creds.owner);
  const id = await openServerSession(profile, creds.material, profile.proxyToken);
  if (creds.owner !== vault || !creds.owner.isUnlocked()) {
    void closeServerSession(id, profile.proxyToken);
    throw new Error('Vault locked while the server session was opening');
  }
  openSessions.set(id, profile.proxyToken);
  return id;
}

function forgetSession(id: string, token: string | undefined): void {
  openSessions.delete(id);
  void closeServerSession(id, token);
}

/** A cached session id, or a new one when there is none or `stale` was rejected. */
async function cachedSession(profile: S3ProfileConfig, creds: SessionCredentials, stale?: string): Promise<string> {
  if (!creds.identity) return trackedSession(profile, creds);
  const key = JSON.stringify([profile.endpoint, profile.region, profile.bucket, profile.pathStyle,
    Object.entries(profile.headers ?? {}).sort(), profile.proxyToken ?? null, creds.identity]);
  const hit = sessionCache.get(key);
  if (hit && hit.owner === creds.owner) {
    const id = await hit.id.catch(() => undefined);
    if (id !== undefined && id !== stale) return id;
    if (sessionCache.get(key) !== hit) return cachedSession(profile, creds, stale);
  }
  if (hit) sessionCache.delete(key);
  if (stale) openSessions.delete(stale);
  const id = trackedSession(profile, creds);
  const entry = { owner: creds.owner, id, token: profile.proxyToken };
  sessionCache.set(key, entry);
  id.catch(() => {
    if (sessionCache.get(key) === entry) sessionCache.delete(key);
  });
  while (sessionCache.size > MAX_CACHED_SESSIONS) {
    const [oldestKey, oldest] = sessionCache.entries().next().value!;
    sessionCache.delete(oldestKey);
    void oldest.id.then(evicted => forgetSession(evicted, oldest.token), () => {});
  }
  return id;
}

async function sessionClient(profile: S3ProfileConfig, creds: SessionCredentials): Promise<RemoteS3> {
  return new RemoteS3(await cachedSession(profile, creds), profile.proxyToken,
    stale => cachedSession(profile, creds, stale));
}

async function handleSessionRequest(request: SessionRequest): Promise<void> {
  const port = transferPort;
  if (!port || request.type !== 'session') return;
  try {
    const creds = await resolveCredentials({ sealed: request.credentials });
    const sessionId = await trackedSession({
      endpoint: request.endpoint,
      region: request.region,
      bucket: request.bucket,
      pathStyle: request.pathStyle,
      headers: request.headers,
      proxyToken: request.accessToken,
    }, creds);
    if (transferPort !== port) {
      openSessions.delete(sessionId);
      void closeServerSession(sessionId, request.accessToken);
      throw new Error('Transfer worker changed');
    }
    assertOwner(creds.owner);
    const response: SessionResponse = { type: 'session', id: request.id, sessionId };
    port.postMessage(response);
  } catch (err) {
    const response: SessionResponse = {
      type: 'session-error',
      id: request.id,
      error: err instanceof Error ? err.message : String(err),
    };
    port.postMessage(response);
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
    case 'vault.create':
    case 'vault.unlock': {
      const p = params as NonNullable<VaultRequest<'vault.unlock'>['params']>;
      invalidate();
      const ticket = epoch;
      const onLock = (reason: VaultLockReason) => {
        if (ticket === epoch) emitLocked(reason);
      };
      const result = method === 'vault.create'
        ? await VaultManager.create(p.passphrase, onLock)
        : { vault: await VaultManager.unlock(p.passphrase, p, onLock), sealed: undefined };
      if (ticket !== epoch) {
        result.vault.lock();
        throw new Error('Vault state changed during key derivation');
      }
      vault = result.vault;
      generation = p.generation;
      return result.sealed ?? { unlocked: true };
    }

    case 'vault.lock': {
      invalidate();
      return { locked: true };
    }

    case 'vault.invalidate': {
      const p = params as NonNullable<VaultRequest<'vault.invalidate'>['params']>;
      const invalidated = p.generation === generation;
      if (invalidated) invalidate();
      return { invalidated };
    }

    case 'vault.status':
      return { unlocked: vault?.isUnlocked() ?? false, generation };

    case 'vault.export': {
      const p = params as NonNullable<VaultRequest<'vault.export'>['params']>;
      const owner = requireUnlocked();
      if (generation !== p.generation) throw new Error('Vault changed before backup');
      const result = await sealManifest(owner, p.manifest);
      assertOwner(owner);
      return result;
    }

    case 'vault.import': {
      const p = params as NonNullable<VaultRequest<'vault.import'>['params']>;
      return openManifest(p.file, p.passphrase);
    }

    case 'vault.attachTransferPort': {
      // A port arrives here directly from the main thread; the other end lives
      // in the transfer worker. From now on this worker signs for it.
      const p = params as { port: MessagePort };
      transferPort?.close();
      transferPort = p.port;
      transferPort.onmessage = (event: MessageEvent<SessionRequest>) => {
        void handleSessionRequest(event.data);
      };
      return { attached: true as const };
    }

    case 'creds.encrypt': {
      const p = params as { credentials: CredentialPlaintext };
      const owner = requireUnlocked();
      const payload = await owner.encryptCredentials(p.credentials);
      assertOwner(owner);
      return { payload, generation };
    }

    case 'galeon.preview': {
      const { file } = params as NonNullable<VaultRequest<'galeon.preview'>['params']>;
      return buildGaleonPreview(await readGaleon(file));
    }

    case 'galeon.prepare': {
      const { file, expectedHash } = params as NonNullable<VaultRequest<'galeon.prepare'>['params']>;
      const owner = requireUnlocked();
      const prepared = await prepareGaleonImport(await readGaleon(file), expectedHash,
        (credentials) => owner.encryptCredentials(credentials));
      assertOwner(owner);
      return { ...prepared, generation };
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
      const maxBytes = Math.min(p.maxBytes ?? MAX_EDITOR_BYTES, MAX_EDITOR_BYTES);
      const res = await client.getObject(p.key);
      if (!res.ok) throw new Error(`GetObject failed: ${res.status} ${res.statusText}`);

      const declared = parseInt(res.headers.get('content-length') ?? '0', 10);
      if (declared > maxBytes) {
        void res.body?.cancel().catch(() => {});
        throw new Error(
          `File is ${formatBytesForWorker(declared)} — the editor opens files up to 2 MB. Use Download instead.`,
        );
      }

      const decoded = await readEditorText(res, maxBytes);
      const { conditionalPut } = await client.editorWriteSupport();
      return { ...decoded, conditionalPut };
    }

    case 's3.putText': {
      const p = params as NonNullable<VaultRequest<'s3.putText'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const client = await sessionClient(p.profile, creds);
      const result = await client.putTextIfMatch(p.key, p.body, p.contentType, p.eTag);
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
      const buckets = await listBucketsFromServer(p.profile, creds.material, p.profile.proxyToken);
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

    case 's3.abortUpload': {
      const p = params as NonNullable<VaultRequest<'s3.abortUpload'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      return (await sessionClient(p.profile, creds)).abortMultipart(p.key, p.uploadId);
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
