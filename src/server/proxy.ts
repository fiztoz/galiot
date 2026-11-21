/**
 * Listen and target policy for the app server: which address it may bind,
 * which access gate guards it, and which S3 endpoints it may call.
 */

import { S3_PROXY_DEFAULT_PORT } from './protocol.ts';
import { isBlockedProxyHost } from './target.ts';

export { isBlockedProxyHost } from './target.ts';

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** Browser-facing origins of reverse proxies that preserve the public Host header. */
export function publicOrigins(env: NodeJS.ProcessEnv): string[] {
  if (!env.GALIOT_PUBLIC_ORIGINS?.trim()) return [];
  return env.GALIOT_PUBLIC_ORIGINS.split(',').map(entry => {
    try {
      const url = new URL(entry.trim());
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
          url.pathname === '/' && !url.search && !url.hash && !url.hostname.includes('*')) return url.origin;
    } catch { /* report the setting without printing its value */ }
    throw new Error('GALIOT_PUBLIC_ORIGINS must contain comma-separated HTTP(S) origins.');
  });
}

/**
 * Refuses a non-loopback listen unless the operator set a token or explicitly
 * accepted an open signed-request proxy.
 */
export const PROXY_GATE_ENV = 'GALIOT_PROXY_TOKEN';
export const PROXY_OPEN_ENV = 'GALIOT_PROXY_OPEN';
export const PROXY_HOST_ENV = 'GALIOT_HOST';
export const PROXY_PORT_ENV = 'GALIOT_PORT';

/** Below this, a gate exposed to a network is guessable; the health route answers every try. */
export const MIN_GATE_LENGTH = 24;

export function assertBindAllowed(hostname: string, token: string | null, open: boolean): void {
  if (token && token.length < MIN_GATE_LENGTH && !isLoopbackHost(hostname)) {
    console.warn(`The access gate is shorter than ${MIN_GATE_LENGTH} characters. Use a random value, e.g. \`openssl rand -base64 32\`.`);
  }
  if (isLoopbackHost(hostname) || token || open) return;
  throw new Error(
    'Refusing to listen on a non-loopback address without GALIOT_PROXY_TOKEN. Set a token, or set GALIOT_PROXY_OPEN=1 only if you accept an open signed-request proxy.',
  );
}

export function checkProxyTarget(target: string): { ok: true; url: URL } | { ok: false; detail: string } {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, detail: 'Target is not a valid absolute URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, detail: 'Only http and https targets are allowed.' };
  }
  if (url.username || url.password) {
    return { ok: false, detail: 'Targets must not embed credentials.' };
  }
  if (isBlockedProxyHost(url.hostname)) {
    return { ok: false, detail: 'This target address is blocked.' };
  }
  return { ok: true, url };
}

/** Reads listen settings from the environment and refuses an unguarded public bind. */
export function proxyListenConfig(env: NodeJS.ProcessEnv = process.env): {
  hostname: string;
  port: number;
  gate: string | null;
  open: boolean;
} {
  const hostname = env[PROXY_HOST_ENV] || '127.0.0.1';
  const port = Number(env[PROXY_PORT_ENV] || S3_PROXY_DEFAULT_PORT);
  const gate = accessGate(env);
  assertBindAllowed(hostname, gate.token, gate.open);
  return { hostname, port, gate: gate.token, open: gate.open };
}

/** Gate for a non-loopback bind. The previous proxy env names still work. */
export function accessGate(env: NodeJS.ProcessEnv = process.env): { token: string | null; open: boolean } {
  const named = env.GALIOT_GATE?.trim() || env[PROXY_GATE_ENV]?.trim() || null;
  const open = env.GALIOT_GATE_OPEN === '1' || env[PROXY_OPEN_ENV] === '1';
  return { token: named, open };
}
