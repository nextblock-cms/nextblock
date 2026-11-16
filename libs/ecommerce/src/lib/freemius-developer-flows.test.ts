import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * With only the Freemius developer key pair configured (nextblock.dev: no
 * FREEMIUS_CHECKOUT_PRODUCTS_JSON, no per-product bearer), every post-sale step works for each
 * product the account owns (24851 Commerce Pro, 28609 Cortex AI, 43273 Affiliates):
 * webhooks (paid, refunds, disputes) verify with that product's own secret, purchase data moves
 * orders to paid, the success page shows the license key, the vendor claim hands it out, and
 * trials are minted. Each step reaches Freemius at developer scope, signed like the PHP SDK.
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

import { forgetFreemiusDeveloperCaches, getFreemiusDeveloperStatus, signFreemiusRequest } from './freemius-developer-api';
import { claimFreemiusLicenseKey } from './freemius-license-claim';
import { getFreemiusOrderLicense } from './freemius-license';
import {
  getFreemiusWebhookVerification,
  syncFreemiusOrderFromWebhookEvent,
  syncFreemiusOrderRefundFromWebhookEvent,
  verifyFreemiusWebhookRequest,
  verifyFreemiusWebhookSignature,
} from './freemius-order-sync';
import { provisionFreemiusTrialLicense } from './freemius-trial-provision';
import { resolveFreemiusProductCredentials } from './providers/freemius';

const DEV = '4242';
const PAIR = { developerId: DEV, publicKey: 'pk_dev_flows', secretKey: 'sk_dev_flows', source: 'env' };
const PRODUCTS: Record<string, { name: string; public_key: string; secret_key: string }> = {
  '24851': { name: 'Commerce Pro', public_key: 'pk_commerce', secret_key: 'sk_commerce_webhooks' },
  '28609': { name: 'Cortex AI', public_key: 'pk_cortex', secret_key: 'sk_cortex_webhooks' },
  '43273': { name: 'Affiliates', public_key: 'pk_affiliates', secret_key: 'sk_affiliates_webhooks' },
};
const NOW = new Date('2026-11-12T15:00:00Z');

type Call = { url: string; method: string; path: string; body: string | undefined; headers: Record<string, string> };
type Answer = { status: number; body?: unknown };

