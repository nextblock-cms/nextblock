import { describe, expect, it, vi } from 'vitest';

vi.mock('@nextblock-cms/utils', () => ({
  formatPrice: (amount: number, currencyCode?: string | null) =>
    `${currencyCode || 'USD'} ${amount}`,
  getCurrencyMinorUnitFactor: () => 100,
  majorUnitAmountToMinor: (amount: number) => Math.round(amount * 100),
  minorUnitAmountToMajor: (amount: number) => amount / 100,
  normalizeCurrencyCode: (code?: string | null) => (code || 'USD').trim().toUpperCase(),
}));

import type { CurrencyRecord } from '../currency';
import {
  listEligibleShippingMethods,
  normalizeShippingDestination,
  resolveCheckoutShippingMethod,
  resolveShippingZoneIdForDestination,
  type ShippingQueryClient,
  type ShippingZoneMethodRow,
} from './checkout-shipping-method';

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

function readPath(row: Row, path: string) {
  const nested = path.match(/^(\w+)\((\w+)\)$/);
  return nested ? row[nested[1]]?.[nested[2]] : row[path];
}

/** Enough of the PostgREST builder for the shipping queries; `failing` tables error. */
function createFakeClient(tables: Tables, failing: string[] = []): ShippingQueryClient {
  class FakeQuery {
    private filters: Array<(row: Row) => boolean> = [];
    private ordering: { path: string; ascending: boolean } | null = null;

    constructor(private readonly table: string) {}

    select() {
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters.push((row) => row[column] === value);
      return this;
    }

    order(path: string, options?: { ascending?: boolean }) {
      this.ordering = { path, ascending: options?.ascending ?? true };
      return this;
    }

    maybeSingle() {
      return this.resolve().then((result) => ({
        data: result.data?.[0] ?? null,
        error: result.error,
      }));
    }

    then(onFulfilled: (value: any) => unknown, onRejected?: (reason: unknown) => unknown) {
      return this.resolve().then(onFulfilled, onRejected);
    }

    private async resolve(): Promise<{ data: Row[] | null; error: { message: string } | null }> {
      if (failing.includes(this.table)) {
        return { data: null, error: { message: `${this.table} unavailable` } };
      }

      const matched = (tables[this.table] || []).filter((row) =>
        this.filters.every((filter) => filter(row))
      );

      if (this.ordering) {
        const { path, ascending } = this.ordering;
        matched.sort((left, right) => {
          const delta = Number(readPath(left, path)) - Number(readPath(right, path));
          return ascending ? delta : -delta;
        });
      }

      return { data: matched, error: null };
    }
  }

  return { from: (table: string) => new FakeQuery(table) } as unknown as ShippingQueryClient;
}

const USD: CurrencyRecord = { code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true };
const CAD: CurrencyRecord = { code: 'CAD', symbol: '$', exchange_rate: 1.35, is_default: false, is_active: true };
const currencies = [USD, CAD];

const ZONE_NA = '4026af0e-5752-44fb-b7f7-ba5ac722cadc';
const ZONE_EU = '5137b01f-6863-55fc-c8f8-cb6bd833dbdd';
const ZONE_TX = '6248c120-7974-66fd-d9f9-dc7ce944ecee';
const STANDARD_ID = 'ea112a82-e05c-46bc-a5e7-5bb62528aa5d';
const FREE_ID = '32d473d1-e3d4-4741-a7f5-63d87a387e08';
const EU_CHEAP_ID = '7359d231-8a85-77fe-eafa-ed8df055fdff';
const MANUAL_ID = '846ae342-9b96-88ff-fbfb-fe9ef166feff';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

function method(overrides: Partial<ShippingZoneMethodRow> & { id: string; zone_id: string }): ShippingZoneMethodRow {
  return {
    method_type: 'flat_rate',
    cost_amount: 0,
    cost_amounts: {},
    cost_currency: 'USD',
    currency_pricing_mode: 'auto',
    min_order_amount: 0,
    min_order_amounts: {},
    name: 'Method',
    name_translations: null,
    ...overrides,
  };
}

