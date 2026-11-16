import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVendorAdmission, resolveVendorClientNetwork, type VendorLimit } from './vendor-route-limits';

/**
 * The admission gate and the address reading the vendor routes share (claim-license,
 * provision-trial; review 2026-11-13). The routes' own tests drive both through real requests; this
 * covers what a route cannot reach in a test: a scope whose map is full.
 */

const MINUTE: VendorLimit = { max: 3, windowMs: 60_000 };
const T0 = Date.parse('2026-11-13T12:00:00Z');

function request(headers: Record<string, string>) {
  return new Request('https://nextblock.dev/api/packages/claim-license', { method: 'POST', headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('createVendorAdmission', () => {
  it('counts a request against every check only when all of them admit it', () => {
    const admit = createVendorAdmission({ instance: { max: 100, windowMs: 60_000 }, instanceRefusalLine: 'busy', maxBucketsPerScope: 100 });
    const checks = (network: string, email: string) => [
      { scope: 'network', key: network, limit: MINUTE },
      { scope: 'email', key: email, limit: { max: 1, windowMs: 60_000 } },
    ];

    expect(admit(checks('net-a', 'one@example.com'), T0)).toEqual({ admitted: true });
    // The email is spent: refused, and net-a's count does not move.
    expect(admit(checks('net-a', 'one@example.com'), T0)).toEqual({ admitted: false, refusedBy: 'email', retryAfterSeconds: 60 });
    expect(admit(checks('net-a', 'one@example.com'), T0)).toMatchObject({ refusedBy: 'email' });
    expect(admit(checks('net-a', 'two@example.com'), T0)).toEqual({ admitted: true });
    expect(admit(checks('net-a', 'three@example.com'), T0)).toEqual({ admitted: true });
    expect(admit(checks('net-a', 'four@example.com'), T0 + 30_000)).toEqual({ admitted: false, refusedBy: 'network', retryAfterSeconds: 30 });
    expect(admit(checks('net-a', 'four@example.com'), T0 + 60_000)).toEqual({ admitted: true });
  });

  it('refuses new keys in a scope whose map is full, keeps serving the keys it holds, and frees room as buckets expire', () => {
    const admit = createVendorAdmission({ instance: { max: 1_000, windowMs: 60_000 }, instanceRefusalLine: 'busy', maxBucketsPerScope: 3 });
    const check = (key: string) => [{ scope: 'network', key, limit: MINUTE }];

    for (const key of ['a', 'b', 'c']) expect(admit(check(key), T0)).toEqual({ admitted: true });
    expect(admit(check('d'), T0)).toEqual({ admitted: false, refusedBy: 'network', retryAfterSeconds: 60 });
    expect(admit(check('a'), T0)).toEqual({ admitted: true });
    expect(admit(check('d'), T0 + 60_000)).toEqual({ admitted: true });
  });

  it('caps the instance across keys, logs one line per window while it refuses, and resets with the window', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const admit = createVendorAdmission({ instance: { max: 2, windowMs: 60_000 }, instanceRefusalLine: '[test] instance cap', maxBucketsPerScope: 100 });
    const check = (key: string) => [{ scope: 'network', key, limit: MINUTE }];

    expect(admit(check('a'), T0)).toEqual({ admitted: true });
    expect(admit(check('b'), T0 + 1_000)).toEqual({ admitted: true });
    expect(admit(check('c'), T0 + 2_000)).toEqual({ admitted: false, refusedBy: 'instance', retryAfterSeconds: 58 });
    expect(admit(check('d'), T0 + 3_000)).toMatchObject({ refusedBy: 'instance' });
    expect(warn.mock.calls).toEqual([['[test] instance cap']]);

    expect(admit(check('c'), T0 + 60_000)).toEqual({ admitted: true });
    admit(check('e'), T0 + 61_000);
    expect(admit(check('f'), T0 + 62_000)).toMatchObject({ refusedBy: 'instance' });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('resolveVendorClientNetwork', () => {
  it('masks to the IPv4 /24 and the IPv6 /48, whatever the spelling', () => {
    expect(resolveVendorClientNetwork(request({ 'x-real-ip': '203.0.113.77' }))).toBe('203.0.113.0/24');
    expect(resolveVendorClientNetwork(request({ 'x-real-ip': '::ffff:203.0.113.77' }))).toBe('203.0.113.0/24');
    expect(resolveVendorClientNetwork(request({ 'x-real-ip': '2001:db8:abcd:12::1' }))).toBe('2001:db8:abcd::/48');
    expect(resolveVendorClientNetwork(request({ 'x-real-ip': '[2001:0DB8:ABCD:ffff::9]:443' }))).toBe('2001:db8:abcd::/48');
    expect(resolveVendorClientNetwork(request({ 'x-real-ip': 'garbage' }))).toBe('unknown');
    expect(resolveVendorClientNetwork(request({}))).toBe('unknown');
  });

  it('reads x-vercel-forwarded-for only when VERCEL=1, then x-real-ip, then the first x-forwarded-for hop, never cf-connecting-ip', () => {
    const headers = {
      'cf-connecting-ip': '192.0.2.1',
      'x-forwarded-for': '198.51.100.7, 10.0.0.1',
      'x-real-ip': '203.0.113.5',
      'x-vercel-forwarded-for': '2001:db8:1::5',
    };

    vi.stubEnv('VERCEL', '');
    expect(resolveVendorClientNetwork(request(headers))).toBe('203.0.113.0/24');
    expect(resolveVendorClientNetwork(request({ ...headers, 'x-real-ip': '' }))).toBe('198.51.100.0/24');
    expect(resolveVendorClientNetwork(request({ 'cf-connecting-ip': '192.0.2.1' }))).toBe('unknown');

    vi.stubEnv('VERCEL', '1');
    expect(resolveVendorClientNetwork(request(headers))).toBe('2001:db8:1::/48');
  });
});
