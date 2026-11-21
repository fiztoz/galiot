/**
 * Minimal XML element reader, used by *both* the app and the Bun tooling.
 *
 * This started as a Bun-only shim because the browser had `DOMParser`. It is now
 * the only reader: `DOMParser` is not exposed to dedicated Web Workers in
 * Chrome (verified: `typeof DOMParser === 'undefined'` in a worker, `function`
 * on the main thread), and every S3 response is parsed inside the vault or
 * transfer worker. Using the DOM API there failed at runtime with
 * "DOMParser is not defined" — which the diagnostics then misreported as a CORS
 * block, making a working bucket look unreachable.
 *
 * This is intentionally *not* a general XML parser: it extracts element text by
 * tag name, which is all S3's machine-generated responses require. Namespaced
 * tags are normalised (`CORSRule`, `s3:CORSRule` → same key).
 */

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

/**
 * One pass, so `&#38;amp;` stays `&amp;` (a chained replace decoded it twice).
 * Decimal and hex references use code points: keys may hold any Unicode
 * character, and S3 escapes control characters such as CR as `&#13;`.
 */
function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(lt|gt|quot|apos|amp));/gi, (whole, dec?: string, hex?: string, named?: string) => {
    if (named) return NAMED_ENTITIES[named.toLowerCase()] ?? whole;
    const code = dec !== undefined ? Number(dec) : parseInt(hex ?? '', 16);
    return Number.isInteger(code) && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      ? String.fromCodePoint(code)
      : whole;
  });
}

/**
 * Returns the text content of every `<tag>` element, document order preserved.
 *
 * Values are returned verbatim — no trimming — because that is what
 * `DOMParser.textContent` did and S3 object keys may legitimately begin or end
 * with a space. Callers parsing numbers or booleans trim (or rely on
 * `parseInt`, which tolerates surrounding whitespace).
 */
export function xmlTextValues(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'g');
  const values: string[] = [];

  for (const match of xml.matchAll(pattern)) {
    values.push(decodeEntities(match[1] ?? ''));
  }
  return values;
}

/** Convenience for repeated-tag responses (ListParts `Part` blocks). */
export function xmlBlocks(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'g');
  return Array.from(xml.matchAll(pattern), (match) => match[1] ?? '');
}

/** First matching element's text, or undefined. */
export function xmlFirst(xml: string, tag: string): string | undefined {
  return xmlTextValues(xml, tag)[0];
}
