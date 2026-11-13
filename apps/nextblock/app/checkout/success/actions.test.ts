import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The checkout success page finalizes the order (it is what marks a Stripe order paid when no
 * webhook arrived). After a paid finalization it schedules the affiliate commission sweep, so a
 * partner hears about the commission the database trigger just recorded; nothing else changes.
 */

const ORDER_ID = '77777777-7777-4777-8777-777777777777';

const mocks = vi.hoisted(() => ({
  session: { id: 'cs_1', payment_status: 'paid' } as Record<string, unknown>,
  order: null as Record<string, unknown> | null,
  sessionUser: null as { id: string } | null,
  syncStripeOrderFromSession: vi.fn(),
  verifyOrderAccessToken: vi.fn(),
  scheduleAffiliateCommissionSweep: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        single: async () => (mocks.order ? { data: mocks.order, error: null } : { data: null, error: { message: 'no rows' } }),
      };
      return builder;
    },
  }),
}));
vi.mock('@nextblock-cms/ecommerce/server', () => ({
  applyOrderInventoryDeduction: vi.fn(async () => undefined),
  assignInvoiceMetadata: vi.fn(async () => ({ invoiceNumber: 'INV-1', paidAt: '2026-10-01T00:00:00Z' })),
  getFreemiusOrderLicense: vi.fn(async () => null),
  getInvoicePresentationData: vi.fn(async () => ({ order: { id: ORDER_ID, status: 'paid', items: [] } })),
  getStripeClient: async () => ({ checkout: { sessions: { retrieve: async () => mocks.session } } }),
  syncStripeOrderFromSession: mocks.syncStripeOrderFromSession,
  verifyOrderAccessToken: mocks.verifyOrderAccessToken,
}));
vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: mocks.sessionUser } }) } }),
}));
vi.mock('../../../lib/setup/env-status', () => ({ resolveSupabaseUrl: () => 'http://127.0.0.1:54321' }));
vi.mock('../../../lib/setup/service-key', () => ({ resolveSupabaseServiceKey: () => 'service-role-test-key' }));
vi.mock('../../../lib/affiliates/refunds', () => ({
  scheduleAffiliateCommissionSweep: mocks.scheduleAffiliateCommissionSweep,
}));

import { fulfillOrderAction } from './actions';

beforeEach(() => {
  mocks.session = { id: 'cs_1', payment_status: 'paid' };
  mocks.order = null;
  mocks.sessionUser = null;
  mocks.syncStripeOrderFromSession.mockReset();
  mocks.syncStripeOrderFromSession.mockResolvedValue({ orderId: ORDER_ID, alreadyPaid: false });
  mocks.verifyOrderAccessToken.mockReset();
  mocks.verifyOrderAccessToken.mockReturnValue(false);
  mocks.scheduleAffiliateCommissionSweep.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('fulfillOrderAction commission sweep', () => {
  it('sweeps after a paid Stripe session is synced', async () => {
    const result = await fulfillOrderAction('cs_1');

    expect(result).toMatchObject({ success: true, status: 'paid' });
    expect(mocks.syncStripeOrderFromSession).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleAffiliateCommissionSweep).toHaveBeenCalledTimes(1);
  });

  it('does not sweep while the Stripe payment is pending', async () => {
    mocks.session = { id: 'cs_1', payment_status: 'unpaid' };

    const result = await fulfillOrderAction('cs_1');

    expect(result).toMatchObject({ success: false, errorKey: 'ecommerce.checkout_payment_pending' });
    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });

  it('does not sweep when the Stripe sync fails', async () => {
    mocks.syncStripeOrderFromSession.mockRejectedValue(new Error('Order lookup failed'));

    const result = await fulfillOrderAction('cs_1');

    expect(result).toMatchObject({ success: false, errorKey: 'ecommerce.checkout_internal_server_error' });
    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });

  it('sweeps for a paid Freemius order its buyer may see', async () => {
    mocks.order = { id: ORDER_ID, user_id: null, status: 'paid', provider: 'freemius', paid_at: '2026-10-01T00:00:00Z' };
    mocks.verifyOrderAccessToken.mockReturnValue(true);

    const result = await fulfillOrderAction(ORDER_ID, 'token');

    expect(result).toMatchObject({ success: true, status: 'paid' });
    expect(mocks.scheduleAffiliateCommissionSweep).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a trial', { status: 'trial' }, true],
    ['an order the caller may not see', { status: 'paid' }, false],
  ])('does not sweep for %s', async (_label, overrides, tokenValid) => {
    mocks.order = { id: ORDER_ID, user_id: null, provider: 'freemius', paid_at: null, ...overrides };
    mocks.verifyOrderAccessToken.mockReturnValue(tokenValid);

    await fulfillOrderAction(ORDER_ID, 'token');

    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });
});
