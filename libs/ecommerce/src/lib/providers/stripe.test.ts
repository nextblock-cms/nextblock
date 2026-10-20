import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

const mocks = vi.hoisted(() => {
  const state: { tables: Tables } = { tables: {} };
  const stripe = {
    customers: {
      list: vi.fn(async () => ({ data: [] })),
      create: vi.fn(async () => ({ id: 'cus_test' })),
      update: vi.fn(async () => ({ id: 'cus_test' })),
    },
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ id: 'cs_test', url: 'https://checkout.stripe.test/cs_test' })),
      },
    },
  };

  function readPath(row: Row, path: string) {
    const nested = path.match(/^(\w+)\((\w+)\)$/);
    return nested ? row[nested[1]]?.[nested[2]] : row[path];
  }

  /** The slice of the PostgREST builder StripeProvider.createCheckoutSession uses. */
  class FakeQuery {
    private filters: Array<(row: Row) => boolean> = [];
    private ordering: { path: string; ascending: boolean } | null = null;
    private pendingUpdate: Row | null = null;
    private inserted: Row[] | null = null;

    constructor(private readonly table: string) {}

    private rows() {
      return (state.tables[this.table] ??= []);
    }

    select() {
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters.push((row) => row[column] === value);
      return this;
    }

    in(column: string, values: unknown[]) {
      const allowed = new Set(values);
      this.filters.push((row) => allowed.has(row[column]));
      return this;
    }

    is(column: string, value: unknown) {
      this.filters.push((row) => (value === null ? row[column] == null : row[column] === value));
      return this;
    }

    or() {
      return this;
    }

    order(path: string, options?: { ascending?: boolean }) {
      this.ordering = { path, ascending: options?.ascending ?? true };
      return this;
    }

    insert(value: Row | Row[]) {
      const rows = (Array.isArray(value) ? value : [value]).map((row, index) => ({
        id: `${this.table}-${this.rows().length + index + 1}`,
        ...row,
      }));
      this.rows().push(...rows);
      this.inserted = rows;
      return this;
    }

    update(value: Row) {
      this.pendingUpdate = value;
      return this;
    }

    maybeSingle() {
      return this.resolve().then((result) => ({ data: result.data[0] ?? null, error: null }));
    }

    single() {
      return this.resolve().then((result) => ({
        data: result.data[0] ?? null,
        error: result.data[0] ? null : { message: `${this.table}: no rows` },
      }));
    }

    then(onFulfilled: (value: any) => unknown, onRejected?: (reason: unknown) => unknown) {
      return this.resolve().then(onFulfilled, onRejected);
    }

    private async resolve(): Promise<{ data: Row[]; error: null }> {
      if (this.inserted) {
        return { data: this.inserted, error: null };
      }

      const matched = this.rows().filter((row) => this.filters.every((filter) => filter(row)));

      if (this.pendingUpdate) {
        for (const row of matched) {
          Object.assign(row, this.pendingUpdate);
        }
      }

      if (this.ordering) {
        const { path, ascending } = this.ordering;
        matched.sort((left, right) => {
          const leftValue = readPath(left, path);
          const rightValue = readPath(right, path);
          const delta =
            typeof leftValue === 'number' && typeof rightValue === 'number'
              ? leftValue - rightValue
              : String(leftValue).localeCompare(String(rightValue));
          return ascending ? delta : -delta;
        });
      }

      return { data: matched, error: null };
    }
  }

  return {
    state,
    stripe,
    createClient: vi.fn(() => ({ from: (table: string) => new FakeQuery(table) })),
  };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('../stripe/client', () => ({ getStripeClient: async () => mocks.stripe }));
vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({}),
  getServiceRoleSupabaseClient: () => ({}),
  getSsgSupabaseClient: () => ({}),
}));
vi.mock('@nextblock-cms/utils', () => ({
  formatPrice: (amount: number, currencyCode?: string | null) =>
    `${currencyCode || 'USD'} ${amount}`,
  getCurrencyMinorUnitFactor: () => 100,
  majorUnitAmountToMinor: (amount: number) => Math.round(amount * 100),
  minorUnitAmountToMajor: (amount: number) => amount / 100,
  normalizeCurrencyCode: (code?: string | null) => (code || 'USD').trim().toUpperCase(),
}));
vi.mock('server-only', () => ({}));

import type { CartItem } from '../types';
import { StripeProvider } from './stripe';

const PRODUCT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ZONE_NA = '4026af0e-5752-44fb-b7f7-ba5ac722cadc';
const ZONE_EU = '5137b01f-6863-55fc-c8f8-cb6bd833dbdd';
const STANDARD_ID = 'ea112a82-e05c-46bc-a5e7-5bb62528aa5d';
const FREE_ID = '32d473d1-e3d4-4741-a7f5-63d87a387e08';
const EU_CHEAP_ID = '7359d231-8a85-77fe-eafa-ed8df055fdff';

