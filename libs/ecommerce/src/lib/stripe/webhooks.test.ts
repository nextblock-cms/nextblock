import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const syncStripeOrderFromSession = vi.fn(async () => undefined);
let nextEvent: { type: string; data: { object: Record<string, unknown> } };

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({}),
  getServiceRoleSupabaseClient: () => ({}),
}));
vi.mock('./order-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncStripeOrderFromSession: (...args: unknown[]) => syncStripeOrderFromSession(...(args as [])),
}));
vi.mock('../payment-config', () => ({ resolveStripeWebhookSecret: async () => 'whsec_test' }));
vi.mock('./client', () => ({
  getStripeClient: async () => ({ webhooks: { constructEvent: () => nextEvent } }),
}));

import { syncStripeOrderDisputeFromEvent, syncStripeOrderRefundFromEvent, type StripeRefundLookupApi } from './order-sync';
import {
  STRIPE_DISPUTE_EVENT_TYPES,
  STRIPE_REFUND_EVENT_TYPES,
  handleStripeWebhook,
  isStripeDisputeEventType,
  isStripeRefundEventType,
  isStripeSessionSettled,
  isStripeSettledCheckoutEvent,
} from './webhooks';

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
    expect(await handleStripeWebhook('sig', '{}')).toMatchObject({ received: true });
    expect(syncStripeOrderFromSession).toHaveBeenCalledTimes(1);
  });

  it('does not sync a completed session paid by a delayed method that has not settled', async () => {
    nextEvent = event('checkout.session.completed', 'unpaid');
    expect(await handleStripeWebhook('sig', '{}')).toMatchObject({ received: true });
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

  it('tells which verified events marked an order paid', () => {
    expect(isStripeSettledCheckoutEvent(event('checkout.session.completed', 'paid') as never)).toBe(true);
    expect(isStripeSettledCheckoutEvent(event('checkout.session.async_payment_succeeded', 'paid') as never)).toBe(true);
    expect(isStripeSettledCheckoutEvent(event('checkout.session.completed', 'unpaid') as never)).toBe(false);
    expect(isStripeSettledCheckoutEvent(event('charge.refunded', 'paid') as never)).toBe(false);
  });
});

describe('handleStripeWebhook returns the verified event', () => {
  beforeEach(() => {
    syncStripeOrderFromSession.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands back the event it verified, for the route to act on', async () => {
    nextEvent = event('checkout.session.completed', 'paid');
    const result = await handleStripeWebhook('sig', '{}');

    expect(result).toEqual({ received: true, event: nextEvent });
  });

  it('acknowledges refunds and disputes without touching the session sync or logging them as unhandled', async () => {
    for (const type of [...STRIPE_REFUND_EVENT_TYPES, ...STRIPE_DISPUTE_EVENT_TYPES]) {
      nextEvent = { type, data: { object: { id: 'ch_1' } } };
      expect(await handleStripeWebhook('sig', '{}')).toEqual({ received: true, event: nextEvent });
    }

    expect(STRIPE_DISPUTE_EVENT_TYPES).toContain('charge.dispute.created');
    expect(syncStripeOrderFromSession).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Unhandled event type'));
  });

  it('knows the dispute event types', () => {
    expect(isStripeDisputeEventType('charge.dispute.created')).toBe(true);
    expect(isStripeDisputeEventType('charge.dispute.closed')).toBe(false);
    expect(isStripeDisputeEventType('charge.refunded')).toBe(false);
    expect(isStripeDisputeEventType(null)).toBe(false);
  });

  it('still returns the event with a sync failure (the route answers 400 and Stripe redelivers)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    syncStripeOrderFromSession.mockRejectedValueOnce(new Error('Order lookup failed') as never);
    nextEvent = event('checkout.session.completed', 'paid');

    expect(await handleStripeWebhook('sig', '{}')).toEqual({ received: false, error: 'Order lookup failed', event: nextEvent });
  });

  it('knows the refund event types', () => {
    expect(isStripeRefundEventType('charge.refunded')).toBe(true);
    expect(isStripeRefundEventType('charge.dispute.closed')).toBe(true);
    expect(isStripeRefundEventType('charge.dispute.created')).toBe(false);
    expect(isStripeRefundEventType(undefined)).toBe(false);
  });
});

/* ------------------------------------------------------------ refunds and disputes --- */

