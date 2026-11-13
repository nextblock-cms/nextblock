import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: () => ({}),
}));
vi.mock('@nextblock-cms/utils', () => ({
  formatPrice: (amount: number) => String(amount),
  getCurrencyMinorUnitFactor: () => 100,
}));
vi.mock('server-only', () => ({}));

const invoiceMocks = vi.hoisted(() => ({
  assignInvoiceMetadata: vi.fn(async () => ({ invoiceNumber: 'INV-1', paidAt: '2026-10-01T00:00:00Z' })),
  applyOrderInventoryDeduction: vi.fn(async () => undefined),
}));
vi.mock('./invoice-server', () => ({ assignInvoiceMetadata: invoiceMocks.assignInvoiceMetadata }));
vi.mock('./order-inventory', () => ({ applyOrderInventoryDeduction: invoiceMocks.applyOrderInventoryDeduction }));

import {
  FREEMIUS_DISPUTE_EVENT_TYPES,
  FREEMIUS_REFUND_EVENT_TYPES,
  isFreemiusDisputeEventType,
  isFreemiusRefundEventType,
  resolveFreemiusStatusFromCheckoutResponse,
  resolveFreemiusStatusFromWebhookEvent,
  syncFreemiusOrderDisputeFromWebhookEvent,
  syncFreemiusOrderFromWebhookEvent,
  syncFreemiusOrderRefundFromWebhookEvent,
} from './freemius-order-sync';

describe('Freemius order status resolution', () => {
  it('marks free trial checkout callbacks as trial', () => {
    expect(
      resolveFreemiusStatusFromCheckoutResponse(
        {
          trial: {
            id: 'trial_1',
            license_id: 'license_1',
            trial_ends_at: '2026-05-21 00:00:00',
          },
        },
        'pending'
      )
    ).toBe('trial');
  });

  it('keeps paid trials with no initial charge in trial', () => {
    expect(
      resolveFreemiusStatusFromCheckoutResponse(
        {
          purchase: {
            license_id: 'license_2',
            subscription_id: 'sub_2',
            initial_amount: 0,
            trial_ends: '2026-05-21 00:00:00',
          },
        },
        'pending'
      )
    ).toBe('trial');
  });

  it('marks immediate paid checkout callbacks as paid when a positive amount is present', () => {
    expect(
      resolveFreemiusStatusFromCheckoutResponse(
        {
          purchase: {
            license_id: 'license_3',
            initial_amount: 250,
          },
        },
        'pending'
      )
    ).toBe('paid');
  });

  it('marks a no-card trial as trial from purchase data with a trial end date', () => {
    // A free trial has no subscription and no positive amount, so the trial end
    // date on the purchase data is the only signal that it is a trial.
    expect(
      resolveFreemiusStatusFromWebhookEvent({
        currentStatus: 'pending',
        event: {
          type: 'checkout.purchaseCompleted',
          data: { license_id: 'license_free_trial' },
          objects: {},
        },
        purchaseData: {
          licenseId: 'license_free_trial',
          initialAmount: 0,
          trialEndsAt: '2026-05-21 00:00:00',
        },
      })
    ).toBe('trial');
  });

  it('marks trial renewal extension webhooks as paid', () => {
    expect(
      resolveFreemiusStatusFromWebhookEvent({
        currentStatus: 'trial',
        event: {
          type: 'license.extended',
          data: {
            license_id: 'license_4',
            is_renewal: true,
          },
        },
      })
    ).toBe('paid');
  });

  it('marks cancellable trial lifecycle webhooks as cancelled', () => {
    expect(
      resolveFreemiusStatusFromWebhookEvent({
        currentStatus: 'trial',
        event: {
          type: 'subscription.cancelled',
          data: {
            license_id: 'license_5',
          },
        },
      })
    ).toBe('cancelled');
  });

  it('does not downgrade an already-paid order after cancellation', () => {
    expect(
      resolveFreemiusStatusFromWebhookEvent({
        currentStatus: 'paid',
        event: {
          type: 'subscription.cancelled',
          data: {
            license_id: 'license_6',
          },
        },
      })
    ).toBe('paid');
  });
});

/* ------------------------------------------------------------ refunds --- */

const PAID_ORDER = '77777777-7777-4777-8777-777777777777';

/** The slice of the PostgREST builder the Freemius order sync uses, over one orders table. */
function fakeOrders(rows: Row[], options: { failUpdate?: boolean } = {}) {
  const updates: Array<{ values: Row; matched: string[] }> = [];

  const client = {
    from: () => {
      const filters: Array<(row: Row) => boolean> = [];
      let pendingUpdate: Row | null = null;
      let single = false;

      const resolve = () => {
        const matched = rows.filter((row) => filters.every((filter) => filter(row)));
        if (pendingUpdate) {
          if (options.failUpdate) return { data: null, error: { code: 'P0001', message: 'affiliate void failed' } };
          updates.push({ values: pendingUpdate, matched: matched.map((row) => row.id) });
          for (const row of matched) Object.assign(row, pendingUpdate);
          return { data: matched.map((row) => ({ id: row.id })), error: null };
        }
        return { data: single ? matched[0] ?? null : matched, error: null };
      };

      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => {
          single = true;
          return builder;
        },
        single: () => {
          single = true;
          return builder;
        },
        update: (values: Row) => {
          pendingUpdate = values;
          return builder;
        },
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(resolve()).then(onFulfilled, onRejected),
      };

      return builder;
    },
  };

  return { client: client as never, updates };
}

