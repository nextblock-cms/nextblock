import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Freemius webhook route: the signature is checked first, always; refunds and lost disputes
 * are handled INSTEAD of the order sync (which would re-promote a refunded order to paid);
 * dispute openings hold the partner's commission and wins release it, never syncing the order;
 * the commission sweep follows a paid order or a refund.
 */

const mocks = vi.hoisted(() => ({
  hydrateFreemiusEnvFromDb: vi.fn(async () => undefined),
  verifyFreemiusWebhookSignature: vi.fn(),
  syncFreemiusOrderFromWebhookEvent: vi.fn(),
  handleFreemiusRefundWebhookEvent: vi.fn(),
  handleFreemiusDisputeWebhookEvent: vi.fn(),
  scheduleAffiliateCommissionSweep: vi.fn(),
}));

vi.mock('@nextblock-cms/ecommerce/server', () => ({
  hydrateFreemiusEnvFromDb: mocks.hydrateFreemiusEnvFromDb,
  verifyFreemiusWebhookSignature: mocks.verifyFreemiusWebhookSignature,
  syncFreemiusOrderFromWebhookEvent: mocks.syncFreemiusOrderFromWebhookEvent,
  isFreemiusRefundEventType: (type: unknown) =>
    ['payment.refund', 'payment.refunded', 'payment.dispute.lost', 'payment.dispute.closed'].includes(type as string),
  isFreemiusDisputeEventType: (type: unknown) =>
    ['payment.dispute.created', 'payment.dispute.won'].includes(type as string),
}));
vi.mock('../../../../lib/affiliates/refunds', () => ({
  handleFreemiusRefundWebhookEvent: mocks.handleFreemiusRefundWebhookEvent,
  handleFreemiusDisputeWebhookEvent: mocks.handleFreemiusDisputeWebhookEvent,
  scheduleAffiliateCommissionSweep: mocks.scheduleAffiliateCommissionSweep,
}));

import { POST } from './route';

const ORDER_ID = '77777777-7777-4777-8777-777777777777';

