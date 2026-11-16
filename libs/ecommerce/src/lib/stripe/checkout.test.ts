import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Checkout Session id between checkout, the success page and the webhook.
 *
 * The NextBlock checkout success page asks Stripe about a session only once an order stores its id
 * in `orders.stripe_session_id` (app/checkout/success/actions.ts), so a forged `cs_` id never spends
 * the operator's Stripe rate limit. Checkout therefore hands out a session's URL only once its order
 * took the id: a session the order could not record is expired, the order fails, and the caller gets
 * the keyed 503 (until this check the write was not even checked here, so a buyer could pay a
 * session the success page then answered with "Order not found"). The app checks out through
 * `providers/stripe.ts` (same rule, `providers/stripe.test.ts`); this standalone helper is exported
 * from `@nextblock-cms/ecommerce/server` for projects that call it themselves.
 *
 * The webhook path is unchanged: `syncStripeOrderFromSession` finds the order through the session's
 * `metadata.orderId` first, so a session whose id no order stores (one created before this release
 * whose write failed) is still settled, and only then falls back to the stored id.
 */

type Row = Record<string, any>;

/** How an update can fail: a PostgREST error, a filter that matched no row, or a request that rejects. */
type UpdateFailure = Record<string, unknown> | 'no-rows' | Error;

const SESSION_ID = 'cs_test_standaloneSession0000000000000000000000000000000000000';
const SESSION_URL = `https://checkout.stripe.test/${SESSION_ID}`;
const PRODUCT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORDER_ID = '77777777-7777-4777-8777-777777777777';