function paidOrder(overrides: Row = {}): Row {
  return {
    id: PAID_ORDER,
    status: 'paid',
    provider: 'freemius',
    created_at: '2026-10-01T00:00:00Z',
    freemius_product_id: '28609',
    freemius_license_id: 'lic_1',
    ...overrides,
  };
}

function refundEvent(type: string, payment: Row = {}) {
  return { id: 'evt_1', type, objects: { payment: { id: 'pay_9', license_id: 'lic_1', is_renewal: false, ...payment } } };
}

describe('Freemius refund event types', () => {
  it('lists the refund events and the dispute events that refund nothing', () => {
    expect([...FREEMIUS_REFUND_EVENT_TYPES]).toEqual(['payment.refund', 'payment.refunded', 'payment.dispute.lost', 'payment.dispute.closed']);
    expect(FREEMIUS_REFUND_EVENT_TYPES.every(isFreemiusRefundEventType)).toBe(true);
    expect([...FREEMIUS_DISPUTE_EVENT_TYPES]).toEqual(['payment.dispute.created', 'payment.dispute.won']);
    expect(FREEMIUS_DISPUTE_EVENT_TYPES.every(isFreemiusDisputeEventType)).toBe(true);
    expect(isFreemiusRefundEventType('payment.created')).toBe(false);
    expect(isFreemiusRefundEventType('payment.dispute.won')).toBe(false);
    expect(isFreemiusDisputeEventType('payment.refund')).toBe(false);
    expect(isFreemiusDisputeEventType('payment.dispute.lost')).toBe(false);
    expect(isFreemiusRefundEventType(undefined)).toBe(false);
  });
});

describe('syncFreemiusOrderDisputeFromWebhookEvent', () => {
  it('names the order of an opened dispute (hold) without changing it', async () => {
    const orders = [paidOrder()];
    const db = fakeOrders(orders);

    const result = await syncFreemiusOrderDisputeFromWebhookEvent({ event: refundEvent('payment.dispute.created'), client: db.client });

    expect(result).toEqual({ isDispute: true, open: true, isRenewal: false, orderId: PAID_ORDER, reason: null });
    expect(orders[0].status).toBe('paid');
    expect(db.updates).toEqual([]);
  });

  it('names the order of a dispute the store won (release)', async () => {
    const db = fakeOrders([paidOrder()]);

    await expect(
      syncFreemiusOrderDisputeFromWebhookEvent({ event: refundEvent('payment.dispute.won'), client: db.client })
    ).resolves.toEqual({ isDispute: true, open: false, isRenewal: false, orderId: PAID_ORDER, reason: null });
    expect(db.updates).toEqual([]);
  });

  it('flags a dispute on a renewal payment: the first purchase is not concerned', async () => {
    const db = fakeOrders([paidOrder()]);

    await expect(
      syncFreemiusOrderDisputeFromWebhookEvent({ event: refundEvent('payment.dispute.created', { is_renewal: 1 }), client: db.client })
    ).resolves.toMatchObject({ isDispute: true, isRenewal: true, orderId: PAID_ORDER, reason: 'renewal' });
  });

  it('reports an event without a license, a license no order holds, and any other event', async () => {
    const db = fakeOrders([paidOrder()]);

    await expect(
      syncFreemiusOrderDisputeFromWebhookEvent({ event: { type: 'payment.dispute.created', objects: { payment: { id: 'p' } } }, client: db.client })
    ).resolves.toMatchObject({ isDispute: true, orderId: null, reason: 'missing_license_id' });
    await expect(
      syncFreemiusOrderDisputeFromWebhookEvent({ event: refundEvent('payment.dispute.won', { license_id: 'lic_other' }), client: db.client })
    ).resolves.toMatchObject({ isDispute: true, orderId: null, reason: 'unknown_license_id' });
    await expect(
      syncFreemiusOrderDisputeFromWebhookEvent({ event: refundEvent('payment.dispute.lost'), client: db.client })
    ).resolves.toMatchObject({ isDispute: false, reason: 'not_a_dispute' });
  });
});

