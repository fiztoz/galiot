/** Browser-safe constants shared by the app and its server. */
export const S3_HEALTH_PATH = '/api/health';
export const S3_API_PREFIX = '/api/s3';
export const S3_ACCESS_TOKEN_HEADER = 'x-galiot-access-token';
/** Accepted alias for servers and tabs that still send the previous name. */
export const S3_PROXY_TOKEN_HEADER = 'x-galiot-proxy-token';
export const S3_PROXY_DEFAULT_PORT = 8788;

/** Deployment branding (white-label). The server injects these into the shell. */
export const BRANDING_META_NAME = 'galiot-branding';
export const BRANDING_LOGO_PATH = '/branding/logo';
export const DEFAULT_BRAND_NAME = 'Galiot';
export const DEFAULT_BRAND_TAGLINE = 'The Agile Cloud Explorer';
export const DEFAULT_LOGO_URL = '/favicon.svg';
export const MAX_BRAND_NAME_LENGTH = 64;
export const MAX_BRAND_TAGLINE_LENGTH = 96;

/** Preset connection defaults for company deployments (no credentials). */
export const PRESETS_META_NAME = 'galiot-presets';
export const MAX_PRESET_ENDPOINT_LENGTH = 2048;
export const MAX_PRESET_REGION_LENGTH = 64;

export function isAppApiPath(pathname: string): boolean {
  return pathname === S3_HEALTH_PATH || pathname === S3_API_PREFIX || pathname.startsWith(`${S3_API_PREFIX}/`);
}