/** api.freemius.com for the developer account: its products and keys, then `answer` for the rest. */
function stubFreemius(answer: (call: Call) => Answer | undefined = () => undefined) {
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
    const custom = answer(call);
    let result: Answer;
    if (custom) {
      result = custom;
    } else if (call.path.startsWith('/plugins.json')) {
      result = { status: 200, body: { plugins: Object.keys(PRODUCTS).map((id) => ({ id: Number(id) })) } };
    } else {
      const product = call.path.match(/^\/plugins\/(\d+)\.json$/);
      result =
        product && PRODUCTS[product[1]]
          ? { status: 200, body: { id: Number(product[1]), ...PRODUCTS[product[1]] } }
          : { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } };
    }
    return new Response(result.body === undefined ? '' : JSON.stringify(result.body), { status: result.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function findCall(calls: Call[], predicate: (call: Call) => boolean): Call {
  const call = calls.find(predicate);
  if (!call) throw new Error('the expected request was not sent');
  return call;
}

function expectDeveloperSigned(call: Call) {
  expect(call.url.startsWith(`https://api.freemius.com/v1/developers/${DEV}/`)).toBe(true);
  expect(call.headers['Authorization']).toBe(
    signFreemiusRequest({
      body: call.body ?? '',
      date: call.headers['Date'],
      method: call.method as 'GET',
      path: call.url.replace('https://api.freemius.com', ''),
      publicKey: PAIR.publicKey,
      scopeId: DEV,
      secretKey: PAIR.secretKey,
    }).authorization
  );
}

function sign(rawBody: string, secret: string) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function webhookBody(productId: string | number, type = 'payment.created', extra: Row = {}) {
  return JSON.stringify({ id: '880001', type, plugin_id: productId, objects: { payment: { license_id: 9001, gross: 250 } }, ...extra });
}

/** The PostgREST slice these flows use, over one orders table. */
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
  for (const name of ['FREEMIUS_CHECKOUT_PRODUCTS_JSON', 'FREEMIUS_SECRET_KEY', 'FREEMIUS_PUBLIC_KEY', 'FREEMIUS_API_KEY', 'FREEMIUS_PRODUCT_ID', 'FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY']) {
    vi.stubEnv(name, '');
  }
  forgetFreemiusDeveloperCaches();
  mocks.candidates.mockReset().mockImplementation(async () => [PAIR]);
  mocks.assignInvoiceMetadata.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getFreemiusWebhookVerification: each event with its own product’s secret', () => {
  it.each(Object.keys(PRODUCTS))('accepts an event of %s signed with that product’s secret, refunds and disputes included', async (productId) => {
    stubFreemius();

    for (const type of ['payment.created', 'payment.refund', 'payment.dispute.created', 'payment.dispute.lost']) {
      const body = webhookBody(productId, type);
      await expect(getFreemiusWebhookVerification(body, sign(body, PRODUCTS[productId].secret_key)), type).resolves.toEqual({
        outcome: 'valid',
        productId,
      });
      await expect(verifyFreemiusWebhookRequest(body, sign(body, PRODUCTS[productId].secret_key)), type).resolves.toBe(true);
    }
  });

  it('refuses an event signed with another product’s secret', async () => {
    // Even when that other secret is also configured the old way: the developer account vouches
    // for 43273's own secret, so nothing else is tried.
    vi.stubEnv('FREEMIUS_SECRET_KEY', PRODUCTS['24851'].secret_key);
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', JSON.stringify({ '43273': { publicKey: 'pk_x', secretKey: PRODUCTS['24851'].secret_key } }));
    stubFreemius();
    const body = webhookBody('43273');

    await expect(getFreemiusWebhookVerification(body, sign(body, PRODUCTS['24851'].secret_key))).resolves.toEqual({
      outcome: 'invalid',
      productId: '43273',
      reason: 'signature_mismatch',
    });
    await expect(verifyFreemiusWebhookRequest(body, sign(body, PAIR.secretKey))).resolves.toBe(false);
  });

  it('refuses a body changed after signing (another product id, a re-serialization)', async () => {
    stubFreemius();
    const original = webhookBody('24851');
    const signature = sign(original, PRODUCTS['24851'].secret_key);

    await expect(verifyFreemiusWebhookRequest(original.replace('"plugin_id":"24851"', '"plugin_id":"43273"'), signature)).resolves.toBe(false);
    await expect(verifyFreemiusWebhookRequest(JSON.stringify(JSON.parse(original), null, 1), signature)).resolves.toBe(false);
  });

  it('refuses a missing or malformed signature without asking Freemius', async () => {
    const { fetchMock } = stubFreemius();
    const body = webhookBody('24851');

    for (const signature of [null, '', 'abc', sign(body, 'x').slice(0, 63), `${sign(body, 'x')}00`, 'z'.repeat(64)]) {
      await expect(getFreemiusWebhookVerification(body, signature)).resolves.toEqual({
        outcome: 'invalid',
        productId: null,
        reason: 'malformed_signature',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an event that names no product (plugin_id), whatever configured secret signed it, without asking Freemius', async () => {
    vi.stubEnv('FREEMIUS_PRODUCT_ID', '24851');
    vi.stubEnv('FREEMIUS_SECRET_KEY', 'sk_one_product');
    vi.stubEnv('FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY', 'sk_sandbox_override');
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', JSON.stringify({ '28609': { publicKey: 'pk_b', secretKey: 'sk_json_b' } }));
    const { fetchMock } = stubFreemius();
    const refund = { id: '1', type: 'payment.refund', objects: { payment: { license_id: 9001, gross: 1 } } };
    const bodies = [
      JSON.stringify(refund),
      JSON.stringify({ ...refund, plugin_id: null }),
      JSON.stringify({ ...refund, plugin_id: 0 }),
      JSON.stringify({ ...refund, plugin_id: 'abc' }),
      JSON.stringify({ ...refund, plugin_id: '24851/../1' }),
      JSON.stringify({ ...refund, plugin_id: 24851.5 }),
      // A product named only inside the objects is not the event's product.
      JSON.stringify({ ...refund, objects: { license: { plugin_id: 24851 }, payment: { license_id: 9001 } } }),
      JSON.stringify([{ ...refund, plugin_id: 24851 }]),
      'not json',
    ];

    for (const body of bodies) {
      for (const secret of ['sk_one_product', 'sk_sandbox_override', 'sk_json_b', PRODUCTS['24851'].secret_key]) {
        await expect(getFreemiusWebhookVerification(body, sign(body, secret)), body).resolves.toEqual({
          outcome: 'invalid',
          productId: null,
          reason: 'missing_product_id',
        });
        expect(verifyFreemiusWebhookSignature(body, sign(body, secret)), body).toBe(false);
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never reads a product the account does not own: such an event is checked with that product’s own entry only', async () => {
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', JSON.stringify({ '777': { publicKey: 'pk_other', secretKey: 'sk_other_account' } }));
    vi.stubEnv('FREEMIUS_SECRET_KEY', 'sk_one_product_24851');
    vi.stubEnv('FREEMIUS_PRODUCT_ID', '24851');
    const { calls } = stubFreemius();
    const body = webhookBody('777');

    await expect(getFreemiusWebhookVerification(body, sign(body, 'sk_other_account'))).resolves.toEqual({ outcome: 'valid', productId: '777' });
    // Not with an owned product's secret, nor with the one-product secret, which belongs to 24851.
    for (const secret of [PRODUCTS['24851'].secret_key, 'sk_one_product_24851', PAIR.secretKey]) {
      await expect(getFreemiusWebhookVerification(body, sign(body, secret))).resolves.toEqual({
        outcome: 'invalid',
        productId: '777',
        reason: 'signature_mismatch',
      });
    }
    // The one-product secret verifies 777 once FREEMIUS_PRODUCT_ID names it.
    vi.stubEnv('FREEMIUS_PRODUCT_ID', '777');
    await expect(getFreemiusWebhookVerification(body, sign(body, 'sk_one_product_24851'))).resolves.toEqual({ outcome: 'valid', productId: '777' });
    expect(calls.some((call) => call.path === '/plugins/777.json')).toBe(false);
  });

  it('another product’s secret no longer verifies: no plugin_id, a product outside the account, an owned product whose key read fails', async () => {
    // The review's probe: the one-product secret holds Cortex's secret (no FREEMIUS_PRODUCT_ID), and
    // 24851's key read answers 503.
    vi.stubEnv('FREEMIUS_SECRET_KEY', PRODUCTS['28609'].secret_key);
    stubFreemius((call) => (call.path === '/plugins/24851.json' ? { status: 503, body: {} } : undefined));
    const cortex = PRODUCTS['28609'].secret_key;
    const refund = (extra: Row) =>
      JSON.stringify({ id: '880002', type: 'payment.refund', objects: { payment: { license_id: 9001, gross: 1 } }, ...extra });

    const anonymous = refund({});
    await expect(getFreemiusWebhookVerification(anonymous, sign(anonymous, cortex))).resolves.toMatchObject({
      outcome: 'invalid',
      reason: 'missing_product_id',
    });

    // A product outside the account is checked with its bound secrets and, the Product ID being
    // empty, the one-product secret standing in for it (the key policy below): never with an owned
    // product's secret that is configured nowhere.
    const outside = refund({ plugin_id: 1 });
    await expect(getFreemiusWebhookVerification(outside, sign(outside, PRODUCTS['43273'].secret_key))).resolves.toEqual({
      outcome: 'invalid',
      productId: '1',
      reason: 'signature_mismatch',
    });

    const paid = webhookBody('24851');
    await expect(getFreemiusWebhookVerification(paid, sign(paid, cortex))).resolves.toEqual({
      outcome: 'unverifiable',
      productId: '24851',
      reason: 'product_key_read_failed',
      developerStatus: 'working',
    });
    await expect(verifyFreemiusWebhookRequest(paid, sign(paid, cortex))).resolves.toBe(false);

    // Nor another product's FREEMIUS_CHECKOUT_PRODUCTS_JSON entry.
    vi.stubEnv('FREEMIUS_SECRET_KEY', '');
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', JSON.stringify({ '28609': { publicKey: 'pk_cortex', secretKey: cortex } }));
    await expect(getFreemiusWebhookVerification(paid, sign(paid, cortex))).resolves.toMatchObject({ outcome: 'unverifiable' });
  });

  it('when Freemius cannot be reached, accepts that product’s own configured secret and answers unverifiable otherwise', async () => {
    vi.stubEnv('FREEMIUS_SECRET_KEY', 'sk_single_configured');
    vi.stubEnv('FREEMIUS_PRODUCT_ID', '24851');
    stubFreemius((call) => (call.path === '/plugins/24851.json' ? { status: 503, body: {} } : undefined));
    const body = webhookBody('24851');

    await expect(getFreemiusWebhookVerification(body, sign(body, 'sk_single_configured'))).resolves.toEqual({ outcome: 'valid', productId: '24851' });
    // Its real secret cannot be checked right now: 503, so Freemius redelivers it (not 401).
    await expect(getFreemiusWebhookVerification(body, sign(body, PRODUCTS['24851'].secret_key))).resolves.toEqual({
      outcome: 'unverifiable',
      productId: '24851',
      reason: 'product_key_read_failed',
      developerStatus: 'working',
    });
    // The one-product secret of another product never stands in for it.
    vi.stubEnv('FREEMIUS_PRODUCT_ID', '28609');
    await expect(getFreemiusWebhookVerification(body, sign(body, 'sk_single_configured'))).resolves.toMatchObject({ outcome: 'unverifiable' });
  });

  it('answers unverifiable when Freemius cannot be asked about the pair at all, unless the product’s own entry matches', async () => {
    stubFreemius((call) => (call.path.startsWith('/plugins.json') ? { status: 503, body: {} } : undefined));
    const body = webhookBody('24851');

    await expect(getFreemiusWebhookVerification(body, sign(body, PRODUCTS['24851'].secret_key))).resolves.toEqual({
      outcome: 'unverifiable',
      productId: '24851',
      reason: 'developer_pair_unreachable',
      developerStatus: 'unreachable',
    });
    // The pair may own 24851: a one-product secret not bound to it by FREEMIUS_PRODUCT_ID never stands in.
    vi.stubEnv('FREEMIUS_SECRET_KEY', 'sk_one_product');
    await expect(getFreemiusWebhookVerification(body, sign(body, 'sk_one_product'))).resolves.toMatchObject({ outcome: 'unverifiable' });

    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', JSON.stringify({ '24851': { publicKey: 'pk_a', secretKey: 'sk_json_a' } }));
    await expect(getFreemiusWebhookVerification(body, sign(body, 'sk_json_a'))).resolves.toEqual({ outcome: 'valid', productId: '24851' });
  });

  it('answers unverifiable for a product the account lists but whose keys Freemius does not return', async () => {
    stubFreemius((call) => (call.path === '/plugins/43273.json' ? { status: 404, body: { error: { code: 'not_found' } } } : undefined));
    const body = webhookBody('43273');

    await expect(getFreemiusWebhookVerification(body, sign(body, PRODUCTS['43273'].secret_key))).resolves.toEqual({
      outcome: 'unverifiable',
      productId: '43273',
      reason: 'product_keys_unavailable',
      developerStatus: 'working',
    });
  });

  it('with a refused dedicated developer pair: unverifiable (503), and the one-product secret never stands in', async () => {
    // Review 2026-11-13: a rotated or revoked pair let FREEMIUS_SECRET_KEY (another product's secret,
    // or the revoked developer secret left there) verify payments and refunds of every product.
    stubFreemius((call) => (call.path.startsWith('/plugins.json') ? { status: 401, body: { error: { code: 'unauthorized' } } } : undefined));
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', 'pk_one_product');
    vi.stubEnv('FREEMIUS_SECRET_KEY', 'sk_one_product');
    const body = webhookBody('24851');
    const refused = { outcome: 'unverifiable', productId: '24851', reason: 'developer_pair_refused', developerStatus: 'refused' };

    await expect(getFreemiusWebhookVerification(body, sign(body, PRODUCTS['24851'].secret_key))).resolves.toEqual(refused);
    await expect(getFreemiusWebhookVerification(body, sign(body, 'sk_one_product'))).resolves.toEqual(refused);
    await expect(verifyFreemiusWebhookRequest(body, sign(body, 'sk_one_product'))).resolves.toBe(false);

    // The same with a legacy candidate beside the dedicated one (both refused).
    mocks.candidates.mockImplementation(async () => [PAIR, { developerId: DEV, publicKey: 'pk_one_product', secretKey: 'sk_one_product', source: 'env-legacy' }]);
    forgetFreemiusDeveloperCaches();
    await expect(getFreemiusWebhookVerification(body, sign(body, 'sk_one_product'))).resolves.toEqual(refused);
  });

  it('without a developer pair, checks the event’s own entry of FREEMIUS_CHECKOUT_PRODUCTS_JSON only', async () => {
    mocks.candidates.mockImplementation(async () => []);
    vi.stubEnv(
      'FREEMIUS_CHECKOUT_PRODUCTS_JSON',
      JSON.stringify({ '24851': { publicKey: 'pk_a', secretKey: 'sk_json_a' }, '28609': { publicKey: 'pk_b', secretKey: 'sk_json_b' } })
    );
    const { fetchMock } = stubFreemius();
    const body = webhookBody('24851');

    await expect(verifyFreemiusWebhookRequest(body, sign(body, 'sk_json_a'))).resolves.toBe(true);
    await expect(verifyFreemiusWebhookRequest(body, sign(body, 'sk_json_b'))).resolves.toBe(false);
    // An event without a product id is refused: it used to be checked against every configured secret.
    const anonymous = JSON.stringify({ id: '1', type: 'install.installed' });
    await expect(verifyFreemiusWebhookRequest(anonymous, sign(anonymous, 'sk_json_b'))).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('without a developer pair or FREEMIUS_PRODUCT_ID, the one-product secret checks a product without an entry, as the checkout does', async () => {
    mocks.candidates.mockImplementation(async () => []);
    vi.stubEnv('FREEMIUS_SECRET_KEY', 'sk_one_product');
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', JSON.stringify({ '28609': { publicKey: 'pk_b', secretKey: 'sk_json_b' } }));
    stubFreemius();
    const commerce = webhookBody('24851');
    const cortex = webhookBody('28609');

    await expect(getFreemiusWebhookVerification(commerce, sign(commerce, 'sk_one_product'))).resolves.toEqual({ outcome: 'valid', productId: '24851' });
    expect(verifyFreemiusWebhookSignature(commerce, sign(commerce, 'sk_one_product'))).toBe(true);
    // 28609 has an entry of its own: only that entry verifies it.
    await expect(getFreemiusWebhookVerification(cortex, sign(cortex, 'sk_one_product'))).resolves.toMatchObject({ outcome: 'invalid' });
    expect(verifyFreemiusWebhookSignature(cortex, sign(cortex, 'sk_one_product'))).toBe(false);
    expect(verifyFreemiusWebhookSignature(cortex, sign(cortex, 'sk_json_b'))).toBe(true);
    // Once FREEMIUS_PRODUCT_ID names another product, the one-product secret is that product's only.
    vi.stubEnv('FREEMIUS_PRODUCT_ID', '43273');
    await expect(getFreemiusWebhookVerification(commerce, sign(commerce, 'sk_one_product'))).resolves.toMatchObject({ outcome: 'invalid' });
    expect(verifyFreemiusWebhookSignature(commerce, sign(commerce, 'sk_one_product'))).toBe(false);
  });

  it('reads a rotated secret once more (at most once a minute), then accepts events signed with it', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    let rotated = false;
    const { calls } = stubFreemius((call) =>
      rotated && call.path === '/plugins/28609.json'
        ? { status: 200, body: { id: 28609, public_key: 'pk_cortex', secret_key: 'sk_cortex_rotated' } }
        : undefined
    );
    const body = webhookBody('28609');

    await expect(verifyFreemiusWebhookRequest(body, sign(body, PRODUCTS['28609'].secret_key))).resolves.toBe(true);
    rotated = true;
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    await expect(verifyFreemiusWebhookRequest(body, sign(body, 'sk_cortex_rotated'))).resolves.toBe(true);
    // A forged signature right after triggers no further read.
    await expect(verifyFreemiusWebhookRequest(body, sign(body, 'sk_forged'))).resolves.toBe(false);

    expect(calls.filter((call) => call.path === '/plugins/28609.json')).toHaveLength(2);
  });

  it('answers unverifiable, never valid, when the re-read of a possibly rotated secret gets no answer', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    let failing = false;
    const { calls } = stubFreemius((call) => (failing && call.path === '/plugins/28609.json' ? { status: 503, body: {} } : undefined));
    const body = webhookBody('28609');
    const unverifiable = { outcome: 'unverifiable', productId: '28609', reason: 'product_key_read_failed', developerStatus: 'working' };

    await expect(verifyFreemiusWebhookRequest(body, sign(body, PRODUCTS['28609'].secret_key))).resolves.toBe(true);
    failing = true;
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));

    // Signed with a secret the cached keys refuse: perhaps rotated, perhaps forged; Freemius cannot say.
    await expect(getFreemiusWebhookVerification(body, sign(body, 'sk_cortex_rotated'))).resolves.toEqual(unverifiable);
    await expect(getFreemiusWebhookVerification(body, sign(body, 'sk_forged'))).resolves.toEqual(unverifiable);
    await expect(verifyFreemiusWebhookRequest(body, sign(body, 'sk_cortex_rotated'))).resolves.toBe(false);
    // The cached secret still verifies the events it signs meanwhile.
    await expect(getFreemiusWebhookVerification(body, sign(body, PRODUCTS['28609'].secret_key))).resolves.toEqual({
      outcome: 'valid',
      productId: '28609',
    });
    // And the forged signatures did not turn into one Freemius read each.
    expect(calls.filter((call) => call.path === '/plugins/28609.json').length).toBeLessThanOrEqual(3);
  });

  it('on the sandbox reads nothing at developer scope: only the configured secrets', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const { fetchMock } = stubFreemius();
    const body = webhookBody('24851');

    await expect(getFreemiusWebhookVerification(body, sign(body, PRODUCTS['24851'].secret_key))).resolves.toMatchObject({ outcome: 'invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.candidates).not.toHaveBeenCalled();
  });

  it('keeps verifyFreemiusWebhookSignature synchronous: an async one would let old route code pass forgeries', () => {
    const result = verifyFreemiusWebhookSignature('{}', 'a'.repeat(64));

    expect(result).toBe(false);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('keeps verifyFreemiusWebhookSignature to the event’s own product’s configured secrets', () => {
    vi.stubEnv(
      'FREEMIUS_CHECKOUT_PRODUCTS_JSON',
      JSON.stringify({ '24851': { publicKey: 'pk_a', secretKey: 'sk_json_a' }, '28609': { publicKey: 'pk_b', secretKey: 'sk_json_b' } })
    );
    vi.stubEnv('FREEMIUS_SECRET_KEY', 'sk_one_product');
    vi.stubEnv('FREEMIUS_PRODUCT_ID', '43273');
    const commerce = webhookBody('24851');
    const affiliates = webhookBody('43273');

    expect(verifyFreemiusWebhookSignature(commerce, sign(commerce, 'sk_json_a'))).toBe(true);
    expect(verifyFreemiusWebhookSignature(commerce, sign(commerce, 'sk_json_b'))).toBe(false);
    expect(verifyFreemiusWebhookSignature(commerce, sign(commerce, 'sk_one_product'))).toBe(false);
    expect(verifyFreemiusWebhookSignature(affiliates, sign(affiliates, 'sk_one_product'))).toBe(true);
    expect(verifyFreemiusWebhookSignature(affiliates, sign(affiliates, 'sk_json_a'))).toBe(false);
  });

  it('a verified event of a product outside the account never touches an order of another product', async () => {
    // The owner of a product listed in FREEMIUS_CHECKOUT_PRODUCTS_JSON signs a refund naming the
    // license of a 24851 order: it verifies, for 777 only, and the refund changes nothing.
    vi.stubEnv('FREEMIUS_CHECKOUT_PRODUCTS_JSON', JSON.stringify({ '777': { publicKey: 'pk_other', secretKey: 'sk_other_account' } }));
    stubFreemius();
    const raw = JSON.stringify({ id: '880003', type: 'payment.refund', plugin_id: 777, objects: { payment: { license_id: 9001 } } });
    const verification = await getFreemiusWebhookVerification(raw, sign(raw, 'sk_other_account'));
    const orders = [{ id: 'order-24851', status: 'paid', provider: 'freemius', freemius_product_id: '24851', freemius_license_id: '9001' }];
    const db = fakeOrders(orders);

    expect(verification).toEqual({ outcome: 'valid', productId: '777' });
    const productId = verification.outcome === 'valid' ? verification.productId : 'none';
    await expect(
      syncFreemiusOrderRefundFromWebhookEvent({ event: { ...JSON.parse(raw), plugin_id: productId }, productId, client: db.client })
    ).resolves.toMatchObject({ isRefund: true, orderId: null, statusUpdated: false, reason: 'product_mismatch' });
    expect(orders[0].status).toBe('paid');
    expect(db.updates).toEqual([]);
  });
});

/**
 * Review 2026-11-13, round 2: the one-product secret (FREEMIUS_SECRET_KEY) for a product without
 * bound keys (no JSON entry, FREEMIUS_PRODUCT_ID empty) follows the key policy the checkout follows
 * (freemius-key-policy.ts). It stands in only where it cannot be the developer key pair.
 */
describe('the one-product secret for a product without bound keys (key policy)', () => {
  const ONE_PRODUCT = { publicKey: 'pk_one_product', secretKey: 'sk_one_product' };
  const LEGACY_ONLY = { developerId: DEV, ...ONE_PRODUCT, source: 'env-legacy' };
  const refusedList = (call: Call): Answer | undefined =>
    call.path.startsWith('/plugins.json') ? { status: 401, body: { error: { code: 'unauthorized' } } } : undefined;

  beforeEach(() => {
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', ONE_PRODUCT.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', ONE_PRODUCT.secretKey);
  });

  /** The one-product keys confirmation: a product-scope read of `productId` signed with `publicKey`. */
  const productScopeRead = (call: Call) => call.url.match(/^https:\/\/api\.freemius\.com\/v1\/plugins\/(\d+)\.json$/)?.[1] ?? null;
  const signedWith = (call: Call) => String(call.headers['Authorization'] ?? '').split(' ')[1]?.split(':')[1] ?? '';
  /** Freemius confirms the one-product keys for `owner` only, and refuses the legacy names as a developer pair. */
  const oneProductInstall = (owner: string, answer: (productId: string) => number = (id) => (id === owner ? 200 : 401)) => (call: Call): Answer | undefined => {
    const productId = productScopeRead(call);
    if (productId) {
      const status = signedWith(call) === ONE_PRODUCT.publicKey ? answer(productId) : 401;
      return status === 200 ? { status, body: { id: Number(productId), public_key: ONE_PRODUCT.publicKey } } : { status, body: {} };
    }
    return refusedList(call);
  };

  it('a one-product install whose developer id was filled in (only the one-product names, refused as a pair): accepted once Freemius confirms they are this product’s keys', async () => {
    mocks.candidates.mockImplementation(async () => [LEGACY_ONLY]);
    const { calls } = stubFreemius(oneProductInstall('24851'));
    const body = webhookBody('24851', 'payment.refund');

    await expect(getFreemiusWebhookVerification(body, sign(body, ONE_PRODUCT.secretKey))).resolves.toEqual({ outcome: 'valid', productId: '24851' });
    // Anything else still cannot be checked while the "pair" is refused: redelivered, never processed.
    await expect(getFreemiusWebhookVerification(body, sign(body, 'sk_forged'))).resolves.toEqual({
      outcome: 'unverifiable',
      productId: '24851',
      reason: 'developer_pair_refused',
      developerStatus: 'refused',
    });
    // One confirmation, kept: the next events ask Freemius nothing.
    await expect(getFreemiusWebhookVerification(body, sign(body, ONE_PRODUCT.secretKey))).resolves.toMatchObject({ outcome: 'valid' });
    expect(calls.filter((call) => productScopeRead(call))).toHaveLength(1);

    // The CMS one-product fields tried as a pair too: still only one-product names.
    mocks.candidates.mockImplementation(async () => [{ ...LEGACY_ONLY, source: 'cms-legacy' }, LEGACY_ONLY]);
    forgetFreemiusDeveloperCaches();
    await expect(getFreemiusWebhookVerification(body, sign(body, ONE_PRODUCT.secretKey))).resolves.toMatchObject({ outcome: 'valid' });
  });

  /**
   * Review 2026-11-13, round 3: with every configured pair under the one-product names and refused,
   * the one-product secret verified every product without bound keys, though those names may hold a
   * revoked developer pair (nextblock.dev keeps its pair there), its leaked secret included.
   */
  it('a one-product install with a developer id: another product’s events signed with that secret are refused (401)', async () => {
    mocks.candidates.mockImplementation(async () => [LEGACY_ONLY]);
    stubFreemius(oneProductInstall('24851'));

    for (const productId of ['28609', '43273', '777']) {
      const body = webhookBody(productId, 'payment.created');
      await expect(getFreemiusWebhookVerification(body, sign(body, ONE_PRODUCT.secretKey))).resolves.toEqual({
        outcome: 'invalid',
        productId,
        reason: 'signature_mismatch',
      });
    }
  });

  it('a revoked developer pair under the one-product names verifies nothing: its secret is refused, genuine events are redelivered', async () => {
    const REVOKED = { developerId: DEV, publicKey: 'pk_dev_revoked_flows', secretKey: 'sk_dev_revoked_flows', source: 'env-legacy' };
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', REVOKED.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', REVOKED.secretKey);
    mocks.candidates.mockImplementation(async () => [REVOKED]);
    // Freemius refuses the pair at developer scope and at every product's scope.
    const { calls } = stubFreemius((call) => (productScopeRead(call) ? { status: 401, body: {} } : refusedList(call)));

    for (const productId of ['24851', '28609', '43273', '777']) {
      const body = webhookBody(productId, 'payment.created');
      await expect(getFreemiusWebhookVerification(body, sign(body, REVOKED.secretKey)), productId).resolves.toEqual({
        outcome: 'invalid',
        productId,
        reason: 'signature_mismatch',
      });
      await expect(verifyFreemiusWebhookRequest(body, sign(body, REVOKED.secretKey)), productId).resolves.toBe(false);
    }
    // A genuine event, signed with its product's own secret, waits until the pair is fixed (503).
    const genuine = webhookBody('28609', 'payment.created');
    await expect(getFreemiusWebhookVerification(genuine, sign(genuine, PRODUCTS['28609'].secret_key))).resolves.toEqual({
      outcome: 'unverifiable',
      productId: '28609',
      reason: 'developer_pair_refused',
      developerStatus: 'refused',
    });
    expect(calls.filter((call) => productScopeRead(call)).length).toBe(4);
  });

  /**
   * Review 2026-11-13, round 3 (K1, both reviewers' probe): a revoked developer pair under the
   * one-product names, its developer scope answering 401 and its product-scope read 200 `{}`. That
   * 200 confirmed the keys for every product, so checkout opened with the revoked public key (order
   * written) and events signed with the revoked secret verified for any product. A 200 must now be
   * the product itself.
   */
  it('a revoked developer pair under the one-product names verifies nothing when its product-scope read answers 200 {}, and opens no checkout', async () => {
    // Keys no other test of this file sends: what Freemius accepted is remembered for the module's life.
    const REVOKED = { developerId: DEV, publicKey: 'pk_dev_revoked_empty_200', secretKey: 'sk_dev_revoked_empty_200', source: 'env-legacy' };
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', REVOKED.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', REVOKED.secretKey);
    mocks.candidates.mockImplementation(async () => [REVOKED]);
    const { calls } = stubFreemius((call) => (productScopeRead(call) ? { status: 200, body: {} } : refusedList(call)));

    for (const productId of ['24851', '28609', '43273', '777']) {
      const body = webhookBody(productId, 'payment.created');
      // Redelivered (503), never processed: Freemius did not say these keys are this product's.
      await expect(getFreemiusWebhookVerification(body, sign(body, REVOKED.secretKey)), productId).resolves.toEqual({
        outcome: 'unverifiable',
        productId,
        reason: 'one_product_keys_unconfirmed',
        developerStatus: 'refused',
      });
      await expect(verifyFreemiusWebhookRequest(body, sign(body, REVOKED.secretKey)), productId).resolves.toBe(false);
      // The checkout gets no keys at all (the keyed 503 before any write), never the revoked public key.
      await expect(resolveFreemiusProductCredentials(productId), productId).resolves.toEqual({
        publicKey: null,
        secretKey: null,
        apiKey: null,
        source: 'none',
        refusal: 'one_product_keys_unconfirmed',
      });
    }
    // One confirmation per product, its unknown answer kept 30 s.
    expect(calls.filter((call) => productScopeRead(call))).toHaveLength(4);
  });

  it('asks Freemius to confirm the keys only for an event their secret signed: a forger without it sends nothing', async () => {
    mocks.candidates.mockImplementation(async () => [LEGACY_ONLY]);
    const { calls } = stubFreemius(oneProductInstall('24851'));

    for (let i = 0; i < 20; i += 1) {
      const body = webhookBody(String(500000 + i), 'payment.created');
      await expect(getFreemiusWebhookVerification(body, sign(body, `sk_forged_${i}`))).resolves.toMatchObject({ outcome: 'unverifiable' });
    }
    expect(calls.filter((call) => productScopeRead(call))).toEqual([]);
  });

  it('20 events signed with the one-product secret for random product ids send a bounded number of confirmations', async () => {
    mocks.candidates.mockImplementation(async () => [LEGACY_ONLY]);
    const { calls } = stubFreemius(oneProductInstall('24851'));
    const outcomes: string[] = [];

    for (let i = 0; i < 20; i += 1) {
      const body = webhookBody(String(700000 + i), 'payment.created');
      outcomes.push((await getFreemiusWebhookVerification(body, sign(body, ONE_PRODUCT.secretKey))).outcome);
    }

    expect(calls.filter((call) => productScopeRead(call))).toHaveLength(10);
    // Refused by Freemius, or not asked (503, redelivered): never valid.
    expect(outcomes.filter((outcome) => outcome === 'invalid')).toHaveLength(10);
    expect(outcomes.filter((outcome) => outcome === 'unverifiable')).toHaveLength(10);
  });

  it('answers unverifiable (503) while Freemius does not answer whether the one-product keys are this product’s', async () => {
    mocks.candidates.mockImplementation(async () => [LEGACY_ONLY]);
    stubFreemius(oneProductInstall('24851', () => 503));
    const body = webhookBody('24851', 'payment.refund');

    await expect(getFreemiusWebhookVerification(body, sign(body, ONE_PRODUCT.secretKey))).resolves.toEqual({
      outcome: 'unverifiable',
      productId: '24851',
      reason: 'one_product_keys_unconfirmed',
      developerStatus: 'refused',
    });
    await expect(verifyFreemiusWebhookRequest(body, sign(body, ONE_PRODUCT.secretKey))).resolves.toBe(false);
  });

  /**
   * Review 2026-11-13, round 3: the secret FREEMIUS_PRODUCT_ID binds was accepted whatever it was,
   * the developer secret included (a revoked one too) when the one-product names hold the pair.
   */
  it('refuses the developer secret as the bound secret of the product FREEMIUS_PRODUCT_ID names, when its key read fails', async () => {
    vi.stubEnv('FREEMIUS_PRODUCT_ID', '28609');
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', PAIR.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', PAIR.secretKey);
    const body = webhookBody('28609', 'payment.created');
    const unverifiable = { outcome: 'unverifiable', productId: '28609', reason: 'product_key_read_failed', developerStatus: 'working' };

    for (const candidates of [[{ ...PAIR, source: 'env-legacy' }], [{ ...PAIR, source: 'cms-legacy' }], [PAIR]]) {
      mocks.candidates.mockImplementation(async () => candidates);
      forgetFreemiusDeveloperCaches();
      stubFreemius((call) => (call.path === '/plugins/28609.json' ? { status: 503, body: {} } : undefined));

      await expect(getFreemiusWebhookVerification(body, sign(body, PAIR.secretKey)), candidates[0].source).resolves.toEqual(unverifiable);
      await expect(getFreemiusWebhookVerification(body, sign(body, PRODUCTS['28609'].secret_key))).resolves.toEqual(unverifiable);
    }

    // The product's own keys in those names stay bound to it: they verify through the failed read.
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', 'pk_single_cortex');
    vi.stubEnv('FREEMIUS_SECRET_KEY', 'sk_single_cortex');
    await expect(getFreemiusWebhookVerification(body, sign(body, 'sk_single_cortex'))).resolves.toEqual({ outcome: 'valid', productId: '28609' });
  });

  it('a working dedicated pair: accepted for a product the account does not own (an answered list), for that product only', async () => {
    // With a developer id set the resolver also lists the one-product names as a (legacy) pair,
    // after the dedicated one that works: they are still that product's keys.
    mocks.candidates.mockImplementation(async () => [PAIR, LEGACY_ONLY]);
    const { calls } = stubFreemius();
    const outside = webhookBody('777', 'payment.refund');

    await expect(getFreemiusWebhookVerification(outside, sign(outside, ONE_PRODUCT.secretKey))).resolves.toEqual({ outcome: 'valid', productId: '777' });
    expect(calls.some((call) => call.path === '/plugins/777.json')).toBe(false);
    // Bound to 777: a refund naming a 24851 order's license changes nothing.
    const orders = [{ id: 'order-24851', status: 'paid', provider: 'freemius', freemius_product_id: '24851', freemius_license_id: '9001' }];
    const db = fakeOrders(orders);
    await expect(
      syncFreemiusOrderRefundFromWebhookEvent({ event: { ...JSON.parse(outside), plugin_id: '777' }, productId: '777', client: db.client })
    ).resolves.toMatchObject({ orderId: null, reason: 'product_mismatch' });
    expect(orders[0].status).toBe('paid');
  });

  it('a working dedicated pair: refused for a product the account owns, which only its own key verifies', async () => {
    stubFreemius((call) => (call.path === '/plugins/43273.json' ? { status: 404, body: { error: { code: 'not_found' } } } : undefined));
    const owned = webhookBody('24851', 'payment.refund');
    const noKeys = webhookBody('43273', 'payment.refund');

    await expect(getFreemiusWebhookVerification(owned, sign(owned, ONE_PRODUCT.secretKey))).resolves.toEqual({
      outcome: 'invalid',
      productId: '24851',
      reason: 'signature_mismatch',
    });
    // Listed but without keys from Freemius: 503, still never the one-product secret.
    await expect(getFreemiusWebhookVerification(noKeys, sign(noKeys, ONE_PRODUCT.secretKey))).resolves.toEqual({
      outcome: 'unverifiable',
      productId: '43273',
      reason: 'product_keys_unavailable',
      developerStatus: 'working',
    });
  });

  it('refused when the one-product names hold the working developer pair (nextblock.dev), or a key of a dedicated one', async () => {
    // The legacy names ARE the developer pair: Freemius accepts them at developer scope.
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', PAIR.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', PAIR.secretKey);
    mocks.candidates.mockImplementation(async () => [{ ...PAIR, source: 'env-legacy' }]);
    stubFreemius();
    const outside = webhookBody('777', 'payment.refund');
    const mismatch = { outcome: 'invalid', productId: '777', reason: 'signature_mismatch' };

    await expect(getFreemiusWebhookVerification(outside, sign(outside, PAIR.secretKey))).resolves.toEqual(mismatch);

    // A dedicated pair with an identical copy under the legacy names (the resolver lists it once, as `env`).
    mocks.candidates.mockImplementation(async () => [PAIR]);
    forgetFreemiusDeveloperCaches();
    await expect(getFreemiusWebhookVerification(outside, sign(outside, PAIR.secretKey))).resolves.toEqual(mismatch);

    // Only the developer secret copied under FREEMIUS_SECRET_KEY, beside another public key.
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', 'pk_something_else');
    await expect(getFreemiusWebhookVerification(outside, sign(outside, PAIR.secretKey))).resolves.toEqual(mismatch);
  });

  it('never while Freemius cannot be asked, nor once FREEMIUS_PRODUCT_ID binds the one-product keys to another product', async () => {
    stubFreemius((call) => (call.path.startsWith('/plugins.json') ? { status: 503, body: {} } : undefined));
    const outside = webhookBody('777');

    await expect(getFreemiusWebhookVerification(outside, sign(outside, ONE_PRODUCT.secretKey))).resolves.toMatchObject({
      outcome: 'unverifiable',
      reason: 'developer_pair_unreachable',
    });

    mocks.candidates.mockImplementation(async () => []);
    vi.stubEnv('FREEMIUS_PRODUCT_ID', '24851');
    await expect(getFreemiusWebhookVerification(outside, sign(outside, ONE_PRODUCT.secretKey))).resolves.toMatchObject({ outcome: 'invalid' });
  });

  it('an absent id while the re-read of a stale product list goes unanswered: 503, never 401, and logged', async () => {
    // List [24851] cached; 43273 is then added at Freemius, which starts answering 429.
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    let listed = ['24851'];
    let throttled = false;
    const { calls } = stubFreemius((call) => {
      if (throttled) return { status: 429, body: { error: { code: 'rate_limit', message: 'Too many requests.' } } };
      if (call.path.startsWith('/plugins.json')) return { status: 200, body: { plugins: listed.map((id) => ({ id: Number(id) })) } };
      return undefined;
    });
    const commerce = webhookBody('24851');
    await expect(getFreemiusWebhookVerification(commerce, sign(commerce, PRODUCTS['24851'].secret_key))).resolves.toMatchObject({ outcome: 'valid' });

    listed = ['24851', '43273'];
    throttled = true;
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 60_000));
    const refund = webhookBody('43273', 'payment.refund');
    const unverifiable = { outcome: 'unverifiable', productId: '43273', reason: 'product_key_read_failed', developerStatus: 'working' };

    await expect(getFreemiusWebhookVerification(refund, sign(refund, PRODUCTS['43273'].secret_key))).resolves.toEqual(unverifiable);
    // Throttled right after the unanswered re-read: the same, with no request.
    const sent = calls.length;
    await expect(getFreemiusWebhookVerification(refund, sign(refund, PRODUCTS['43273'].secret_key))).resolves.toEqual(unverifiable);
    expect(calls.length).toBe(sent);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Could not read product 43273's keys"), expect.stringContaining('unavailable'));
    // The one-product secret does not stand in for it meanwhile either.
    await expect(getFreemiusWebhookVerification(refund, sign(refund, ONE_PRODUCT.secretKey))).resolves.toEqual(unverifiable);

    // Freemius answers again: the new product's own secret verifies.
    throttled = false;
    vi.setSystemTime(new Date(NOW.getTime() + 4 * 60_000));
    await expect(getFreemiusWebhookVerification(refund, sign(refund, PRODUCTS['43273'].secret_key))).resolves.toEqual({ outcome: 'valid', productId: '43273' });
  });
});

