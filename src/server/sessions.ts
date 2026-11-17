/**
 * In-memory S3 sessions for the self-hosted server.
 *
 * The browser vault still seals credentials at rest. A session is the only
 * place the secret exists on the server, and only until it expires or the
 * vault locks. Nothing here is written to disk.
 */

const SESSION_TTL_MS = 15 * 60 * 1000;
const MEDIA_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 200;
const MAX_MEDIA = 500;

export interface SessionMaterial {
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  headers: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SessionView {
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  headers: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface SessionRecord {
  id: string;
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  headers: Record<string, string>;
  accessKeyId: Uint8Array;
  secretAccessKey: Uint8Array;
  sessionToken?: Uint8Array;
  expiresAt: number;
}

/**
 * An issued link owns its own credential snapshot. It must outlive the session
 * that minted it: the operator's vault auto-locks after 15 idle minutes, and a
 * share link that died with the lock would be useless. The snapshot is wiped
 * when the grant expires or is revoked.
 */
interface MediaGrant {
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  headers: Record<string, string>;
  accessKeyId: Uint8Array;
  secretAccessKey: Uint8Array;
  sessionToken?: Uint8Array;
  key: string;
  versionId?: string;
  expiresAt: number;
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function wipe(value: Uint8Array | undefined): void {
  value?.fill(0);
}

export function newCapabilityId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly media = new Map<string, MediaGrant>();

  constructor(private readonly now: () => number = Date.now) {}

  create(material: SessionMaterial, ttlMs = SESSION_TTL_MS): string {
    this.sweep();
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (!oldest) break;
      this.destroy(oldest);
    }
    const id = newCapabilityId();
    this.sessions.set(id, {
      id,
      endpoint: material.endpoint,
      region: material.region,
      bucket: material.bucket,
      pathStyle: material.pathStyle,
      headers: { ...material.headers },
      accessKeyId: encode(material.accessKeyId),
      secretAccessKey: encode(material.secretAccessKey),
      sessionToken: material.sessionToken ? encode(material.sessionToken) : undefined,
      expiresAt: this.now() + ttlMs,
    });
    return id;
  }

  /** Returns a live view and extends the idle timer. Secrets are copies. */
  use(id: string, ttlMs = SESSION_TTL_MS): SessionView | null {
    const record = this.sessions.get(id);
    if (!record || record.expiresAt <= this.now()) {
      if (record) this.destroy(id);
      return null;
    }
    record.expiresAt = this.now() + ttlMs;
    return {
      endpoint: record.endpoint,
      region: record.region,
      bucket: record.bucket,
      pathStyle: record.pathStyle,
      headers: record.headers,
      accessKeyId: decode(record.accessKeyId),
      secretAccessKey: decode(record.secretAccessKey),
      sessionToken: record.sessionToken ? decode(record.sessionToken) : undefined,
    };
  }

  destroy(id: string): void {
    const record = this.sessions.get(id);
    if (!record) return;
    wipe(record.accessKeyId);
    wipe(record.secretAccessKey);
    wipe(record.sessionToken);
    this.sessions.delete(id);
  }

  mintMedia(sessionId: string, key: string, ttlMs = MEDIA_TTL_MS, versionId?: string): string | null {
    const session = this.use(sessionId);
    if (!session) return null;
    while (this.media.size >= MAX_MEDIA) {
      const oldest = this.media.keys().next().value;
      if (!oldest) break;
      this.revokeMedia(oldest);
    }
    const token = newCapabilityId();
    this.media.set(token, {
      endpoint: session.endpoint,
      region: session.region,
      bucket: session.bucket,
      pathStyle: session.pathStyle,
      headers: session.headers,
      accessKeyId: encode(session.accessKeyId),
      secretAccessKey: encode(session.secretAccessKey),
      sessionToken: session.sessionToken ? encode(session.sessionToken) : undefined,
      key,
      versionId,
      expiresAt: this.now() + ttlMs,
    });
    return token;
  }

  revokeMedia(token: string): boolean {
    const grant = this.media.get(token);
    if (!grant) return false;
    wipe(grant.accessKeyId);
    wipe(grant.secretAccessKey);
    wipe(grant.sessionToken);
    this.media.delete(token);
    return true;
  }

  useMedia(token: string): { session: SessionView; key: string; versionId?: string } | null {
    const grant = this.media.get(token);
    if (!grant || grant.expiresAt <= this.now()) {
      this.revokeMedia(token);
      return null;
    }
    return {
      session: {
        endpoint: grant.endpoint,
        region: grant.region,
        bucket: grant.bucket,
        pathStyle: grant.pathStyle,
        headers: grant.headers,
        accessKeyId: decode(grant.accessKeyId),
        secretAccessKey: decode(grant.secretAccessKey),
        sessionToken: grant.sessionToken ? decode(grant.sessionToken) : undefined,
      },
      key: grant.key,
      versionId: grant.versionId,
    };
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, record] of this.sessions) {
      if (record.expiresAt <= now) this.destroy(id);
    }
    for (const [token, grant] of this.media) {
      if (grant.expiresAt <= now) this.media.delete(token);
    }
  }
}
