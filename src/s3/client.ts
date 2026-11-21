import { AwsClient, type AwsSignOptions } from '../lib/aws4fetch';
import { buildS3Url, encodeKey } from './url';
import { md5Base64 } from '../transfer/integrity';
import { withCustomHeaders } from './customHeaders';
import { BRAND } from '../branding';
import { readBoundedText } from '../lib/boundedBody';
import { xmlBlocks, xmlFirst } from './xml';
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
  versionId: string | null;
  contentLength: number;
  contentType: string;
  lastModified: string;
  eTag: string;
  /** Absent on STANDARD objects; providers only send the header otherwise. */
  storageClass: string | null;
  /** `x-amz-restore`: ongoing-request="false" plus an expiry once restored. */
  restore: string | null;
  /** Object Lock / retention: mode, retain-until date, legal hold. */
  objectLockMode: string | null;
  retainUntil: string | null;
  legalHold: string | null;
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

/** Allows a full ListObjects page with entity-escaped, maximum-length keys. */
const MAX_S3_XML_BYTES = 8 * 1024 * 1024;
const MAX_S3_ERROR_BYTES = 64 * 1024;
/** Prefix for continuation tokens that are really ListObjects v1 markers. */
const V1_MARKER_PREFIX = 'v1:';
const readXml = (res: Response) => readBoundedText(res, MAX_S3_XML_BYTES);

/**
 * Query parameters for ListObjectsV2, with empty values omitted.
 *
 * An empty `continuation-token=` is not the same as no token: AWS S3 ignores it,
 * but MinIO answers **400 InvalidArgument** (verified against
 * `quay.io/minio/minio` RELEASE.2025-09-07). Since the explorer sends this on
 * every listing, that one empty parameter made every bucket unlistable on MinIO
 * — a failure no mock server reproduced, because mocks happily accept it.
 *
 * Subresource parameters such as `?uploads=` or `?versions=` are the opposite case
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
 * apart from a status line alone.
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
    const body = await readBoundedText(res, MAX_S3_ERROR_BYTES);
    const parsedCode = xmlFirst(body, 'Code');
    const parsedMessage = xmlFirst(body, 'Message');
    if (parsedCode) code = parsedCode;
    if (parsedMessage) message = parsedMessage;
  } catch {
    // A body we cannot read still leaves a usable status.
  }
  throw new S3RequestError(operation, res.status, code, message || res.statusText);
}

/** Copy and completion can report an S3 error after the HTTP 200 headers. */
async function confirmedETag(res: Response, operation: string, root: string): Promise<string> {
  if (!res.ok) await throwS3Error(res, operation);
  const xml = (await readXml(res)).trim().replace(/^<\?xml\s[^?]*\?>\s*/, '');
  if (/<(?:[\w-]+:)?Error[\s/>]/.test(xml)) {
    const failure = xmlBlocks(xml, 'Error')[0] ?? '';
    throw new S3RequestError(operation, res.status, xmlFirst(failure, 'Code') || 'S3Error',
      xmlFirst(failure, 'Message') || 'The provider reported an error in the response body.');
  }
  const result = new RegExp(`^<((?:[\\w-]+:)?${root})(?:\\s[^>]*)?>([\\s\\S]*)</\\1>$`).exec(xml);
  // S3 result fields are scalar elements. Exclude truncated/concatenated
  // documents and markup that merely contains the spelling of an ETag.
  const fields = result?.[2] ?? '';
  const scalar = /\s*<([\w.:-]+)(?:\s[^<>]*)?(?:\/>|>[^<>]*<\/\1>)/y;
  const children = fields.trimEnd();
  let offset = 0;
  while (offset < children.length && scalar.exec(children)) offset = scalar.lastIndex;
  const tags = offset === children.length ? xmlBlocks(fields, 'ETag') : [];
  const eTag = tags.length === 1 && xmlFirst(fields, 'ETag')?.trim();
  if (!eTag) throw new S3RequestError(operation, res.status, 'UnconfirmedResult', `Missing ${root} with ETag.`);
  return eTag;
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
   * Operator certification is scoped to the canonical bucket URL, including
   * addressing style and any gateway path. A move requires enforcement of
   * CopySourceIfMatch (including multipart) and DeleteObject If-Match.
   * Successful writes, provider names and ETag presence prove none of these.
   */
  public supportsCondition(operation: 'put' | 'copy' | 'move'): boolean {
    // A custom header can select another tenant or backing service at this URL.
    if (Object.keys(this.customHeaders).length) return false;
    try {
      const endpoint = new URL(this.endpoint);
      const standardHost = /^(?:s3\.amazonaws\.com|s3(?:-fips)?\.(?:dualstack\.)?(?:us(?:-gov)?|af|ap|ca|eu|il|me|mx|sa)-[a-z]+-\d+\.amazonaws\.com|s3\.(?:dualstack\.)?cn-[a-z]+-\d+\.amazonaws\.com\.cn)$/;
      const generalBucket = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(this.bucket)
        && !/(?:--x-s3|-s3alias|--ol-s3|\.mrap|--table-s3)$/.test(this.bucket);
      if (endpoint.protocol === 'https:' && !endpoint.port && endpoint.pathname === '/'
        && !endpoint.search && !endpoint.hash && !endpoint.username && !endpoint.password
        && generalBucket && standardHost.test(endpoint.hostname)) return true;
      const config: unknown = JSON.parse(process.env.GALIOT_S3_CONDITIONS ?? '{}');
      if (!config || typeof config !== 'object') return false;
      const url = this.buildUrl().href;
      const supported: unknown = Object.hasOwn(config, url) ? (config as Record<string, unknown>)[url] : null;
      return Array.isArray(supported) && (supported.includes(operation) || (operation === 'copy' && supported.includes('move')));
    } catch {
      return false;
    }
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
    if (init?.method === 'PUT' && new Headers(init.headers).has('if-match') && !this.supportsCondition('put')) {
      throw new S3RequestError('PutObject', 501, 'ConditionalWriteUnverified',
        'Conditional writes have not been verified for this bucket.');
    }
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
      `This process does not call S3. The self-hosted ${BRAND.name} server signs and connects. The machine running it must be able to reach the bucket.`,
    );
  }

