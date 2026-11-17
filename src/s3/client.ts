import { AwsClient, type AwsSignOptions } from '../lib/aws4fetch';
import { buildS3Url, encodeKey } from './url';
import { md5Base64 } from '../transfer/integrity';
import { withCustomHeaders } from './customHeaders';
import { xmlBlocks, xmlFirst, xmlTextValues } from './xml';
import type { CredentialPlaintext, S3ProfileConfig } from '../vault/protocol';

export interface S3ClientOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  pathStyle?: boolean;
  /**
   * Extra headers sent on every request, already screened by
   * `src/s3/customHeaders.ts`. Folded in *before* signing so they become part of
   * the canonical request.
   */
  headers?: Record<string, string>;
  /** Public app-server gate. Not an S3 key. Retained on the profile; the server session is the gate. */
  proxyToken?: string;
  /**
   * Call S3 with global fetch. Bun tools and tests only. The app does not set it.
   */
  direct?: boolean;
  /**
   * Sign, then hand the signed request to the self-hosted server transport.
   * The browser does not set this.
   */
  dispatch?: S3Dispatch;
}

/** Receives an already-signed request. The server pins DNS before connecting. */
export type S3Dispatch = (signed: Request, signal?: AbortSignal) => Promise<Response>;

/**
 * Byte length of a body whose size is known without reading it. S3 refuses a
 * PUT without Content-Length (411), and a server-originated request has no
 * browser to add the header, so the client must supply it before signing.
 */
function bodyByteLength(body: BodyInit): number | null {
  if (typeof body === 'string') return new TextEncoder().encode(body).length;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return null;
}

/** Normalises the three `HeadersInit` shapes to a plain record. */
function headersToRecord(init: HeadersInit | undefined): Record<string, string> {
  if (!init) return {};
  if (init instanceof Headers) {
    const out: Record<string, string> = {};
    init.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(init)) return Object.fromEntries(init);
  return { ...init };
}

