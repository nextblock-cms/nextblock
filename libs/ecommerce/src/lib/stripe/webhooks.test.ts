import { beforeEach, describe, expect, it, vi } from 'vitest';

const syncStripeOrderFromSession = vi.fn(async () => undefined);
let nextEvent: { type: string; data: { object: Record<string, unknown> } };

vi.mock('server-only', () => ({}));
vi.mock('./order-sync', () => ({ syncStripeOrderFromSession: (...args: unknown[]) => syncStripeOrderFromSession(...(args as [])) }));
vi.mock('../payment-config', () => ({ resolveStripeWebhookSecret: async () => 'whsec_test' }));
vi.mock('./client', () => ({
  getStripeClient: async () => ({ webhooks: { constructEvent: () => nextEvent } }),
}));

import { handleStripeWebhook, isStripeSessionSettled } from './webhooks';

function event(type: string, payment_status: string) {
  return { type, data: { object: { id: 'cs_1', payment_status } } };
}

describe('Stripe webhook marks an order paid only once the money arrives', () => {
  beforeEach(() => syncStripeOrderFromSession.mockClear());

  it('knows which payment statuses are settled', () => {
    expect(isStripeSessionSettled({ payment_status: 'paid' })).toBe(true);
    expect(isStripeSessionSettled({ payment_status: 'no_payment_required' })).toBe(true);
    expect(isStripeSessionSettled({ payment_status: 'unpaid' })).toBe(false);
  });

  it('syncs a completed, paid session', async () => {
    nextEvent = event('checkout.session.completed', 'paid');
    expect(await handleStripeWebhook('sig', '{}')).toEqual({ received: true });
    expect(syncStripeOrderFromSession).toHaveBeenCalledTimes(1);
  });

  it('does not sync a completed session paid by a delayed method that has not settled', async () => {
    nextEvent = event('checkout.session.completed', 'unpaid');
    expect(await handleStripeWebhook('sig', '{}')).toEqual({ received: true });
    expect(syncStripeOrderFromSession).not.toHaveBeenCalled();
  });

  it('syncs when the delayed payment succeeds, never when it fails', async () => {
    nextEvent = event('checkout.session.async_payment_succeeded', 'paid');
    await handleStripeWebhook('sig', '{}');
    expect(syncStripeOrderFromSession).toHaveBeenCalledTimes(1);
    nextEvent = event('checkout.session.async_payment_failed', 'unpaid');
    await handleStripeWebhook('sig', '{}');
    expect(syncStripeOrderFromSession).toHaveBeenCalledTimes(1);
  });
});
