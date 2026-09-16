import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CurrencyRow = {
  auto_update_exchange_rate: boolean | null;
  exchange_rate_updated_at: string | null;
  is_active: boolean | null;
  is_default: boolean | null;
};

const mocks = vi.hoisted(() => ({
  verifyPackageOnline: vi.fn(),
  syncStoreCurrencyRates: vi.fn(),
  currencies: [] as CurrencyRow[],
}));

vi.mock('server-only', () => ({}));

vi.mock('@nextblock-cms/ecommerce/server', () => ({
  syncStoreCurrencyRates: mocks.syncStoreCurrencyRates,
}));

vi.mock('@nextblock-cms/db/server', () => ({
  verifyPackageOnline: mocks.verifyPackageOnline,
  getServiceRoleSupabaseClient: () => ({
    from: () => ({
      select: async () => ({ data: mocks.currencies, error: null }),
    }),
  }),
}));

import { isCurrencyRefreshDue, maybeSyncCurrencyRates } from './currency-rates-refresh';

const HOUR = 60 * 60_000;
const NOW = Date.parse('2026-09-14T12:00:00Z');

const usd: CurrencyRow = {
  is_default: true,
  is_active: true,
  auto_update_exchange_rate: false,
  exchange_rate_updated_at: null,
};

function eur(agoMs: number | null, overrides: Partial<CurrencyRow> = {}): CurrencyRow {
  return {
    is_default: false,
    is_active: true,
    auto_update_exchange_rate: true,
    exchange_rate_updated_at: agoMs === null ? null : new Date(NOW - agoMs).toISOString(),
    ...overrides,
  };
}

describe('isCurrencyRefreshDue', () => {
  it('is due when an auto-updating currency was never synced', () => {
    expect(isCurrencyRefreshDue([usd, eur(null)], NOW)).toBe(true);
  });

  it('is due when the last sync is older than a day', () => {
    expect(isCurrencyRefreshDue([usd, eur(25 * HOUR)], NOW)).toBe(true);
  });

  it('is not due when the last sync is fresh', () => {
    expect(isCurrencyRefreshDue([usd, eur(2 * HOUR)], NOW)).toBe(false);
  });

  it('ignores the default currency, inactive rows and manual rates', () => {
    expect(
      isCurrencyRefreshDue(
        [usd, eur(null, { is_active: false }), eur(null, { auto_update_exchange_rate: false })],
        NOW
      )
    ).toBe(false);
  });
});

describe('maybeSyncCurrencyRates', () => {
  // The fixtures below are timestamps relative to the fixed NOW, but this function
  // calls isCurrencyRefreshDue WITHOUT a clock argument, so it reads Date.now().
  // Without freezing the clock, "fresh" stops being fresh once real time moves a day
  // past NOW and the suite starts failing on a date rather than on a code change.
  // Only Date is faked; timers are left real so nothing here has to be advanced.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mocks.verifyPackageOnline.mockReset();
    mocks.syncStoreCurrencyRates.mockReset();
    mocks.currencies = [usd, eur(null)];
    mocks.syncStoreCurrencyRates.mockResolvedValue({
      provider: 'frankfurter',
      updatedCurrencies: ['EUR'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing without the ecommerce package', async () => {
    mocks.verifyPackageOnline.mockResolvedValue(false);
    await maybeSyncCurrencyRates();
    expect(mocks.syncStoreCurrencyRates).not.toHaveBeenCalled();
  });

  it('trusts an activation flag passed by the caller', async () => {
    await maybeSyncCurrencyRates(true);
    expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();
    expect(mocks.syncStoreCurrencyRates).toHaveBeenCalledTimes(1);
  });

  it('skips when every rate is fresh', async () => {
    mocks.currencies = [usd, eur(HOUR)];
    await maybeSyncCurrencyRates(true);
    expect(mocks.syncStoreCurrencyRates).not.toHaveBeenCalled();
  });

  it('never throws when the sync fails', async () => {
    mocks.syncStoreCurrencyRates.mockRejectedValue(new Error('provider down'));
    await expect(maybeSyncCurrencyRates(true)).resolves.toBeUndefined();
  });
});
