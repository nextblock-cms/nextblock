import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Refund and dispute webhooks reach two ledgers: the order (the ecommerce helpers) and the
 * affiliate commission (apply_affiliate_refund, set_affiliate_commission_dispute), whatever the
 * package state: a refund skipped while the license check failed would be lost for good. Partial
 * refunds pass the charge's CUMULATIVE amounts, so a replayed or out-of-order delivery is
 * harmless; an open dispute holds the commission and one the store wins releases it; renewals
 * never touch a commission; and every failure propagates so the webhook answers 5xx and is
 * redelivered. The commission sweep after a payment runs only for an active package.
 */

const mocks = vi.hoisted(() => ({
  packageActive: true,
  serviceClient: { tag: 'service-role' },
  syncStripeOrderRefundFromEvent: vi.fn(),
  syncStripeOrderDisputeFromEvent: vi.fn(),
  syncFreemiusOrderRefundFromWebhookEvent: vi.fn(),
  syncFreemiusOrderDisputeFromWebhookEvent: vi.fn(),
  applyAffiliateRefund: vi.fn(),
  setAffiliateCommissionDispute: vi.fn(),
  verifyPackageOnline: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  scheduled: [] as Array<() => unknown>,
  sweep: vi.fn(async () => 0),
  refundAlertSweep: vi.fn(async () => 0),
}));

vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/constants')),
}));
vi.mock('@nextblock-cms/affiliates/server', () => ({
  applyAffiliateRefund: mocks.applyAffiliateRefund,
  setAffiliateCommissionDispute: mocks.setAffiliateCommissionDispute,
}));
vi.mock('@nextblock-cms/db/server', () => ({
  verifyPackageOnline: mocks.verifyPackageOnline,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));
vi.mock('@nextblock-cms/ecommerce/server', () => ({
  syncStripeOrderRefundFromEvent: mocks.syncStripeOrderRefundFromEvent,
  syncStripeOrderDisputeFromEvent: mocks.syncStripeOrderDisputeFromEvent,
  syncFreemiusOrderRefundFromWebhookEvent: mocks.syncFreemiusOrderRefundFromWebhookEvent,
  syncFreemiusOrderDisputeFromWebhookEvent: mocks.syncFreemiusOrderDisputeFromWebhookEvent,
}));
vi.mock('./notify', () => ({
  scheduleAffiliateNotification: (task: () => unknown) => {
    mocks.scheduled.push(task);
  },
  sweepAffiliateCommissionNotifications: mocks.sweep,
  sweepAffiliateRefundAlertEmails: mocks.refundAlertSweep,
}));

import {
  handleFreemiusDisputeWebhookEvent,
  handleFreemiusRefundWebhookEvent,
  handleStripeDisputeWebhookEvent,
  handleStripeRefundWebhookEvent,
  scheduleAffiliateCommissionSweep,
} from './refunds';

const ORDER_ID = '77777777-7777-4777-8777-777777777777';
const STRIPE_EVENT = { id: 'evt_1', type: 'charge.refunded', data: { object: { id: 'ch_1' } } } as never;
const FREEMIUS_EVENT = { id: 'evt_2', type: 'payment.refund', objects: { payment: { license_id: 'lic_1' } } };

function stripeRefund(overrides: Record<string, unknown> = {}) {
  return {
    isRefund: true,
    orderId: ORDER_ID,
    full: false,
    refundedMinor: 2500,
    totalMinor: 10000,
    previousStatus: 'paid',
    statusUpdated: false,
    ...overrides,
  };
}

function freemiusRefund(overrides: Record<string, unknown> = {}) {
  return {
    isRefund: true,
    isRenewal: false,
    orderId: ORDER_ID,
    previousStatus: 'paid',
    statusUpdated: true,
    reason: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.packageActive = true;
  for (const fn of [
    mocks.syncStripeOrderRefundFromEvent,
    mocks.syncStripeOrderDisputeFromEvent,
    mocks.syncFreemiusOrderRefundFromWebhookEvent,
    mocks.syncFreemiusOrderDisputeFromWebhookEvent,
    mocks.applyAffiliateRefund,
    mocks.setAffiliateCommissionDispute,
    mocks.verifyPackageOnline,
    mocks.getServiceRoleSupabaseClient,
  ]) {
    fn.mockReset();
  }
  // The program runs only while Affiliates AND Commerce Pro are active (lib/affiliates/package-state.ts).
  mocks.verifyPackageOnline.mockImplementation(async (id: string) => (id === 'affiliates' || id === 'ecommerce') && mocks.packageActive);
  mocks.getServiceRoleSupabaseClient.mockReturnValue(mocks.serviceClient);
  mocks.applyAffiliateRefund.mockResolvedValue('adjusted');
  mocks.setAffiliateCommissionDispute.mockResolvedValue('held');
  mocks.scheduled = [];
  mocks.sweep.mockClear();
  mocks.refundAlertSweep.mockClear();
});

describe('scheduleAffiliateCommissionSweep', () => {
  it('sweeps after the response when the package is active', async () => {
    scheduleAffiliateCommissionSweep();

    expect(mocks.scheduled).toHaveLength(1);
    expect(mocks.sweep).not.toHaveBeenCalled();
    await mocks.scheduled[0]();
    expect(mocks.verifyPackageOnline).toHaveBeenCalledWith('affiliates');
    expect(mocks.sweep).toHaveBeenCalledTimes(1);
    // A refund after a payout raised an alert in the database: its email goes out from here.
    expect(mocks.refundAlertSweep).toHaveBeenCalledTimes(1);
  });

  it('does not sweep while the package is inactive', async () => {
    mocks.packageActive = false;

    scheduleAffiliateCommissionSweep();
    await mocks.scheduled[0]();

    expect(mocks.sweep).not.toHaveBeenCalled();
    expect(mocks.refundAlertSweep).not.toHaveBeenCalled();
  });
});

describe('handleStripeRefundWebhookEvent', () => {
  it('voids the commission of a fully refunded order after the order is marked refunded', async () => {
    mocks.syncStripeOrderRefundFromEvent.mockResolvedValue(
      stripeRefund({ full: true, refundedMinor: 10000, statusUpdated: true })
    );
    mocks.applyAffiliateRefund.mockResolvedValue('voided');

    const result = await handleStripeRefundWebhookEvent(STRIPE_EVENT);

    expect(mocks.syncStripeOrderRefundFromEvent).toHaveBeenCalledWith(STRIPE_EVENT);
    expect(mocks.applyAffiliateRefund).toHaveBeenCalledWith({
      supabase: mocks.serviceClient,
      gateway: 'STRIPE',
      orderId: ORDER_ID,
      refundedMinor: 10000,
      orderTotalMinor: 10000,
      full: true,
      throwOnError: true,
    });
    expect(result).toEqual({ handled: true, orderId: ORDER_ID, full: true, orderStatusUpdated: true, affiliate: 'voided' });
  });

  it('reduces the commission of a partial refund with the cumulative amounts', async () => {
    mocks.syncStripeOrderRefundFromEvent.mockResolvedValue(stripeRefund());

    const result = await handleStripeRefundWebhookEvent(STRIPE_EVENT);

    expect(mocks.applyAffiliateRefund).toHaveBeenCalledWith(
      expect.objectContaining({ refundedMinor: 2500, orderTotalMinor: 10000, full: false })
    );
    expect(result).toMatchObject({ handled: true, full: false, orderStatusUpdated: false, affiliate: 'adjusted' });
  });

  it('passes out-of-order partial refunds through with the amount each charge carried', async () => {
    // Refunds of 1000 then 2000; the second event (cumulative 3000) arrives first.
    mocks.syncStripeOrderRefundFromEvent
      .mockResolvedValueOnce(stripeRefund({ refundedMinor: 3000 }))
      .mockResolvedValueOnce(stripeRefund({ refundedMinor: 1000 }));
    mocks.applyAffiliateRefund.mockResolvedValueOnce('adjusted').mockResolvedValueOnce('none');

    const later = await handleStripeRefundWebhookEvent(STRIPE_EVENT);
    const earlier = await handleStripeRefundWebhookEvent(STRIPE_EVENT);

    expect(mocks.applyAffiliateRefund.mock.calls.map((call) => call[0].refundedMinor)).toEqual([3000, 1000]);
    expect([later.affiliate, earlier.affiliate]).toEqual(['adjusted', 'none']);
  });

  it.each([
    ['reads inactive', () => mocks.verifyPackageOnline.mockResolvedValue(false)],
    ['cannot be checked', () => mocks.verifyPackageOnline.mockRejectedValue(new Error('license service unreachable'))],
  ])('still applies a partial refund to the ledger when the package %s (it would be lost for good)', async (_label, arrange) => {
    arrange();
    mocks.syncStripeOrderRefundFromEvent.mockResolvedValue(stripeRefund());

    const result = await handleStripeRefundWebhookEvent(STRIPE_EVENT);

    expect(mocks.applyAffiliateRefund).toHaveBeenCalledWith({
      supabase: mocks.serviceClient,
      gateway: 'STRIPE',
      orderId: ORDER_ID,
      refundedMinor: 2500,
      orderTotalMinor: 10000,
      full: false,
      throwOnError: true,
    });
    expect(result).toEqual({ handled: true, orderId: ORDER_ID, full: false, orderStatusUpdated: false, affiliate: 'adjusted' });
    expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();
  });

  it.each([
    ['a dispute that was won', { isRefund: false, orderId: null, full: false }],
    ['a refund of a charge no order matches', { orderId: null }],
  ])('applies nothing for %s', async (_label, overrides) => {
    mocks.syncStripeOrderRefundFromEvent.mockResolvedValue(stripeRefund(overrides));

    const result = await handleStripeRefundWebhookEvent(STRIPE_EVENT);

    expect(result).toMatchObject({ handled: false, orderId: null, affiliate: 'skipped' });
    expect(mocks.applyAffiliateRefund).not.toHaveBeenCalled();
  });

  it('lets an order-side failure through (the route answers 5xx)', async () => {
    mocks.syncStripeOrderRefundFromEvent.mockRejectedValue(new Error('affiliate void failed'));

    await expect(handleStripeRefundWebhookEvent(STRIPE_EVENT)).rejects.toThrow('affiliate void failed');
    expect(mocks.applyAffiliateRefund).not.toHaveBeenCalled();
  });

  it('lets a ledger failure through (the route answers 5xx)', async () => {
    mocks.syncStripeOrderRefundFromEvent.mockResolvedValue(stripeRefund());
    mocks.applyAffiliateRefund.mockRejectedValue(new Error('Affiliates: apply_affiliate_refund failed'));

    await expect(handleStripeRefundWebhookEvent(STRIPE_EVENT)).rejects.toThrow('apply_affiliate_refund failed');
  });
});

describe('handleFreemiusRefundWebhookEvent', () => {
  it('voids the commission of the refunded order (always a full refund)', async () => {
    mocks.syncFreemiusOrderRefundFromWebhookEvent.mockResolvedValue(freemiusRefund());
    mocks.applyAffiliateRefund.mockResolvedValue('voided');

    const result = await handleFreemiusRefundWebhookEvent(FREEMIUS_EVENT);

    expect(mocks.syncFreemiusOrderRefundFromWebhookEvent).toHaveBeenCalledWith({ event: FREEMIUS_EVENT });
    expect(mocks.applyAffiliateRefund).toHaveBeenCalledWith({
      supabase: mocks.serviceClient,
      gateway: 'FREEMIUS',
      orderId: ORDER_ID,
      refundedMinor: 0,
      orderTotalMinor: 0,
      full: true,
      throwOnError: true,
    });
    expect(result).toEqual({ handled: true, orderId: ORDER_ID, full: true, orderStatusUpdated: true, affiliate: 'voided' });
  });

  it('still records a tombstone for an attributed order that was refunded before it was paid', async () => {
    mocks.syncFreemiusOrderRefundFromWebhookEvent.mockResolvedValue(freemiusRefund({ previousStatus: 'pending', statusUpdated: false }));
    mocks.applyAffiliateRefund.mockResolvedValue('voided');

    const result = await handleFreemiusRefundWebhookEvent(FREEMIUS_EVENT);

    expect(mocks.applyAffiliateRefund).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER_ID, full: true }));
    expect(result).toMatchObject({ handled: true, orderStatusUpdated: false, affiliate: 'voided' });
  });

  it('ignores the refund of a renewal for commissions', async () => {
    mocks.syncFreemiusOrderRefundFromWebhookEvent.mockResolvedValue(
      freemiusRefund({ isRenewal: true, statusUpdated: false, reason: 'renewal' })
    );

    const result = await handleFreemiusRefundWebhookEvent(FREEMIUS_EVENT);

    expect(mocks.applyAffiliateRefund).not.toHaveBeenCalled();
    expect(result).toMatchObject({ handled: false, orderId: ORDER_ID, affiliate: 'skipped' });
  });

  it('still voids the commission (or leaves the tombstone) while the package is inactive', async () => {
    mocks.packageActive = false;
    mocks.syncFreemiusOrderRefundFromWebhookEvent.mockResolvedValue(freemiusRefund({ previousStatus: 'pending', statusUpdated: false }));
    mocks.applyAffiliateRefund.mockResolvedValue('voided');

    const result = await handleFreemiusRefundWebhookEvent(FREEMIUS_EVENT);

    expect(mocks.applyAffiliateRefund).toHaveBeenCalledWith(expect.objectContaining({ gateway: 'FREEMIUS', orderId: ORDER_ID, full: true, throwOnError: true }));
    expect(result).toMatchObject({ handled: true, orderStatusUpdated: false, affiliate: 'voided' });
    expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();
  });

  it('lets a ledger failure through while the package is inactive too (the route answers 5xx)', async () => {
    mocks.packageActive = false;
    mocks.syncFreemiusOrderRefundFromWebhookEvent.mockResolvedValue(freemiusRefund());
    mocks.applyAffiliateRefund.mockRejectedValue(new Error('Affiliates: apply_affiliate_refund failed'));

    await expect(handleFreemiusRefundWebhookEvent(FREEMIUS_EVENT)).rejects.toThrow('apply_affiliate_refund failed');
  });

  it('applies nothing when no order holds the license', async () => {
    mocks.syncFreemiusOrderRefundFromWebhookEvent.mockResolvedValue(
      freemiusRefund({ orderId: null, statusUpdated: false, reason: 'unknown_license_id' })
    );

    await expect(handleFreemiusRefundWebhookEvent(FREEMIUS_EVENT)).resolves.toMatchObject({ handled: false, orderId: null });
    expect(mocks.applyAffiliateRefund).not.toHaveBeenCalled();
  });

  it('lets failures through (the route answers 5xx)', async () => {
    mocks.syncFreemiusOrderRefundFromWebhookEvent.mockRejectedValue(new Error('affiliate void failed'));

    await expect(handleFreemiusRefundWebhookEvent(FREEMIUS_EVENT)).rejects.toThrow('affiliate void failed');
  });
});

