/**
 * Minimal XML element reader for Node/Bun tooling.
 *
 * The browser app uses `DOMParser` (see src/s3/client.ts), but Bun has no DOM.
 * The integrity harness runs in Bun, so it needs a tiny parser for the handful
 * of S3 XML responses we care about. This is intentionally *not* a general XML
 * parser: it only extracts element text by tag name, which is all S3's
 * machine-generated responses require.
 *
 * Namespaced tags are normalised (`CORSRule`, `s3:CORSRule` → same key).
 */

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

/** Returns the text content of every `<tag>` element, document order preserved. */
export function xmlTextValues(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'g');
  const values: string[] = [];

  for (const match of xml.matchAll(pattern)) {
    values.push(decodeEntities((match[1] ?? '').trim()));
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
