import { describe, expect, test } from 'bun:test';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { s3ProxyPlugin } from './vite';

function attach(plugin: Plugin, preview: boolean, host: string | boolean | undefined): boolean {
  let attached = false;
  const server = {
    config: { server: { host }, preview: { host } },
    middlewares: { use() { attached = true; } },
  };
  const hook = preview ? plugin.configurePreviewServer : plugin.configureServer;
  if (typeof hook !== 'function') throw new Error('Missing Vite configuration hook');
  hook.call({} as never, server as unknown as ViteDevServer & PreviewServer);
  return attached;
}

describe('Vite public proxy gate', () => {
  for (const preview of [false, true]) {
    test(`${preview ? 'preview' : 'dev'} requires a gate on every public host form`, () => {
      for (const host of [true, '', '0.0.0.0', '::', '10.0.0.5', 's3.example.com']) {
        expect(() => attach(s3ProxyPlugin({}), preview, host)).toThrow('GALIOT_PROXY_TOKEN');
        expect(attach(s3ProxyPlugin({ GALIOT_PROXY_TOKEN: 'alpha-gate' }), preview, host)).toBe(true);
        expect(attach(s3ProxyPlugin({ GALIOT_PROXY_OPEN: '1' }), preview, host)).toBe(true);
      }
      expect(() => attach(s3ProxyPlugin({ GALIOT_PROXY_TOKEN: '  ' }), preview, true)).toThrow();
    });
    test(`${preview ? 'preview' : 'dev'} allows Vite's loopback defaults`, () => {
      for (const host of [undefined, false, 'localhost', '127.0.0.1', '::1']) {
        expect(attach(s3ProxyPlugin({}), preview, host)).toBe(true);
      }
    });
  }
});
