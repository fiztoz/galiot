/**
 * Preset connection defaults for company deployments.
 *
 * Operators can pre-fill the "Add connection" form with their own S3 endpoint
 * (and region / path-style addressing) WITHOUT rebuilding the image:
 * GALIOT_PRESET_ENDPOINT, GALIOT_PRESET_REGION, GALIOT_PRESET_PATH_STYLE.
 * The server injects them into index.html as a JSON meta tag — never an
 * inline script — and the SPA reads it synchronously at boot.
 *
 * Presets are conveniences, not policy: fields stay editable, and no
 * credentials are ever part of a preset. The endpoint is screened at startup
 * with the same rules as a live connection target (http/https only, no
 * embedded credentials, no link-local/metadata addresses); a bad preset
 * refuses startup so a typo surfaces immediately.
 */

import { checkProxyTarget } from './proxy';
import { assertConnectionEndpoint } from '../s3/endpoint';
import {
  MAX_PRESET_ENDPOINT_LENGTH,
  MAX_PRESET_REGION_LENGTH,
  PRESETS_META_NAME,
} from './protocol';
import { escapeHtml } from './branding';

export const PRESET_ENDPOINT_ENV = 'GALIOT_PRESET_ENDPOINT';
export const PRESET_REGION_ENV = 'GALIOT_PRESET_REGION';
export const PRESET_PATH_STYLE_ENV = 'GALIOT_PRESET_PATH_STYLE';

export interface ConnectionPresets {
  /** Absolute http(s) URL, or '' when no endpoint is preset. */
  endpoint: string;
  /** '' keeps the app's built-in default (us-east-1). */
  region: string;
  pathStyle: boolean;
}

function cleanRegion(raw: string): string {
  const trimmed = raw.trim();
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${PRESET_REGION_ENV} must not contain control characters.`);
  }
  if (trimmed.length > MAX_PRESET_REGION_LENGTH) {
    throw new Error(`${PRESET_REGION_ENV} is too long (max ${MAX_PRESET_REGION_LENGTH} characters).`);
  }
  return trimmed;
}

/** Reads and validates presets from the environment. Throws on bad config. */
export function presetsFromEnv(env: NodeJS.ProcessEnv = process.env): ConnectionPresets {
  const endpoint = (env[PRESET_ENDPOINT_ENV] ?? '').trim();
  if (endpoint !== '') {
    if (endpoint.length > MAX_PRESET_ENDPOINT_LENGTH) {
      throw new Error(`${PRESET_ENDPOINT_ENV} is too long (max ${MAX_PRESET_ENDPOINT_LENGTH} characters).`);
    }
    if (/[\u0000-\u001f\u007f]/.test(endpoint)) {
      throw new Error(`${PRESET_ENDPOINT_ENV} must not contain control characters.`);
    }
    const checked = checkProxyTarget(endpoint);
    if (!checked.ok) {
      throw new Error(`${PRESET_ENDPOINT_ENV} is not a usable S3 endpoint: ${checked.detail} Include the scheme, e.g. https://s3.example.com`);
    }
    assertConnectionEndpoint(endpoint);
  }
  const region = cleanRegion(env[PRESET_REGION_ENV] ?? '');
  const rawPathStyle = (env[PRESET_PATH_STYLE_ENV] ?? '').trim().toLowerCase();
  return { endpoint, region, pathStyle: rawPathStyle === '1' || rawPathStyle === 'true' };
}

/**
 * Injects presets into the built index.html as a JSON meta tag. Always
 * emitted (even when empty) so the client has one uniform code path.
 */
export function injectPresets(html: string, presets: ConnectionPresets): string {
  if (!html.includes('</head>')) throw new Error('index.html has no </head> for presets.');
  const payload = JSON.stringify({
    endpoint: presets.endpoint,
    region: presets.region,
    pathStyle: presets.pathStyle,
  });
  const meta = `<meta name="${PRESETS_META_NAME}" content="${escapeHtml(payload)}" />`;
  return html.replace('</head>', () => `  ${meta}\n  </head>`);
}