/**
 * Review 2026-11-13, round 2: the last keys Freemius returned were served with no maximum age, so a
 * product secret rotated because it leaked kept verifying forged payments and refunds for as long as
 * reads failed (and the shared developer key can be pushed into 429s).
 */
describe('last-good product keys verify webhooks for a limited time', () => {
  it('valid inside the limit during an outage, unverifiable past it (bound secrets still count), valid again once Freemius answers', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    let down = false;
    stubFreemius(() => (down ? { status: 503, body: {} } : undefined));
    const body = webhookBody('28609', 'payment.refund');
    const signed = sign(body, PRODUCTS['28609'].secret_key);
    const at = (minutes: number) => vi.setSystemTime(new Date(NOW.getTime() + minutes * 60_000));

    await expect(getFreemiusWebhookVerification(body, signed)).resolves.toEqual({ outcome: 'valid', productId: '28609' });
    down = true;

    // 11 minutes on: the keys are past their TTL and the re-read fails; the last keys still verify.
    at(11);
    await expect(getFreemiusWebhookVerification(body, signed)).resolves.toEqual({ outcome: 'valid', productId: '28609' });
    // 69 minutes on: still inside the limit (TTL + 1 h).
    at(69);
    await expect(getFreemiusWebhookVerification(body, signed)).resolves.toEqual({ outcome: 'valid', productId: '28609' });

    // 71 minutes on: past it. The cached secret no longer verifies anything.
    at(71);
    await expect(getFreemiusWebhookVerification(body, signed)).resolves.toEqual({
      outcome: 'unverifiable',
      productId: '28609',
      reason: 'product_key_read_failed',
      developerStatus: 'working',
    });
    // The product's own configured secret still does.
    vi.stubEnv('FREEMIUS_PRODUCT_ID', '28609');
    vi.stubEnv('FREEMIUS_SECRET_KEY', 'sk_cortex_configured');
    await expect(getFreemiusWebhookVerification(body, sign(body, 'sk_cortex_configured'))).resolves.toEqual({ outcome: 'valid', productId: '28609' });

    // Freemius answers again (past the 30 s retry window): its keys verify again.
    down = false;
    at(72);
    await expect(getFreemiusWebhookVerification(body, signed)).resolves.toEqual({ outcome: 'valid', productId: '28609' });
  });
});

