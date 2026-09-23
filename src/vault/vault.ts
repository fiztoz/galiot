import type { PGlite } from '@electric-sql/pglite';
import { 
  deriveKEK, 
  generateDEK, 
  generateSalt, 
  wrapDEK, 
  unwrapDEK, 
  encrypt, 
  decrypt, 
  type EncryptedPayload,
  zeroBuffer
} from './crypto.js';

export interface NewProfile {
  name: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface DecryptedProfile extends NewProfile {
  id: string;
  createdAt: number;
}

export interface ProfileSummary {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  createdAt: number;
}

interface EncryptedProfileRecord {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  encrypted_credentials: string; // JSON string of EncryptedPayload
  created_at: number;
}

const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

export class VaultManager {
  private dek: CryptoKey | null = null;
  private db: PGlite;
  private lockTimer: number | null = null;

  private constructor(db: PGlite, dek: CryptoKey) {
    this.db = db;
    this.dek = dek;
    this.resetTimer();
  }

  private resetTimer() {
    if (this.lockTimer !== null) {
      window.clearTimeout(this.lockTimer);
    }
    this.lockTimer = window.setTimeout(() => this.lock(), INACTIVITY_TIMEOUT_MS);
  }

  private ensureUnlocked() {
    if (!this.dek) {
      throw new Error('Vault is locked');
    }
    this.resetTimer();
  }

