/** Browser-safe constants shared by the app and its server. */
export const S3_HEALTH_PATH = '/api/health';
export const S3_API_PREFIX = '/api/s3';
export const S3_ACCESS_TOKEN_HEADER = 'x-galiot-access-token';
/** Accepted alias for servers and tabs that still send the previous name. */
export const S3_PROXY_TOKEN_HEADER = 'x-galiot-proxy-token';
export const S3_PROXY_PATH = '/api/s3-proxy';
export const S3_PROXY_TARGET_HEADER = 'x-galiot-s3-target';
export const S3_PROXY_DEFAULT_PORT = 8788;

export function isAppApiPath(pathname: string): boolean {
  return pathname === S3_HEALTH_PATH || pathname === S3_API_PREFIX || pathname.startsWith(`${S3_API_PREFIX}/`);
}