const mocks = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, Row[]>,
    /** The Checkout Sessions Stripe knows, by id (what `retrieve` answers). */
    sessions: {} as Record<string, Row>,
    /** Fail an update (no row changes): return how, or null to let it through. */
    failUpdate: null as ((table: string, values: Row) => UpdateFailure | null) | null,
  };

  const stripe = {
    checkout: {
      sessions: {
        create: vi.fn<(params: Row) => Promise<{ id: string; url: string }>>(async () => ({ id: '', url: '' })),
        expire: vi.fn(async (id: string) => ({ id, status: 'expired' })),
        retrieve: vi.fn(async (id: string) => state.sessions[id]),
        listLineItems: vi.fn(async () => ({ data: [] })),
      },
    },
  };

  /** The slice of the PostgREST builder the helper and the webhook sync use; lazy like the real one. */
  class FakeQuery {
    private filters: Array<(row: Row) => boolean> = [];
    private inserted: Row[] | null = null;
    private pendingUpdate: Row | null = null;
    private updateFailure: UpdateFailure | null = null;
    private mode: 'many' | 'single' | 'maybeSingle' = 'many';

    constructor(private readonly table: string) {}

    private rows() {
      return (state.tables[this.table] ??= []);
    }

    select() {
      return this;
    }

    order() {
      return this;
    }

    limit() {
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

    insert(value: Row | Row[]) {
      const rows = (Array.isArray(value) ? value : [value]).map((row, index) => ({
        id: this.table === 'orders' ? ORDER_ID : `${this.table}-${this.rows().length + index + 1}`,
        ...row,
      }));
      this.rows().push(...rows);
      this.inserted = rows;
      return this;
    }

    update(values: Row) {
      this.pendingUpdate = values;
      this.updateFailure = state.failUpdate?.(this.table, values) ?? null;
      return this;
    }

    single() {
      this.mode = 'single';
      return this;
    }

    maybeSingle() {
      this.mode = 'maybeSingle';
      return this;
    }

    then(onFulfilled: (value: any) => unknown, onRejected?: (reason: unknown) => unknown) {
      return this.run().then(onFulfilled, onRejected);
    }

    private async run(): Promise<{ data: unknown; error: Record<string, unknown> | null }> {
      let data: Row[] | null;
      let error: Record<string, unknown> | null = null;

      if (this.inserted) {
        data = this.inserted;
      } else if (this.pendingUpdate && this.updateFailure) {
        if (this.updateFailure instanceof Error) {
          throw this.updateFailure;
        }

        if (this.updateFailure === 'no-rows') {
          data = [];
        } else {
          data = null;
          error = this.updateFailure;
        }
      } else {
        data = this.rows().filter((row) => this.filters.every((filter) => filter(row)));

        if (this.pendingUpdate) {
          for (const row of data) {
            Object.assign(row, this.pendingUpdate);
          }
        }
      }

      if (this.mode === 'many') {
        return { data, error };
      }

      const first = data?.[0] ?? null;

      if (this.mode === 'maybeSingle' || first) {
        return { data: first, error };
      }

      return { data: null, error: error ?? { message: `${this.table}: no rows` } };
    }
  }

  return {
    state,
    stripe,
    createClient: vi.fn(() => ({ from: (table: string) => new FakeQuery(table) })),
    assignInvoiceMetadata: vi.fn(async () => ({ invoiceNumber: 'INV-1', paidAt: '2026-11-14T00:00:00Z' })),
    applyOrderInventoryDeduction: vi.fn(async () => undefined),
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('./client', () => ({ getStripeClient: async () => mocks.stripe }));
vi.mock('@nextblock-cms/db/server', () => ({ verifyPackageOnline: async () => true }));
vi.mock('../shipping/resolver', () => ({ resolveShippingOptions: async () => [] }));
// The webhook sync's own collaborators: invoice numbering and inventory are not what this file pins.
vi.mock('../invoice-server', () => ({ assignInvoiceMetadata: mocks.assignInvoiceMetadata }));
vi.mock('../order-inventory', () => ({ applyOrderInventoryDeduction: mocks.applyOrderInventoryDeduction }));
vi.mock('../customer-addresses', () => ({ upsertDefaultUserAddresses: vi.fn(async () => undefined) }));

import type { CartItem } from '../types';
import { createCheckoutSession } from './checkout';
import { syncStripeOrderFromSession } from './order-sync';

const PAYMENTS_UNAVAILABLE = {
  url: null,
  error: 'This store is not able to take payments right now. Please contact the seller to complete your purchase.',
  errorKey: 'ecommerce.checkout_payments_unavailable',
  errorStatus: 503,
};

function seedTables(): Record<string, Row[]> {
  return {
    currencies: [{ code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true }],
    products: [
      {
        id: PRODUCT_ID,
        title: 'Live Product',
        price: 1000,
        prices: { USD: 1000 },
        sale_price: null,
        sale_prices: {},
        sale_start_at: null,
        sale_end_at: null,
        scheduled_price: null,
        scheduled_prices: {},
        scheduled_price_at: null,
      },
    ],
    orders: [],
    order_items: [],
  };
}

function checkout() {
  const items = [{ id: PRODUCT_ID, product_id: PRODUCT_ID, title: 'Live Product', price: 1000, quantity: 2 }];
  return createCheckoutSession(items as unknown as CartItem[], undefined, { country: 'US', state: 'NY', postal_code: '10001' });
}

/** Fail only the write of the session id onto the order; every other write goes through. */
function failSessionIdWrite(failure: UpdateFailure) {
  mocks.state.failUpdate = (table, values) => (table === 'orders' && 'stripe_session_id' in values ? failure : null);
}

/** The success page's lookup: the order that stores this session id. */
function orderStoringSession(sessionId: string) {
  return mocks.state.tables.orders.find((row) => row.stripe_session_id === sessionId) ?? null;
}

/** A session Stripe reports as paid, as the webhook and the success page receive it. */
function paidSession(id: string, metadata: Record<string, string>) {
  const session = {
    id,
    object: 'checkout.session',
    payment_status: 'paid',
    payment_intent: 'pi_paid',
    amount_total: 2000,
    currency: 'usd',
    metadata,
    customer_details: { email: 'buyer@example.test', name: 'Buyer', phone: null, address: null },
    total_details: { amount_tax: 0, breakdown: { taxes: [] } },
  };
  mocks.state.sessions[id] = session;
  return session as never;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
  mocks.state.tables = seedTables();
  mocks.state.sessions = {};
  mocks.state.failUpdate = null;
  mocks.stripe.checkout.sessions.create.mockReset().mockImplementation(async () => ({ id: SESSION_ID, url: SESSION_URL }));
  mocks.stripe.checkout.sessions.expire.mockReset().mockImplementation(async (id: string) => ({ id, status: 'expired' }));
  mocks.stripe.checkout.sessions.retrieve.mockClear();
  mocks.assignInvoiceMetadata.mockClear();
  mocks.applyOrderInventoryDeduction.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('createCheckoutSession (the standalone Stripe helper)', () => {
  it('hands out the URL once the order the session names stores its id, the row the success page finds', async () => {
    const result = await checkout();

    expect(result).toEqual({ url: SESSION_URL });
    expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { orderId: ORDER_ID } })
    );
    expect(orderStoringSession(SESSION_ID)).toMatchObject({ id: ORDER_ID, total: 2000 });
    expect(mocks.stripe.checkout.sessions.expire).not.toHaveBeenCalled();
  });

  it.each<[string, UpdateFailure]>([
    ['the database refuses the write', { code: '57014', message: 'canceling statement due to statement timeout' }],
    ['the write matches no order row', 'no-rows'],
    ['the request itself fails', new TypeError('fetch failed')],
  ])('expires the session and answers the keyed 503, never the URL, when %s', async (_label, failure) => {
    failSessionIdWrite(failure);

    const result = await checkout();

    expect(result).toEqual(PAYMENTS_UNAVAILABLE);
    expect(JSON.stringify(result)).not.toContain('checkout.stripe.test');
    expect(mocks.stripe.checkout.sessions.expire).toHaveBeenCalledTimes(1);
    expect(mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(SESSION_ID);
    // Nothing is marked paid: the order fails, and no order names the session.
    expect(mocks.state.tables.orders).toHaveLength(1);
    expect(mocks.state.tables.orders[0]).toMatchObject({ id: ORDER_ID, status: 'failed' });
    expect(mocks.state.tables.orders[0]).not.toHaveProperty('paid_at');
    expect(orderStoringSession(SESSION_ID)).toBeNull();
  });

  it('still withholds the URL when Stripe refuses to expire the session too', async () => {
    failSessionIdWrite({ code: '57014', message: 'canceling statement due to statement timeout' });
    mocks.stripe.checkout.sessions.expire.mockRejectedValueOnce(new Error('Stripe is unreachable'));

    const result = await checkout();

    expect(result).toEqual(PAYMENTS_UNAVAILABLE);
    expect(mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(SESSION_ID);
    expect(mocks.state.tables.orders[0].status).toBe('failed');
  });
});

describe('syncStripeOrderFromSession (the webhook path) is unchanged', () => {
  it('settles the order checkout recorded the session on', async () => {
    expect(await checkout()).toEqual({ url: SESSION_URL });

    const result = await syncStripeOrderFromSession(paidSession(SESSION_ID, { orderId: ORDER_ID }));

    expect(result).toMatchObject({ orderId: ORDER_ID, alreadyPaid: false });
    expect(mocks.state.tables.orders[0]).toMatchObject({
      id: ORDER_ID,
      status: 'paid',
      stripe_session_id: SESSION_ID,
      payment_intent_id: 'pi_paid',
    });
  });

  it('finds the order through the session metadata even when no order stores the session id', async () => {
    // A session created before this release whose id write failed: the webhook still settles it,
    // and records the id the success page looks up.
    mocks.state.tables.orders = [{ id: ORDER_ID, status: 'pending', stripe_session_id: null, total: 2000, currency: 'USD' }];
    const sessionId = 'cs_live_inFlightBeforeTheUpgrade000000000000000000000000000000000';

    const result = await syncStripeOrderFromSession(paidSession(sessionId, { orderId: ORDER_ID }));

    expect(result).toMatchObject({ orderId: ORDER_ID, alreadyPaid: false });
    expect(mocks.state.tables.orders[0]).toMatchObject({ status: 'paid', stripe_session_id: sessionId });
    expect(mocks.applyOrderInventoryDeduction).toHaveBeenCalledWith(expect.anything(), ORDER_ID);
  });

  it('falls back to the stored session id when the session carries no order id', async () => {
    mocks.state.tables.orders = [{ id: ORDER_ID, status: 'pending', stripe_session_id: SESSION_ID, total: 2000, currency: 'USD' }];

    const result = await syncStripeOrderFromSession(paidSession(SESSION_ID, {}));

    expect(result).toMatchObject({ orderId: ORDER_ID });
    expect(mocks.state.tables.orders[0]).toMatchObject({ status: 'paid', stripe_session_id: SESSION_ID });
  });
});