const PAID_ORDER = '77777777-7777-4777-8777-777777777777';
const PENDING_ORDER = '88888888-8888-4888-8888-888888888888';
const FREEMIUS_ORDER = '99999999-9999-4999-8999-999999999999';

function seedOrders(): Row[] {
  return [
    { id: PAID_ORDER, status: 'paid', provider: 'stripe', payment_intent_id: 'pi_paid', created_at: '2026-10-01T00:00:00Z' },
    { id: PENDING_ORDER, status: 'pending', provider: 'stripe', payment_intent_id: null, created_at: '2026-10-02T00:00:00Z' },
    { id: FREEMIUS_ORDER, status: 'paid', provider: 'freemius', payment_intent_id: null, created_at: '2026-10-03T00:00:00Z' },
  ];
}

function fakeDatabase(orders: Row[], options: { failUpdate?: boolean } = {}) {
  const updates: Array<{ values: Row; matched: string[] }> = [];

  class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
    private filters: Array<(row: Row) => boolean> = [];
    private pendingUpdate: Row | null = null;
    private single = false;
    private max: number | null = null;

    select() {
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters.push((row) => row[column] === value);
      return this;
    }

    in(column: string, values: unknown[]) {
      this.filters.push((row) => values.includes(row[column]));
      return this;
    }

    order() {
      return this;
    }

    limit(count: number) {
      this.max = count;
      return this;
    }

    maybeSingle() {
      this.single = true;
      return this;
    }

    update(values: Row) {
      this.pendingUpdate = values;
      return this;
    }

    private resolve(): { data: unknown; error: unknown } {
      let matched = orders.filter((row) => this.filters.every((filter) => filter(row)));

      if (this.pendingUpdate) {
        if (options.failUpdate) {
          return { data: null, error: { code: 'P0001', message: 'affiliate void failed' } };
        }
        updates.push({ values: this.pendingUpdate, matched: matched.map((row) => row.id) });
        for (const row of matched) Object.assign(row, this.pendingUpdate);
        return { data: matched.map((row) => ({ id: row.id })), error: null };
      }

      if (this.max !== null) matched = matched.slice(0, this.max);
      return { data: this.single ? matched[0] ?? null : matched, error: null };
    }

    then<T1 = { data: unknown; error: unknown }, T2 = never>(
      onFulfilled?: ((value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
      onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
    ): PromiseLike<T1 | T2> {
      return Promise.resolve(this.resolve()).then(onFulfilled, onRejected);
    }
  }

  return { client: { from: () => new FakeQuery() } as never, updates };
}

function fakeStripe(options: { paymentIntents?: Record<string, Row>; charges?: Record<string, Row> } = {}) {
  const missing = () => Object.assign(new Error('No such object'), { code: 'resource_missing', statusCode: 404 });
  const api = {
    charges: {
      retrieve: vi.fn(async (id: string) => {
        const charge = options.charges?.[id];
        if (!charge) throw missing();
        return charge;
      }),
    },
    paymentIntents: {
      retrieve: vi.fn(async (id: string) => {
        const paymentIntent = options.paymentIntents?.[id];
        if (!paymentIntent) throw missing();
        return paymentIntent;
      }),
    },
  };
  return api as typeof api & StripeRefundLookupApi;
}

function chargeRefunded(charge: Row) {
  return {
    type: 'charge.refunded',
    data: { object: { id: 'ch_1', object: 'charge', amount: 10000, amount_refunded: 0, refunded: false, payment_intent: 'pi_paid', metadata: {}, ...charge } },
  } as never;
}

function disputeClosed(dispute: Row) {
  return {
    type: 'charge.dispute.closed',
    data: { object: { id: 'dp_1', object: 'dispute', amount: 10000, charge: 'ch_1', payment_intent: 'pi_paid', status: 'lost', ...dispute } },
  } as never;
}

function disputeCreated(dispute: Row) {
  return {
    type: 'charge.dispute.created',
    data: {
      object: { id: 'dp_1', object: 'dispute', amount: 10000, charge: 'ch_1', payment_intent: 'pi_paid', status: 'needs_response', ...dispute },
    },
  } as never;
}

describe('syncStripeOrderRefundFromEvent', () => {
  let orders: Row[];

  beforeEach(() => {
    orders = seedOrders();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks a paid order refunded on a full refund, with the charge amounts', async () => {
    const db = fakeDatabase(orders);

    const result = await syncStripeOrderRefundFromEvent(chargeRefunded({ amount_refunded: 10000, refunded: true }), {
      client: db.client,
      stripe: fakeStripe(),
    });

    expect(result).toEqual({
      isRefund: true,
      orderId: PAID_ORDER,
      full: true,
      refundedMinor: 10000,
      totalMinor: 10000,
      previousStatus: 'paid',
      statusUpdated: true,
    });
    expect(orders[0].status).toBe('refunded');
    expect(db.updates).toEqual([{ values: { status: 'refunded' }, matched: [PAID_ORDER] }]);
  });

  it('treats a refunded amount reaching the charge amount as full', async () => {
    const db = fakeDatabase(orders);

    const result = await syncStripeOrderRefundFromEvent(chargeRefunded({ amount_refunded: 10000, refunded: false }), {
      client: db.client,
    });

    expect(result).toMatchObject({ full: true, statusUpdated: true });
  });

  it('changes nothing on a replay, but still names the order (the affiliate RPC is idempotent)', async () => {
    const db = fakeDatabase(orders);
    const refund = chargeRefunded({ amount_refunded: 10000, refunded: true });

    await syncStripeOrderRefundFromEvent(refund, { client: db.client });
    const replay = await syncStripeOrderRefundFromEvent(refund, { client: db.client });

    expect(replay).toMatchObject({ orderId: PAID_ORDER, full: true, previousStatus: 'refunded', statusUpdated: false });
    expect(db.updates).toHaveLength(1);
  });

  it('refunds a shipped order too', async () => {
    orders[0].status = 'shipped';
    const db = fakeDatabase(orders);

    const result = await syncStripeOrderRefundFromEvent(chargeRefunded({ amount_refunded: 10000, refunded: true }), { client: db.client });

    expect(result).toMatchObject({ previousStatus: 'shipped', statusUpdated: true });
    expect(orders[0].status).toBe('refunded');
  });

  it('leaves the status of a partial refund alone and reports the CUMULATIVE amount', async () => {
    const db = fakeDatabase(orders);

    const result = await syncStripeOrderRefundFromEvent(chargeRefunded({ amount_refunded: 2500 }), { client: db.client });

    expect(result).toMatchObject({ orderId: PAID_ORDER, full: false, refundedMinor: 2500, totalMinor: 10000, statusUpdated: false });
    expect(orders[0].status).toBe('paid');
    expect(db.updates).toEqual([]);
  });

  it('reports each partial refund with the cumulative amount its charge carried, even out of order', async () => {
    // Two refunds of 1000 then 2000: Stripe delivers the second event (cumulative 3000) first.
    const db = fakeDatabase(orders);
    const second = await syncStripeOrderRefundFromEvent(chargeRefunded({ amount_refunded: 3000 }), { client: db.client });
    const first = await syncStripeOrderRefundFromEvent(chargeRefunded({ amount_refunded: 1000 }), { client: db.client });

    expect([second.refundedMinor, first.refundedMinor]).toEqual([3000, 1000]);
    expect([second.totalMinor, first.totalMinor]).toEqual([10000, 10000]);
    expect([second.full, first.full]).toEqual([false, false]);
    expect(orders[0].status).toBe('paid');
  });

  it('never refunds a pending order, but names it so the ledger can block a late commission', async () => {
    const db = fakeDatabase(orders);

    const result = await syncStripeOrderRefundFromEvent(
      chargeRefunded({ payment_intent: 'pi_new', amount_refunded: 10000, refunded: true, metadata: { orderId: PENDING_ORDER } }),
      { client: db.client, stripe: fakeStripe() }
    );

    expect(result).toMatchObject({ orderId: PENDING_ORDER, full: true, previousStatus: 'pending', statusUpdated: false });
    expect(orders[1].status).toBe('pending');
  });

  it('finds the order through the PaymentIntent metadata when nothing else names it', async () => {
    const db = fakeDatabase(orders);
    const stripe = fakeStripe({ paymentIntents: { pi_new: { id: 'pi_new', metadata: { orderId: PENDING_ORDER } } } });

    const result = await syncStripeOrderRefundFromEvent(chargeRefunded({ payment_intent: 'pi_new', amount_refunded: 500 }), {
      client: db.client,
      stripe,
    });

    expect(result).toMatchObject({ orderId: PENDING_ORDER, full: false, refundedMinor: 500 });
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_new');
  });

  it('refuses a metadata match whose order recorded another PaymentIntent', async () => {
    const db = fakeDatabase(orders);

    const result = await syncStripeOrderRefundFromEvent(
      chargeRefunded({ payment_intent: 'pi_other', amount_refunded: 10000, refunded: true, metadata: { orderId: PAID_ORDER } }),
      { client: db.client, stripe: fakeStripe() }
    );

    expect(result).toMatchObject({ isRefund: true, orderId: null, statusUpdated: false });
    expect(orders[0].status).toBe('paid');
  });

  it('refuses a metadata match on a Freemius order', async () => {
    const db = fakeDatabase(orders);

    const result = await syncStripeOrderRefundFromEvent(
      chargeRefunded({ payment_intent: null, amount_refunded: 10000, refunded: true, metadata: { orderId: FREEMIUS_ORDER } }),
      { client: db.client, stripe: fakeStripe() }
    );

    expect(result).toMatchObject({ orderId: null, statusUpdated: false });
    expect(orders[2].status).toBe('paid');
  });

  it('returns no order (and does not throw) for a charge Stripe no longer knows', async () => {
    const db = fakeDatabase(orders);

    const result = await syncStripeOrderRefundFromEvent(chargeRefunded({ payment_intent: 'pi_unknown', amount_refunded: 10000, refunded: true }), {
      client: db.client,
      stripe: fakeStripe(),
    });

    expect(result).toMatchObject({ isRefund: true, orderId: null, statusUpdated: false });
  });

  it('throws when Stripe fails for another reason, so the webhook is redelivered', async () => {
    const db = fakeDatabase(orders);
    const stripe = fakeStripe();
    stripe.paymentIntents.retrieve.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { statusCode: 429 }));

    await expect(
      syncStripeOrderRefundFromEvent(chargeRefunded({ payment_intent: 'pi_unknown', amount_refunded: 10000, refunded: true }), {
        client: db.client,
        stripe,
      })
    ).rejects.toThrow('rate limited');
  });

  it('throws when the status update fails (the order trigger refused it), so Stripe redelivers', async () => {
    const db = fakeDatabase(orders, { failUpdate: true });

    await expect(
      syncStripeOrderRefundFromEvent(chargeRefunded({ amount_refunded: 10000, refunded: true }), { client: db.client })
    ).rejects.toThrow('affiliate void failed');
  });

  it('treats a lost dispute as a full refund', async () => {
    const db = fakeDatabase(orders);

    const result = await syncStripeOrderRefundFromEvent(disputeClosed({ status: 'lost', amount: 10000 }), { client: db.client });

    expect(result).toMatchObject({ isRefund: true, orderId: PAID_ORDER, full: true, refundedMinor: 10000, totalMinor: 10000, statusUpdated: true });
    expect(orders[0].status).toBe('refunded');
  });

  it.each(['won', 'warning_closed', 'prevented'])('ignores a dispute closed as %s', async (status) => {
    const db = fakeDatabase(orders);

    const result = await syncStripeOrderRefundFromEvent(disputeClosed({ status }), { client: db.client });

    expect(result).toEqual({
      isRefund: false,
      orderId: null,
      full: false,
      refundedMinor: 0,
      totalMinor: 0,
      previousStatus: null,
      statusUpdated: false,
    });
    expect(orders[0].status).toBe('paid');
  });

  it('follows a lost dispute that names only its charge to the PaymentIntent', async () => {
    const db = fakeDatabase(orders);
    const stripe = fakeStripe({ charges: { ch_9: { id: 'ch_9', payment_intent: 'pi_paid', metadata: {} } } });

    const result = await syncStripeOrderRefundFromEvent(disputeClosed({ charge: 'ch_9', payment_intent: null }), {
      client: db.client,
      stripe,
    });

    expect(stripe.charges.retrieve).toHaveBeenCalledWith('ch_9');
    expect(result).toMatchObject({ orderId: PAID_ORDER, statusUpdated: true });
  });

  it('is not a refund for any other event', async () => {
    const db = fakeDatabase(orders);

    await expect(
      syncStripeOrderRefundFromEvent({ type: 'checkout.session.completed', data: { object: {} } } as never, { client: db.client })
    ).resolves.toMatchObject({ isRefund: false, orderId: null });
  });
});