/**
 * Review 2026-11-13, round 3: one 404 on the first page of the product list at a working pair's
 * re-check refused the pair for ten minutes (checkout keyed 503, webhooks 503, readiness off), and a
 * 200 without a product list recorded a working pair that owned nothing (genuine webhooks 401, the
 * one-product keys standing in for owned products).
 */
describe('a working pair through a misrouted answer at its re-check', () => {
  const RECHECK = NOW.getTime() + 10 * 60_000 + 1_000;

  it('one 404 on the first page of the list, then a healthy Freemius: still working, checkout on the product’s keys, webhooks valid', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    let listAnswer: Answer | undefined;
    stubFreemius((call) => (call.path.startsWith('/plugins.json') ? listAnswer : undefined));
    const body = webhookBody('24851', 'payment.refund');
    const signed = sign(body, PRODUCTS['24851'].secret_key);

    await expect(getFreemiusWebhookVerification(body, signed)).resolves.toEqual({ outcome: 'valid', productId: '24851' });

    vi.setSystemTime(new Date(RECHECK));
    listAnswer = { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } };
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working' });
    listAnswer = undefined;

    for (const seconds of [5, 60, 300, 540]) {
      vi.setSystemTime(new Date(RECHECK + seconds * 1_000));
      await expect(getFreemiusDeveloperStatus({ wait: false }), `${seconds} s`).resolves.toMatchObject({ state: 'working' });
      await expect(resolveFreemiusProductCredentials('24851'), `${seconds} s`).resolves.toMatchObject({
        source: 'developer-api',
        publicKey: PRODUCTS['24851'].public_key,
      });
      await expect(getFreemiusWebhookVerification(body, signed), `${seconds} s`).resolves.toEqual({ outcome: 'valid', productId: '24851' });
    }
  });

  it('two 404s in a row, 30 s apart: refused, as a wrong developer id is', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    let notFound = false;
    stubFreemius((call) => (notFound && call.path.startsWith('/plugins.json') ? { status: 404, body: {} } : undefined));
    const body = webhookBody('24851', 'payment.refund');
    await getFreemiusDeveloperStatus();

    notFound = true;
    vi.setSystemTime(new Date(RECHECK));
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working' });
    vi.setSystemTime(new Date(RECHECK + 31_000));
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'refused' });

    await expect(getFreemiusWebhookVerification(body, sign(body, PRODUCTS['24851'].secret_key))).resolves.toEqual({
      outcome: 'unverifiable',
      productId: '24851',
      reason: 'developer_pair_refused',
      developerStatus: 'refused',
    });
    await expect(resolveFreemiusProductCredentials('24851')).resolves.toMatchObject({ source: 'none', refusal: 'no_one_product_keys' });
  });

  it.each([
    ['an HTML page', '<html>maintenance</html>'],
    ['an empty body', ''],
    ['{}', '{}'],
    ['{ "plugins": null }', '{"plugins":null}'],
  ])('a 200 with %s: owned products keep their own keys, and an outside product’s keys stand in for none of them', async (_label, text) => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    // The security review's probe: a working dedicated pair, the one-product keys of a product
    // outside the account (tried as a legacy pair after it), the Product ID empty.
    const OUTSIDE = { publicKey: 'pk_outside_product', secretKey: 'sk_outside_product' };
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', OUTSIDE.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', OUTSIDE.secretKey);
    mocks.candidates.mockImplementation(async () => [PAIR, { developerId: DEV, ...OUTSIDE, source: 'env-legacy' }]);
    let broken = false;
    const { fetchMock } = stubFreemius();
    const answer = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (broken && String(url).includes(`/v1/developers/${DEV}/plugins.json`)) return new Response(text, { status: 200 });
      if (!answer) throw new Error('no fake Freemius');
      return answer(url, init);
    });
    await getFreemiusDeveloperStatus();

    broken = true;
    vi.setSystemTime(new Date(RECHECK));
    await expect(getFreemiusDeveloperStatus()).resolves.toMatchObject({ state: 'working', productIds: ['24851', '28609', '43273'] });

    const refund = webhookBody('28609', 'payment.refund');
    await expect(getFreemiusWebhookVerification(refund, sign(refund, PRODUCTS['28609'].secret_key))).resolves.toEqual({
      outcome: 'valid',
      productId: '28609',
    });
    await expect(getFreemiusWebhookVerification(refund, sign(refund, OUTSIDE.secretKey))).resolves.toEqual({
      outcome: 'invalid',
      productId: '28609',
      reason: 'signature_mismatch',
    });
    await expect(resolveFreemiusProductCredentials('28609')).resolves.toMatchObject({ source: 'developer-api', publicKey: PRODUCTS['28609'].public_key });
  });
});