function seedTables(): Tables {
  return {
    currencies: [
      { code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true },
    ],
    site_settings: [],
    products: [
      {
        id: PRODUCT_A,
        title: 'Live Product',
        sku: 'SKU-LIVE',
        price: 1000,
        prices: { USD: 1000 },
        sale_price: null,
        sale_prices: {},
        sale_start_at: null,
        sale_end_at: null,
        scheduled_price: null,
        scheduled_prices: {},
        scheduled_price_at: null,
        stock: 50,
        is_taxable: true,
      },
    ],
    product_variants: [],
    inventory_items: [{ sku: 'SKU-LIVE', quantity: 50 }],
    shipping_zone_locations: [
      { zone_id: ZONE_EU, country_code: 'DE', state_code: null, postal_code: null, shipping_zones: { priority_order: 0 } },
      { zone_id: ZONE_NA, country_code: 'US', state_code: null, postal_code: null, shipping_zones: { priority_order: 1 } },
      { zone_id: ZONE_NA, country_code: 'CA', state_code: null, postal_code: null, shipping_zones: { priority_order: 1 } },
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
        name_translations: { fr: 'Livraison gratuite (commandes de plus de 100 $)' },
      },
      {
        id: EU_CHEAP_ID,
        zone_id: ZONE_EU,
        method_type: 'flat_rate',
        cost_amount: 100,
        cost_amounts: { USD: 100 },
        cost_currency: 'USD',
        currency_pricing_mode: 'auto',
        min_order_amount: 0,
        min_order_amounts: { USD: 0 },
        name: 'EU Letter',
        name_translations: null,
      },
    ],
    orders: [],
    order_items: [],
  };
}

const US_ADDRESS = {
  recipient_name: 'Guest Shopper',
  line1: '1 Main St',
  city: 'New York',
  state: 'NY',
  postal_code: '10001',
  country_code: 'US',
};

function cartLine(overrides: Partial<CartItem> & Record<string, unknown> = {}): CartItem {
  return {
    id: PRODUCT_A,
    product_id: PRODUCT_A,
    title: 'Live Product',
    slug: 'live-product',
    sku: 'SKU-LIVE',
    price: 1000,
    language_id: 1,
    translation_group_id: 'g1',
    product_type: 'physical',
    provider: 'stripe',
    quantity: 1,
    ...overrides,
  } as CartItem;
}

function checkout(overrides: Record<string, unknown> = {}) {
  return new StripeProvider().createCheckoutSession({
    items: [cartLine({ quantity: 2 })],
    customerEmail: 'guest@example.test',
    billingAddress: US_ADDRESS,
    shippingAddress: US_ADDRESS,
    shippingMethodId: STANDARD_ID,
    currencyCode: 'USD',
    locale: 'en',
    ...overrides,
  });
}

function sessionLineItems() {
  const call = mocks.stripe.checkout.sessions.create.mock.calls[0] as unknown as [
    { line_items: Array<{ price_data: { unit_amount: number; product_data: { name: string } }; quantity: number }> },
  ];
  return call[0].line_items.map((line) => ({
    name: line.price_data.product_data.name,
    unit_amount: line.price_data.unit_amount,
    quantity: line.quantity,
  }));
}

