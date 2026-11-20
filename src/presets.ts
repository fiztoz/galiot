/**
 * Preset connection defaults for the UI (company deployments).
 *
 * The self-hosted server injects a JSON meta tag into the shell at serve time
 * (src/server/presets.ts); this module reads it synchronously at boot. Without
 * the meta tag — dev server, workers, tests — no presets apply and the form
 * keeps its built-in defaults.
 *
 * Presets pre-fill the "Add connection" form; every field stays editable and
 * no credentials are ever preset. The endpoint is re-validated here for shape
 * (absolute http/https URL, no embedded credentials); the server additionally
 * screens addresses at startup and on every request.
 */

import { assertConnectionEndpoint } from './s3/endpoint';
import {
  MAX_PRESET_ENDPOINT_LENGTH,
  MAX_PRESET_REGION_LENGTH,
  PRESETS_META_NAME,
} from './server/protocol';

export interface Presets {
  endpoint: string;
  region: string;
  pathStyle: boolean;
}

const NO_PRESETS: Presets = { endpoint: '', region: '', pathStyle: false };

function safeEndpoint(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_PRESET_ENDPOINT_LENGTH) return '';
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return '';
  try {
    assertConnectionEndpoint(trimmed);
    return trimmed;
  } catch {
    return '';
  }
}

/** Parses the meta tag content defensively; anything odd falls back. */
export function presetsFromMetaContent(content: string | null): Presets {
  if (!content) return NO_PRESETS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return NO_PRESETS;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return NO_PRESETS;
  const row = parsed as Record<string, unknown>;
  const rawRegion = typeof row['region'] === 'string' ? row['region'].trim() : '';
  const region = rawRegion.length <= MAX_PRESET_REGION_LENGTH && !/[\u0000-\u001f\u007f]/.test(rawRegion)
    ? rawRegion
    : '';
  return {
    endpoint: safeEndpoint(row['endpoint']),
    region,
    pathStyle: row['pathStyle'] === true,
  };
}

/** Reads the injected meta tag. DOM-free environments get no presets. */
export function readPresets(): Presets {
  if (typeof document === 'undefined') return NO_PRESETS;
  const meta = document.querySelector(`meta[name="${PRESETS_META_NAME}"]`);
  return presetsFromMetaContent(meta?.getAttribute('content') ?? null);
}

export const PRESETS: Presets = readPresets();
