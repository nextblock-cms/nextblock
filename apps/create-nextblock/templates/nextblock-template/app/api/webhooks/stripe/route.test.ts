import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Stripe webhook route: the lib verifies the signature and syncs settled sessions; the route
 * then applies refunds and lost disputes (orders + affiliate commissions), holds the commission
 * of a disputed order and releases it when the dispute closes without loss, and schedules the
 * commission sweep after a paid order or a refund. A failed refund or dispute answers 5xx so
 * Stripe redelivers; anything the lib refused stays a 400 as before.
 */

const mocks = vi.hoisted(() => ({
  handleStripeWebhook: vi.fn(),
  handleStripeRefundWebhookEvent: vi.fn(),
  handleStripeDisputeWebhookEvent: vi.fn(),
  scheduleAffiliateCommissionSweep: vi.fn(),
}));

vi.mock('@nextblock-cms/ecommerce/server', () => ({
  handleStripeWebhook: mocks.handleStripeWebhook,
  isStripeRefundEventType: (type: unknown) => type === 'charge.refunded' || type === 'charge.dispute.closed',
  isStripeDisputeEventType: (type: unknown) => type === 'charge.dispute.created',
  isStripeSettledCheckoutEvent: (event: { type: string; data: { object: { payment_status?: string } } }) =>
    (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') &&
    event.data.object.payment_status === 'paid',
}));
vi.mock('../../../../lib/affiliates/refunds', () => ({
  handleStripeRefundWebhookEvent: mocks.handleStripeRefundWebhookEvent,
  handleStripeDisputeWebhookEvent: mocks.handleStripeDisputeWebhookEvent,
  scheduleAffiliateCommissionSweep: mocks.scheduleAffiliateCommissionSweep,
}));

import { POST } from './route';

function stripeEvent(type: string, object: Record<string, unknown> = {}) {
  return { id: 'evt_1', type, data: { object } };
}

async function post(signature: string | null = 't=1,v1=abc') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signature) headers['stripe-signature'] = signature;
  const response = await POST(new Request('http://localhost:4200/api/webhooks/stripe', { method: 'POST', headers, body: '{"id":"evt_1"}' }));
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  mocks.handleStripeWebhook.mockReset();
  mocks.handleStripeRefundWebhookEvent.mockReset();
  mocks.handleStripeDisputeWebhookEvent.mockReset();
  mocks.handleStripeDisputeWebhookEvent.mockResolvedValue({ handled: false, orderId: null, open: false, affiliate: 'skipped' });
  mocks.scheduleAffiliateCommissionSweep.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('POST /api/webhooks/stripe', () => {
  it('refuses a request without a signature before anything runs', async () => {
    const { status } = await post(null);

    expect(status).toBe(400);
    expect(mocks.handleStripeWebhook).not.toHaveBeenCalled();
  });

  it('verifies the raw body and answers 400 when the lib refuses it, applying nothing', async () => {
    mocks.handleStripeWebhook.mockResolvedValue({ received: false, error: 'Webhook Error: bad signature' });

    const { status } = await post();

    expect(status).toBe(400);
    expect(mocks.handleStripeWebhook).toHaveBeenCalledWith('t=1,v1=abc', Buffer.from('{"id":"evt_1"}'));
    expect(mocks.handleStripeRefundWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });

  it('applies a refund and schedules the commission sweep', async () => {
    const event = stripeEvent('charge.refunded', { id: 'ch_1', amount: 10000, amount_refunded: 2500 });
    mocks.handleStripeWebhook.mockResolvedValue({ received: true, event });
    mocks.handleStripeRefundWebhookEvent.mockResolvedValue({ handled: true, orderId: 'o1', full: false, orderStatusUpdated: false, affiliate: 'adjusted' });

    const { status, body } = await post();

    expect(status).toBe(200);
    expect(body).toEqual({ received: true });
    expect(mocks.handleStripeRefundWebhookEvent).toHaveBeenCalledWith(event);
    expect(mocks.scheduleAffiliateCommissionSweep).toHaveBeenCalledTimes(1);
  });

  it('applies a lost dispute the same way', async () => {
    const event = stripeEvent('charge.dispute.closed', { id: 'dp_1', status: 'lost' });
    mocks.handleStripeWebhook.mockResolvedValue({ received: true, event });
    mocks.handleStripeRefundWebhookEvent.mockResolvedValue({ handled: true, orderId: 'o1', full: true, orderStatusUpdated: true, affiliate: 'voided' });

    await post();

    expect(mocks.handleStripeRefundWebhookEvent).toHaveBeenCalledWith(event);
  });

  it('acknowledges a refund that matches no order without a sweep', async () => {
    mocks.handleStripeWebhook.mockResolvedValue({ received: true, event: stripeEvent('charge.refunded') });
    mocks.handleStripeRefundWebhookEvent.mockResolvedValue({ handled: false, orderId: null, full: false, orderStatusUpdated: false, affiliate: 'skipped' });

    const { status } = await post();

    expect(status).toBe(200);
    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });

  it('answers 500 when refund handling fails, so Stripe redelivers', async () => {
    mocks.handleStripeWebhook.mockResolvedValue({ received: true, event: stripeEvent('charge.refunded') });
    mocks.handleStripeRefundWebhookEvent.mockRejectedValue(new Error('deadlock detected'));

    const { status, body } = await post();

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Refund or dispute handling failed' });
    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });

  it('holds the commission of a disputed order without refunding anything', async () => {
    const event = stripeEvent('charge.dispute.created', { id: 'dp_1', status: 'needs_response' });
    mocks.handleStripeWebhook.mockResolvedValue({ received: true, event });
    mocks.handleStripeDisputeWebhookEvent.mockResolvedValue({ handled: true, orderId: 'o1', open: true, affiliate: 'held' });

    const { status, body } = await post();

    expect(status).toBe(200);
    expect(body).toEqual({ received: true });
    expect(mocks.handleStripeDisputeWebhookEvent).toHaveBeenCalledWith(event);
    expect(mocks.handleStripeRefundWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });

  it('releases the hold of a dispute closed without loss (and asks the refund path, which applies nothing)', async () => {
    const event = stripeEvent('charge.dispute.closed', { id: 'dp_1', status: 'won' });
    mocks.handleStripeWebhook.mockResolvedValue({ received: true, event });
    mocks.handleStripeRefundWebhookEvent.mockResolvedValue({ handled: false, orderId: null, full: false, orderStatusUpdated: false, affiliate: 'skipped' });
    mocks.handleStripeDisputeWebhookEvent.mockResolvedValue({ handled: true, orderId: 'o1', open: false, affiliate: 'released' });

    const { status } = await post();

    expect(status).toBe(200);
    expect(mocks.handleStripeRefundWebhookEvent).toHaveBeenCalledWith(event);
    expect(mocks.handleStripeDisputeWebhookEvent).toHaveBeenCalledWith(event);
  });

  it('answers 500 when the dispute hold fails, so Stripe redelivers', async () => {
    mocks.handleStripeWebhook.mockResolvedValue({ received: true, event: stripeEvent('charge.dispute.created') });
    mocks.handleStripeDisputeWebhookEvent.mockRejectedValue(new Error('Affiliates: set_affiliate_commission_dispute failed'));

    const { status, body } = await post();

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Refund or dispute handling failed' });
  });

  it('schedules the sweep after a settled checkout session marked the order paid', async () => {
    mocks.handleStripeWebhook.mockResolvedValue({
      received: true,
      event: stripeEvent('checkout.session.completed', { payment_status: 'paid' }),
    });

    const { status } = await post();

    expect(status).toBe(200);
    expect(mocks.scheduleAffiliateCommissionSweep).toHaveBeenCalledTimes(1);
    expect(mocks.handleStripeRefundWebhookEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['an unsettled session', stripeEvent('checkout.session.completed', { payment_status: 'unpaid' })],
    ['a failed delayed payment', stripeEvent('checkout.session.async_payment_failed', { payment_status: 'unpaid' })],
    ['any other event', stripeEvent('customer.updated')],
  ])('neither refunds nor sweeps for %s', async (_label, event) => {
    mocks.handleStripeWebhook.mockResolvedValue({ received: true, event });

    const { status } = await post();

    expect(status).toBe(200);
    expect(mocks.handleStripeRefundWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.handleStripeDisputeWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });
});
