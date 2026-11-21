import { describe, expect, test } from 'bun:test';
import { SNIFF_LIMIT, sampleStream, sniffBytes } from './sniff';

const ascii = (text: string) => Uint8Array.from([...text].map((char) => char.charCodeAt(0)));
const bytes = (...values: number[]) => Uint8Array.from(values);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};
/** ISO base-media box: 4-byte size, 'ftyp', major brand, minor + compat brands. */
const ftyp = (brand: string) =>
  join(bytes(0, 0, 0, 24), ascii('ftyp'), ascii(brand), bytes(0, 0, 0, 0), bytes(0, 0, 0, 0), bytes(0, 0, 0, 0));
const riff = (form: string) => join(ascii('RIFF'), bytes(0, 0, 0, 0), ascii(form));

describe('sniffBytes', () => {
  test('recognises document and image signatures', () => {
    expect(sniffBytes(ascii('%PDF-1.7\n')).kind).toBe('pdf');
    expect(sniffBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)).kind).toBe('image');
    expect(sniffBytes(bytes(0xff, 0xd8, 0xff, 0xe0)).kind).toBe('image');
    expect(sniffBytes(ascii('GIF89a')).kind).toBe('image');
    expect(sniffBytes(join(ascii('BM'), bytes(100, 0, 0, 0), bytes(0, 0, 0, 0), bytes(54, 0, 0, 0))).kind).toBe('image');
    expect(sniffBytes(bytes(0, 0, 1, 0)).kind).toBe('image');
    expect(sniffBytes(riff('WEBP')).kind).toBe('image');
    expect(sniffBytes(ftyp('avif')).kind).toBe('image');
    expect(sniffBytes(ftyp('heic')).kind).toBe('image');
  });

  test('recognises audio and video signatures', () => {
    expect(sniffBytes(ascii('ID3\x04\x00')).kind).toBe('audio');
    expect(sniffBytes(ascii('fLaC')).kind).toBe('audio');
    expect(sniffBytes(ascii('OggS')).kind).toBe('audio');
    expect(sniffBytes(riff('WAVE')).kind).toBe('audio');
    expect(sniffBytes(ftyp('M4A ')).kind).toBe('audio');
    expect(sniffBytes(ftyp('isom')).kind).toBe('video');
    expect(sniffBytes(ftyp('mp42')).kind).toBe('video');
    expect(sniffBytes(bytes(0x1a, 0x45, 0xdf, 0xa3)).kind).toBe('video');
    expect(sniffBytes(riff('AVI ')).kind).toBe('video');
  });

  test('svg is text but previews as an image', () => {
    expect(sniffBytes(ascii('<svg viewBox="0 0 1 1"></svg>')).kind).toBe('image');
    expect(sniffBytes(ascii('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>')).kind).toBe('image');
  });

  test('plain and structured text stay editable', () => {
    const plain = sniffBytes(ascii('hello world\nsecond line\n'));
    expect(plain.kind).toBeNull();
    expect(plain.text).toBe('hello world\nsecond line\n');
    const json = sniffBytes(ascii('{"a": 1}'));
    expect(json.kind).toBeNull();
    expect(json.text).toBe('{"a": 1}');
    const empty = sniffBytes(bytes());
    expect(empty.kind).toBeNull();
    expect(empty.text).toBe('');
  });

  test('opaque binary is reported, not dumped into the editor', () => {
    expect(sniffBytes(bytes(0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe)).kind).toBe('binary'); // zip
    expect(sniffBytes(ascii('before\x00after')).kind).toBe('binary');
    expect(sniffBytes(bytes(0x7f, 0x45, 0x4c, 0x46)).kind).toBe('binary'); // ELF
  });

  test('truncated signatures do not crash', () => {
    expect(sniffBytes(bytes(0x25)).kind).not.toBe('pdf');
    expect(sniffBytes(bytes(0x89, 0x50)).kind).toBe('binary');
    expect(sniffBytes(ascii('RIF')).kind).toBeNull();
  });

  test('a codepoint cut by the sample boundary stays text', () => {
    const body = new Uint8Array(SNIFF_LIMIT).fill(0x61);
    body[SNIFF_LIMIT - 1] = 0xe2; // lead byte of a 3-byte codepoint, tail missing
    const result = sniffBytes(body);
    expect(result.kind).toBeNull();
    expect(result.text?.length).toBe(SNIFF_LIMIT - 1);
  });

  test('signature lookalikes in prose are not media', () => {
    expect(sniffBytes(ascii('abcdftypisom and more words')).kind).toBeNull();
    expect(sniffBytes(ascii('BM reserves are not zero here')).kind).toBeNull();
    const bmp = join(ascii('BM'), bytes(100, 0, 0, 0), bytes(0, 0, 0, 0), bytes(54, 0, 0, 0));
    expect(sniffBytes(bmp).kind).toBe('image');
    const mp4 = join(bytes(0, 0, 0, 24), ascii('ftypisom'), bytes(0, 0, 2, 0), bytes(0, 0, 0, 0), bytes(0, 0, 0, 0));
    expect(sniffBytes(mp4).kind).toBe('video');
  });
});

describe('sampleStream', () => {
  test('keeps only the limit and cancels the rest of an unbounded body', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 8; i++) controller.enqueue(new Uint8Array(SNIFF_LIMIT).fill(0x61 + i));
        // never close: the sniffer must cancel instead of waiting
      },
      cancel() {
        cancelled = true;
      },
    });
    const sample = await sampleStream(new Response(stream));
    expect(sample.byteLength).toBe(SNIFF_LIMIT);
    expect(sample[0]).toBe(0x61);
    expect(cancelled).toBe(true);
  });

  test('short bodies pass through whole', async () => {
    const sample = await sampleStream(new Response(ascii('hello')));
    expect(new TextDecoder().decode(sample)).toBe('hello');
  });
});
