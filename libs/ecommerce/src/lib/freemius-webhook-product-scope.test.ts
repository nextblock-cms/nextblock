import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A signed Freemius webhook acts only on orders of the product whose secret verified it: the route
 * passes that id (`productId`) and stamps it on the event (`plugin_id`), and the order sync, the
 * refund and the dispute handlers skip (and log) the order of a license that belongs to another
 * product. Without it, anyone holding one product's secret (a FREEMIUS_CHECKOUT_PRODUCTS_JSON entry
 * of another account, the one-product secret) could refund, mark paid or release the commission of
 * any order by naming its license id.
 */

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  assignInvoiceMetadata: vi.fn(async () => ({ invoiceNumber: 'INV-1', paidAt: '2026-11-13T15:00:00Z' })),
  applyOrderInventoryDeduction: vi.fn(async () => undefined),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', async () => {
  const { isSandboxEnvironment } = await vi.importActual<{ isSandboxEnvironment: () => boolean }>(
    '../../../db/src/lib/config-resolve'
  );
  return { createClient: () => ({}), getServiceRoleSupabaseClient: () => ({}), isSandboxEnvironment };
});
// No developer key pair and no product keys: purchase data reads nothing from Freemius here.
vi.mock('./payment-config', () => ({
  hydrateFreemiusEnvFromDb: async () => undefined,
  resolveFreemiusDeveloperCredentialCandidates: async () => [],
}));
vi.mock('./invoice-server', () => ({ assignInvoiceMetadata: mocks.assignInvoiceMetadata }));
vi.mock('./order-inventory', () => ({ applyOrderInventoryDeduction: mocks.applyOrderInventoryDeduction }));

import {
  syncFreemiusOrderDisputeFromWebhookEvent,
  syncFreemiusOrderFromWebhookEvent,
  syncFreemiusOrderRefundFromWebhookEvent,
} from './freemius-order-sync';

const COMMERCE = '24851';
const CORTEX = '28609';

/**
 * The PostgREST slice the handlers use, over the orders table and the `order_items` / `products`
 * rows the scope check reads for an order that stores no product. `reads` lists every table read,
 * `failReads` makes a table's reads answer an error.
 */