export interface ListObjectsResult {
  objects: {
    key: string;
    lastModified: string;
    size: number;
    eTag: string;
    /** ListObjectsV2 returns StorageClass per key (absent on some providers). */
    storageClass: string | null;
  }[];
  prefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

export interface ObjectMeta {
  contentLength: number;
  contentType: string;
  lastModified: string;
  eTag: string;
  /** Absent on STANDARD objects; providers only send the header otherwise. */
  storageClass: string | null;
  /** `x-amz-restore`: ongoing-request="false" plus an expiry once restored. */
  restore: string | null;
}

/** Storage classes whose objects must be restored before they can be read. */
export const ARCHIVE_STORAGE_CLASSES = new Set(['GLACIER', 'DEEP_ARCHIVE', 'GLACIER_IR']);

export function isArchiveClass(storageClass: string | null | undefined): boolean {
  return storageClass != null && ARCHIVE_STORAGE_CLASSES.has(storageClass);
}

/** True when a restore has finished and the copy is still readable. */
export function isRestored(restore: string | null | undefined): boolean {
  if (!restore) return false;
  return /ongoing-request="false"/.test(restore);
}

export interface PutObjectResult {
  eTag: string;
}

export interface ObjectVersion {
  versionId: string;
  isLatest: boolean;
  lastModified: string;
  size: number;
  eTag: string;
  /** A delete marker hides the object; it carries no bytes. */
  isDeleteMarker: boolean;
}

export interface VersionListResult {
  versions: ObjectVersion[];
  /** True when the bucket has never had versioning enabled. */
  unversioned: boolean;
}

export interface BucketSearchResult {
  objects: { key: string; size: number; lastModified: string }[];
  scanned: number;
  truncated: boolean;
}

export interface DeleteResult {
  deleted: string[];
  errors: { key: string; code: string; message: string }[];
}

export interface PartInfo {
  PartNumber: number;
  ETag: string;
}

export interface CorsCheckResult {
  allowed: boolean;
  methods: string[];
}

export interface CorsRule {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposeHeaders: string[];
  maxAgeSeconds: number;
}

export interface CorsConfiguration {
  rules: CorsRule[];
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

function serializeCorsRule(rule: CorsRule): string {
  const values = (items: string[], tag: string): string =>
    items.map((item) => `<${tag}>${escapeXml(item)}</${tag}>`).join('');

  return (
    '<CORSRule>' +
    `<ID>${escapeXml(`galiot-${rule.maxAgeSeconds}s`)}</ID>` +
    values(rule.allowedOrigins, 'AllowedOrigin') +
    values(rule.allowedMethods, 'AllowedMethod') +
    values(rule.allowedHeaders, 'AllowedHeader') +
    values(rule.exposeHeaders, 'ExposeHeader') +
    `<MaxAgeSeconds>${rule.maxAgeSeconds}</MaxAgeSeconds>` +
    '</CORSRule>'
  );
}

/**
 * Query parameters for ListObjectsV2, with empty values omitted.
 *
 * An empty `continuation-token=` is not the same as no token: AWS S3 ignores it,
 * but MinIO answers **400 InvalidArgument** (verified against
 * `quay.io/minio/minio` RELEASE.2025-09-07). Since the explorer sends this on
 * every listing, that one empty parameter made every bucket unlistable on MinIO
 * — a failure no mock server reproduced, because mocks happily accept it.
 *
 * Subresource parameters such as `?cors=` or `?uploads=` are the opposite case
 * and must keep their empty value; that is how S3 identifies them.
 */
export function listObjectsQuery(
  prefix?: string,
  options?: { delimiter?: string; maxKeys?: number; continuationToken?: string },
): Record<string, string> {
  const query: Record<string, string> = { 'list-type': '2' };
  if (prefix) query.prefix = prefix;
  if (options?.delimiter) query.delimiter = options.delimiter;
  if (options?.maxKeys !== undefined) query['max-keys'] = options.maxKeys.toString();
  if (options?.continuationToken) query['continuation-token'] = options.continuationToken;
  return query;
}

/**
 * The result of probing an endpoint for reachability.
 *
 * `alternate*` describe the *other* addressing form (path-style vs
 * virtual-hosted). They are only meaningful when `reachable` is false: an
 * alternate that answers proves the failure was the addressing, not the host.
 */
export interface ProbeResult {
  reachable: boolean;
  url: string;
  error?: string;
  alternateReachable: boolean;
  alternateUrl: string;
}

/**
 * An S3 error response, with the server's own error code preserved.
 *
 * The code is what makes the difference between "you lack permission" and
 * "this server does not implement that API at all", and the UI cannot tell them
 * apart from a status line alone. MinIO answers `501 NotImplemented` for
 * PutBucketCors (and for `mc cors set`), so treating that as a permissions
 * problem sends the user after a policy change that cannot help.
 */
export class S3RequestError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${operation} failed: ${code} (${status}) — ${message}`);
    this.name = 'S3RequestError';
  }

  /** True when the endpoint does not implement the API that was called. */
  public get unsupported(): boolean {
    return this.status === 501 || this.code === 'NotImplemented';
  }
}

/** Parses an S3 error body (`<Error><Code>…</Code>…`) and throws a typed error. */
async function throwS3Error(res: Response, operation: string): Promise<never> {
  let code = res.statusText || `HTTP ${res.status}`;
  let message = '';
  try {
    const body = await res.text();
    const parsedCode = xmlFirst(body, 'Code');
    const parsedMessage = xmlFirst(body, 'Message');
    if (parsedCode) code = parsedCode;
    if (parsedMessage) message = parsedMessage;
  } catch {
    // A body we cannot read still leaves a usable status.
  }
  throw new S3RequestError(operation, res.status, code, message || res.statusText);
}

/**
 * Builds the client the server and Bun tools use.
 *
 * The profile-to-client mapping is the line that decides whether a connection's
 * custom headers are applied at all, so it stays testable outside a worker.
 */
export function s3ClientForProfile(
  profile: S3ProfileConfig,
  creds: CredentialPlaintext,
  options?: { direct?: boolean; dispatch?: S3Dispatch },
): S3Client {
  return new S3Client({
    endpoint: profile.endpoint,
    region: profile.region,
    bucket: profile.bucket,
    pathStyle: profile.pathStyle,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    headers: profile.headers,
    proxyToken: profile.proxyToken,
    direct: options?.direct,
    dispatch: options?.dispatch,
  });
}

export class S3Client {
  private awsClient: AwsClient;
  private endpoint: string;
  private bucket: string;
  private pathStyle: boolean;
  private customHeaders: Record<string, string>;
  private direct: boolean;
  private dispatch?: S3Dispatch;
  /** Set once a gateway proves it only speaks ListObjects v1; pages stay on v1. */
  private listV1 = false;

  constructor(options: S3ClientOptions) {
    this.awsClient = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
      region: options.region,
      service: 's3',
    });
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.bucket = options.bucket;
    this.pathStyle = options.pathStyle ?? false;
    this.customHeaders = options.headers ?? {};
    this.direct = options.direct === true;
    this.dispatch = options.dispatch;
  }

  /** Signed request, used by the server for operations that stream a body. */
  public send(url: URL, init?: RequestInit & AwsSignOptions): Promise<Response> {
    return this.request(url, init);
  }

  /**
   * The single path every request takes, so a connection's custom headers are
   * folded in before the request is signed.
   *
   * Order matters: `AwsClient.sign` hashes whatever headers it is handed into
   * the canonical request, so injecting them here makes them part of the
   * signature. A header added after signing goes out unsigned — some gateways
   * ignore it, S3 rejects the request outright.
   *
   * Call-specific headers still win over stored ones (`withCustomHeaders`), so a
   * resumed download's `Range` and an upload's `Content-Type` cannot be
   * displaced by a stale row that predates the screening rule.
   */
  private async request(url: URL, init?: RequestInit & AwsSignOptions): Promise<Response> {
    let requestInit = Object.keys(this.customHeaders).length === 0
      ? init
      : {
          ...init,
          headers: withCustomHeaders(this.customHeaders, headersToRecord(init?.headers)),
        };
    if (this.dispatch) {
      if (requestInit?.body != null) {
        const headers = headersToRecord(requestInit.headers);
        if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-length')) {
          const length = bodyByteLength(requestInit.body);
          if (length !== null) {
            requestInit = { ...requestInit, headers: { ...headers, 'content-length': String(length) } };
          }
        }
      }
      const signed = await this.awsClient.sign(url, requestInit);
      return this.dispatch(signed, requestInit?.signal ?? undefined);
    }
    if (this.direct) return this.awsClient.fetch(url, requestInit);
    throw new Error(
      'This process does not call S3. The self-hosted Galiot server signs and connects. The machine running it must be able to reach the bucket.',
    );
  }

/** Public accessor for the endpoint/bucket/addressing (used by tooling). */
  public objectUrl(key?: string, queryParams?: Record<string, string>): URL {
    return this.buildUrl(key, queryParams);
  }

  private buildUrl(key?: string, queryParams?: Record<string, string>): URL {
    return buildS3Url(
      { endpoint: this.endpoint, bucket: this.bucket, pathStyle: this.pathStyle },
      key,
      queryParams,
    );
  }

  public async listObjects(prefix?: string, options?: { delimiter?: string; maxKeys?: number; continuationToken?: string }): Promise<ListObjectsResult> {
    const v1Query = (): Record<string, string> => {
      const query: Record<string, string> = {};
      if (prefix) query.prefix = prefix;
      if (options?.delimiter) query.delimiter = options.delimiter;
      if (options?.maxKeys !== undefined) query['max-keys'] = options.maxKeys.toString();
      if (options?.continuationToken) query.marker = options.continuationToken;
      return query;
    };
    const url = this.buildUrl(undefined, this.listV1 ? v1Query() : listObjectsQuery(prefix, options));

    let res = await this.request(url);
    let v1 = this.listV1;
    if (!res.ok && (res.status === 501 || res.status === 400)) {
      // Older S3 gateways (Dell ECS family and other on-premises systems) may
      // implement only ListObjects v1. Retry once with marker paging; a real
      // permissions or bucket error fails the same way on both and surfaces.
      const body = await res.clone().text();
      if (/NotImplemented|InvalidArgument|InvalidRequest|not supported/i.test(body)) {
        res = await this.request(this.buildUrl(undefined, v1Query()));
        v1 = true;
        this.listV1 = true;
      }
    }
    if (!res.ok) await throwS3Error(res, 'ListObjects');

    const text = await res.text();

    const objects = xmlBlocks(text, 'Contents').map((block) => ({
      key: xmlFirst(block, 'Key') ?? '',
      lastModified: xmlFirst(block, 'LastModified') ?? '',
      size: parseInt(xmlFirst(block, 'Size') ?? '0', 10),
      eTag: xmlFirst(block, 'ETag') ?? '',
      storageClass: xmlFirst(block, 'StorageClass') ?? null,
    }));

    const prefixes = xmlBlocks(text, 'CommonPrefixes').map(
      (block) => xmlFirst(block, 'Prefix') ?? '',
    );
    // Trimmed here, and only here: the reader is verbatim so object keys keep
    // any leading/trailing spaces S3 allows.
    const isTruncated = (xmlFirst(text, 'IsTruncated') ?? '').trim() === 'true';
    // v1 pages with NextMarker (or the last key when the provider omits it).
    const nextContinuationToken = v1
      ? xmlFirst(text, 'NextMarker') ?? (isTruncated ? objects[objects.length - 1]?.key : undefined)
      : xmlFirst(text, 'NextContinuationToken');

    return { objects, prefixes, isTruncated, nextContinuationToken };
  }

  public async headObject(key: string): Promise<ObjectMeta> {
    const url = this.buildUrl(key);
    const res = await this.request(url, { method: 'HEAD' });
    if (!res.ok) await throwS3Error(res, 'HeadObject');

    return {
      contentLength: parseInt(res.headers.get('content-length') || '0', 10),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      lastModified: res.headers.get('last-modified') || '',
      eTag: res.headers.get('etag') || '',
      storageClass: res.headers.get('x-amz-storage-class'),
      restore: res.headers.get('x-amz-restore'),
    };
  }

  /**
   * Asks the provider to make an archived object readable for `days` days.
   * Providers without archive tiers answer 501/NotImplemented, which the
   * caller surfaces as unsupported rather than as a permissions problem.
   */
  public async restoreObject(key: string, days = 1): Promise<void> {
    const url = this.buildUrl(key, { restore: '' });
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      `<RestoreRequest><Days>${Math.max(1, Math.floor(days))}</Days>` +
      '<GlacierJobParameters><Tier>Standard</Tier></GlacierJobParameters></RestoreRequest>';
    const res = await this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: xml,
    });
    // 200 = restore already in progress or done; 202 = accepted.
    if (!res.ok && res.status !== 202) await throwS3Error(res, 'RestoreObject');
  }

  /**
   * Server-side copy. The bytes never leave S3: one PUT with a copy-source
   * header. Objects above 5 GiB must use `copyPart` instead (AWS limit).
   */
  public async copyObject(sourceKey: string, destKey: string, versionId?: string): Promise<{ eTag: string }> {
    const url = this.buildUrl(destKey);
    const res = await this.request(url, {
      method: 'PUT',
      headers: { 'x-amz-copy-source': this.copySource(sourceKey, versionId) },
    });
    if (!res.ok) await throwS3Error(res, 'CopyObject');
    return { eTag: xmlFirst(await res.text(), 'ETag') ?? '' };
  }

  /**
   * Versions of one exact key. ListObjectVersions is prefix-based, so the
   * response is filtered to the key itself. A bucket that never had versioning
   * answers with a single `null` version — reported as `unversioned`.
   */
  public async listVersions(key: string): Promise<VersionListResult> {
    const url = this.buildUrl(undefined, { versions: '', prefix: key, 'max-keys': '1000' });
    const res = await this.request(url);
    if (!res.ok) await throwS3Error(res, 'ListObjectVersions');
    const text = await res.text();
    const parse = (block: string, isDeleteMarker: boolean): ObjectVersion & { key: string } => ({
      key: xmlFirst(block, 'Key') ?? '',
      versionId: xmlFirst(block, 'VersionId') ?? 'null',
      isLatest: (xmlFirst(block, 'IsLatest') ?? '').trim() === 'true',
      lastModified: xmlFirst(block, 'LastModified') ?? '',
      size: parseInt(xmlFirst(block, 'Size') ?? '0', 10),
      eTag: xmlFirst(block, 'ETag') ?? '',
      isDeleteMarker,
    });
    const versions: ObjectVersion[] = [
      ...xmlBlocks(text, 'Version').map((block) => parse(block, false)),
      ...xmlBlocks(text, 'DeleteMarker').map((block) => parse(block, true)),
    ]
      .filter((version) => version.key === key)
      .map(({ key: _key, ...version }) => version)
      .sort((a, b) => b.lastModified.localeCompare(a.lastModified));
    const unversioned = versions.length > 0 && versions.every((v) => v.versionId === 'null');
    return { versions, unversioned };
  }

  /** Deletes one specific version. Without versionId this would write a marker. */
  public async deleteVersion(key: string, versionId: string): Promise<void> {
    const url = this.buildUrl(key, { versionId });
    const res = await this.request(url, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) await throwS3Error(res, 'DeleteObjectVersion');
  }

  /**
   * Flat walk of the bucket (no delimiter), matching key names server-side.
   * Capped so one search cannot run away on a huge bucket.
   */
  public async searchKeys(
    needle: string,
    options?: { prefix?: string; maxMatches?: number; maxScanned?: number },
  ): Promise<BucketSearchResult> {
    const maxMatches = options?.maxMatches ?? 500;
    const maxScanned = options?.maxScanned ?? 50_000;
    const lower = needle.toLowerCase();
    const objects: BucketSearchResult['objects'] = [];
    let scanned = 0;
    let truncated = false;
    let continuationToken: string | undefined;
    do {
      const page = await this.listObjects(options?.prefix, { maxKeys: 1000, continuationToken });
      for (const object of page.objects) {
        scanned += 1;
        if (object.key.toLowerCase().includes(lower)) {
          objects.push({ key: object.key, size: object.size, lastModified: object.lastModified });
          if (objects.length >= maxMatches) {
            return { objects, scanned, truncated: true };
          }
        }
        if (scanned >= maxScanned) {
          return { objects, scanned, truncated: true };
        }
      }
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);
    return { objects, scanned, truncated };
  }

  /** One part of a multipart server-side copy, over a byte range of the source. */
  public async copyPart(
    sourceKey: string,
    destKey: string,
    uploadId: string,
    partNumber: number,
    startByte: number,
    endByte: number,
  ): Promise<string> {
    const url = this.buildUrl(destKey, { uploadId, partNumber: String(partNumber) });
    const res = await this.request(url, {
      method: 'PUT',
      headers: {
        'x-amz-copy-source': this.copySource(sourceKey),
        'x-amz-copy-source-range': `bytes=${startByte}-${endByte}`,
      },
    });
    if (!res.ok) await throwS3Error(res, 'UploadPartCopy');
    return xmlFirst(await res.text(), 'ETag') ?? '';
  }

  private copySource(key: string, versionId?: string): string {
    const base = `/${encodeURIComponent(this.bucket)}/${encodeKey(key)}`;
    return versionId ? `${base}?versionId=${encodeURIComponent(versionId)}` : base;
  }

  /** Buckets this key can see. Uses the endpoint root, not a bucket URL. */
  public async listBuckets(): Promise<string[]> {
    const url = new URL(`${this.endpoint}/`);
    const res = await this.request(url);
    if (!res.ok) await throwS3Error(res, 'ListBuckets');
    const text = await res.text();
    return xmlBlocks(text, 'Bucket')
      .map((block) => xmlFirst(block, 'Name') ?? '')
      .filter(Boolean);
  }

  public async getObject(key: string): Promise<Response> {
    const url = this.buildUrl(key);
    const res = await this.request(url);
    if (!res.ok) await throwS3Error(res, 'GetObject');
    return res;
  }

  public async putObject(key: string, body: Blob | ArrayBuffer | string, contentType?: string): Promise<PutObjectResult> {
    const url = this.buildUrl(key);
    const headers: Record<string, string> = {
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    };
    if (contentType) headers['content-type'] = contentType;

    const res = await this.request(url, {
      method: 'PUT',
      headers,
      body,
    });
    if (!res.ok) await throwS3Error(res, 'PutObject');
    
    return {
      eTag: res.headers.get('etag') || '',
    };
  }

  public async deleteObject(key: string): Promise<void> {
    const url = this.buildUrl(key);
    const res = await this.request(url, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`DeleteObject failed: ${res.statusText}`);
  }

  public async deleteObjects(keys: string[]): Promise<DeleteResult> {
    const url = this.buildUrl(undefined, { delete: '' });
    
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Delete>
  <Quiet>false</Quiet>
  ${keys.map(k => `<Object><Key>${k.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')}</Key></Object>`).join('\n  ')}
</Delete>`;

    const res = await this.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/xml',
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        // DeleteObjects requires a Content-MD5 of the request body; without it
        // both MinIO and AWS S3 answer `400 MissingContentMD5`, so deleting a
        // selection failed outright (found against MinIO RELEASE.2025-09-07).
        'content-md5': md5Base64(new TextEncoder().encode(xml)),
      },
      body: xml,
    });
    
    if (!res.ok) await throwS3Error(res, 'DeleteObjects');
    
    const text = await res.text();

    const deleted = xmlBlocks(text, 'Deleted').map((block) => xmlFirst(block, 'Key') ?? '');
    const errors = xmlBlocks(text, 'Error').map((block) => ({
      key: xmlFirst(block, 'Key') ?? '',
      code: xmlFirst(block, 'Code') ?? '',
      message: xmlFirst(block, 'Message') ?? '',
    }));
    
    return { deleted, errors };
  }

  public async createMultipartUpload(key: string, contentType?: string): Promise<string> {
    const url = this.buildUrl(key, { uploads: '' });
    const headers: Record<string, string> = {};
    if (contentType) headers['content-type'] = contentType;

    const res = await this.request(url, { method: 'POST', headers });
    if (!res.ok) await throwS3Error(res, 'CreateMultipartUpload');
    
    const text = await res.text();
    const uploadId = xmlFirst(text, 'UploadId');
    if (!uploadId) throw new Error('Failed to parse UploadId');
    return uploadId;
  }

  public async uploadPart(key: string, uploadId: string, partNumber: number, body: Blob): Promise<string> {
    const url = this.buildUrl(key, { uploadId, partNumber: partNumber.toString() });
    const res = await this.request(url, {
      method: 'PUT',
      headers: {
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      },
      body,
    });
    if (!res.ok) await throwS3Error(res, 'UploadPart');
    return res.headers.get('etag') || '';
  }

  public async completeMultipartUpload(key: string, uploadId: string, parts: PartInfo[]): Promise<void> {
    const url = this.buildUrl(key, { uploadId });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUpload>
  ${parts.map(p => `<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${p.ETag}</ETag></Part>`).join('\n  ')}
</CompleteMultipartUpload>`;

    const res = await this.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/xml',
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      },
      body: xml,
    });
    if (!res.ok) await throwS3Error(res, 'CompleteMultipartUpload');
  }

  public async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const url = this.buildUrl(key, { uploadId });
    const res = await this.request(url, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`AbortMultipartUpload failed: ${res.statusText}`);
  }


  /** Reads the bucket's current CORS configuration. */
  public async getBucketCors(): Promise<CorsConfiguration> {
    const url = this.buildUrl(undefined, { cors: '' });
    const res = await this.request(url, { method: 'GET' });

    // No CORSConfiguration element is the documented "not configured" case.
    if (res.status === 404) return { rules: [] };
    if (!res.ok) await throwS3Error(res, 'GetBucketCors');

    const text = await res.text();
    const rules: CorsRule[] = xmlBlocks(text, 'CORSRule').map((block) => ({
      allowedOrigins: xmlTextValues(block, 'AllowedOrigin'),
      allowedMethods: xmlTextValues(block, 'AllowedMethod'),
      allowedHeaders: xmlTextValues(block, 'AllowedHeader'),
      exposeHeaders: xmlTextValues(block, 'ExposeHeader'),
      maxAgeSeconds: parseInt(xmlFirst(block, 'MaxAgeSeconds') ?? '0', 10),
    }));

    return { rules };
  }

  /** Replaces the bucket's CORS configuration. */
  public async putBucketCors(config: CorsConfiguration): Promise<void> {
    if (config.rules.length === 0) {
      await this.deleteBucketCors();
      return;
    }

    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<CORSConfiguration>' +
      config.rules.map(serializeCorsRule).join('') +
      '</CORSConfiguration>';

    const url = this.buildUrl(undefined, { cors: '' });
    const res = await this.request(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/xml' },
      body: xml,
    });
    if (!res.ok) await throwS3Error(res, 'PutBucketCors');
  }

  /** Removes the bucket's CORS configuration. */
  public async deleteBucketCors(): Promise<void> {
    const url = this.buildUrl(undefined, { cors: '' });
    const res = await this.request(url, { method: 'DELETE' });
    // 204 is MinIO's and Ceph's success answer for removing a policy that is
    // not there; anything else non-ok carries a code worth surfacing.
    if (!res.ok && res.status !== 204) {
      await throwS3Error(res, 'DeleteBucketCors');
    }
  }

  /**
   * Browser-compatible policy for this app: the given origin, the methods
   * Galiot uses, ETag exposed (multipart uploads depend on reading it), and
   * headers needed by presigned PUTs.
   */
  public static recommendedCorsRule(origin: string): CorsRule {
    return {
      allowedOrigins: [origin],
      allowedMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE'],
      allowedHeaders: ['*'],
      exposeHeaders: ['ETag', 'x-amz-request-id', 'x-amz-id-2'],
      maxAgeSeconds: 3600,
    };
  }

  /**
   * Probes the bucket endpoint *without* triggering CORS, so callers can tell
   * "the host is unreachable" apart from "the browser blocked the response".
   *
   * The previous implementation replayed a preflight by hand, which could never
   * succeed and therefore reported failure even for correctly configured
   * buckets. See src/s3/diagnostics.ts for the reasoning.
   */
  public async probeReachable(key?: string): Promise<{ reachable: boolean; url: string; error?: string }> {
    const url = this.buildUrl(key);
    try {
      // NOTE: do not add `redirect: 'manual'` here — Chrome rejects that
      // combination with a TypeError, which would make every reachable host
      // look unreachable (verified in a real browser against an on-premises
      // gateway, a public site and a refused port alike).
      await fetch(url.toString(), { method: 'GET', mode: 'no-cors' });
      return { reachable: true, url: url.toString() };
    } catch (err) {
      return {
        reachable: false,
        url: url.toString(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Probes the endpoint, and — only if that fails — the *other* addressing form.
   *
   * A failed probe is not evidence of a network problem. Virtual-hosted
   * addressing dials `bucket.endpoint`, and most endpoints have no wildcard DNS
   * for it, so the probe fails on a host that is perfectly reachable. Reporting
   * that as "network, DNS, port or TLS" sends the user to check a network that
   * was never broken.
   *
   * The two forms are the only variable here, so trying the other one is a
   * decisive differential: if it answers, the addressing was the cause.
   */
  public async probeAddressing(key?: string): Promise<ProbeResult> {
    const current = await this.probeReachable(key);
    const alternateUrl = buildS3Url(
      { endpoint: this.endpoint, bucket: this.bucket, pathStyle: !this.pathStyle },
      key,
    ).toString();

    // Already answered: the addressing is fine, so do not spend a second probe.
    if (current.reachable) {
      return { ...current, alternateReachable: false, alternateUrl };
    }

    try {
      await fetch(alternateUrl, { method: 'GET', mode: 'no-cors' });
      return { ...current, alternateReachable: true, alternateUrl };
    } catch {
      // Neither form answered, so the host itself is the problem.
      return { ...current, alternateReachable: false, alternateUrl };
    }
  }
}
