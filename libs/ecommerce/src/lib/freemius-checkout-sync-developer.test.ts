import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The browser checkout sync (POST /api/checkout/freemius/sync) is the step that links the license
 * to the order on nextblock.dev, which runs on the Freemius developer key pair alone: no
 * FREEMIUS_CHECKOUT_PRODUCTS_JSON, no per-product bearer, no injected license lookup. Without the
 * link, every later webhook is ignored as unknown_license_id, the success page shows no key and no
 * commission is earned. Here the whole sync runs against a stubbed api.freemius.com: the license
 * check and the purchase data both go through freemius-developer-api.ts at developer scope.
 */

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  candidates: vi.fn<() => Promise<Array<Record<string, string>>>>(async () => []),
  assignInvoiceMetadata: vi.fn(async () => ({ invoiceNumber: 'INV-1', paidAt: '2026-11-12T15:00:00Z' })),
  applyOrderInventoryDeduction: vi.fn(async () => undefined),
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', async () => {
  const { isSandboxEnvironment } = await vi.importActual<{ isSandboxEnvironment: () => boolean }>(
    '../../../db/src/lib/config-resolve'
  );
  return { createClient: () => ({}), getServiceRoleSupabaseClient: () => ({}), isSandboxEnvironment };
});
vi.mock('./payment-config', () => ({
  hydrateFreemiusEnvFromDb: async () => undefined,
  resolveFreemiusDeveloperCredentialCandidates: mocks.candidates,
}));
vi.mock('./invoice-server', () => ({ assignInvoiceMetadata: mocks.assignInvoiceMetadata }));
vi.mock('./order-inventory', () => ({ applyOrderInventoryDeduction: mocks.applyOrderInventoryDeduction }));

import { forgetFreemiusDeveloperCaches, signFreemiusRequest } from './freemius-developer-api';
import { syncFreemiusCheckoutOrder } from './freemius-order-sync';

const DEV = '4242';
const PAIR = { developerId: DEV, publicKey: 'pk_dev_checkout_sync', secretKey: 'sk_dev_checkout_sync', source: 'env' };
const NOW = new Date('2026-11-12T15:00:00Z');

/** The buyer's fresh, never-activated 43273 (Affiliates) license, created a minute after the order. */
const LICENSE = {
  id: 7001,
  plugin_id: 43273,
  plan_id: 75655,
  pricing_id: 110100,
  user_id: 88,
  activated: 0,
  is_cancelled: false,
  quota: 1,
  created: '2026-11-12 14:59:00',
  expiration: '2027-11-12 14:59:00',
  secret_key: 'sk_affiliates_license_7001',
};
const BUYER = { id: 88, email: 'partner@example.com', first: 'Pat', last: 'Partner' };
const SUBSCRIPTION = {
  id: 444,
  license_id: 7001,
  initial_amount: '200.00',
  renewal_amount: '200.00',
  billing_cycle: 12,
  currency: 'usd',
  gateway: 'stripe',
  next_payment: '2027-11-12 14:59:00',
};
const SUBSCRIPTION_NOT_FOUND = { status: 404, body: { error: { code: 'subscription_not_found', message: 'Subscription not found.' } } };

type Call = { url: string; method: string; path: string; body: string | undefined; headers: Record<string, string> };
type Answer = { status: number; body?: unknown };

/**
 * api.freemius.com for the developer account: its products, the 43273 license and its owner, and
 * the license's subscription (`subscription`, a 404 for a license without one). Anything else 404s.
 */
function stubFreemius(options: { subscription: Answer; license?: Answer }) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url: String(url),
      method: init.method ?? 'GET',
      path: String(url).replace(`https://api.freemius.com/v1/developers/${DEV}`, ''),
      body: typeof init.body === 'string' ? init.body : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    let answer: Answer;
    if (call.path.startsWith('/plugins.json')) {
      answer = { status: 200, body: { plugins: [{ id: 24851 }, { id: 28609 }, { id: 43273 }] } };
    } else if (call.path === '/plugins/43273/licenses/7001.json') {
      answer = options.license ?? { status: 200, body: LICENSE };
    } else if (call.path === '/plugins/43273/licenses/7001/subscription.json') {
      answer = options.subscription;
    } else if (call.path.startsWith('/plugins/43273/users/88.json')) {
      answer = { status: 200, body: BUYER };
    } else {
      answer = { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } };
    }
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), { status: answer.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/** Every request went to the developer account, signed with the developer pair, as a read. */
function expectEveryCallDeveloperSigned(calls: Call[]) {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.method).toBe('GET');
    expect(call.url.startsWith(`https://api.freemius.com/v1/developers/${DEV}/`)).toBe(true);
    expect(call.headers['Authorization']).toBe(
      signFreemiusRequest({
        body: '',
        date: call.headers['Date'],
        method: 'GET',
        path: call.url.replace('https://api.freemius.com', ''),
        publicKey: PAIR.publicKey,
        scopeId: DEV,
        secretKey: PAIR.secretKey,
      }).authorization
    );
  }
}

function pathsRead(calls: Call[]) {
  return [...new Set(calls.map((call) => call.path.split('?', 1)[0]))];
}

/** The pending order the checkout wrote for 43273, before Freemius confirmed anything. */
function pendingOrder(): Row {
  return {
    id: 'order-43273',
    status: 'pending',
    provider: 'freemius',
    created_at: '2026-11-12T14:58:00Z',
    freemius_product_id: '43273',
    freemius_plan_id: '75655',
    freemius_license_id: null,
    freemius_subscription_id: null,
    freemius_trial_id: null,
    freemius_user_id: null,
    freemius_trial_ends_at: null,
  };
}

