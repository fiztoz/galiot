export interface AwsClientOptions {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
  service?: string;
  retries?: number;
  initRetryMs?: number;
}

export interface AwsSignOptions {
  aws?: {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    region?: string;
    service?: string;
    datetime?: string;
    signQuery?: boolean;
    appendSessionToken?: boolean;
    allHeaders?: boolean;
    singleEncode?: boolean;
    retries?: number;
    initRetryMs?: number;
  };
}

const encoder = new TextEncoder();

const HOST_SERVICES: Record<string, string> = {
  appstream2: 'appstream',
  cloudhsmv2: 'cloudhsm',
  email: 'ses',
  marketplace: 'aws-marketplace',
  mobile: 'AWSMobileHubService',
  pinpoint: 'mobiletargeting',
  queue: 'sqs',
  'git-codecommit': 'codecommit',
  'mturk-requester-sandbox': 'mturk-requester',
  'personalize-runtime': 'personalize',
};

// https://github.com/aws/aws-sdk-js/blob/v2.1390.0/lib/signers/v4.js#L191
const UNSIGNABLE_HEADERS = new Set([
  'authorization',
  'content-type',
  'content-length',
  'user-agent',
  'presigned-expires',
  'expect',
  'x-amzn-trace-id',
  'range',
  'connection',
]);

/** RFC 3986 encoding: like encodeURIComponent, but also escapes !'()* */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Canonical URI for SigV4: the path percent-encoded exactly once, with `/` kept
 * as a separator (S3's rule).
 *
 * The URL parser has *already* encoded the path by the time we see it, so
 * running `encodeURI` over it encodes every `%` again: a key of
 * ` leading-space.txt` became `%20` in the URL and `%2520` in the signature,
 * while the request that went out carried `%20`. MinIO answered every such
 * upload with `403 SignatureDoesNotMatch` (verified against
 * quay.io/minio/minio RELEASE.2025-09-07), which meant any key with a space or
 * a non-ASCII character — "Q3 report.pdf", "写真.jpg" — could not be uploaded,
 * fetched or deleted.
 *
 * Decoding first and re-encoding per segment is idempotent, so a key that
 * literally contains `%20` is still encoded once and matches what is sent.
 */
export function canonicalUri(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A stray '%' that is not a valid escape: use the path as we received it.
    decoded = pathname;
  }
  return decoded.split('/').map((segment) => encodeRfc3986(segment)).join('/');
}

export class AwsClient {
  public accessKeyId: string;
  public secretAccessKey: string;
  public sessionToken: string | undefined;
  public service: string | undefined;
  public region: string | undefined;

  constructor(options: AwsClientOptions) {
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.sessionToken = options.sessionToken;
    this.service = options.service;
    this.region = options.region;
  }

