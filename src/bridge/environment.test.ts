import { describe, expect, test } from 'bun:test';
import { isLocalHostname } from './environment';

describe('isLocalHostname', () => {
  test('accepts loopback and localhost names', () => {
    expect(isLocalHostname('localhost')).toBe(true);
    expect(isLocalHostname('LOCALHOST')).toBe(true);
    expect(isLocalHostname('galiot.localhost')).toBe(true);
    expect(isLocalHostname('127.0.0.1')).toBe(true);
    expect(isLocalHostname('127.1.2.3')).toBe(true);
    expect(isLocalHostname('::1')).toBe(true);
    expect(isLocalHostname('[::1]')).toBe(true);
    expect(isLocalHostname('0.0.0.0')).toBe(true);
  });

  test('accepts private LAN addresses and .local names', () => {
    expect(isLocalHostname('192.168.1.10')).toBe(true);
    expect(isLocalHostname('10.1.2.3')).toBe(true);
    expect(isLocalHostname('172.16.0.5')).toBe(true);
    expect(isLocalHostname('172.31.255.254')).toBe(true);
    expect(isLocalHostname('minio.local')).toBe(true);
  });

  test('rejects public hosts and deployment targets', () => {
    expect(isLocalHostname('galiot.example.com')).toBe(false);
    expect(isLocalHostname('galiot.pages.dev')).toBe(false);
    expect(isLocalHostname('acct.r2.cloudflarestorage.com')).toBe(false);
    expect(isLocalHostname('8.8.8.8')).toBe(false);
    expect(isLocalHostname('172.15.0.1')).toBe(false); // just outside RFC1918 172.16/12
    expect(isLocalHostname('172.32.0.1')).toBe(false);
    expect(isLocalHostname('11.0.0.1')).toBe(false);
  });

  test('rejects empty input rather than treating it as local', () => {
    expect(isLocalHostname('')).toBe(false);
    expect(isLocalHostname('   ')).toBe(false);
  });
});
