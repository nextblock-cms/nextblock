import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * syncStripeOrderFromSession runs on every settled-session webhook and on every visit of the
 * checkout success page. It must never move a refunded order back to paid (the order would be
 * live again for fulfilment), nor undo a shipment; a pending order still becomes paid.
 */

type Row = Record<string, any>;

const ORDER_ID = '77777777-7777-4777-8777-777777777777';

const mocks = vi.hoisted(() => ({
  order: null as Row | null,
  updates: [] as Row[],
  assignInvoiceMetadata: vi.fn(async () => ({ invoiceNumber: 'INV-1', paidAt: '2026-10-01T00:00:00Z' })),
  applyOrderInventoryDeduction: vi.fn(async () => undefined),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({}),
  getServiceRoleSupabaseClient: () => ({}),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: mocks.order, error: null }),
        update: (values: Row) => {
          mocks.updates.push(values);
          return { eq: async () => ({ error: null }) };
        },
      };
      return builder;
    },
  }),
}));
vi.mock('../invoice-server', () => ({ assignInvoiceMetadata: mocks.assignInvoiceMetadata }));
vi.mock('../order-inventory', () => ({ applyOrderInventoryDeduction: mocks.applyOrderInventoryDeduction }));
vi.mock('../customer-addresses', () => ({ upsertDefaultUserAddresses: vi.fn(async () => undefined) }));
vi.mock('./client', () => ({
  getStripeClient: async () => ({
    checkout: {
      sessions: {
        retrieve: async (id: string) => session(id),
        listLineItems: async () => ({ data: [] }),
      },
    },
  }),
}));

import { syncStripeOrderFromSession } from './order-sync';

function session(id = 'cs_1') {
  return {
    id,
    object: 'checkout.session',
    payment_status: 'paid',
    payment_intent: 'pi_1',
    amount_total: 3500,
    currency: 'usd',
    metadata: { orderId: ORDER_ID },
    customer_details: { email: 'buyer@example.test', name: 'Buyer', phone: null, address: null },
    total_details: { amount_tax: 0, breakdown: { taxes: [] } },
  } as never;
}

function storedOrder(status: string): Row {
  return {
    id: ORDER_ID,
    user_id: null,
    status,
    total: 3500,
    currency: 'USD',
    subtotal: 2000,
    shipping_total: 1500,
    tax_total: 0,
    tax_details: null,
    customer_details: { email: 'buyer@example.test', name: 'Buyer', phone: null, billing: null, shipping: null },
  };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
  mocks.updates = [];
  mocks.assignInvoiceMetadata.mockClear();
  mocks.applyOrderInventoryDeduction.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('syncStripeOrderFromSession status pins', () => {
  it('marks a pending order paid', async () => {
    mocks.order = storedOrder('pending');

    const result = await syncStripeOrderFromSession(session());

    expect(mocks.updates).toHaveLength(1);
    expect(mocks.updates[0]).toMatchObject({ status: 'paid', payment_intent_id: 'pi_1', stripe_session_id: 'cs_1' });
    expect(result).toMatchObject({ orderId: ORDER_ID, alreadyPaid: false });
  });

  it('never moves a refunded order back to paid (a success-page revisit or a replayed webhook)', async () => {
    mocks.order = storedOrder('refunded');

    await syncStripeOrderFromSession(session());

    expect(mocks.updates).toHaveLength(1);
    expect(mocks.updates[0].status).toBe('refunded');
  });

  it('keeps a shipped order shipped', async () => {
    mocks.order = storedOrder('shipped');

    await syncStripeOrderFromSession(session());

    expect(mocks.updates[0].status).toBe('shipped');
  });

  it('keeps a paid order paid and reports it as already paid', async () => {
    mocks.order = storedOrder('paid');

    const result = await syncStripeOrderFromSession(session());

    expect(mocks.updates[0].status).toBe('paid');
    expect(result).toMatchObject({ alreadyPaid: true });
  });
});
