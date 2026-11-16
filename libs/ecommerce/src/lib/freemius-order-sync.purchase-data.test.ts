import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review 2026-11-13 (vendor license routes, L4): the purchase-data read behind a webhook or a checkout
 * sync names a refused key as a configuration error. On the product bearer, `@freemius/sdk`'s
 * `retrievePurchaseData` returns null for any failure, so a wrong token silently left every order to
 * the event alone; at developer scope a 401/403 fell back to the bearer without a word. Both now
 * write one `console.error` line a minute per credential and product, naming no key. The sync itself
 * behaves as before (no purchase data: the event decides).
 */

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  candidates: vi.fn<() => Promise<Array<Record<string, string>>>>(async () => []),
  assignInvoiceMetadata: vi.fn(async () => ({ invoiceNumber: 'INV-1', paidAt: '2026-11-13T12:00:00Z' })),
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

const DEV = '4242';
const PAIR = { developerId: DEV, publicKey: 'pk_dev_sync_pair', secretKey: 'sk_dev_sync_pair_secret', source: 'env' };
const BEARER = { publicKey: 'pk_cortex_sync', secretKey: 'sk_cortex_sync_secret_0123456789abcdefg', apiKey: 'fs_sync_bearer_token' };
const KEY_MATERIAL = [PAIR.publicKey, PAIR.secretKey, BEARER.publicKey, BEARER.secretKey, BEARER.apiKey];

type Call = { host: string; path: string };
type Answer = { status: number; body?: unknown };

async function load() {
  vi.resetModules();
  const sync = await import('./freemius-order-sync');
  const developer = await import('./freemius-developer-api');
  developer.forgetFreemiusDeveloperCaches();
  return sync;
}

function stubFreemius(answer: (call: Call) => Answer | undefined) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const developerPrefix = `/v1/developers/${DEV}`;
      const call: Call = {
        host: url.host,
        path: url.pathname.startsWith(developerPrefix) ? url.pathname.slice(developerPrefix.length) : url.pathname.replace(/^\/v1/, ''),
      };
      calls.push(call);
      const result =
        answer(call) ??
        (call.host === 'api.freemius.com' && call.path === '/plugins.json'
          ? { status: 200, body: { plugins: [{ id: 28609 }] } }
          : { status: 404, body: { error: { code: 'not_found' } } });
      return new Response(result.body === undefined ? '' : JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
  return calls;
}

/** The PostgREST slice the webhook sync uses, over one orders table. */
function fakeOrders(rows: Row[]) {
  const client = {
    from: () => {
      const filters: Array<(row: Row) => boolean> = [];
      let pendingUpdate: Row | null = null;
      let single = false;
      const resolve = () => {
        const matched = rows.filter((row) => filters.every((filter) => filter(row)));
        if (pendingUpdate) {
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
  return client as never;
}

const pendingOrder = (): Row => ({
  id: 'order-1',
  status: 'pending',
  provider: 'freemius',
  created_at: '2026-11-13T11:58:00Z',
  freemius_product_id: '28609',
  freemius_license_id: '9001',
});

const paymentEvent = { type: 'payment.created', plugin_id: '28609', objects: { payment: { license_id: 9001, gross: 250 } } };

function configurationLines(): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.map((args) => args.map(String).join(' '))
    .filter((line) => line.includes('Configuration error'));
}

function loggedText(): string {
  return [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.warn).mock.calls]
    .map((args) => args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack ?? ''}` : String(arg))).join(' '))
    .join('\n');
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  for (const name of ['FREEMIUS_SECRET_KEY', 'FREEMIUS_PUBLIC_KEY', 'FREEMIUS_API_KEY', 'FREEMIUS_PRODUCT_ID']) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', JSON.stringify({ '28609': BEARER }));
  mocks.candidates.mockReset().mockImplementation(async () => []);
  mocks.assignInvoiceMetadata.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('purchase data with a refused key', () => {
  it.each([401, 403])('a %i to the product bearer: the event still decides, and one configuration line a minute says why', async (status) => {
    const { syncFreemiusOrderFromWebhookEvent } = await load();
    const calls = stubFreemius((call) => (call.host === 'fast-api.freemius.com' ? { status, body: {} } : undefined));
    const orders = [pendingOrder()];

    await expect(
      syncFreemiusOrderFromWebhookEvent({ event: paymentEvent, client: fakeOrders(orders), productId: '28609' })
    ).resolves.toMatchObject({ orderId: 'order-1', status: 'paid' });
    await syncFreemiusOrderFromWebhookEvent({ event: { ...paymentEvent, type: 'payment.created' }, client: fakeOrders([pendingOrder()]), productId: '28609' });

    expect(calls.some((call) => call.host === 'fast-api.freemius.com' && call.path === '/products/28609/licenses/9001.json')).toBe(true);
    expect(configurationLines()).toEqual([expect.stringContaining(`answered ${status} to product 28609's API bearer token on the purchase data lookup`)]);
    for (const secret of KEY_MATERIAL) expect(loggedText()).not.toContain(secret);
  });

  it('a 403 to the developer key pair is logged before the fallback to the product bearer, which then reads the purchase', async () => {
    mocks.candidates.mockImplementation(async () => [PAIR]);
    const { syncFreemiusOrderFromWebhookEvent } = await load();
    stubFreemius((call) => {
      if (call.host === 'api.freemius.com' && call.path === '/plugins/28609/licenses/9001.json') return { status: 403, body: {} };
      if (call.host !== 'fast-api.freemius.com') return undefined;
      if (call.path === '/products/28609/licenses/9001.json') {
        return {
          status: 200,
          body: {
            id: 9001,
            plugin_id: 28609,
            user_id: 77,
            plan_id: 47122,
            pricing_id: 6,
            quota: 1,
            created: '2026-11-13 11:59:00',
            expiration: '2027-11-13 11:59:00',
            is_cancelled: false,
          },
        };
      }
      if (call.path === '/products/28609/licenses/9001/subscription.json') {
        return { status: 200, body: { id: 333, initial_amount: '250.00', billing_cycle: 12, currency: 'usd', gateway: 'stripe' } };
      }
      if (call.path === '/products/28609/users/77.json') return { status: 200, body: { id: 77, email: 'buyer@example.com' } };
      return undefined;
    });
    const orders = [pendingOrder()];

    await expect(
      syncFreemiusOrderFromWebhookEvent({
        event: { type: 'subscription.created', plugin_id: '28609', objects: { license: { id: 9001, plugin_id: 28609 } } },
        client: fakeOrders(orders),
        productId: '28609',
      })
    ).resolves.toMatchObject({ status: 'paid' });
    expect(orders[0]).toMatchObject({ freemius_subscription_id: '333' });
    expect(configurationLines()).toEqual([expect.stringContaining('to the developer key pair on the purchase data lookup for product 28609')]);
    for (const secret of KEY_MATERIAL) expect(loggedText()).not.toContain(secret);
  });

  it.each([404, 500])('a %i on the bearer is no configuration error: no line, the event decides as before', async (status) => {
    const { syncFreemiusOrderFromWebhookEvent } = await load();
    stubFreemius((call) => (call.host === 'fast-api.freemius.com' ? { status, body: {} } : undefined));

    await expect(
      syncFreemiusOrderFromWebhookEvent({ event: paymentEvent, client: fakeOrders([pendingOrder()]), productId: '28609' })
    ).resolves.toMatchObject({ status: 'paid' });
    expect(configurationLines()).toEqual([]);
  });
});
