/**
 * Deployment branding for the UI (white-label).
 *
 * The self-hosted server injects a JSON meta tag into the shell at serve time
 * (src/server/branding.ts); this module reads it synchronously at boot, so
 * there is no flash of the default brand and no extra request. Without the
 * meta tag — dev server, workers, tests — the built-in Galiot brand applies.
 *
 * Only same-origin logo paths are accepted; the CSP keeps everything local.
 */

import {
  BRANDING_META_NAME,
  DEFAULT_BRAND_NAME,
  DEFAULT_BRAND_TAGLINE,
  DEFAULT_LOGO_URL,
  MAX_BRAND_NAME_LENGTH,
  MAX_BRAND_TAGLINE_LENGTH,
} from './server/protocol';

export interface Brand {
  name: string;
  tagline: string;
  logoUrl: string;
  /** True when the deployment replaced the built-in logo. */
  customLogo: boolean;
  title: string;
}

function fallbackBrand(): Brand {
  return {
    name: DEFAULT_BRAND_NAME,
    tagline: DEFAULT_BRAND_TAGLINE,
    logoUrl: DEFAULT_LOGO_URL,
    customLogo: false,
    title: `${DEFAULT_BRAND_NAME} — ${DEFAULT_BRAND_TAGLINE}`,
  };
}

/** Parses the meta tag content defensively; anything odd falls back. */
export function brandFromMetaContent(content: string | null): Brand {
  if (!content) return fallbackBrand();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return fallbackBrand();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallbackBrand();
  const row = parsed as Record<string, unknown>;

  const base = fallbackBrand();
  const name = typeof row['name'] === 'string' ? row['name'].trim() : '';
  const tagline = typeof row['tagline'] === 'string' ? row['tagline'].trim() : base.tagline;
  const logoUrl = typeof row['logoUrl'] === 'string' ? row['logoUrl'] : null;

  const safeName = name !== '' && name.length <= MAX_BRAND_NAME_LENGTH ? name : base.name;
  const safeTagline = tagline.length <= MAX_BRAND_TAGLINE_LENGTH ? tagline : base.tagline;
  // Same-origin absolute paths only: no protocol-relative, no schemes.
  const safeLogo = logoUrl !== null && logoUrl.startsWith('/') && !logoUrl.startsWith('//')
    ? logoUrl
    : DEFAULT_LOGO_URL;

  return {
    name: safeName,
    tagline: safeTagline,
    logoUrl: safeLogo,
    customLogo: safeLogo !== DEFAULT_LOGO_URL,
    title: safeTagline ? `${safeName} — ${safeTagline}` : safeName,
  };
}

/** Reads the injected meta tag. DOM-free environments get the default brand. */
export function readBrand(): Brand {
  if (typeof document === 'undefined') return fallbackBrand();
  const meta = document.querySelector(`meta[name="${BRANDING_META_NAME}"]`);
  return brandFromMetaContent(meta?.getAttribute('content') ?? null);
}

export const BRAND: Brand = readBrand();