/** The PostgREST slice the checkout sync uses, over one orders table. */
function fakeOrders(rows: Row[]) {
  const updates: Row[] = [];
  const client = {
    from: () => {
      const filters: Array<(row: Row) => boolean> = [];
      let pendingUpdate: Row | null = null;
      let single = false;
      const resolve = () => {
        const matched = rows.filter((row) => filters.every((filter) => filter(row)));
        if (pendingUpdate) {
          updates.push(pendingUpdate);
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
        neq: (column: string, value: unknown) => {
          filters.push((row) => row[column] !== value);
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

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  // Only the developer pair: no per-product key, bearer or JSON map anywhere.
  for (const name of [
    'FREEMIUS_CHECKOUT_PRODUCTS_JSON',
    'FREEMIUS_PUBLIC_KEY',
    'FREEMIUS_SECRET_KEY',
    'FREEMIUS_API_KEY',
    'FREEMIUS_PRODUCT_ID',
    'FREEMIUS_ECOMMERCE_SANDBOX_PUBLIC_KEY',
    'FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY',
  ]) {
    vi.stubEnv(name, '');
  }
  forgetFreemiusDeveloperCaches();
  mocks.candidates.mockReset().mockImplementation(async () => [PAIR]);
  mocks.assignInvoiceMetadata.mockClear();
  mocks.applyOrderInventoryDeduction.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('syncFreemiusCheckoutOrder with only the developer key pair', () => {
  it('marks a pending 43273 order with a fresh license and a subscription paid, with the license linked', async () => {
    const { calls } = stubFreemius({ subscription: { status: 200, body: SUBSCRIPTION } });
    const orders = [pendingOrder()];
    const db = fakeOrders(orders);

    const result = await syncFreemiusCheckoutOrder({
      orderId: 'order-43273',
      // The callback's own amount never marks an order paid, and it names no subscription: the paid
      // status and the subscription id below can only come from the purchase data read from Freemius.
      checkoutResponse: {
        purchase: { license_id: 7001, plugin_id: 43273, plan_id: 75655, user_id: 88, initial_amount: '200.00' },
        user: { id: 88, email: 'Partner@Example.com' },
      },
      client: db.client,
      now: NOW,
    });

    expect(result).toMatchObject({ success: true, orderId: 'order-43273', status: 'paid' });
    expect(db.updates).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      status: 'paid',
      freemius_license_id: '7001',
      freemius_subscription_id: '444',
      freemius_user_id: '88',
      freemius_plan_id: '75655',
      freemius_product_id: '43273',
    });
    expect(mocks.assignInvoiceMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.assignInvoiceMetadata).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order-43273' }));
    expect(mocks.applyOrderInventoryDeduction).toHaveBeenCalledTimes(1);
    // The license check and the purchase data both read Freemius at developer scope.
    expect(pathsRead(calls)).toEqual(
      expect.arrayContaining([
        '/plugins/43273/licenses/7001.json',
        '/plugins/43273/users/88.json',
        '/plugins/43273/licenses/7001/subscription.json',
      ])
    );
    expectEveryCallDeveloperSigned(calls);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('keeps a license without a subscription (404) a trial, linked but never paid', async () => {
    const { calls } = stubFreemius({ subscription: SUBSCRIPTION_NOT_FOUND });
    const orders = [pendingOrder()];
    const db = fakeOrders(orders);

    const result = await syncFreemiusCheckoutOrder({
      orderId: 'order-43273',
      checkoutResponse: {
        trial: { id: 9100, license_id: 7001, plugin_id: 43273, user_id: 88, trial_ends_at: '2026-11-26 14:59:00' },
        user: { id: 88, email: 'partner@example.com' },
      },
      client: db.client,
      now: NOW,
    });

    expect(result).toMatchObject({ success: true, orderId: 'order-43273', status: 'trial' });
    expect(orders[0]).toMatchObject({
      status: 'trial',
      freemius_license_id: '7001',
      freemius_user_id: '88',
      freemius_plan_id: '75655',
      freemius_product_id: '43273',
      freemius_subscription_id: null,
    });
    expect(mocks.assignInvoiceMetadata).not.toHaveBeenCalled();
    expect(mocks.applyOrderInventoryDeduction).not.toHaveBeenCalled();
    // The purchase data did ask for the subscription: the 404 is an answer, not a skipped step.
    expect(pathsRead(calls)).toContain('/plugins/43273/licenses/7001/subscription.json');
    expectEveryCallDeveloperSigned(calls);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('refuses another customer’s license read at developer scope, writing nothing', async () => {
    const { calls } = stubFreemius({
      subscription: { status: 200, body: SUBSCRIPTION },
      license: { status: 200, body: { ...LICENSE, user_id: 12, created: '2026-11-01 10:00:00' } },
    });
    const db = fakeOrders([pendingOrder()]);

    const result = await syncFreemiusCheckoutOrder({
      orderId: 'order-43273',
      checkoutResponse: { purchase: { license_id: 7001, user_id: 88 }, user: { id: 88, email: 'partner@example.com' } },
      client: db.client,
      now: NOW,
    });

    expect(result.success).toBe(false);
    expect(db.updates).toEqual([]);
    expect(mocks.assignInvoiceMetadata).not.toHaveBeenCalled();
    // Refused on the license itself: the purchase data is never read.
    expect(pathsRead(calls)).not.toContain('/plugins/43273/licenses/7001/subscription.json');
    expectEveryCallDeveloperSigned(calls);
  });
});