/** Public accessor for the endpoint/bucket/addressing (used by tooling). */
  public objectUrl(key?: string, queryParams?: Record<string, string>): URL {
    return this.buildUrl(key, queryParams);
  }

  private buildUrl(key?: string, queryParams?: Record<string, string>): URL {
    if (key === '') throw new Error('An object key cannot be empty.');
    return buildS3Url(
      { endpoint: this.endpoint, bucket: this.bucket, pathStyle: this.pathStyle },
      key,
      queryParams,
    );
  }

  public async listObjects(prefix?: string, options?: { delimiter?: string; maxKeys?: number; continuationToken?: string }): Promise<ListObjectsResult> {
    // The server builds a client per request, so a v1 page marks its own token.
    const token = options?.continuationToken;
    const v1Marker = token?.startsWith(V1_MARKER_PREFIX) ? token.slice(V1_MARKER_PREFIX.length) : undefined;
    const v1Query = (): Record<string, string> => {
      const query: Record<string, string> = {};
      if (prefix) query.prefix = prefix;
      if (options?.delimiter) query.delimiter = options.delimiter;
      if (options?.maxKeys !== undefined) query['max-keys'] = options.maxKeys.toString();
      if (v1Marker) query.marker = v1Marker;
      return query;
    };
    let v1 = this.listV1 || v1Marker !== undefined;
    if (token && v1Marker === undefined && v1) throw new Error('This listing token belongs to ListObjects v2.');
    const url = this.buildUrl(undefined, v1 ? v1Query() : listObjectsQuery(prefix, options));

    let res = await this.request(url);
    // Only a first v2 page may fall back: a v2 continuation token is opaque, and
    // replaying it as a v1 marker would silently list the wrong keys.
    if (!res.ok && !v1 && !token && (res.status === 501 || res.status === 400)) {
      // Older S3 gateways (Dell ECS family and other on-premises systems) may
      // implement only ListObjects v1. Retry once with marker paging; a real
      // permissions or bucket error fails the same way on both and surfaces.
      const body = await readBoundedText(res, MAX_S3_ERROR_BYTES);
      if (/NotImplemented|InvalidArgument|InvalidRequest|not supported/i.test(body)) {
        res = await this.request(this.buildUrl(undefined, v1Query()));
        v1 = true;
        this.listV1 = true;
      } else {
        throw new S3RequestError('ListObjects', res.status, xmlFirst(body, 'Code') || res.statusText,
          xmlFirst(body, 'Message') || res.statusText);
      }
    }
    if (!res.ok) await throwS3Error(res, 'ListObjects');

    const text = await readXml(res);

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
    // Without NextMarker, v1 resumes after the greatest key or prefix returned:
    // a delimited page can end in CommonPrefixes, which the last object misses.
    const lastReturned = [objects[objects.length - 1]?.key, prefixes[prefixes.length - 1]]
      .filter((key): key is string => Boolean(key)).sort().pop();
    const v1Next = xmlFirst(text, 'NextMarker') ?? (isTruncated ? lastReturned : undefined);
    const nextContinuationToken = v1
      ? v1Next === undefined ? undefined : V1_MARKER_PREFIX + v1Next
      : xmlFirst(text, 'NextContinuationToken');

    return { objects, prefixes, isTruncated, nextContinuationToken };
  }

  public async headObject(key: string): Promise<ObjectMeta> {
    const url = this.buildUrl(key);
    const res = await this.request(url, { method: 'HEAD' });
    if (!res.ok) await throwS3Error(res, 'HeadObject');

    return {
      contentLength: parseInt(res.headers.get('content-length') || '0', 10),
      versionId: res.headers.get('x-amz-version-id'),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      lastModified: res.headers.get('last-modified') || '',
      eTag: res.headers.get('etag') || '',
      storageClass: res.headers.get('x-amz-storage-class'),
      restore: res.headers.get('x-amz-restore'),
      objectLockMode: res.headers.get('x-amz-object-lock-mode'),
      retainUntil: res.headers.get('x-amz-object-lock-retain-until-date'),
      legalHold: res.headers.get('x-amz-object-lock-legal-hold'),
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
  public async copyObject(sourceKey: string, destKey: string, versionId?: string, ifMatch?: string): Promise<{ eTag: string }> {
    const url = this.buildUrl(destKey);
    const res = await this.request(url, {
      method: 'PUT',
      headers: {
        'x-amz-copy-source': this.copySource(sourceKey, versionId),
        ...(ifMatch && { 'x-amz-copy-source-if-match': ifMatch }),
      },
    });
    return { eTag: await confirmedETag(res, 'CopyObject', 'CopyObjectResult') };
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
    const text = await readXml(res);
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
      // A truncated page without a token means the rest was never scanned.
      if (page.isTruncated && !continuationToken) truncated = true;
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
    ifMatch?: string,
    versionId?: string,
  ): Promise<string> {
    const url = this.buildUrl(destKey, { uploadId, partNumber: String(partNumber) });
    const res = await this.request(url, {
      method: 'PUT',
      headers: {
        'x-amz-copy-source': this.copySource(sourceKey, versionId),
        ...(ifMatch && { 'x-amz-copy-source-if-match': ifMatch }),
        'x-amz-copy-source-range': `bytes=${startByte}-${endByte}`,
      },
    });
    return confirmedETag(res, 'UploadPartCopy', 'CopyPartResult');
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
    const text = await readXml(res);
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

  public async deleteObject(key: string, ifMatch?: string): Promise<void> {
    if (ifMatch !== undefined && !this.supportsCondition('move')) {
      throw new S3RequestError('DeleteObject', 501, 'ConditionalDeleteUnverified',
        'Conditional moves have not been verified for this bucket. The source was retained.');
    }
    const url = this.buildUrl(key);
    const res = await this.request(url, { method: 'DELETE', headers: ifMatch ? { 'if-match': ifMatch } : {} });
    if (!res.ok) await throwS3Error(res, 'DeleteObject');
  }

  public async deleteObjects(keys: string[]): Promise<DeleteResult> {
    const result: DeleteResult = { deleted: [], errors: [] };
    const unique: string[] = [];
    for (const key of new Set(keys)) {
      // Fetch replaces unpaired surrogates, and XML 1.0 cannot represent
      // every control character. Never serialize one name as another.
      if (!key || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u.test(key)) {
        result.errors.push({ key, code: 'InvalidKey', message: 'This key cannot be represented in a bulk delete request.' });
      } else {
        unique.push(key);
      }
    }
    for (let i = 0; i < unique.length; i += 1000) {
      const batch = unique.slice(i, i + 1000);
      try {
        const reply = await this.deleteBatch(batch);
        result.deleted.push(...reply.deleted);
        result.errors.push(...reply.errors);
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 512);
        for (const key of unique.slice(i)) result.errors.push({ key, code: 'UnconfirmedDelete', message });
        break;
      }
    }
    return result;
  }

  private async deleteBatch(keys: string[]): Promise<DeleteResult> {
    const url = this.buildUrl(undefined, { delete: '' });
    
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Delete>
  <Quiet>false</Quiet>
  ${keys.map(key => `<Object><Key>${escapeXml(key).replace(/\r/g, '&#13;')}</Key></Object>`).join('\n  ')}
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
    
    const text = (await readXml(res)).trim().replace(/^<\?xml\s[^?]*\?>\s*/, '');
    if (!/^<((?:[\w-]+:)?DeleteResult)(?:\s[^>]*)?>[\s\S]*<\/\1>$/.test(text)) {
      throw new Error('S3 did not return a DeleteResult.');
    }
    const deleted = xmlBlocks(text, 'Deleted').map((block) => xmlFirst(block, 'Key') ?? '');
    const errors = xmlBlocks(text, 'Error').map((block) => ({
      key: xmlFirst(block, 'Key') ?? '',
      code: xmlFirst(block, 'Code') ?? '',
      message: xmlFirst(block, 'Message') ?? '',
    }));
    
    const requested = new Set(keys);
    const confirmed = new Set(deleted.filter(key => requested.has(key)));
    const knownErrors = errors.filter(error => requested.has(error.key));
    const failed = new Set(knownErrors.map(error => error.key));
    for (const key of keys) {
      if (failed.has(key)) confirmed.delete(key);
      else if (!confirmed.has(key)) knownErrors.push({ key, code: 'UnconfirmedDelete', message: 'S3 did not confirm deletion.' });
    }
    return { deleted: [...confirmed], errors: knownErrors };
  }

  public async createMultipartUpload(key: string, contentType?: string): Promise<string> {
    const url = this.buildUrl(key, { uploads: '' });
    const headers: Record<string, string> = {};
    if (contentType) headers['content-type'] = contentType;

    const res = await this.request(url, { method: 'POST', headers });
    if (!res.ok) await throwS3Error(res, 'CreateMultipartUpload');
    
    const text = await readXml(res);
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
  ${parts.map(p => `<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${escapeXml(p.ETag)}</ETag></Part>`).join('\n  ')}
</CompleteMultipartUpload>`;

    const res = await this.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/xml',
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      },
      body: xml,
    });
    await confirmedETag(res, 'CompleteMultipartUpload', 'CompleteMultipartUploadResult');
  }

  public async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const url = this.buildUrl(key, { uploadId });
    const res = await this.request(url, { method: 'DELETE' });
    if (!res.ok) await throwS3Error(res, 'AbortMultipartUpload');
  }


}