function fakeOrders(rows: Row[], tables: { order_items?: Row[]; products?: Row[] } = {}, options: { failReads?: string[] } = {}) {
  const updates: Row[] = [];
  const reads: string[] = [];
  const data: Record<string, Row[]> = { order_items: tables.order_items ?? [], products: tables.products ?? [], orders: rows };
  const client = {
    from: (table: string) => {
      const tableRows = data[table] ?? [];
      const filters: Array<(row: Row) => boolean> = [];
      let pendingUpdate: Row | null = null;
      let single = false;
      const resolve = () => {
        const matched = tableRows.filter((row) => filters.every((filter) => filter(row)));
        if (pendingUpdate) {
          updates.push(pendingUpdate);
          for (const row of matched) Object.assign(row, pendingUpdate);
          return { data: matched.map((row) => ({ id: row.id })), error: null };
        }
        reads.push(table);
        if (options.failReads?.includes(table)) return { data: null, error: { message: `${table} read failed` } };
        return { data: single ? matched[0] ?? null : matched, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push((row) => row[column] === value);
          return builder;
        },
        is: (column: string, value: null) => {
          filters.push((row) => (row[column] ?? null) === value);
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
  return { client: client as never, updates, reads };
}

function commerceOrder(overrides: Row = {}): Row {
  return {
    id: 'order-commerce',
    status: 'paid',
    provider: 'freemius',
    created_at: '2026-11-12T14:58:00Z',
    freemius_product_id: COMMERCE,
    freemius_license_id: '9001',
    ...overrides,
  };
}

/** An event as the route hands it over: stamped with the product whose secret verified it. */
function event(type: string, productId: string | number | undefined, payment: Row = {}): Row {
  return {
    id: '880001',
    type,
    ...(productId === undefined ? {} : { plugin_id: productId }),
    objects: { payment: { license_id: 9001, gross: 250, is_renewal: false, ...payment } },
  };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  for (const name of ['FREEMIUS_CHECKOUT_PRODUCTS_JSON', 'FREEMIUS_SECRET_KEY', 'FREEMIUS_PUBLIC_KEY', 'FREEMIUS_API_KEY', 'FREEMIUS_PRODUCT_ID']) {
    vi.stubEnv(name, '');
  }
  // Nothing here may reach Freemius.
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('no Freemius call expected');
  }));
  mocks.assignInvoiceMetadata.mockClear();
  mocks.applyOrderInventoryDeduction.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('syncFreemiusOrderFromWebhookEvent keeps to the verified product', () => {
  it('skips the order of another product: a payment verified for Cortex never marks a Commerce Pro order paid', async () => {
    const orders = [commerceOrder({ status: 'pending' })];
    const db = fakeOrders(orders);

    const result = await syncFreemiusOrderFromWebhookEvent({ event: event('payment.created', CORTEX), productId: CORTEX, client: db.client });

    expect(result).toEqual({ success: true, ignored: true, reason: 'product_mismatch', licenseId: '9001', type: 'payment.created' });
    expect(orders[0].status).toBe('pending');
    expect(db.updates).toEqual([]);
    expect(mocks.assignInvoiceMetadata).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('its order order-commerce is for product 24851, not for product 28609, whose secret verified the event')
    );
  });

  it('keeps to the event’s own plugin_id when no product id is passed (a route written before the outcome check)', async () => {
    const orders = [commerceOrder({ status: 'pending' })];
    const db = fakeOrders(orders);

    await expect(
      syncFreemiusOrderFromWebhookEvent({ event: event('payment.created', Number(CORTEX)), client: db.client })
    ).resolves.toMatchObject({ ignored: true, reason: 'product_mismatch' });
    expect(orders[0].status).toBe('pending');
  });

  it.each([
    ['the passed id and the event’s plugin_id disagree', { productId: COMMERCE, pluginId: CORTEX }],
    ['the passed id is not a Freemius id', { productId: 'abc', pluginId: undefined }],
    ['the event names a product id that is not a Freemius id', { productId: undefined, pluginId: '24851/../1' }],
  ])('matches no order when %s', async (_label, ids) => {
    const orders = [commerceOrder({ status: 'pending' })];
    const db = fakeOrders(orders);

    await expect(
      syncFreemiusOrderFromWebhookEvent({ event: event('payment.created', ids.pluginId), productId: ids.productId, client: db.client })
    ).resolves.toMatchObject({ ignored: true, reason: 'product_mismatch' });
    expect(db.updates).toEqual([]);
  });

  it('skips an order that records no product, and whose items prove none, when the event is scoped to one', async () => {
    const orders = [commerceOrder({ status: 'pending', freemius_product_id: null })];
    const db = fakeOrders(orders);

    await expect(
      syncFreemiusOrderFromWebhookEvent({ event: event('payment.created', COMMERCE), productId: COMMERCE, client: db.client })
    ).resolves.toMatchObject({ ignored: true, reason: 'product_mismatch' });
    expect(orders[0].status).toBe('pending');
    expect(orders[0].freemius_product_id).toBeNull();
    expect(db.updates).toEqual([]);
  });

  it('syncs the order of the verified product, and its objects cannot move the order to another product', async () => {
    const orders = [commerceOrder({ status: 'pending' })];
    const db = fakeOrders(orders);
    const paid = { ...event('payment.created', COMMERCE), objects: { license: { id: 9001, plugin_id: 43273 }, payment: { license_id: 9001, gross: 250 } } };

    const result = await syncFreemiusOrderFromWebhookEvent({ event: paid, productId: COMMERCE, client: db.client });

    expect(result).toMatchObject({ success: true, orderId: 'order-commerce', status: 'paid' });
    expect(orders[0]).toMatchObject({ status: 'paid', freemius_product_id: COMMERCE });
    expect(mocks.assignInvoiceMetadata).toHaveBeenCalledTimes(1);
    // An order that stores its product is judged by it: its items are never read.
    expect(db.reads).not.toContain('order_items');
    expect(db.reads).not.toContain('products');
  });

  it('still acts on the license alone for a caller that names no product at all (unchanged)', async () => {
    const orders = [commerceOrder({ status: 'pending' })];
    const db = fakeOrders(orders);

    await expect(syncFreemiusOrderFromWebhookEvent({ event: event('payment.created', undefined), client: db.client })).resolves.toMatchObject({
      orderId: 'order-commerce',
      status: 'paid',
    });
  });

  it('prints a forged event type and license on one log line', async () => {
    const db = fakeOrders([commerceOrder({ freemius_license_id: 'lic\n[admin] ok' })]);
    const forged = { type: 'payment.created\n[Freemius] all good', plugin_id: CORTEX, objects: { payment: { license_id: 'lic\n[admin] ok' } } };

    await syncFreemiusOrderFromWebhookEvent({ event: forged, productId: CORTEX, client: db.client });

    const line = String(vi.mocked(console.warn).mock.calls[0]?.[0]);
    expect(line).toContain('Skipped payment.createdFreemiusallgood for license licadminok');
    expect(line).not.toContain('\n');
  });
});

describe('syncFreemiusOrderRefundFromWebhookEvent keeps to the verified product', () => {
  it('refunds nothing for an order of another product, and names no order', async () => {
    const orders = [commerceOrder()];
    const db = fakeOrders(orders);

    const result = await syncFreemiusOrderRefundFromWebhookEvent({ event: event('payment.refund', CORTEX), productId: CORTEX, client: db.client });

    expect(result).toEqual({
      isRefund: true,
      isRenewal: false,
      orderId: null,
      previousStatus: null,
      statusUpdated: false,
      reason: 'product_mismatch',
    });
    expect(orders[0].status).toBe('paid');
    expect(db.updates).toEqual([]);
  });

  it('keeps to the event’s plugin_id when the caller passes no id (the affiliates handler today)', async () => {
    const orders = [commerceOrder()];
    const db = fakeOrders(orders);

    await expect(syncFreemiusOrderRefundFromWebhookEvent({ event: event('payment.dispute.lost', CORTEX), client: db.client })).resolves.toMatchObject({
      orderId: null,
      reason: 'product_mismatch',
    });
    expect(orders[0].status).toBe('paid');
  });

  it('refunds the order of the verified product', async () => {
    const orders = [commerceOrder()];
    const db = fakeOrders(orders);

    await expect(
      syncFreemiusOrderRefundFromWebhookEvent({ event: event('payment.refund', COMMERCE), productId: COMMERCE, client: db.client })
    ).resolves.toMatchObject({ orderId: 'order-commerce', statusUpdated: true, reason: null });
    expect(orders[0].status).toBe('refunded');
  });
});

describe('syncFreemiusOrderDisputeFromWebhookEvent keeps to the verified product', () => {
  it.each(['payment.dispute.created', 'payment.dispute.won'])('names no order of another product on %s (no hold, no release)', async (type) => {
    const db = fakeOrders([commerceOrder()]);

    await expect(syncFreemiusOrderDisputeFromWebhookEvent({ event: event(type, CORTEX), productId: CORTEX, client: db.client })).resolves.toEqual({
      isDispute: true,
      open: type === 'payment.dispute.created',
      isRenewal: false,
      orderId: null,
      reason: 'product_mismatch',
    });
    expect(db.updates).toEqual([]);
  });

  it('names the order of the verified product', async () => {
    const db = fakeOrders([commerceOrder()]);

    await expect(
      syncFreemiusOrderDisputeFromWebhookEvent({ event: event('payment.dispute.created', COMMERCE), productId: COMMERCE, client: db.client })
    ).resolves.toMatchObject({ orderId: 'order-commerce', reason: null });
  });
});

/**
 * 0.23.4 verification (F7): checkout has stored `orders.freemius_product_id` only since 2026-05-07
 * and nothing backfilled it, so the scope above skipped every event for an older or imported order,
 * refunds and disputes included (answered 200, the order left paid). Such an order is the verified
 * product's when its own items prove it (each item's product carries that Freemius Product ID), and
 * the proof is written to the order. Never on the event's word: a forged event signed with one
 * product's secret can name any license, and any product in its objects.
 */
describe('an order that records no product', () => {
  const PRODUCTS: Row[] = [
    { id: 'product-commerce', freemius_product_id: COMMERCE },
    { id: 'product-cortex', freemius_product_id: CORTEX },
    { id: 'product-unsynced', freemius_product_id: null },
  ];

  function legacyOrder(id: string, overrides: Row = {}): Row {
    return commerceOrder({ id, freemius_product_id: null, ...overrides });
  }

  function itemsOf(orderId: string, ...productIds: Array<string | null>): Row[] {
    return productIds.map((productId, index) => ({ id: `${orderId}-item-${index}`, order_id: orderId, product_id: productId }));
  }

  /** Every handler, with an event that names the verified product in its objects too. */
  const HANDLERS = {
    refund: (client: never, productId: string) =>
      syncFreemiusOrderRefundFromWebhookEvent({
        event: { ...event('payment.refund', productId), objects: { license: { id: 9001, plugin_id: productId }, payment: { license_id: 9001, gross: 250, is_renewal: false } } },
        productId,
        client,
      }),
    dispute: (client: never, productId: string) =>
      syncFreemiusOrderDisputeFromWebhookEvent({ event: event('payment.dispute.created', productId), productId, client }),
    cancellation: (client: never, productId: string) =>
      syncFreemiusOrderFromWebhookEvent({
        event: { id: '880002', type: 'subscription.cancelled', plugin_id: productId, objects: { license: { id: 9001, plugin_id: productId }, subscription: { id: 77, license_id: 9001 } } },
        productId,
        client,
      }),
  };

  function warnLinesNaming(orderId: string): string[] {
    return vi.mocked(console.warn).mock.calls.map((call) => String(call[0])).filter((line) => line.includes(`its order ${orderId} `));
  }

  it('applies a refund of the verified product and records the product its items prove', async () => {
    const orders = [legacyOrder('order-legacy-refund')];
    const db = fakeOrders(orders, { order_items: itemsOf('order-legacy-refund', 'product-commerce'), products: PRODUCTS });

    await expect(HANDLERS.refund(db.client, COMMERCE)).resolves.toEqual({
      isRefund: true,
      isRenewal: false,
      orderId: 'order-legacy-refund',
      previousStatus: 'paid',
      statusUpdated: true,
      reason: null,
    });
    expect(orders[0]).toMatchObject({ status: 'refunded', freemius_product_id: COMMERCE });
    expect(warnLinesNaming('order-legacy-refund')).toEqual([]);
  });

  it('records the product on a renewal’s refund too, which changes nothing else', async () => {
    const orders = [legacyOrder('order-legacy-renewal')];
    const db = fakeOrders(orders, { order_items: itemsOf('order-legacy-renewal', 'product-commerce'), products: PRODUCTS });

    await expect(
      syncFreemiusOrderRefundFromWebhookEvent({ event: event('payment.refund', COMMERCE, { is_renewal: true }), productId: COMMERCE, client: db.client })
    ).resolves.toMatchObject({ orderId: 'order-legacy-renewal', statusUpdated: false, reason: 'renewal' });
    expect(orders[0]).toMatchObject({ status: 'paid', freemius_product_id: COMMERCE });
  });

  it.each(['payment.dispute.created', 'payment.dispute.won'])('names the order on %s and records its product, its status unchanged', async (type) => {
    const orders = [legacyOrder('order-legacy-dispute')];
    const db = fakeOrders(orders, { order_items: itemsOf('order-legacy-dispute', 'product-commerce'), products: PRODUCTS });

    await expect(syncFreemiusOrderDisputeFromWebhookEvent({ event: event(type, COMMERCE), productId: COMMERCE, client: db.client })).resolves.toEqual({
      isDispute: true,
      open: type === 'payment.dispute.created',
      isRenewal: false,
      orderId: 'order-legacy-dispute',
      reason: null,
    });
    expect(orders[0]).toMatchObject({ status: 'paid', freemius_product_id: COMMERCE });
  });

  it('applies a cancellation of the verified product to a trial and records its product', async () => {
    const orders = [legacyOrder('order-legacy-trial', { status: 'trial' })];
    const db = fakeOrders(orders, { order_items: itemsOf('order-legacy-trial', 'product-commerce'), products: PRODUCTS });

    await expect(HANDLERS.cancellation(db.client, COMMERCE)).resolves.toMatchObject({
      success: true,
      orderId: 'order-legacy-trial',
      status: 'cancelled',
    });
    expect(orders[0]).toMatchObject({ status: 'cancelled', freemius_product_id: COMMERCE });
  });

  it.each(Object.keys(HANDLERS) as Array<keyof typeof HANDLERS>)(
    'refuses a %s verified for Commerce Pro on an order whose items are Cortex’s, whatever the event’s objects name',
    async (kind) => {
      const orders = [legacyOrder('order-legacy-cortex', { status: kind === 'cancellation' ? 'trial' : 'paid' })];
      const db = fakeOrders(orders, { order_items: itemsOf('order-legacy-cortex', 'product-cortex'), products: PRODUCTS });

      const result = await HANDLERS[kind](db.client, COMMERCE);

      expect(result).toMatchObject({ reason: 'product_mismatch' });
      expect('orderId' in result ? result.orderId : null).toBeNull();
      expect(orders[0]).toMatchObject({ status: kind === 'cancellation' ? 'trial' : 'paid', freemius_product_id: null });
      expect(db.updates).toEqual([]);
      expect(warnLinesNaming('order-legacy-cortex')).toEqual([
        expect.stringContaining('its order order-legacy-cortex is for product 28609 (from its items), not for product 24851, whose secret verified the event'),
      ]);
    }
  );

  it('refuses an order whose items name two products: none of them is proven to be the order’s', async () => {
    const orders = [legacyOrder('order-legacy-mixed')];
    const db = fakeOrders(orders, { order_items: itemsOf('order-legacy-mixed', 'product-commerce', 'product-cortex'), products: PRODUCTS });

    await expect(HANDLERS.refund(db.client, COMMERCE)).resolves.toMatchObject({ orderId: null, reason: 'product_mismatch' });
    expect(orders[0]).toMatchObject({ status: 'paid', freemius_product_id: null });
    expect(db.updates).toEqual([]);
    expect(warnLinesNaming('order-legacy-mixed')).toEqual([expect.stringContaining('is for products 24851, 28609 (from its items), not for product 24851')]);
  });

  it.each([
    ['it has no items', 'order-unproven-empty', []],
    ['its item’s product is gone', 'order-unproven-gone', [null]],
    ['its item names a product that no longer exists', 'order-unproven-missing', ['product-deleted']],
    ['its product has no Freemius Product ID', 'order-unproven-unsynced', ['product-unsynced']],
    ['one of its two items has no product left', 'order-unproven-partial', ['product-commerce', null]],
  ] as Array<[string, string, Array<string | null>]>)('keeps the skip when %s, and logs it once with the order id', async (_label, orderId, productIds) => {
    const orders = [legacyOrder(orderId)];
    const db = fakeOrders(orders, { order_items: itemsOf(orderId, ...productIds), products: PRODUCTS });

    // A refund, then the cancellation Freemius sends with it: both skipped, one line.
    await expect(HANDLERS.refund(db.client, COMMERCE)).resolves.toMatchObject({ orderId: null, reason: 'product_mismatch' });
    await expect(HANDLERS.cancellation(db.client, COMMERCE)).resolves.toMatchObject({ ignored: true, reason: 'product_mismatch' });

    expect(orders[0]).toMatchObject({ status: 'paid', freemius_product_id: null });
    expect(db.updates).toEqual([]);
    const lines = warnLinesNaming(orderId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`its order ${orderId} records no Freemius product and its items prove none`);
    expect(lines[0]).toContain('cannot be tied to product 24851, whose secret verified the event');
  });

  it.each(['order_items', 'products'])('throws when %s cannot be read, so the webhook answers 5xx and Freemius redelivers', async (table) => {
    const orders = [legacyOrder('order-legacy-read-error')];
    const db = fakeOrders(orders, { order_items: itemsOf('order-legacy-read-error', 'product-commerce'), products: PRODUCTS }, { failReads: [table] });

    await expect(HANDLERS.refund(db.client, COMMERCE)).rejects.toThrow(`${table} read failed`);
    expect(orders[0]).toMatchObject({ status: 'paid', freemius_product_id: null });
    expect(db.updates).toEqual([]);
  });

  it('reads no items when the ids disagree: no order matches', async () => {
    const orders = [legacyOrder('order-legacy-disagree')];
    const db = fakeOrders(orders, { order_items: itemsOf('order-legacy-disagree', 'product-commerce'), products: PRODUCTS });

    await expect(
      syncFreemiusOrderRefundFromWebhookEvent({ event: event('payment.refund', CORTEX), productId: COMMERCE, client: db.client })
    ).resolves.toMatchObject({ orderId: null, reason: 'product_mismatch' });
    expect(db.reads).not.toContain('order_items');
    expect(orders[0].status).toBe('paid');
  });

  it('still acts on the license alone, writing no product, for a caller that names no product at all (unchanged)', async () => {
    const orders = [legacyOrder('order-legacy-unscoped')];
    const db = fakeOrders(orders, { order_items: itemsOf('order-legacy-unscoped', 'product-cortex'), products: PRODUCTS });

    await expect(syncFreemiusOrderRefundFromWebhookEvent({ event: event('payment.refund', undefined), client: db.client })).resolves.toMatchObject({
      orderId: 'order-legacy-unscoped',
      statusUpdated: true,
    });
    expect(orders[0]).toMatchObject({ status: 'refunded', freemius_product_id: null });
    expect(db.reads).not.toContain('order_items');
  });
});
