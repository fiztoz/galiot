/**
 * Transfer integrity primitives.
 *
 * S3 ETags are content fingerprints with one caveat: for a multipart upload
 * the ETag is `"<md5-of-concatenated-part-md5s>-<partCount>"`, not the MD5 of
 * the object. Verifying a completed upload therefore means recomputing both
 * forms, which is what this module does.
 *
 * MD5 is implemented here (rather than via WebCrypto, which does not provide
 * it) purely to *verify* S3's own metadata — it is not used for signing or for
 * any security decision.
 */

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += HEX[byte >> 4];
    out += HEX[byte & 15];
  }
  return out;
}

function rotl(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

/** Incremental MD5, so large payloads never need to be buffered whole. */
export class Md5 {
  private state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  private buffer = new Uint8Array(64);
  private bufferLength = 0;
  private totalLength = 0;

  update(chunk: Uint8Array): this {
    this.totalLength += chunk.length;

    let offset = 0;
    if (this.bufferLength > 0) {
      const needed = 64 - this.bufferLength;
      const take = Math.min(needed, chunk.length);
      this.buffer.set(chunk.subarray(0, take), this.bufferLength);
      this.bufferLength += take;
      offset = take;
      if (this.bufferLength === 64) {
        this.processBlock(this.buffer, 0);
        this.bufferLength = 0;
      }
    }

    for (; offset + 64 <= chunk.length; offset += 64) {
      this.processBlock(chunk, offset);
    }

    if (offset < chunk.length) {
      this.buffer.set(chunk.subarray(offset), 0);
      this.bufferLength = chunk.length - offset;
    }

    return this;
  }

  /** The 16 raw digest bytes, for APIs that want binary rather than hex. */
  digestBytes(): Uint8Array {
    const bitLength = this.totalLength * 8;
    const padded = new Uint8Array(this.bufferLength < 56 ? 64 : 128);
    padded.set(this.buffer.subarray(0, this.bufferLength));
    padded[this.bufferLength] = 0x80;

    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, bitLength >>> 0, true);
    view.setUint32(padded.length - 4, Math.floor(bitLength / 0x100000000), true);

    for (let offset = 0; offset < padded.length; offset += 64) {
      this.processBlock(padded, offset);
    }

    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 4; i += 1) {
      outView.setUint32(i * 4, this.state[i]! >>> 0, true);
    }
    return out;
  }

  digest(): string {
    return toHex(this.digestBytes());
  }

  private processBlock(block: Uint8Array, offset: number): void {
    const m = new Int32Array(16);
    for (let i = 0; i < 16; i += 1) {
      m[i] =
        (block[offset + i * 4] ?? 0) |
        ((block[offset + i * 4 + 1] ?? 0) << 8) |
        ((block[offset + i * 4 + 2] ?? 0) << 16) |
        ((block[offset + i * 4 + 3] ?? 0) << 24);
    }

    let a: number = this.state[0]!;
    let b: number = this.state[1]!;
    let c: number = this.state[2]!;
    let d: number = this.state[3]!;
    const shifts = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const constants = new Int32Array(64);
    for (let i = 0; i < 64; i += 1) {
      constants[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;
    }

    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;

      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const temp = d;
      d = c;
      c = b;
      const sum = (a + f + constants[i]! + m[g]!) >>> 0;
      b = (b + rotl(sum, shifts[i]!)) >>> 0;
      a = temp;
    }

    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
  }
}

export function md5Hex(data: Uint8Array): string {
  return new Md5().update(data).digest();
}

/**
 * Base64 of the raw MD5 digest, which is what the S3 `Content-MD5` header wants
 * (hex is a different encoding of the same bytes).
 */
export function md5Base64(data: Uint8Array): string {
  const bytes = new Md5().update(data).digestBytes();
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Splits `"abc-3"` into its hex digest and part count. */
export function parseMultipartEtag(etag: string): { digest: string; parts: number } | null {
  const match = /^"?([0-9a-f]{32})-(\d+)"?$/i.exec(etag.trim());
  if (!match) return null;
  return { digest: match[1]!.toLowerCase(), parts: Number(match[2]) };
}

/** Recomputes the ETag S3 reports for a completed multipart upload. */
export function multipartEtag(partDigests: string[]): string {
  const concatenated = partDigests
    .map((digest) => Uint8Array.from(Buffer.from(digest, 'hex')))
    .reduce<Uint8Array>((acc, part) => {
      const next = new Uint8Array(acc.length + part.length);
      next.set(acc, 0);
      next.set(part, acc.length);
      return next;
    }, new Uint8Array(0));

  return `${md5Hex(concatenated)}-${partDigests.length}`;
}

/**
 * Verifies a downloaded object against the ETag S3 reported for it.
 * Returns null when the ETag is opaque (SSE-C/KMS encrypts it) and therefore
 * not comparable.
 */
export function verifyAgainstEtag(
  data: Uint8Array,
  etag: string,
  partSizes: number[] = [],
): { ok: boolean; reason: string } {
  const cleaned = etag.replace(/^"|"$/g, '');

  if (/-(\d+)$/.test(cleaned)) {
    if (partSizes.length === 0) {
      return { ok: false, reason: 'multipart ETag needs the part boundaries to verify' };
    }

    const partDigests: string[] = [];
    let offset = 0;
    for (const size of partSizes) {
      partDigests.push(md5Hex(data.subarray(offset, offset + size)));
      offset += size;
    }
    if (offset !== data.length) {
      return {
        ok: false,
        reason: `part sizes cover ${offset} bytes but the object is ${data.length}`,
      };
    }

    const expected = multipartEtag(partDigests);
    return expected === cleaned
      ? { ok: true, reason: `multipart ETag matches (${partDigests.length} parts)` }
      : { ok: false, reason: `multipart ETag mismatch: expected ${expected}, bucket said ${cleaned}` };
  }

  if (!/^[0-9a-f]{32}$/i.test(cleaned)) {
    return { ok: false, reason: 'ETag is not a content MD5 (encrypted or provider-specific)' };
  }

  const actual = md5Hex(data);
  return actual === cleaned.toLowerCase()
    ? { ok: true, reason: 'MD5 ETag matches' }
    : { ok: false, reason: `MD5 mismatch: computed ${actual}, bucket said ${cleaned}` };
}