describe('handleStripeDisputeWebhookEvent', () => {
  const DISPUTE_EVENT = { id: 'evt_3', type: 'charge.dispute.created', data: { object: { id: 'dp_1' } } } as never;

  it('holds the commission of the disputed order, whatever the package state', async () => {
    mocks.packageActive = false;
    mocks.syncStripeOrderDisputeFromEvent.mockResolvedValue({ isDispute: true, open: true, orderId: ORDER_ID, status: 'needs_response' });

    const result = await handleStripeDisputeWebhookEvent(DISPUTE_EVENT);

    expect(mocks.syncStripeOrderDisputeFromEvent).toHaveBeenCalledWith(DISPUTE_EVENT);
    expect(mocks.setAffiliateCommissionDispute).toHaveBeenCalledWith({
      supabase: mocks.serviceClient,
      gateway: 'STRIPE',
      orderId: ORDER_ID,
      open: true,
      throwOnError: true,
    });
    expect(result).toEqual({ handled: true, orderId: ORDER_ID, open: true, affiliate: 'held' });
    expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();
    expect(mocks.applyAffiliateRefund).not.toHaveBeenCalled();
  });

  it('releases it when the dispute closes without loss', async () => {
    mocks.syncStripeOrderDisputeFromEvent.mockResolvedValue({ isDispute: true, open: false, orderId: ORDER_ID, status: 'won' });
    mocks.setAffiliateCommissionDispute.mockResolvedValue('released');

    const result = await handleStripeDisputeWebhookEvent(DISPUTE_EVENT);

    expect(mocks.setAffiliateCommissionDispute).toHaveBeenCalledWith(expect.objectContaining({ open: false, throwOnError: true }));
    expect(result).toMatchObject({ handled: true, open: false, affiliate: 'released' });
  });

  it.each([
    ['a lost dispute (the refund path handles it) or another event', { isDispute: false, open: false, orderId: null, status: null }],
    ['a dispute no order matches', { isDispute: true, open: true, orderId: null, status: 'needs_response' }],
  ])('applies nothing for %s', async (_label, sync) => {
    mocks.syncStripeOrderDisputeFromEvent.mockResolvedValue(sync);

    await expect(handleStripeDisputeWebhookEvent(DISPUTE_EVENT)).resolves.toMatchObject({ handled: false, affiliate: 'skipped' });
    expect(mocks.setAffiliateCommissionDispute).not.toHaveBeenCalled();
  });

  it('lets a ledger failure through (the route answers 5xx)', async () => {
    mocks.syncStripeOrderDisputeFromEvent.mockResolvedValue({ isDispute: true, open: true, orderId: ORDER_ID, status: 'needs_response' });
    mocks.setAffiliateCommissionDispute.mockRejectedValue(new Error('Affiliates: set_affiliate_commission_dispute failed'));

    await expect(handleStripeDisputeWebhookEvent(DISPUTE_EVENT)).rejects.toThrow('set_affiliate_commission_dispute failed');
  });
});