describe('syncFreemiusOrderRefundFromWebhookEvent', () => {
  it.each([...FREEMIUS_REFUND_EVENT_TYPES])('marks the paid order of the license refunded on %s', async (type) => {
    const orders = [paidOrder()];
    const db = fakeOrders(orders);

    const result = await syncFreemiusOrderRefundFromWebhookEvent({ event: refundEvent(type), client: db.client });

    expect(result).toEqual({
      isRefund: true,
      isRenewal: false,
      orderId: PAID_ORDER,
      previousStatus: 'paid',
      statusUpdated: true,
      reason: null,
    });
    expect(orders[0]).toMatchObject({ status: 'refunded', freemius_last_event_type: type });
  });

  it.each([
    ['a boolean', { is_renewal: true }],
    ['a "1" string', { is_renewal: '1' }],
  ])('ignores the refund of a renewal (%s): the first purchase and its commission stand', async (_label, payment) => {
    const orders = [paidOrder()];
    const db = fakeOrders(orders);

    const result = await syncFreemiusOrderRefundFromWebhookEvent({ event: refundEvent('payment.refund', payment), client: db.client });

    expect(result).toMatchObject({ isRefund: true, isRenewal: true, orderId: PAID_ORDER, statusUpdated: false, reason: 'renewal' });
    expect(orders[0].status).toBe('paid');
    expect(db.updates).toEqual([]);
  });

  it('reads the renewal flag from data.payment as well', async () => {
    const orders = [paidOrder()];
    const db = fakeOrders(orders);

    const result = await syncFreemiusOrderRefundFromWebhookEvent({
      event: { type: 'payment.refund', data: { payment: { license_id: 'lic_1', is_renewal: true } } },
      client: db.client,
    });

    expect(result).toMatchObject({ isRenewal: true, statusUpdated: false });
  });

  it('changes nothing on a replay, still naming the order', async () => {
    const orders = [paidOrder()];
    const db = fakeOrders(orders);
    const event = refundEvent('payment.refund');

    await syncFreemiusOrderRefundFromWebhookEvent({ event, client: db.client });
    const replay = await syncFreemiusOrderRefundFromWebhookEvent({ event, client: db.client });

    expect(replay).toMatchObject({ orderId: PAID_ORDER, previousStatus: 'refunded', statusUpdated: false, reason: null });
    expect(db.updates).toHaveLength(1);
  });

  it.each(['pending', 'trial', 'cancelled'])('leaves a %s order alone but names it', async (status) => {
    const orders = [paidOrder({ status })];
    const db = fakeOrders(orders);

    const result = await syncFreemiusOrderRefundFromWebhookEvent({ event: refundEvent('payment.refund'), client: db.client });

    expect(result).toMatchObject({ orderId: PAID_ORDER, previousStatus: status, statusUpdated: false });
    expect(orders[0].status).toBe(status);
  });

  it('reports an event without a license, and a license no order holds', async () => {
    const db = fakeOrders([paidOrder()]);

    await expect(
      syncFreemiusOrderRefundFromWebhookEvent({ event: { type: 'payment.refund', objects: { payment: { id: 'pay_1' } } }, client: db.client })
    ).resolves.toMatchObject({ isRefund: true, orderId: null, reason: 'missing_license_id' });
    await expect(
      syncFreemiusOrderRefundFromWebhookEvent({ event: refundEvent('payment.refund', { license_id: 'lic_other' }), client: db.client })
    ).resolves.toMatchObject({ isRefund: true, orderId: null, reason: 'unknown_license_id' });
  });

  it('throws when the update fails, so the webhook answers 5xx and Freemius redelivers', async () => {
    const db = fakeOrders([paidOrder()], { failUpdate: true });

    await expect(
      syncFreemiusOrderRefundFromWebhookEvent({ event: refundEvent('payment.refund'), client: db.client })
    ).rejects.toThrow('affiliate void failed');
  });

  it('is not a refund for any other event', async () => {
    const db = fakeOrders([paidOrder()]);

    await expect(
      syncFreemiusOrderRefundFromWebhookEvent({ event: { type: 'payment.created', objects: {} }, client: db.client })
    ).resolves.toMatchObject({ isRefund: false, reason: 'not_a_refund' });
    expect(db.updates).toEqual([]);
  });
});

describe('syncFreemiusOrderFromWebhookEvent keeps a refunded order refunded', () => {
  beforeEach(() => {
    invoiceMocks.assignInvoiceMetadata.mockClear();
    invoiceMocks.applyOrderInventoryDeduction.mockClear();
  });

  it('does not revive a refunded order on a later payment event', async () => {
    const orders = [paidOrder({ status: 'refunded' })];
    const db = fakeOrders(orders);

    const result = await syncFreemiusOrderFromWebhookEvent({
      event: { type: 'payment.created', objects: { payment: { license_id: 'lic_1', gross: 250 } } },
      client: db.client,
    });

    expect(result).toMatchObject({ orderId: PAID_ORDER, status: 'refunded' });
    expect(orders[0].status).toBe('refunded');
    expect(invoiceMocks.assignInvoiceMetadata).not.toHaveBeenCalled();
  });

  it('still marks a pending order paid on a positive payment', async () => {
    const orders = [paidOrder({ status: 'pending' })];
    const db = fakeOrders(orders);

    const result = await syncFreemiusOrderFromWebhookEvent({
      event: { type: 'payment.created', objects: { payment: { license_id: 'lic_1', gross: 250 } } },
      client: db.client,
    });

    expect(result).toMatchObject({ status: 'paid' });
    expect(orders[0].status).toBe('paid');
    expect(invoiceMocks.assignInvoiceMetadata).toHaveBeenCalledTimes(1);
  });
});