/**
 * Review 2026-11-13, round 2: while Freemius throttled the developer key, every forged webhook wrote
 * an error line (the remembered failure, logged again with no request sent) beside the route's own.
 */
describe('log volume while Freemius throttles the developer key', () => {
  it('20 forged webhooks write one key-read line per product per minute', async () => {
    // A clock far from every other test's, whose logged lines then count as long expired.
    const start = new Date('2099-01-01T00:00:00Z');
    vi.useFakeTimers({ now: start, toFake: ['Date'] });
    const { calls } = stubFreemius((call) =>
      call.path === '/plugins/24851.json' ? { status: 429, body: { error: { code: 'rate_limit', message: 'Too many requests.' } } } : undefined
    );
    const keyReadLines = () =>
      vi.mocked(console.error).mock.calls.filter((call) => String(call[0]).includes("Could not read product 24851's keys")).length;

    for (let i = 0; i < 20; i += 1) {
      const body = webhookBody('24851', 'payment.refund', { id: `forged-${i}` });
      await expect(getFreemiusWebhookVerification(body, sign(body, `sk_forged_${i}`))).resolves.toMatchObject({ outcome: 'unverifiable' });
    }
    expect(keyReadLines()).toBe(1);
    expect(calls.filter((call) => call.path === '/plugins/24851.json')).toHaveLength(1);

    // A minute later the next failure is logged again, once.
    vi.setSystemTime(new Date(start.getTime() + 61_000));
    for (let i = 0; i < 5; i += 1) {
      const body = webhookBody('24851', 'payment.refund', { id: `forged-late-${i}` });
      await getFreemiusWebhookVerification(body, sign(body, 'sk_forged'));
    }
    expect(keyReadLines()).toBe(2);
  });

  it('stays bounded for forged product ids: one line each at most, and a capped number per minute', async () => {
    const start = new Date('2099-02-01T00:00:00Z');
    vi.useFakeTimers({ now: start, toFake: ['Date'] });
    // The list was answered; Freemius then throttles, so any id the list lacks reaches the failure path.
    let throttled = false;
    stubFreemius(() => (throttled ? { status: 429, body: {} } : undefined));
    await getFreemiusWebhookVerification(webhookBody('24851'), sign(webhookBody('24851'), PRODUCTS['24851'].secret_key));
    throttled = true;
    vi.setSystemTime(new Date(start.getTime() + 2 * 60_000));
    const before = vi.mocked(console.error).mock.calls.length;

    for (let i = 0; i < 200; i += 1) {
      const body = webhookBody(String(900000 + i), 'payment.refund');
      await expect(getFreemiusWebhookVerification(body, sign(body, 'sk_forged'))).resolves.toMatchObject({
        outcome: 'unverifiable',
        reason: 'product_key_read_failed',
      });
    }
    const lines = vi.mocked(console.error).mock.calls.length - before;
    expect(lines).toBeGreaterThan(0);
    expect(lines).toBeLessThanOrEqual(50);
  });
});

