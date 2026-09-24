import { AwsClient } from '../lib/aws4fetch';
import { buildS3Url } from './url';
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
    const url = this.buildUrl(undefined, {
      'list-type': '2',
      prefix: prefix || '',
      delimiter: options?.delimiter || '',
      'max-keys': options?.maxKeys?.toString() || '1000',
      'continuation-token': options?.continuationToken || '',
    });

    const res = await this.awsClient.fetch(url);
    if (!res.ok) throw new Error(`ListObjects failed: ${res.statusText}`);

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
    if (!res.ok) throw new Error(`HeadObject failed: ${res.statusText}`);

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
    if (!res.ok) throw new Error(`GetObject failed: ${res.statusText}`);
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
    if (!res.ok) throw new Error(`PutObject failed: ${res.statusText}`);
    
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
      },
      body: xml,
    });
    
    if (!res.ok) throw new Error(`DeleteObjects failed: ${res.statusText}`);
    
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
    if (!res.ok) throw new Error(`CreateMultipartUpload failed: ${res.statusText}`);
    
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
    if (!res.ok) throw new Error(`UploadPart failed: ${res.statusText}`);
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
    if (!res.ok) throw new Error(`CompleteMultipartUpload failed: ${res.statusText}`);
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
    if (!res.ok) throw new Error(`GetBucketCors failed: ${res.status} ${res.statusText}`);

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
    if (!res.ok) throw new Error(`PutBucketCors failed: ${res.status} ${res.statusText}`);
  }

  /** Removes the bucket's CORS configuration. */
  public async deleteBucketCors(): Promise<void> {
    const url = this.buildUrl(undefined, { cors: '' });
    const res = await this.awsClient.fetch(url, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      throw new Error(`DeleteBucketCors failed: ${res.status} ${res.statusText}`);
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
