/**
 * Content-based file typing for objects whose name gives nothing away.
 *
 * S3 listings carry no Content-Type, and uploads often land as
 * `application/octet-stream`, so an extensionless object needs its first
 * bytes read before the editor decides between preview, text and "binary".
 * Pure and dependency-free so the magic-byte table stays unit-testable.
 */

import type { PreviewKind } from './filetypes';

/** How many leading bytes are fetched for sniffing. Magic numbers and text
 * heuristics never need more; the rest of the object streams on demand. */
export const SNIFF_LIMIT = 64 * 1024;

export interface SniffResult {
  /** `null` means "looks like text — open the editor with `text`". */
  kind: PreviewKind | null;
  /** Decoded sample when the content is text, for grammar hints. */
  text: string | null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = offset; i < offset + length && i < bytes.byteLength; i++) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const BMP = [0x42, 0x4d];
const ICO = [0x00, 0x00, 0x01, 0x00];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const FLAC = [0x66, 0x4c, 0x61, 0x43]; // fLaC
const OGG = [0x4f, 0x67, 0x67, 0x53]; // OggS
const ID3 = [0x49, 0x44, 0x33]; // ID3
const EBML = [0x1a, 0x45, 0xdf, 0xa3]; // Matroska / WebM
const MPEG_PS = [0x00, 0x00, 0x01, 0xba];
const AMR = [0x23, 0x21, 0x41, 0x4d, 0x52]; // #!AMR

/** ISO base-media brands that are still pictures or sound, not video. */
const IMAGE_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'F4A ', 'F4B ']);

function riffKind(bytes: Uint8Array): PreviewKind | null {
  if (!startsWith(bytes, [0x52, 0x49, 0x46, 0x46])) return null; // RIFF
  const form = ascii(bytes, 8, 4);
  if (form === 'WEBP') return 'image';
  if (form === 'WAVE') return 'audio';
  if (form === 'AVI ') return 'video';
  return null;
}

function ftypKind(bytes: Uint8Array): PreviewKind | null {
  if (ascii(bytes, 4, 4) !== 'ftyp') return null;
  // The ftyp box is small and sits at byte 0; a nonsensical size means text
  // that happens to contain 'ftyp', not an ISO base-media file.
  const size =
    ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  if (size < 16 || size > bytes.byteLength) return null;
  const brand = ascii(bytes, 8, 4);
  if (IMAGE_BRANDS.has(brand)) return 'image';
  if (AUDIO_BRANDS.has(brand)) return 'audio';
  return 'video';
}

/** Control characters that never appear in plain text (ESC stays: ANSI logs). */
function isBinaryText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0 || code === 127) return true;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12 && code !== 27) return true;
  }
  return false;
}

export function sniffBytes(bytes: Uint8Array): SniffResult {
  if (startsWith(bytes, PDF)) return { kind: 'pdf', text: null };
  if (
    startsWith(bytes, PNG) ||
    startsWith(bytes, JPEG) ||
    startsWith(bytes, ICO) ||
    startsWith(bytes, GIF87) ||
    startsWith(bytes, GIF89)
  ) {
    return { kind: 'image', text: null };
  }
  // 'BM' alone also starts prose; a real BMP header zeroes its reserved word.
  if (
    startsWith(bytes, BMP) &&
    bytes.byteLength >= 14 &&
    bytes[6] === 0 && bytes[7] === 0 && bytes[8] === 0 && bytes[9] === 0
  ) {
    return { kind: 'image', text: null };
  }
  const riff = riffKind(bytes);
  if (riff) return { kind: riff, text: null };
  const ftyp = ftypKind(bytes);
  if (ftyp) return { kind: ftyp, text: null };
  if (startsWith(bytes, FLAC) || startsWith(bytes, OGG) || startsWith(bytes, ID3) || startsWith(bytes, AMR)) {
    return { kind: 'audio', text: null };
  }
  if (startsWith(bytes, EBML) || startsWith(bytes, MPEG_PS)) {
    return { kind: 'video', text: null };
  }

  // Not a known binary signature: try to read it as UTF-8 text. `stream: true`
  // keeps a codepoint cut by the sample boundary in the decoder's buffer
  // instead of throwing — a truncated tail must not turn text into "binary".
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return { kind: 'binary', text: null };
  }
  if (isBinaryText(decoded)) return { kind: 'binary', text: null };

  // SVG is text but previews as an image, like its extension-named twins.
  const head = decoded.slice(0, 4096).replace(/^\uFEFF/, '').trimStart();
  if (/^<svg[\s>]/i.test(head) || (head.startsWith('<?xml') && /<svg[\s>]/i.test(head))) {
    return { kind: 'image', text: null };
  }

  return { kind: null, text: decoded };
}

/**
 * Reads at most `limit` leading bytes of a response and cancels the rest, so
 * providers that ignore Range do not stream whole objects into the sniffer.
 * Exported for unit tests; EditorPanel wraps it with the vault media URL.
 */
export async function sampleStream(response: Response, limit = SNIFF_LIMIT): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer()).subarray(0, limit);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const sample = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, sample.byteLength - offset);
    sample.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= sample.byteLength) break;
  }
  return sample;
}