describe('purchase data at developer scope moves the order (webhook sync)', () => {
  const ORDER = { id: 'order-1', status: 'pending', provider: 'freemius', created_at: '2026-11-12T14:58:00Z', freemius_product_id: '28609', freemius_license_id: '9001' };
  const LICENSE = { id: 9001, plugin_id: 28609, user_id: 77, plan_id: 47122, pricing_id: 6, created: '2026-11-12 14:59:00', expiration: '2027-11-12 14:59:00', is_cancelled: false, quota: 1, secret_key: 'sk_license_9001' };
  const USER = { id: 77, email: 'buyer@example.com', first: 'Buyer', last: 'One' };

  function freemiusWith(subscription: Answer) {
    return stubFreemius((call) => {
      if (call.path === '/plugins/28609/licenses/9001.json') return { status: 200, body: LICENSE };
      if (call.path === '/plugins/28609/licenses/9001/subscription.json') return subscription;
      if (call.path.startsWith('/plugins/28609/users/77.json')) return { status: 200, body: USER };
      return undefined;
    });
  }

  it('marks a pending order paid from the subscription’s initial amount, and records its ids', async () => {
    const { calls } = freemiusWith({
      status: 200,
      body: { id: 333, license_id: 9001, initial_amount: '250.00', billing_cycle: 12, currency: 'usd', gateway: 'stripe' },
    });
    const orders = [{ ...ORDER }];
    const db = fakeOrders(orders);

    const result = await syncFreemiusOrderFromWebhookEvent({
      event: { type: 'subscription.created', objects: { license: { id: 9001, plugin_id: 28609 } } },
      client: db.client,
    });

    expect(result).toMatchObject({ orderId: 'order-1', status: 'paid' });
    expect(orders[0]).toMatchObject({ status: 'paid', freemius_subscription_id: '333', freemius_user_id: '77', freemius_plan_id: '47122' });
    expect(mocks.assignInvoiceMetadata).toHaveBeenCalledTimes(1);
    const reads = calls.filter((call) => call.path.startsWith('/plugins/28609/'));
    expect(reads.map((call) => call.path)).toEqual([
      '/plugins/28609/licenses/9001.json',
      '/plugins/28609/licenses/9001/subscription.json',
      '/plugins/28609/users/77.json?fields=email%2Cfirst%2Clast%2Cpicture%2Cis_verified%2Cid%2Ccreated%2Cupdated%2Cis_marketing_allowed',
    ]);
    reads.forEach(expectDeveloperSigned);
  });

  it('reads a license without a subscription (404) as a trial, never as paid', async () => {
    freemiusWith({ status: 404, body: { error: { code: 'subscription_not_found', message: 'Subscription not found.' } } });
    const orders = [{ ...ORDER }];

    const result = await syncFreemiusOrderFromWebhookEvent({
      event: { type: 'license.created', objects: { license: { id: 9001, plugin_id: 28609 } } },
      client: fakeOrders(orders).client,
    });

    expect(result).toMatchObject({ status: 'trial' });
    expect(mocks.assignInvoiceMetadata).not.toHaveBeenCalled();
  });
});

