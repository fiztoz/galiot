import { AwsClient } from '../lib/aws4fetch';
import { buildS3Url } from './url';
import { md5Base64 } from '../transfer/integrity';
import { xmlBlocks, xmlFirst, xmlTextValues } from './xml';

export interface S3ClientOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  pathStyle?: boolean;
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
}

export interface PutObjectResult {
  eTag: string;
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

export class S3Client {
  private awsClient: AwsClient;
  private endpoint: string;
  private bucket: string;
  private pathStyle: boolean;

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
    const url = this.buildUrl(undefined, listObjectsQuery(prefix, options));

    const res = await this.awsClient.fetch(url);
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
    const nextContinuationToken = xmlFirst(text, 'NextContinuationToken');

    return { objects, prefixes, isTruncated, nextContinuationToken };
  }

  public async headObject(key: string): Promise<ObjectMeta> {
    const url = this.buildUrl(key);
    const res = await this.awsClient.fetch(url, { method: 'HEAD' });
    if (!res.ok) await throwS3Error(res, 'HeadObject');

    return {
      contentLength: parseInt(res.headers.get('content-length') || '0', 10),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      lastModified: res.headers.get('last-modified') || '',
      eTag: res.headers.get('etag') || '',
    };
  }

  public async getObject(key: string): Promise<Response> {
    const url = this.buildUrl(key);
    const res = await this.awsClient.fetch(url);
    if (!res.ok) await throwS3Error(res, 'GetObject');
    return res;
  }

  public async putObject(key: string, body: Blob | ArrayBuffer | string, contentType?: string): Promise<PutObjectResult> {
    const url = this.buildUrl(key);
    const headers: Record<string, string> = {
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    };
    if (contentType) headers['content-type'] = contentType;

    const res = await this.awsClient.fetch(url, {
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
    const res = await this.awsClient.fetch(url, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`DeleteObject failed: ${res.statusText}`);
  }

  public async deleteObjects(keys: string[]): Promise<DeleteResult> {
    const url = this.buildUrl(undefined, { delete: '' });
    
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Delete>
  <Quiet>false</Quiet>
  ${keys.map(k => `<Object><Key>${k.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')}</Key></Object>`).join('\n  ')}
</Delete>`;

    const res = await this.awsClient.fetch(url, {
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

    const res = await this.awsClient.fetch(url, { method: 'POST', headers });
    if (!res.ok) await throwS3Error(res, 'CreateMultipartUpload');
    
    const text = await res.text();
    const uploadId = xmlFirst(text, 'UploadId');
    if (!uploadId) throw new Error('Failed to parse UploadId');
    return uploadId;
  }

  public async uploadPart(key: string, uploadId: string, partNumber: number, body: Blob): Promise<string> {
    const url = this.buildUrl(key, { uploadId, partNumber: partNumber.toString() });
    const res = await this.awsClient.fetch(url, {
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

    const res = await this.awsClient.fetch(url, {
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
    const res = await this.awsClient.fetch(url, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error(`AbortMultipartUpload failed: ${res.statusText}`);
  }


  /** Reads the bucket's current CORS configuration. */
  public async getBucketCors(): Promise<CorsConfiguration> {
    const url = this.buildUrl(undefined, { cors: '' });
    const res = await this.awsClient.fetch(url, { method: 'GET' });

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
    const res = await this.awsClient.fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/xml' },
      body: xml,
    });
    if (!res.ok) await throwS3Error(res, 'PutBucketCors');
  }

  /** Removes the bucket's CORS configuration. */
  public async deleteBucketCors(): Promise<void> {
    const url = this.buildUrl(undefined, { cors: '' });
    const res = await this.awsClient.fetch(url, { method: 'DELETE' });
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
      // look unreachable (verified in a real browser).
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
}
