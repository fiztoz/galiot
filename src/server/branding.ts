/**
 * Deployment branding (white-label) for the self-hosted server.
 *
 * Operators can rename the app and replace the logo WITHOUT rebuilding the
 * image: GALIOT_BRAND_NAME, GALIOT_BRAND_TAGLINE, GALIOT_BRAND_LOGO (a path to
 * an image file, e.g. a mounted ConfigMap). The server injects the brand into
 * index.html (title, favicon, a JSON meta tag — never an inline script, the
 * CSP forbids those), rewrites the PWA manifest, and serves the logo bytes
 * same-origin at /branding/logo.
 *
 * Config is read once at startup. An unreadable or oversized logo file is a
 * startup error, mirroring the gate refusal: fail fast on operator typos.
 */

import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import {
  BRANDING_LOGO_PATH,
  BRANDING_META_NAME,
  DEFAULT_BRAND_NAME,
  DEFAULT_BRAND_TAGLINE,
  MAX_BRAND_NAME_LENGTH,
  MAX_BRAND_TAGLINE_LENGTH,
} from './protocol';

export const BRAND_NAME_ENV = 'GALIOT_BRAND_NAME';
export const BRAND_TAGLINE_ENV = 'GALIOT_BRAND_TAGLINE';
export const BRAND_LOGO_ENV = 'GALIOT_BRAND_LOGO';

export const MAX_LOGO_BYTES = 1024 * 1024; // ConfigMap-friendly cap.

const LOGO_CONTENT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

export interface BrandingConfig {
  name: string;
  /** Empty string means "no tagline": the title is just the name. */
  tagline: string;
  /** Same-origin URL of the custom logo, or null for the built-in favicon. */
  logoUrl: string | null;
  logo: { bytes: Uint8Array; contentType: string } | null;
}

function cleanText(raw: string, max: number, label: string): string {
  const trimmed = raw.trim();
  // Control characters have no business in a display name and would make the
  // injected HTML/meta harder to reason about.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  if (trimmed.length > max) {
    throw new Error(`${label} is too long (max ${max} characters).`);
  }
  return trimmed;
}

/** Reads and validates branding from the environment. Throws on bad config. */
export function brandingFromEnv(env: NodeJS.ProcessEnv = process.env): BrandingConfig {
  const rawName = env[BRAND_NAME_ENV];
  const name = rawName === undefined || rawName.trim() === ''
    ? DEFAULT_BRAND_NAME
    : cleanText(rawName, MAX_BRAND_NAME_LENGTH, BRAND_NAME_ENV);

  // Unset keeps the default tagline; an explicit empty string removes it.
  const rawTagline = env[BRAND_TAGLINE_ENV];
  const tagline = rawTagline === undefined
    ? DEFAULT_BRAND_TAGLINE
    : cleanText(rawTagline, MAX_BRAND_TAGLINE_LENGTH, BRAND_TAGLINE_ENV);

  const logoPath = (env[BRAND_LOGO_ENV] ?? '').trim();
  let logo: BrandingConfig['logo'] = null;
  if (logoPath !== '') {
    const contentType = LOGO_CONTENT_TYPES[extname(logoPath).toLowerCase()];
    if (!contentType) {
      throw new Error(
        `${BRAND_LOGO_ENV} must end in ${Object.keys(LOGO_CONTENT_TYPES).join(', ')} (got ${logoPath}).`,
      );
    }
    let size: number;
    try {
      const stat = statSync(logoPath);
      if (!stat.isFile()) throw new Error('not a file');
      size = stat.size;
    } catch {
      throw new Error(`${BRAND_LOGO_ENV} points to an unreadable file: ${logoPath}`);
    }
    if (size === 0) throw new Error(`${BRAND_LOGO_ENV} points to an empty file: ${logoPath}`);
    if (size > MAX_LOGO_BYTES) {
      throw new Error(`${BRAND_LOGO_ENV} is larger than ${MAX_LOGO_BYTES} bytes: ${logoPath}`);
    }
    logo = { bytes: new Uint8Array(readFileSync(logoPath)), contentType };
  }

  return { name, tagline, logoUrl: logo ? BRANDING_LOGO_PATH : null, logo };
}

export function brandTitle(brand: Pick<BrandingConfig, 'name' | 'tagline'>): string {
  return brand.tagline ? `${brand.name} — ${brand.tagline}` : brand.name;
}

/** Escapes text for HTML text nodes and double-quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Injects branding into the built index.html. Replaces the title and favicon,
 * and adds a JSON meta tag the SPA reads synchronously at boot. No inline
 * script is emitted: the CSP (script-src 'self') would block it anyway.
 */
export function injectBranding(html: string, brand: BrandingConfig): string {
  const title = `<title>${escapeHtml(brandTitle(brand))}</title>`;
  // Function replacements: a brand name containing $& / $' must stay literal.
  const replacedTitle = html.replace(/<title>[\s\S]*?<\/title>/i, () => title);
  if (replacedTitle === html && !/<title>[\s\S]*?<\/title>/i.test(html)) {
    throw new Error('index.html has no <title> to brand.');
  }

  let out = replacedTitle;
  if (brand.logoUrl && brand.logo) {
    const iconTag = `<link rel="icon" type="${brand.logo.contentType}" href="${brand.logoUrl}" />`;
    out = out.replace(/<link\b[^>]*\brel="icon"[^>]*>/i, () => iconTag);
  }

  const payload = JSON.stringify({ name: brand.name, tagline: brand.tagline, logoUrl: brand.logoUrl });
  const meta = `<meta name="${BRANDING_META_NAME}" content="${escapeHtml(payload)}" />`;
  if (!out.includes('</head>')) throw new Error('index.html has no </head> to brand.');
  return out.replace('</head>', () => `  ${meta}\n  </head>`);
}

/** Rewrites the PWA manifest with the deployment brand. */
export function brandedManifest(raw: string, brand: BrandingConfig): string {
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  manifest['name'] = brand.name;
  // PWA launchers truncate long short_names; 12 chars is the common guidance.
  manifest['short_name'] = brand.name.length > 12 ? brand.name.slice(0, 12) : brand.name;
  manifest['description'] = brand.tagline
    ? `${brand.tagline} — a self-hosted S3 file browser`
    : 'A self-hosted S3 file browser';
  if (brand.logoUrl && brand.logo) {
    manifest['icons'] = [
      { src: brand.logoUrl, sizes: 'any', type: brand.logo.contentType, purpose: 'any maskable' },
    ];
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Headers for the logo response. The sandbox CSP neutralizes scripts if an
 * operator-supplied SVG is ever opened as a top-level document; inside <img>
 * scripts never run regardless.
 */
export function logoResponseHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}