function seedTables(): Tables {
  return {
    shipping_zone_locations: [
      { zone_id: ZONE_EU, country_code: 'DE', state_code: null, postal_code: null, shipping_zones: { priority_order: 0 } },
      { zone_id: ZONE_NA, country_code: 'US', state_code: null, postal_code: null, shipping_zones: { priority_order: 1 } },
      { zone_id: ZONE_NA, country_code: 'CA', state_code: null, postal_code: null, shipping_zones: { priority_order: 1 } },
      { zone_id: ZONE_TX, country_code: 'US', state_code: 'TX', postal_code: null, shipping_zones: { priority_order: 2 } },
    ],
    shipping_zone_methods: [
      method({ id: STANDARD_ID, zone_id: ZONE_NA, cost_amount: 1500, cost_amounts: { USD: 1500 }, name: 'Standard Shipping' }),
      method({
        id: FREE_ID,
        zone_id: ZONE_NA,
        method_type: 'free_shipping',
        min_order_amount: 10000,
        min_order_amounts: { USD: 10000 },
        name: 'Free Shipping (Orders over $100)',
        name_translations: { fr: 'Livraison gratuite (commandes de plus de 100 $)' },
      }),
      method({
        id: MANUAL_ID,
        zone_id: ZONE_NA,
        currency_pricing_mode: 'manual',
        cost_amount: 2500,
        cost_amounts: { USD: 2500, CAD: 2999 },
        name: 'Express',
      }),
      method({ id: EU_CHEAP_ID, zone_id: ZONE_EU, cost_amount: 100, cost_amounts: { USD: 100 }, name: 'EU Letter' }),
    ],
  };
}

const US_DESTINATION = { country: 'US', state: 'NY' };

describe('normalizeShippingDestination', () => {
  it('normalizes the country alias and the state name the way the estimate does', () => {
    expect(normalizeShippingDestination({ country: 'usa', state: 'California', postal_code: ' 90210 ' })).toEqual({
      country: 'US',
      state: 'CA',
      postal_code: '90210',
    });
  });

  it('is null without a usable country', () => {
    expect(normalizeShippingDestination({ country: '' })).toBeNull();
    expect(normalizeShippingDestination(null)).toBeNull();
  });
});

describe('resolveShippingZoneIdForDestination', () => {
  it('prefers a state match, then the country-wide zone', async () => {
    const client = createFakeClient(seedTables());

    await expect(resolveShippingZoneIdForDestination(client, { country: 'US', state: 'TX' })).resolves.toEqual({
      zoneId: ZONE_TX,
      error: null,
    });
    await expect(resolveShippingZoneIdForDestination(client, US_DESTINATION)).resolves.toEqual({
      zoneId: ZONE_NA,
      error: null,
    });
  });

  it('is null for a destination no zone covers, and reports a query failure', async () => {
    await expect(
      resolveShippingZoneIdForDestination(createFakeClient(seedTables()), { country: 'JP' })
    ).resolves.toEqual({ zoneId: null, error: null });

    const failed = await resolveShippingZoneIdForDestination(
      createFakeClient(seedTables(), ['shipping_zone_locations']),
      US_DESTINATION
    );
    expect(failed.zoneId).toBeNull();
    expect(failed.error).toBeTruthy();
  });
});