describe('StripeProvider.createCheckoutSession', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
    mocks.state.tables = seedTables();
    mocks.stripe.checkout.sessions.create.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('guest happy path', () => {
    it('charges the DB cost of the chosen method and records it on the pending order', async () => {
      const result = await checkout();

      expect(result).toEqual({ url: 'https://checkout.stripe.test/cs_test' });
      expect(mocks.state.tables.orders).toHaveLength(1);
      expect(mocks.state.tables.orders[0]).toMatchObject({
        status: 'pending',
        subtotal: 2000,
        shipping_total: 1500,
        total: 3500,
        currency: 'USD',
        provider: 'stripe',
        stripe_session_id: 'cs_test',
      });
      expect(mocks.state.tables.order_items).toEqual([
        expect.objectContaining({ product_id: PRODUCT_A, quantity: 2, price_at_purchase: 1000 }),
      ]);
      expect(sessionLineItems()).toEqual([
        { name: 'Live Product', unit_amount: 1000, quantity: 2 },
        { name: 'Standard Shipping', unit_amount: 1500, quantity: 1 },
      ]);
    });

    it('grants free shipping once the cart meets the threshold', async () => {
      const result = await checkout({ items: [cartLine({ quantity: 10 })], shippingMethodId: FREE_ID });

      expect(result).toEqual({ url: 'https://checkout.stripe.test/cs_test' });
      expect(mocks.state.tables.orders[0]).toMatchObject({ subtotal: 10000, shipping_total: 0, total: 10000 });
      expect(sessionLineItems()).toEqual([{ name: 'Live Product', unit_amount: 1000, quantity: 10 }]);
    });

    it('localizes the shipping line from the DB row, not the request', async () => {
      await checkout({ locale: 'fr' });

      expect(sessionLineItems()[1].name).toBe('Livraison standard');
    });
  });

  describe('shipping method spoofing', () => {
    it.each([
      ['the free-shipping id on a cart below its threshold', FREE_ID],
      ["a method from another zone than the address's", EU_CHEAP_ID],
      ['an id no method has', '99999999-9999-4999-8999-999999999999'],
      ['a malformed id', 'not-a-uuid'],
    ])('rejects %s before any order row or Stripe call', async (_label, shippingMethodId) => {
      const result = await checkout({ shippingMethodId });

      expect(result).toEqual({
        url: null,
        error: 'The selected shipping method is not available for this order.',
        errorKey: 'ecommerce.checkout_invalid_shipping_method',
        errorStatus: 400,
      });
      expect(mocks.state.tables.orders).toEqual([]);
      expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('requires a method when the store offers one for the destination', async () => {
      const result = await checkout({ shippingMethodId: null });

      expect(result).toMatchObject({
        url: null,
        errorKey: 'ecommerce.shipping_method_required',
        errorStatus: 400,
      });
      expect(mocks.state.tables.orders).toEqual([]);
    });

    it('requires a shipping address for a physical cart', async () => {
      const result = await checkout({ shippingAddress: null });

      expect(result).toMatchObject({
        url: null,
        errorKey: 'ecommerce.checkout_shipping_address_required',
        errorStatus: 400,
      });
      expect(mocks.state.tables.orders).toEqual([]);
    });

    it('still checks out, unshipped, where the store offers no method at all', async () => {
      const result = await checkout({
        shippingAddress: { ...US_ADDRESS, state: null, country_code: 'JP' },
        shippingMethodId: null,
      });

      expect(result).toEqual({ url: 'https://checkout.stripe.test/cs_test' });
      expect(mocks.state.tables.orders[0]).toMatchObject({ shipping_total: 0, total: 2000 });
    });
  });

  describe('cart line quantities', () => {
    it.each([
      ['a negative line beside a positive one (the repro)', [cartLine({ quantity: 1 }), cartLine({ quantity: -5 })]],
      ['a zero quantity', [cartLine({ quantity: 0 })]],
      ['a fractional quantity', [cartLine({ quantity: 1.5 })]],
      ['an absurd quantity', [cartLine({ quantity: 1_000_000 })]],
      ['a string quantity', [cartLine({ quantity: '2' as unknown as number })]],
    ])('rejects %s before pricing or inventory', async (_label, items) => {
      const result = await checkout({ items });

      expect(result).toEqual({
        url: null,
        error: 'Your checkout items could not be processed.',
        errorKey: 'ecommerce.checkout_invalid_items',
        errorStatus: 400,
      });
      expect(mocks.state.tables.orders).toEqual([]);
      expect(mocks.state.tables.order_items).toEqual([]);
      expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it('merges duplicate lines into one priced, recorded and charged line', async () => {
      const result = await checkout({ items: [cartLine({ quantity: 1 }), cartLine({ quantity: 2 })] });

      expect(result).toEqual({ url: 'https://checkout.stripe.test/cs_test' });
      expect(mocks.state.tables.order_items).toEqual([
        expect.objectContaining({ product_id: PRODUCT_A, quantity: 3 }),
      ]);
      expect(mocks.state.tables.orders[0]).toMatchObject({ subtotal: 3000, total: 4500 });
      expect(sessionLineItems()[0]).toEqual({ name: 'Live Product', unit_amount: 1000, quantity: 3 });
    });

    it('checks the merged quantity against inventory', async () => {
      const result = await checkout({ items: [cartLine({ quantity: 30 }), cartLine({ quantity: 30 })] });

      expect(result).toMatchObject({ url: null, errorKey: 'ecommerce.inventory_insufficient' });
      expect(mocks.state.tables.orders).toEqual([]);
    });

    it('rejects invalid coupon-context lines the same way', async () => {
      const result = await checkout({
        couponContextItems: [cartLine({ quantity: 2 }), cartLine({ quantity: -2 })],
      });

      expect(result).toMatchObject({ url: null, errorKey: 'ecommerce.checkout_invalid_items', errorStatus: 400 });
      expect(mocks.state.tables.orders).toEqual([]);
    });
  });
});