  /**
   * Zeros the DEK from memory implicitly and sets locked state.
   */
  public lock(): void {
    if (this.lockTimer !== null) {
      window.clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
    // WebCrypto CryptoKey cannot be directly zeroed via ArrayBuffer access,
    // so we drop the reference to allow GC to handle it.
    this.dek = null;
  }

  public isLocked(): boolean {
    return this.dek === null;
  }

  static async initDbSchema(db: PGlite): Promise<void> {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        region TEXT NOT NULL,
        encrypted_credentials TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
    `);
  }

  /**
   * Creates a new vault. Generates salt and DEK, wraps DEK with passphrase-derived KEK,
   * and stores salt and wrapped DEK in the database.
   */
  static async create(passphrase: string, db: PGlite): Promise<VaultManager> {
    await VaultManager.initDbSchema(db);
    
    const salt = generateSalt();
    const kek = await deriveKEK(passphrase, salt);
    const dek = await generateDEK();
    
    const wrappedDekBuf = await wrapDEK(kek, dek);
    const wrappedDekBase64 = btoa(String.fromCharCode(...new Uint8Array(wrappedDekBuf)));
    const saltBase64 = btoa(String.fromCharCode(...salt));

    await db.query(
      `INSERT INTO _meta (key, value) VALUES ('salt', $1), ('wrapped_dek', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`,
      [saltBase64, wrappedDekBase64]
    );

    // Defense-in-depth: clear intermediate arrays
    zeroBuffer(salt);
    zeroBuffer(wrappedDekBuf);

    return new VaultManager(db, dek);
  }

  /**
   * Unlocks an existing vault. Reads salt and wrapped DEK, derives KEK from passphrase,
   * and unwraps DEK.
   */
  static async unlock(passphrase: string, db: PGlite): Promise<VaultManager> {
    await VaultManager.initDbSchema(db);

    const saltRes = await db.query<{value: string}>(`SELECT value FROM _meta WHERE key = 'salt'`);
    const dekRes = await db.query<{value: string}>(`SELECT value FROM _meta WHERE key = 'wrapped_dek'`);

    const saltRow = saltRes.rows[0];
    const dekRow = dekRes.rows[0];

    if (!saltRow || !dekRow) {
      throw new Error('Vault metadata not found');
    }

    const saltBase64 = saltRow.value;
    const wrappedDekBase64 = dekRow.value;

    const saltStr = atob(saltBase64);
    const salt = new Uint8Array(saltStr.length);
    for (let i = 0; i < saltStr.length; i++) salt[i] = saltStr.charCodeAt(i);

    const dekStr = atob(wrappedDekBase64);
    const wrappedDek = new Uint8Array(dekStr.length);
    for (let i = 0; i < dekStr.length; i++) wrappedDek[i] = dekStr.charCodeAt(i);

    let kek: CryptoKey | null = null;
    let dek: CryptoKey | null = null;
    try {
      kek = await deriveKEK(passphrase, salt);
      dek = await unwrapDEK(kek, wrappedDek.buffer);
    } catch (e) {
      zeroBuffer(salt);
      zeroBuffer(wrappedDek);
      throw new Error('Invalid passphrase');
    }

    zeroBuffer(salt);
    zeroBuffer(wrappedDek);

    return new VaultManager(db, dek);
  }

  /**
   * Checks if vault metadata exists.
   */
  static async exists(db: PGlite): Promise<boolean> {
    try {
      const res = await db.query<{count: number}>(
        `SELECT COUNT(*) as count FROM _meta WHERE key IN ('salt', 'wrapped_dek')`
      );
      return Number(res.rows[0]?.count ?? 0) === 2;
    } catch (e) {
      return false; // Table might not exist yet
    }
  }

  async addProfile(profile: NewProfile): Promise<string> {
    this.ensureUnlocked();
    
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const credentials = JSON.stringify({
      accessKeyId: profile.accessKeyId,
      secretAccessKey: profile.secretAccessKey
    });

    const encryptedCredentials = await encrypt(this.dek!, credentials);
    
    await this.db.query(
      `INSERT INTO profiles (id, name, endpoint, region, encrypted_credentials, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, profile.name, profile.endpoint, profile.region, JSON.stringify(encryptedCredentials), createdAt]
    );

    return id;
  }

  async getProfile(id: string): Promise<DecryptedProfile> {
    this.ensureUnlocked();

    const res = await this.db.query<EncryptedProfileRecord>(
      `SELECT * FROM profiles WHERE id = $1`,
      [id]
    );

    const row = res.rows[0];

    if (!row) {
      throw new Error('Profile not found');
    }

    const encryptedCreds: EncryptedPayload = JSON.parse(row.encrypted_credentials);
    const decryptedJson = await decrypt(this.dek!, encryptedCreds);
    const creds = JSON.parse(decryptedJson) as { accessKeyId: string; secretAccessKey: string };

    return {
      id: row.id,
      name: row.name,
      endpoint: row.endpoint,
      region: row.region,
      createdAt: Number(row.created_at),
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey
    };
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    this.ensureUnlocked();

    const res = await this.db.query<{id: string, name: string, endpoint: string, region: string, created_at: number}>(
      `SELECT id, name, endpoint, region, created_at FROM profiles ORDER BY created_at DESC`
    );

    return res.rows.map(row => ({
      id: row.id,
      name: row.name,
      endpoint: row.endpoint,
      region: row.region,
      createdAt: Number(row.created_at)
    }));
  }

  async deleteProfile(id: string): Promise<void> {
    this.ensureUnlocked();
    await this.db.query(`DELETE FROM profiles WHERE id = $1`, [id]);
  }

  async updateProfile(id: string, updates: Partial<NewProfile>): Promise<void> {
    this.ensureUnlocked();

    const currentProfile = await this.getProfile(id);
    const newProfile = { ...currentProfile, ...updates };

    const credentials = JSON.stringify({
      accessKeyId: newProfile.accessKeyId,
      secretAccessKey: newProfile.secretAccessKey
    });

    const encryptedCredentials = await encrypt(this.dek!, credentials);

    await this.db.query(
      `UPDATE profiles SET name = $1, endpoint = $2, region = $3, encrypted_credentials = $4 WHERE id = $5`,
      [newProfile.name, newProfile.endpoint, newProfile.region, JSON.stringify(encryptedCredentials), id]
    );
  }
}
