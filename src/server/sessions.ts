/**
 * In-memory S3 sessions for the self-hosted server.
 *
 * The browser vault still seals credentials at rest. A session is the only
 * place the secret exists on the server, and only until it expires or the
 * vault locks. Nothing here is written to disk.
 */

import type { EditorWriteCheck } from './editorWriteProbe.ts';

const EDITOR_WRITE_TTL_MS = 10 * 60 * 1000;
const MAX_EDITOR_WRITE_PROBES = 4;
const SESSION_TTL_MS = 15 * 60 * 1000;
const MEDIA_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 200;
const MAX_MEDIA = 500;

export interface SessionMaterial {
  verifyEditorWrites?: boolean;
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
  verifyEditorWrites: boolean;
  editorWriteResult?: { check: EditorWriteCheck; expiresAt: number };
  editorWriteProbe?: { abort: AbortController; result: Promise<EditorWriteCheck> };
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
  /** Read grants stream bytes out; write grants accept one bounded PUT. */
  kind: 'read' | 'write';
  maxBytes?: number;
  expiresAt: number;
  /**
   * Preview grants are bound to the issuing session and die with it (vault
   * lock, idle-out, explicit close). Share grants leave this undefined: they
   * are delegated authority that must outlive the vault by design.
   */
  sessionId?: string;
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
  private readonly issuer = newCapabilityId();
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private nextExpiry = Infinity;
  private activeEditorWriteProbes = 0;

  constructor(private readonly now: () => number = Date.now) {}

  create(material: SessionMaterial, ttlMs = SESSION_TTL_MS): string {
    this.sweep();
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (!oldest) break;
      this.destroy(oldest);
    }
    const id = newCapabilityId();
    const expiresAt = this.now() + ttlMs;
    this.sessions.set(id, {
      id,
      verifyEditorWrites: material.verifyEditorWrites === true,
      endpoint: material.endpoint,
      region: material.region,
      bucket: material.bucket,
      pathStyle: material.pathStyle,
      headers: { ...material.headers },
      accessKeyId: encode(material.accessKeyId),
      secretAccessKey: encode(material.secretAccessKey),
      sessionToken: material.sessionToken ? encode(material.sessionToken) : undefined,
      expiresAt,
    });
    this.scheduleExpiry(expiresAt);
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
    this.scheduleExpiry(record.expiresAt);
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

  editorWriteCheck(id: string): EditorWriteCheck | undefined {
    const record = this.sessions.get(id);
    const result = record?.editorWriteResult;
    const now = this.now();
    return record && result && record.expiresAt > now && result.expiresAt > now ? result.check : undefined;
  }

  /** Dedupe by server session (target and credentials), and bound concurrent probes. */
  startEditorWriteCheck(id: string, probe: (signal: AbortSignal) => Promise<EditorWriteCheck>): Promise<EditorWriteCheck | undefined> {
    const record = this.sessions.get(id);
    if (!record?.verifyEditorWrites || record.expiresAt <= this.now()) return Promise.resolve(undefined);
    const cached = this.editorWriteCheck(id);
    if (cached) return Promise.resolve(cached);
    if (record.editorWriteProbe) return record.editorWriteProbe.result;
    if (this.activeEditorWriteProbes >= MAX_EDITOR_WRITE_PROBES) {
      return Promise.resolve({ verified: false, issue: 'Verification is busy. Reopen the editor to try again.' });
    }
    const abort = new AbortController();
    this.activeEditorWriteProbes++;
    const result = Promise.resolve().then(() => probe(abort.signal))
      .catch((): EditorWriteCheck => ({ verified: false, issue: 'The verification test could not finish.' }))
      .then(check => {
        if (!abort.signal.aborted) record.editorWriteResult = { check, expiresAt: this.now() + EDITOR_WRITE_TTL_MS };
        return check;
      }).finally(() => {
        record.editorWriteProbe = undefined;
        this.activeEditorWriteProbes--;
      });
    record.editorWriteProbe = { abort, result };
    return result;
  }

  destroy(id: string): void {
    const record = this.sessions.get(id);
    if (!record) return;
    record.editorWriteProbe?.abort.abort();
    wipe(record.accessKeyId);
    wipe(record.secretAccessKey);
    wipe(record.sessionToken);
    this.sessions.delete(id);
    // Session-bound preview grants must not outlive the session that minted
    // them; unbound share grants keep their delegated lifetime.
    for (const [token, grant] of this.media) {
      if (grant.sessionId === id) this.revokeMedia(token);
    }
  }

  /** Revokes a preview grant from its own session, without the operator gate. */
  revokeMediaForSession(sessionId: string, token: string): boolean {
    const grant = this.media.get(token);
    if (!grant || grant.sessionId !== sessionId) return false;
    return this.revokeMedia(token);
  }

  mintMedia(
    sessionId: string,
    key: string,
    opts: { ttlMs?: number; versionId?: string; kind?: 'read' | 'write'; maxBytes?: number; bound?: boolean } = {},
  ): string | null {
    const session = this.use(sessionId);
    if (!session) return null;
    const ttlMs = opts.ttlMs ?? MEDIA_TTL_MS;
    // Evict the grant closest to expiry, not the oldest: previews mint
    // hour-long grants constantly, and must not push out a week-long share.
    while (this.media.size >= MAX_MEDIA) {
      let soonest: string | undefined;
      let soonestAt = Infinity;
      for (const [token, grant] of this.media) {
        if (grant.expiresAt < soonestAt) {
          soonest = token;
          soonestAt = grant.expiresAt;
        }
      }
      if (!soonest) break;
      this.revokeMedia(soonest);
    }
    const token = this.issuer + '_' + newCapabilityId();
    const expiresAt = this.now() + ttlMs;
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
      versionId: opts.versionId,
      kind: opts.kind ?? 'read',
      maxBytes: opts.maxBytes,
      expiresAt,
      sessionId: opts.bound ? sessionId : undefined,
    });
    this.scheduleExpiry(expiresAt);
    return token;
  }

  revokeMedia(token: string): boolean {
    const grant = this.media.get(token);
    // Only this process can confirm that a previously consumed or revoked
    // capability it issued is already inactive.
    if (!grant) return token.startsWith(this.issuer + '_');
    wipe(grant.accessKeyId);
    wipe(grant.secretAccessKey);
    wipe(grant.sessionToken);
    this.media.delete(token);
    return true;
  }

  useMedia(token: string): { session: SessionView; key: string; versionId?: string; kind: 'read' | 'write'; maxBytes?: number } | null {
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
      kind: grant.kind,
      maxBytes: grant.maxBytes,
    };
  }

  private scheduleExpiry(at: number): void {
    if (at >= this.nextExpiry) return;
    clearTimeout(this.expiryTimer);
    this.nextExpiry = at;
    this.expiryTimer = setTimeout(() => {
      this.nextExpiry = Infinity;
      this.sweep();
    }, Math.max(0, at - this.now()));
    this.expiryTimer.unref();
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, record] of this.sessions) {
      if (record.expiresAt <= now) this.destroy(id);
      else this.scheduleExpiry(record.expiresAt);
    }
    for (const [token, grant] of this.media) {
      if (grant.expiresAt <= now) this.revokeMedia(token);
      else this.scheduleExpiry(grant.expiresAt);
    }
  }
}
