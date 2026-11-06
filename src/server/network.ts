/**
 * How a connection reaches S3.
 *
 * Signed requests are posted to the same-origin proxy, and the Galiot process
 * calls S3. Traffic leaves from the machine running Galiot. Bucket CORS is not
 * required for those calls.
 *
 * The `profiles.network` column still exists so older vaults can be migrated
 * in place. `parseNetwork` ignores a stored `user` value: that route called S3
 * from the browser, and it is no longer used.
 */
export type NetworkRoute = 'server';

export function parseNetwork(_value: unknown): NetworkRoute {
  return 'server';
}