async function post(event: Record<string, unknown>, signature: string | null = 'abc123') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signature) headers['x-signature'] = signature;
  const response = await POST(
    new Request('http://localhost:4200/api/webhooks/freemius', { method: 'POST', headers, body: JSON.stringify(event) })
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  for (const fn of [
    mocks.verifyFreemiusWebhookSignature,
    mocks.syncFreemiusOrderFromWebhookEvent,
    mocks.handleFreemiusRefundWebhookEvent,
    mocks.handleFreemiusDisputeWebhookEvent,
    mocks.scheduleAffiliateCommissionSweep,
  ]) {
    fn.mockReset();
  }
  mocks.verifyFreemiusWebhookSignature.mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('POST /api/webhooks/freemius', () => {
  it('refuses a missing or invalid signature before reading the event, refunds included', async () => {
    const missing = await post({ type: 'payment.refund' }, null);
    mocks.verifyFreemiusWebhookSignature.mockReturnValue(false);
    const invalid = await post({ type: 'payment.refund' });

    expect([missing.status, invalid.status]).toEqual([400, 401]);
    expect(mocks.handleFreemiusRefundWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.syncFreemiusOrderFromWebhookEvent).not.toHaveBeenCalled();
  });

  it.each(['payment.refund', 'payment.refunded', 'payment.dispute.lost', 'payment.dispute.closed'])(
    'handles %s instead of the order sync, then sweeps',
    async (type) => {
      const event = { id: 'evt_1', type, objects: { payment: { license_id: 'lic_1', is_renewal: false } } };
      mocks.handleFreemiusRefundWebhookEvent.mockResolvedValue({
        handled: true,
        orderId: ORDER_ID,
        full: true,
        orderStatusUpdated: true,
        affiliate: 'voided',
      });

      const { status, body } = await post(event);

      expect(status).toBe(200);
      expect(body).toEqual({ received: true, type, handled: true, orderId: ORDER_ID, status: 'refunded' });
      expect(mocks.handleFreemiusRefundWebhookEvent).toHaveBeenCalledWith(event);
      expect(mocks.syncFreemiusOrderFromWebhookEvent).not.toHaveBeenCalled();
      expect(mocks.scheduleAffiliateCommissionSweep).toHaveBeenCalledTimes(1);
    }
  );

  it('acknowledges the refund of a renewal without a sweep (and still never syncs it)', async () => {
    mocks.handleFreemiusRefundWebhookEvent.mockResolvedValue({
      handled: false,
      orderId: ORDER_ID,
      full: true,
      orderStatusUpdated: false,
      affiliate: 'skipped',
    });

    const { status, body } = await post({ type: 'payment.refund', objects: { payment: { license_id: 'lic_1', is_renewal: true } } });

    expect(status).toBe(200);
    expect(body).toMatchObject({ received: true, handled: false, status: null });
    expect(mocks.syncFreemiusOrderFromWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });

  it('answers 500 when refund handling fails, so Freemius redelivers', async () => {
    mocks.handleFreemiusRefundWebhookEvent.mockRejectedValue(new Error('affiliate void failed'));

    const { status, body } = await post({ type: 'payment.refund' });

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Webhook processing failed' });
  });

  it.each([
    ['payment.dispute.created', true, 'held'],
    ['payment.dispute.won', false, 'released'],
  ])('applies %s to the commission only: no order sync, no refund, no sweep', async (type, open, affiliate) => {
    const event = { type, objects: { payment: { license_id: 'lic_1' } } };
    mocks.handleFreemiusDisputeWebhookEvent.mockResolvedValue({ handled: true, orderId: ORDER_ID, open, affiliate });

    const { status, body } = await post(event);

    expect(status).toBe(200);
    expect(body).toEqual({ received: true, type, handled: true, orderId: ORDER_ID });
    expect(mocks.handleFreemiusDisputeWebhookEvent).toHaveBeenCalledWith(event);
    expect(mocks.handleFreemiusRefundWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.syncFreemiusOrderFromWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });

  it('answers 500 when the dispute hold fails, so Freemius redelivers', async () => {
    mocks.handleFreemiusDisputeWebhookEvent.mockRejectedValue(new Error('Affiliates: set_affiliate_commission_dispute failed'));

    const { status, body } = await post({ type: 'payment.dispute.created', objects: { payment: { license_id: 'lic_1' } } });

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Webhook processing failed' });
    expect(mocks.syncFreemiusOrderFromWebhookEvent).not.toHaveBeenCalled();
  });

  it('syncs every other event as before and sweeps once the order is paid', async () => {
    const event = { type: 'payment.created', objects: { payment: { license_id: 'lic_1', gross: 250 } } };
    mocks.syncFreemiusOrderFromWebhookEvent.mockResolvedValue({ success: true, orderId: ORDER_ID, status: 'paid', type: 'payment.created' });

    const { status, body } = await post(event);

    expect(status).toBe(200);
    expect(body).toEqual({ received: true, success: true, orderId: ORDER_ID, status: 'paid', type: 'payment.created' });
    expect(mocks.syncFreemiusOrderFromWebhookEvent).toHaveBeenCalledWith({ event });
    expect(mocks.scheduleAffiliateCommissionSweep).toHaveBeenCalledTimes(1);
  });

  it('does not sweep when the synced order is not paid', async () => {
    mocks.syncFreemiusOrderFromWebhookEvent.mockResolvedValue({ success: true, orderId: ORDER_ID, status: 'trial', type: 'license.created' });

    await post({ type: 'license.created' });
    mocks.syncFreemiusOrderFromWebhookEvent.mockResolvedValue({ success: true, ignored: true, reason: 'unknown_license_id', type: 'license.created' });
    await post({ type: 'license.created' });

    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });
});