describe('syncStripeOrderDisputeFromEvent', () => {
  let orders: Row[];

  beforeEach(() => {
    orders = seedOrders();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the order of an opened dispute through its PaymentIntent, and never changes the order', async () => {
    const db = fakeDatabase(orders);

    const result = await syncStripeOrderDisputeFromEvent(disputeCreated({}), { client: db.client, stripe: fakeStripe() });

    expect(result).toEqual({ isDispute: true, open: true, orderId: PAID_ORDER, status: 'needs_response' });
    expect(db.updates).toEqual([]);
    expect(orders[0].status).toBe('paid');
  });

  it('holds on an inquiry too (warning_needs_response)', async () => {
    const db = fakeDatabase(orders);

    const result = await syncStripeOrderDisputeFromEvent(disputeCreated({ status: 'warning_needs_response' }), { client: db.client });

    expect(result).toMatchObject({ isDispute: true, open: true, orderId: PAID_ORDER });
  });

  it('follows a dispute that names only its charge to the checkout metadata', async () => {
    const db = fakeDatabase(orders);
    const stripe = fakeStripe({ charges: { ch_9: { id: 'ch_9', payment_intent: 'pi_new', metadata: { orderId: PENDING_ORDER } } } });

    const result = await syncStripeOrderDisputeFromEvent(disputeCreated({ charge: 'ch_9', payment_intent: null }), {
      client: db.client,
      stripe,
    });

    expect(stripe.charges.retrieve).toHaveBeenCalledWith('ch_9');
    expect(result).toMatchObject({ isDispute: true, open: true, orderId: PENDING_ORDER });
    expect(orders[1].status).toBe('pending');
  });

  it('reads the metadata of an expanded charge', async () => {
    const db = fakeDatabase(orders);

    const result = await syncStripeOrderDisputeFromEvent(
      disputeCreated({ payment_intent: null, charge: { id: 'ch_2', payment_intent: null, metadata: { orderId: PAID_ORDER } } }),
      { client: db.client, stripe: fakeStripe() }
    );

    expect(result).toMatchObject({ orderId: PAID_ORDER, open: true });
  });

  it.each(['won', 'warning_closed', 'prevented'])('releases on a dispute closed as %s', async (status) => {
    const db = fakeDatabase(orders);

    const result = await syncStripeOrderDisputeFromEvent(disputeClosed({ status }), { client: db.client });

    expect(result).toEqual({ isDispute: true, open: false, orderId: PAID_ORDER, status });
    expect(db.updates).toEqual([]);
  });

  it('leaves a lost dispute to the refund path', async () => {
    const db = fakeDatabase(orders);

    await expect(syncStripeOrderDisputeFromEvent(disputeClosed({ status: 'lost' }), { client: db.client })).resolves.toEqual({
      isDispute: false,
      open: false,
      orderId: null,
      status: null,
    });
  });

  it('names no order (and does not throw) for a charge Stripe no longer knows', async () => {
    const db = fakeDatabase(orders);

    const result = await syncStripeOrderDisputeFromEvent(disputeCreated({ payment_intent: null, charge: 'ch_gone' }), {
      client: db.client,
      stripe: fakeStripe(),
    });

    expect(result).toMatchObject({ isDispute: true, orderId: null });
  });

  it('is not a dispute for any other event', async () => {
    const db = fakeDatabase(orders);

    await expect(
      syncStripeOrderDisputeFromEvent(chargeRefunded({ amount_refunded: 10000, refunded: true }), { client: db.client })
    ).resolves.toMatchObject({ isDispute: false, orderId: null });
    expect(db.updates).toEqual([]);
  });
});

describe('CMS payments setup lists the webhook events this route needs', () => {
  it('names the checkout events and every refund and dispute event', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // The list lives in webhook-events.ts (shared with the Affiliates connection test); the payments screen renders it.
    const source = readFileSync(path.join(here, 'webhook-events.ts'), 'utf8');
    const screen = readFileSync(path.join(here, '../pages/cms/payments/PaymentsClient.tsx'), 'utf8');
    expect(screen).toContain("import { STRIPE_REQUIRED_WEBHOOK_EVENTS, stripeCliListenCommand } from '../../../stripe/webhook-events';");
    expect(screen).toContain('STRIPE_REQUIRED_WEBHOOK_EVENTS.map(');

    for (const type of [
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'checkout.session.async_payment_failed',
      ...STRIPE_REFUND_EVENT_TYPES,
      ...STRIPE_DISPUTE_EVENT_TYPES,
    ]) {
      expect(source, type).toContain(`'${type}'`);
    }
  });
});
