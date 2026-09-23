/// <reference lib="webworker" />
import { VaultManager } from '../vault/vault';
import { S3Client } from '../s3/client';
import { AwsClient } from '../lib/aws4fetch';
import { presignGetUrl } from '../s3/presign';
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
} from '../vault/protocol';

let vault: VaultManager | null = null;

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

    case 'creds.encrypt': {
      const p = params as { credentials: CredentialPlaintext };
      const payload = await requireUnlocked().encryptCredentials(p.credentials);
      return { payload };
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

    case 's3.delete': {
      const p = params as NonNullable<VaultRequest<'s3.delete'>['params']>;
      const creds = await resolveCredentials(p.credentials);
      const client = makeS3Client(p.profile, creds);
      return client.deleteObjects(p.keys);
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
      const url = await presignGetUrl(
        aws,
        p.profile.endpoint,
        p.profile.bucket,
        p.key,
        p.expiresIn ?? 3600,
      );
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
