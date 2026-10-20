import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSsgSupabaseClient: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  getSsgSupabaseClient: mocks.getSsgSupabaseClient,
}));
vi.mock('@nextblock-cms/utils', () => ({
  formatPrice: (amount: number, currencyCode?: string | null) =>
    `${currencyCode || 'USD'} ${amount}`,
  getCurrencyMinorUnitFactor: () => 100,
  majorUnitAmountToMinor: (amount: number) => Math.round(amount * 100),
  minorUnitAmountToMajor: (amount: number) => amount / 100,
  normalizeCurrencyCode: (code?: string | null) => (code || 'USD').trim().toUpperCase(),
}));

import { resolveShippingOptions } from './resolver';

type Row = Record<string, any>;

/** Filter-only PostgREST stand-in: every row is pre-sorted the way the real query orders it. */
function createFakeClient(tables: Record<string, Row[]>) {
  class FakeQuery {
    private filters: Array<(row: Row) => boolean> = [];

    constructor(private readonly table: string) {}

    select() {
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters.push((row) => row[column] === value);
      return this;
    }

    order() {
      return this;
    }

    then(onFulfilled: (value: any) => unknown, onRejected?: (reason: unknown) => unknown) {
      const data = (tables[this.table] || []).filter((row) =>
        this.filters.every((filter) => filter(row))
      );
      return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
    }
  }

  return { from: (table: string) => new FakeQuery(table) };
}

const ZONE_NA = '4026af0e-5752-44fb-b7f7-ba5ac722cadc';
const STANDARD_ID = 'ea112a82-e05c-46bc-a5e7-5bb62528aa5d';
const FREE_ID = '32d473d1-e3d4-4741-a7f5-63d87a387e08';

const tables = {
  currencies: [
    { code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true },
  ],
  shipping_zone_locations: [
    { zone_id: ZONE_NA, country_code: 'US', state_code: null, postal_code: null, shipping_zones: { priority_order: 0 } },
  ],
  shipping_zone_methods: [
    {
      id: STANDARD_ID,
      zone_id: ZONE_NA,
      method_type: 'flat_rate',
      cost_amount: 1500,
      cost_amounts: { USD: 1500 },
      cost_currency: 'USD',
      currency_pricing_mode: 'auto',
      min_order_amount: 0,
      min_order_amounts: { USD: 0 },
      name: 'Standard Shipping',
      name_translations: { fr: 'Livraison standard' },
    },
    {
      id: FREE_ID,
      zone_id: ZONE_NA,
      method_type: 'free_shipping',
      cost_amount: 0,
      cost_amounts: { USD: 0 },
      cost_currency: 'USD',
      currency_pricing_mode: 'auto',
      min_order_amount: 10000,
      min_order_amounts: { USD: 10000 },
      name: 'Free Shipping (Orders over $100)',
      name_translations: null,
    },
  ],
};

describe('resolveShippingOptions (storefront estimate)', () => {
  it('offers only the cheapest method whose threshold the cart meets', async () => {
    mocks.getSsgSupabaseClient.mockReturnValue(createFakeClient(tables));

    await expect(resolveShippingOptions(2000, { country: 'US' }, 'fr', 'USD')).resolves.toEqual([
      { id: STANDARD_ID, name: 'Livraison standard', amount: 1500, currency: 'USD', type: 'flat_rate' },
    ]);

    await expect(resolveShippingOptions(10000, { country: 'US' }, null, 'USD')).resolves.toEqual([
      { id: FREE_ID, name: 'Free Shipping (Orders over $100)', amount: 0, currency: 'USD', type: 'free_shipping' },
    ]);
  });

  it('offers nothing for a destination no zone covers', async () => {
    mocks.getSsgSupabaseClient.mockReturnValue(createFakeClient(tables));

    await expect(resolveShippingOptions(2000, { country: 'JP' })).resolves.toEqual([]);
  });
});