describe('the license key on the success page and order history', () => {
  it('reads the order’s license at developer scope and shows its key', async () => {
    const { calls } = stubFreemius((call) =>
      call.path === '/plugins/43273/licenses/5001.json'
        ? { status: 200, body: { id: 5001, plugin_id: 43273, plan_id: 75655, created: '2026-11-12 14:59:30', expiration: '2027-11-12 14:59:30', is_cancelled: false, secret_key: 'sk_affiliates_license' } }
        : undefined
    );
    const db = fakeOrders([
      { id: 'order-2', provider: 'freemius', created_at: '2026-11-12T14:58:00Z', freemius_product_id: '43273', freemius_license_id: '5001', freemius_trial_ends_at: null },
    ]);

    await expect(getFreemiusOrderLicense({ orderId: 'order-2', client: db.client })).resolves.toEqual({
      licenseId: '5001',
      licenseKey: 'sk_affiliates_license',
      planId: '75655',
      expiration: '2027-11-12 14:59:30',
      trialEndsAt: null,
      isCancelled: false,
    });
    expectDeveloperSigned(findCall(calls, (call) => call.path === '/plugins/43273/licenses/5001.json'));
  });
});

describe('the vendor license claim (POST /api/packages/claim-license)', () => {
  const FRESH_LICENSE = { id: 6001, plugin_id: 28609, user_id: 77, plan_id: 47122, activated: 0, is_cancelled: false, created: '2026-11-12 14:58:00', secret_key: 'sk_claimed_key' };
  const request = { email: 'Buyer@Example.com', kind: 'purchase' as const, licenseId: '6001', productId: '28609', userId: '77' };

  function freemiusWithLicense(license: Answer) {
    return stubFreemius((call) => {
      if (call.path === '/plugins/28609/licenses/6001.json') return license;
      if (call.path.startsWith('/plugins/28609/users/77.json')) return { status: 200, body: { id: 77, email: 'buyer@example.com' } };
      return undefined;
    });
  }

  it('hands out the key of the buyer’s fresh license', async () => {
    const { calls } = freemiusWithLicense({ status: 200, body: FRESH_LICENSE });

    await expect(claimFreemiusLicenseKey(request, { now: NOW })).resolves.toEqual({
      ok: true,
      licenseKey: 'sk_claimed_key',
      planId: '47122',
      expiration: null,
    });
    calls.filter((call) => call.path.startsWith('/plugins/28609/')).forEach(expectDeveloperSigned);
  });

  it('refuses another product’s license and a missing one, uniformly', async () => {
    freemiusWithLicense({ status: 200, body: { ...FRESH_LICENSE, plugin_id: 24851 } });
    await expect(claimFreemiusLicenseKey(request, { now: NOW })).resolves.toMatchObject({ ok: false, reason: 'product_mismatch', status: 403 });

    forgetFreemiusDeveloperCaches();
    freemiusWithLicense({ status: 404, body: { error: { code: 'license_not_found' } } });
    await expect(claimFreemiusLicenseKey(request, { now: NOW })).resolves.toMatchObject({ ok: false, reason: 'license_not_found', status: 403 });
  });

  it('answers 502 when Freemius fails, and asks nothing for an id that is not a Freemius id', async () => {
    freemiusWithLicense({ status: 500, body: {} });
    await expect(claimFreemiusLicenseKey(request, { now: NOW })).resolves.toMatchObject({ ok: false, reason: 'upstream_error', status: 502 });

    const { fetchMock } = stubFreemius();
    await expect(claimFreemiusLicenseKey({ ...request, licenseId: '6001/../../users/1' }, { now: NOW })).resolves.toMatchObject({
      ok: false,
      reason: 'license_not_found',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('trial minting (POST /api/packages/provision-trial)', () => {
  const trial = { email: ' New.Buyer@Example.com ', name: ' New Buyer ', planId: '47122', productId: '28609', trialDays: 30 };

  function freemiusForTrial(options: { users?: unknown[]; licenses?: unknown[]; create?: Answer; assign?: Answer } = {}) {
    return stubFreemius((call) => {
      if (call.path.startsWith('/plugins/28609/users.json')) return { status: 200, body: { users: options.users ?? [] } };
      if (/^\/plugins\/28609\/users\/\d+\/licenses\.json/.test(call.path)) return { status: 200, body: { licenses: options.licenses ?? [] } };
      if (call.path === '/plugins/28609/plans/47122/pricing.json') {
        return { status: 200, body: { pricing: [{ id: 7, licenses: 5 }, { id: 110047, licenses: 1 }, { id: 9, licenses: 1, is_hidden: true }] } };
      }
      if (call.method === 'POST') return options.create ?? { status: 201, body: { license: { id: 999, secret_key: 'sk_trial_key' } } };
      if (call.method === 'PUT') return options.assign ?? { status: 200, body: {} };
      return undefined;
    });
  }

  it('mints a 30-day license on the single-site pricing and assigns it to the email, all at developer scope', async () => {
    const { calls } = freemiusForTrial();

    await expect(provisionFreemiusTrialLicense(trial, { now: NOW })).resolves.toEqual({
      ok: true,
      assigned: true,
      expiresAt: '2026-12-12 15:00:00',
      licenseId: '999',
      licenseKey: 'sk_trial_key',
      planId: '47122',
      pricingId: '110047',
    });

    const lookup = findCall(calls, (call) => call.path.startsWith('/plugins/28609/users.json'));
    expect(new URL(lookup.url).searchParams.get('email')).toBe('new.buyer@example.com');
    const create = findCall(calls, (call) => call.method === 'POST');
    expect(create.path).toBe('/plugins/28609/plans/47122/pricing/110047/licenses.json');
    expect(JSON.parse(String(create.body))).toEqual({ expires_at: '2026-12-12 15:00:00', is_block_features: true, send_email: false });
    expect(create.headers['Content-MD5']).toBe(crypto.createHash('md5').update(String(create.body)).digest('hex'));
    const assign = findCall(calls, (call) => call.method === 'PUT');
    expect(assign.path).toBe('/plugins/28609/licenses.json');
    expect(JSON.parse(String(assign.body))).toEqual({ email: 'new.buyer@example.com', license_key: 'sk_trial_key', name: 'New Buyer' });
    calls.filter((call) => call.path.startsWith('/plugins/28609/')).forEach(expectDeveloperSigned);
  });

  it('refuses an email that already holds a license for the product, minting nothing', async () => {
    const { calls } = freemiusForTrial({ users: [{ id: 501 }], licenses: [{ id: 1, plugin_id: 28609 }] });

    await expect(provisionFreemiusTrialLicense(trial, { now: NOW })).resolves.toMatchObject({ ok: false, reason: 'already_licensed', status: 409 });
    expect(calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('when Freemius refuses the developer pair before minting, tries the bearer (none here) and mints nothing', async () => {
    const { calls } = freemiusForTrial({ create: { status: 403, body: { error: { code: 'unauthorized' } } } });

    await expect(provisionFreemiusTrialLicense(trial, { now: NOW })).resolves.toMatchObject({ ok: false, reason: 'not_configured', status: 503 });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('keeps a minted license when the assignment is refused: one license, assigned false', async () => {
    const { calls } = freemiusForTrial({ assign: { status: 403, body: {} } });

    await expect(provisionFreemiusTrialLicense(trial, { now: NOW })).resolves.toMatchObject({ ok: true, assigned: false, licenseKey: 'sk_trial_key' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('answers 502 on a Freemius failure while minting, without retrying with other keys', async () => {
    const { calls } = freemiusForTrial({ create: { status: 500, body: {} } });

    await expect(provisionFreemiusTrialLicense(trial, { now: NOW })).resolves.toMatchObject({ ok: false, reason: 'upstream_error', status: 502 });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('on the sandbox sends nothing at developer scope', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const { fetchMock } = freemiusForTrial();

    await expect(provisionFreemiusTrialLicense(trial, { now: NOW })).resolves.toMatchObject({ ok: false, reason: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