  public async sign(input: RequestInfo | URL, init?: RequestInit & AwsSignOptions): Promise<Request> {
    if (input instanceof Request) {
      const { method, url, headers } = input;
      init = Object.assign({ method, url, headers }, init);
    }
    init = init || {};
    
    let url: URL;
    if (input instanceof URL) {
        url = input;
    } else if (typeof input === 'string') {
        url = new URL(input);
    } else if (input instanceof Request) {
        url = new URL(input.url);
    } else {
        throw new Error('Invalid input');
    }

    const headers = new Headers(init.headers);
    const method = init.method || 'GET';

    const awsOptions = init.aws || {};
    const datetime = awsOptions.datetime || new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = datetime.substring(0, 8);

    const region = awsOptions.region || this.region || guessRegion(url.hostname);
    const service = awsOptions.service || this.service || guessService(url.hostname);
    const signQuery = awsOptions.signQuery || false;

    let payloadHash = headers.get('x-amz-content-sha256');
    if (!payloadHash) {
      if (init.body && typeof init.body === 'string') {
        payloadHash = await hash(init.body);
      } else if (init.body && init.body instanceof ArrayBuffer) {
        payloadHash = await hashBuffer(init.body);
      } else {
        payloadHash = 'UNSIGNED-PAYLOAD';
      }
      if (!signQuery) {
          headers.set('x-amz-content-sha256', payloadHash);
      }
    }

    if (!headers.has('host')) {
      headers.set('host', url.host);
    }

    if (!signQuery) {
        headers.set('x-amz-date', datetime);
        if (this.sessionToken && !headers.has('x-amz-security-token')) {
            headers.set('x-amz-security-token', this.sessionToken);
        }
    }

    const canonicalHeaders: [string, string][] = [];
    const signedHeadersList: string[] = [];
    
    for (const [k, v] of Array.from(headers.entries())) {
      const lowerK = k.toLowerCase();
      if (!UNSIGNABLE_HEADERS.has(lowerK) || lowerK === 'host' || awsOptions.allHeaders) {
        canonicalHeaders.push([lowerK, v]);
        signedHeadersList.push(lowerK);
      }
    }

    canonicalHeaders.sort(([a], [b]) => a < b ? -1 : 1);
    signedHeadersList.sort();

    const canonicalHeadersStr = canonicalHeaders.map(([k, v]) => `${k}:${v.replace(/\s+/g, ' ').trim()}\n`).join('');
    const signedHeadersStr = signedHeadersList.join(';');

    const credentialScope = `${date}/${region}/${service}/aws4_request`;

    let queryStr = '';
    if (signQuery) {
        url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
        url.searchParams.set('X-Amz-Credential', `${this.accessKeyId}/${credentialScope}`);
        url.searchParams.set('X-Amz-Date', datetime);
        url.searchParams.set('X-Amz-SignedHeaders', signedHeadersStr);
        if (this.sessionToken) {
            url.searchParams.set('X-Amz-Security-Token', this.sessionToken);
        }
    }

    const queryParams: [string, string][] = [];
    for (const [k, v] of Array.from(url.searchParams.entries())) {
        queryParams.push([encodeURIComponent(k).replace(/[!'()*]/g, escape), encodeURIComponent(v).replace(/[!'()*]/g, escape)]);
    }
    queryParams.sort(([aK, aV], [bK, bV]) => {
        if (aK === bK) return aV < bV ? -1 : 1;
        return aK < bK ? -1 : 1;
    });
    queryStr = queryParams.map(([k, v]) => `${k}=${v}`).join('&');

    const uri = canonicalUri(url.pathname);
    const canonicalRequest = `${method}\n${uri}\n${queryStr}\n${canonicalHeadersStr}\n${signedHeadersStr}\n${payloadHash}`;

    const canonicalRequestHash = await hash(canonicalRequest);
    const stringToSign = `AWS4-HMAC-SHA256\n${datetime}\n${credentialScope}\n${canonicalRequestHash}`;

    const kDate = await hmac(`AWS4${this.secretAccessKey}`, date);
    const kRegion = await hmac(kDate, region);
    const kService = await hmac(kRegion, service);
    const kSigning = await hmac(kService, 'aws4_request');
    const signature = hex(await hmac(kSigning, stringToSign));

    if (signQuery) {
        url.searchParams.set('X-Amz-Signature', signature);
        return new Request(url.toString(), {
            method,
            headers: new Headers(), // omit canonical headers in request for presigned URLs if desired, but typically we return the URL
            body: init.body,
        });
    }

    headers.set('Authorization', `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`);

    return new Request(url.toString(), {
      method,
      headers,
      body: init.body,
    });
  }

  public async fetch(input: RequestInfo | URL, init?: RequestInit & AwsSignOptions): Promise<Response> {
    for (let i = 0; i <= (init?.aws?.retries || 0); i++) {
        const req = await this.sign(input, init);
        const res = await fetch(req);
        if (res.status < 500 && res.status !== 429) {
            return res;
        }
        if (i < (init?.aws?.retries || 0)) {
            await new Promise(r => setTimeout(r, (init?.aws?.initRetryMs || 50) * Math.pow(2, i)));
        } else {
            return res;
        }
    }
    throw new Error('Unreachable');
  }
}

async function hmac(key: CryptoKey | string | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = typeof key === 'string'
    ? await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    : key instanceof ArrayBuffer
      ? await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      : key;
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

async function hash(data: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return hex(buffer);
}

async function hashBuffer(data: ArrayBuffer): Promise<string> {
    const buffer = await crypto.subtle.digest('SHA-256', data);
    return hex(buffer);
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function guessService(hostname: string): string {
    const parts = hostname.split('.');
    const svc = parts[0] ?? 's3';
    if (svc === 's3' || svc.startsWith('s3-')) {
        return 's3';
    }
    if (parts.length > 2) {
        return HOST_SERVICES[svc] ?? svc;
    }
    return 's3'; // fallback
}

function guessRegion(hostname: string): string {
    const parts = hostname.split('.');
    if (parts[1] !== 'amazonaws' && parts.length > 2) {
        if (parts[1] !== 's3') {
            return parts[1] ?? 'us-east-1';
        } else if (parts.length > 3) {
            return parts[2] ?? 'us-east-1';
        }
    }
    return 'us-east-1'; // fallback
}
