import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The FX-rate sync keeps its documented policy: open while CRON_SECRET is unset (a zero-config
 * deploy may run the low-harm sync), otherwise only `Authorization: Bearer <CRON_SECRET>` runs it,
 * compared in constant time and without a minimum length.
 */

const mocks = vi.hoisted(() => ({ sync: vi.fn(), timingSafeEqual: vi.fn() }));

vi.mock('@nextblock-cms/ecommerce/server', () => ({ syncStoreCurrencyRates: mocks.sync }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  mocks.timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, default: actual, timingSafeEqual: mocks.timingSafeEqual };
});

import { GET, runtime } from './route';

const ROUTE_URL = 'https://shop.example.org/api/cron/sync-currencies';

function request(authorization?: string) {
  return new NextRequest(ROUTE_URL, { headers: authorization === undefined ? {} : { authorization } });
}

beforeEach(() => {
  mocks.sync.mockReset();
  mocks.sync.mockResolvedValue({ updated: 2 });
  mocks.timingSafeEqual.mockClear();
  vi.stubEnv('CRON_SECRET', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('FX sync cron route', () => {
  it('runs on Node (the bearer check hashes with node:crypto)', () => {
    expect(runtime).toBe('nodejs');
  });

  it('stays open while CRON_SECRET is unset or blank', async () => {
    for (const secret of ['', '   ']) {
      vi.stubEnv('CRON_SECRET', secret);
      const response = await GET(request());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, updated: 2 });
    }
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });

  it('refuses a missing or wrong bearer once CRON_SECRET is set, without running the sync', async () => {
    vi.stubEnv('CRON_SECRET', 'fx-cron-secret');
    for (const header of [undefined, 'Bearer wrong', 'Bearer fx-cron-secre', 'Bearer fx-cron-secret!', 'Basic fx-cron-secret', 'fx-cron-secret']) {
      const response = await GET(request(header));
      expect(response.status).toBe(401);
    }
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('runs with the right bearer, compared in constant time', async () => {
    vi.stubEnv('CRON_SECRET', 'fx-cron-secret');
    const response = await GET(request('Bearer fx-cron-secret'));
    expect(response.status).toBe(200);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(mocks.timingSafeEqual).toHaveBeenCalled();
  });

  it('keeps a short secret working (no minimum length)', async () => {
    vi.stubEnv('CRON_SECRET', 'abc');
    expect((await GET(request('Bearer abc'))).status).toBe(200);
  });

  // 2026-10-29 fix review: the open route echoed the provider's or the database's error text.
  it('answers a failed sync with a fixed message, never the underlying error text', async () => {
    mocks.sync.mockRejectedValue(new Error('permission denied for table site_settings (relation details)'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to sync currency exchange rates.' });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