describe('resolveCheckoutShippingMethod', () => {
  const baseParams = {
    destination: US_DESTINATION,
    currencies,
    currencyCode: 'USD',
  };

  it('rejects the free-shipping id on a cart below its threshold (the repro)', async () => {
    const result = await resolveCheckoutShippingMethod(createFakeClient(seedTables()), {
      ...baseParams,
      methodId: FREE_ID,
      cartTotal: 2000,
    });

    expect(result).toEqual({ ok: false, reason: 'threshold_not_met' });
  });

  it('accepts the free-shipping id once the discounted subtotal meets the threshold', async () => {
    const result = await resolveCheckoutShippingMethod(createFakeClient(seedTables()), {
      ...baseParams,
      methodId: FREE_ID,
      cartTotal: 10000,
      languageCode: 'fr',
    });

    expect(result).toEqual({
      ok: true,
      method: {
        id: FREE_ID,
        name: 'Livraison gratuite (commandes de plus de 100 $)',
        amount: 0,
        currency: 'USD',
        type: 'free_shipping',
        zoneId: ZONE_NA,
      },
    });
  });

  it("rejects a method that belongs to another zone than the address's", async () => {
    const result = await resolveCheckoutShippingMethod(createFakeClient(seedTables()), {
      ...baseParams,
      methodId: EU_CHEAP_ID,
      cartTotal: 2000,
    });

    expect(result).toEqual({ ok: false, reason: 'zone_mismatch' });
  });

  it('rejects a destination no zone covers even when the method exists', async () => {
    const result = await resolveCheckoutShippingMethod(createFakeClient(seedTables()), {
      ...baseParams,
      destination: { country: 'JP' },
      methodId: STANDARD_ID,
      cartTotal: 2000,
    });

    expect(result).toEqual({ ok: false, reason: 'zone_mismatch' });
  });

  it.each([
    ['an unknown id', UNKNOWN_ID],
    ['a malformed id', 'not-a-uuid'],
    ['a blank id', '   '],
    ['a non-string id', 42],
  ])('reports %s as not found', async (_label, methodId) => {
    const result = await resolveCheckoutShippingMethod(createFakeClient(seedTables()), {
      ...baseParams,
      methodId,
      cartTotal: 2000,
    });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('prices the method from the DB row in the shopper currency, honouring manual rates', async () => {
    const standard = await resolveCheckoutShippingMethod(createFakeClient(seedTables()), {
      ...baseParams,
      methodId: STANDARD_ID,
      cartTotal: 2000,
    });
    expect(standard.ok && standard.method.amount).toBe(1500);

    const manualInCad = await resolveCheckoutShippingMethod(createFakeClient(seedTables()), {
      ...baseParams,
      currencyCode: 'CAD',
      methodId: MANUAL_ID,
      cartTotal: 2000,
    });
    expect(manualInCad.ok && manualInCad.method).toMatchObject({ amount: 2999, currency: 'CAD' });
  });

  it('distinguishes a failed lookup from a rejected method', async () => {
    const result = await resolveCheckoutShippingMethod(
      createFakeClient(seedTables(), ['shipping_zone_methods']),
      { ...baseParams, methodId: STANDARD_ID, cartTotal: 2000 }
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('load_failed');
  });
});

describe('listEligibleShippingMethods', () => {
  it("returns the destination zone's methods whose threshold the cart meets", async () => {
    const below = await listEligibleShippingMethods(createFakeClient(seedTables()), {
      destination: US_DESTINATION,
      cartTotal: 2000,
      currencies,
      currencyCode: 'USD',
    });
    expect(below.ok && below.methods.map((m) => m.id).sort()).toEqual([MANUAL_ID, STANDARD_ID].sort());

    const above = await listEligibleShippingMethods(createFakeClient(seedTables()), {
      destination: US_DESTINATION,
      cartTotal: 12000,
      currencies,
      currencyCode: 'USD',
    });
    expect(above.ok && above.methods.map((m) => m.id).sort()).toEqual([FREE_ID, MANUAL_ID, STANDARD_ID].sort());
  });

  it('is empty, not an error, when no zone covers the destination', async () => {
    await expect(
      listEligibleShippingMethods(createFakeClient(seedTables()), {
        destination: { country: 'JP' },
        cartTotal: 2000,
        currencies,
        currencyCode: 'USD',
      })
    ).resolves.toEqual({ ok: true, zoneId: null, methods: [] });
  });
});
