import { AwsClient } from '../lib/aws4fetch';

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
  objects: { key: string; lastModified: string; size: number; eTag: string }[];
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

  private buildUrl(key?: string, queryParams?: Record<string, string>): URL {
    let urlStr = this.endpoint;
    if (this.pathStyle) {
      urlStr += `/${this.bucket}`;
      if (key) {
        urlStr += `/${key.split('/').map(encodeURIComponent).join('/')}`;
      }
    } else {
      const url = new URL(this.endpoint);
      url.hostname = `${this.bucket}.${url.hostname}`;
      urlStr = url.toString();
      if (key) {
        urlStr += `/${key.split('/').map(encodeURIComponent).join('/')}`;
      }
    }
    
    const url = new URL(urlStr);
    if (queryParams) {
      for (const [k, v] of Object.entries(queryParams)) {
        if (v !== undefined && v !== null) {
          url.searchParams.set(k, v);
        }
      }
    }
    return url;
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
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');

    const objects = Array.from(doc.querySelectorAll('Contents')).map(node => ({
      key: node.querySelector('Key')?.textContent || '',
      lastModified: node.querySelector('LastModified')?.textContent || '',
      size: parseInt(node.querySelector('Size')?.textContent || '0', 10),
      eTag: node.querySelector('ETag')?.textContent || '',
    }));

    const prefixes = Array.from(doc.querySelectorAll('CommonPrefixes Prefix')).map(node => node.textContent || '');
    const isTruncated = doc.querySelector('IsTruncated')?.textContent === 'true';
    const nextContinuationToken = doc.querySelector('NextContinuationToken')?.textContent || undefined;

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
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    
    const deleted = Array.from(doc.querySelectorAll('Deleted Key')).map(node => node.textContent || '');
    const errors = Array.from(doc.querySelectorAll('Error')).map(node => ({
      key: node.querySelector('Key')?.textContent || '',
      code: node.querySelector('Code')?.textContent || '',
      message: node.querySelector('Message')?.textContent || '',
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
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    const uploadId = doc.querySelector('UploadId')?.textContent;
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

  public async checkCors(): Promise<CorsCheckResult> {
    const url = this.buildUrl();
    const res = await fetch(url.toString(), {
      method: 'OPTIONS',
      headers: {
        'Origin': window.location.origin,
        'Access-Control-Request-Method': 'GET',
      },
    });
    
    if (!res.ok) {
        return { allowed: false, methods: [] };
    }
    
    const methods = res.headers.get('Access-Control-Allow-Methods');
    return {
        allowed: true,
        methods: methods ? methods.split(',').map(m => m.trim()) : [],
    };
  }
}