describe('handleFreemiusDisputeWebhookEvent', () => {
  const DISPUTE_EVENT = { id: 'evt_4', type: 'payment.dispute.created', objects: { payment: { license_id: 'lic_1' } } };

  function freemiusDispute(overrides: Record<string, unknown> = {}) {
    return { isDispute: true, open: true, isRenewal: false, orderId: ORDER_ID, reason: null, ...overrides };
  }

  it('holds the commission of the license order on an opened dispute', async () => {
    mocks.syncFreemiusOrderDisputeFromWebhookEvent.mockResolvedValue(freemiusDispute());

    const result = await handleFreemiusDisputeWebhookEvent(DISPUTE_EVENT);

    expect(mocks.syncFreemiusOrderDisputeFromWebhookEvent).toHaveBeenCalledWith({ event: DISPUTE_EVENT });
    expect(mocks.setAffiliateCommissionDispute).toHaveBeenCalledWith({
      supabase: mocks.serviceClient,
      gateway: 'FREEMIUS',
      orderId: ORDER_ID,
      open: true,
      throwOnError: true,
    });
    expect(result).toEqual({ handled: true, orderId: ORDER_ID, open: true, affiliate: 'held' });
  });

  it('releases it when the store wins', async () => {
    mocks.syncFreemiusOrderDisputeFromWebhookEvent.mockResolvedValue(freemiusDispute({ open: false }));
    mocks.setAffiliateCommissionDispute.mockResolvedValue('released');

    await expect(handleFreemiusDisputeWebhookEvent(DISPUTE_EVENT)).resolves.toMatchObject({ handled: true, affiliate: 'released' });
    expect(mocks.setAffiliateCommissionDispute).toHaveBeenCalledWith(expect.objectContaining({ open: false }));
  });

  it.each([
    ['a dispute on a renewal payment', { isRenewal: true, reason: 'renewal' }],
    ['a license no order holds', { orderId: null, reason: 'unknown_license_id' }],
  ])('applies nothing for %s', async (_label, overrides) => {
    mocks.syncFreemiusOrderDisputeFromWebhookEvent.mockResolvedValue(freemiusDispute(overrides));

    await expect(handleFreemiusDisputeWebhookEvent(DISPUTE_EVENT)).resolves.toMatchObject({ handled: false, affiliate: 'skipped' });
    expect(mocks.setAffiliateCommissionDispute).not.toHaveBeenCalled();
  });

  it('lets failures through (the route answers 5xx)', async () => {
    mocks.syncFreemiusOrderDisputeFromWebhookEvent.mockRejectedValue(new Error('Order lookup failed'));

    await expect(handleFreemiusDisputeWebhookEvent(DISPUTE_EVENT)).rejects.toThrow('Order lookup failed');
  });
});
