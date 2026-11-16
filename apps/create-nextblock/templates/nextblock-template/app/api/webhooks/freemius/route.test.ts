import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Freemius webhook route: the signature is checked first, always, over the raw body with the
 * secret of the product the event names; an event the app cannot check (Freemius unreachable, the
 * developer key pair refused) answers 503 so Freemius redelivers it, with nothing processed; every
 * handler keeps to the product that verified the event; refunds and lost disputes are handled
 * INSTEAD of the order sync (which would re-promote a refunded order to paid); dispute openings
 * hold the partner's commission and wins release it, never syncing the order; the commission sweep
 * follows a paid order or a refund.
 */

const mocks = vi.hoisted(() => ({
  hydrateFreemiusEnvFromDb: vi.fn(async () => undefined),
  getFreemiusWebhookVerification: vi.fn(),
  verifyFreemiusWebhookRequest: vi.fn(),
  syncFreemiusOrderFromWebhookEvent: vi.fn(),
  handleFreemiusRefundWebhookEvent: vi.fn(),
  handleFreemiusDisputeWebhookEvent: vi.fn(),
  scheduleAffiliateCommissionSweep: vi.fn(),
  developerPair: { developerId: '4242', publicKey: 'pk_dev_route', secretKey: 'sk_dev_route', source: 'env' },
  /** The configured developer key pairs the real verifier sees (one dedicated pair unless a test says otherwise). */
  developerCandidates: vi.fn<() => Promise<Array<Record<string, string>>>>(async () => []),
}));

vi.mock('@nextblock-cms/ecommerce/server', () => ({
  hydrateFreemiusEnvFromDb: mocks.hydrateFreemiusEnvFromDb,
  // The per-product check (the event's own product secret, via the developer key pair): async, an outcome.
  getFreemiusWebhookVerification: mocks.getFreemiusWebhookVerification,
  // The boolean wrapper older routes call: this route must not rely on it.
  verifyFreemiusWebhookRequest: mocks.verifyFreemiusWebhookRequest,
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

// What the real verifier needs when one test runs it through this route (the route never loads
// these itself): the sandbox predicate, one developer key pair, and nothing that writes.
const LIB = '../../../../../../libs/ecommerce/src/lib';
const DEVELOPER_PAIR = mocks.developerPair;
vi.mock('@nextblock-cms/db/server', async () => {
  const { isSandboxEnvironment } = await vi.importActual<{ isSandboxEnvironment: () => boolean }>(
    '../../../../../../libs/db/src/lib/config-resolve'
  );
  return { createClient: () => ({}), getServiceRoleSupabaseClient: () => ({}), isSandboxEnvironment };
});
vi.mock('../../../../../../libs/ecommerce/src/lib/payment-config', () => ({
  hydrateFreemiusEnvFromDb: async () => undefined,
  resolveFreemiusDeveloperCredentialCandidates: () => mocks.developerCandidates(),
}));
vi.mock('../../../../../../libs/ecommerce/src/lib/invoice-server', () => ({ assignInvoiceMetadata: vi.fn() }));
vi.mock('../../../../../../libs/ecommerce/src/lib/order-inventory', () => ({ applyOrderInventoryDeduction: vi.fn() }));

import { POST } from './route';

const ORDER_ID = '77777777-7777-4777-8777-777777777777';
const PRODUCT = '28609';
const VALID = { outcome: 'valid', productId: PRODUCT };

async function post(event: Record<string, unknown>, signature: string | null = 'abc123') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signature) headers['x-signature'] = signature;
  const response = await POST(
    new Request('http://localhost:4200/api/webhooks/freemius', { method: 'POST', headers, body: JSON.stringify(event) })
  );
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function expectNothingProcessed() {
  expect(mocks.handleFreemiusRefundWebhookEvent).not.toHaveBeenCalled();
  expect(mocks.handleFreemiusDisputeWebhookEvent).not.toHaveBeenCalled();
  expect(mocks.syncFreemiusOrderFromWebhookEvent).not.toHaveBeenCalled();
  expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
}

/**
 * The route writes its 503 line at most once per reason per minute and keeps that memory for the
 * module's life: each test runs ten minutes after the previous one, so no line of one test
 * silences another's.
 */
let clock = Date.parse('2026-11-13T12:00:00Z');

beforeEach(() => {
  clock += 10 * 60_000;
  vi.useFakeTimers({ now: clock, toFake: ['Date'] });
  for (const fn of [
    mocks.getFreemiusWebhookVerification,
    mocks.verifyFreemiusWebhookRequest,
    mocks.syncFreemiusOrderFromWebhookEvent,
    mocks.handleFreemiusRefundWebhookEvent,
    mocks.handleFreemiusDisputeWebhookEvent,
    mocks.scheduleAffiliateCommissionSweep,
  ]) {
    fn.mockReset();
  }
  mocks.getFreemiusWebhookVerification.mockResolvedValue(VALID);
  // A route that trusted the boolean wrapper would let these through; this one never asks it.
  mocks.verifyFreemiusWebhookRequest.mockResolvedValue(true);
  mocks.developerCandidates.mockReset().mockImplementation(async () => [mocks.developerPair]);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('POST /api/webhooks/freemius', () => {
  it('refuses a missing or invalid signature before reading the event, refunds included', async () => {
    const missing = await post({ type: 'payment.refund', plugin_id: 28609 }, null);
    mocks.getFreemiusWebhookVerification.mockResolvedValue({ outcome: 'invalid', productId: PRODUCT, reason: 'signature_mismatch' });
    const invalid = await post({ type: 'payment.refund', plugin_id: 28609 });

    expect([missing.status, invalid.status]).toEqual([400, 401]);
    expect(invalid.body).toEqual({ error: 'Invalid signature' });
    expectNothingProcessed();
    expect(mocks.verifyFreemiusWebhookRequest).not.toHaveBeenCalled();
  });

  it('refuses an event that names no product (no plugin_id): 401, nothing processed', async () => {
    mocks.getFreemiusWebhookVerification.mockResolvedValue({ outcome: 'invalid', productId: null, reason: 'missing_product_id' });

    const { status, body } = await post({ type: 'payment.refund', objects: { payment: { license_id: 9001 } } });

    expect(status).toBe(401);
    expect(body).toEqual({ error: 'Invalid signature' });
    expectNothingProcessed();
  });

  it('answers 503 for an event it cannot check, logs the developer key pair state and processes nothing', async () => {
    mocks.getFreemiusWebhookVerification.mockResolvedValue({
      outcome: 'unverifiable',
      productId: PRODUCT,
      reason: 'product_key_read_failed',
      developerStatus: 'unreachable',
    });

    for (const type of ['payment.refund', 'payment.dispute.created', 'payment.created']) {
      const { status, headers, body } = await post({ type, plugin_id: 28609, objects: { payment: { license_id: 9001, gross: 250 } } });

      expect(status, type).toBe(503);
      expect(headers.get('retry-after')).toBe('60');
      expect(body).toEqual({ error: 'Webhook signature could not be checked' });
    }
    expectNothingProcessed();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/product 28609 \(product_key_read_failed; developer key pair: unreachable\)\. Answered 503/)
    );
  });

  it('writes the 503 line at most once per reason per minute, however many events (forged or not) it answers 503', async () => {
    // Review 2026-11-13, round 2: while Freemius throttled the developer key, every forged webhook
    // wrote this line (and the lib's key-read line), so anyone could fill the logs.
    const start = Date.now();
    const unverifiable = (reason: string, productId = PRODUCT) => ({ outcome: 'unverifiable', productId, reason, developerStatus: 'working' });
    const lines = () => vi.mocked(console.error).mock.calls.map((call) => String(call[0]));

    mocks.getFreemiusWebhookVerification.mockResolvedValue(unverifiable('product_key_read_failed'));
    for (let i = 0; i < 20; i += 1) {
      const { status } = await post({ type: 'payment.refund', plugin_id: 28609, id: `forged-${i}` });
      expect(status).toBe(503);
    }
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain('product 28609 (product_key_read_failed; developer key pair: working). Answered 503 so Freemius redelivers it.');

    // Another reason gets its own line.
    mocks.getFreemiusWebhookVerification.mockResolvedValue(unverifiable('developer_pair_refused', '43273'));
    await post({ type: 'payment.created', plugin_id: 43273 });
    await post({ type: 'payment.created', plugin_id: 43273 });
    expect(lines()).toHaveLength(2);

    // A minute on, the next one is logged again, with a count of the 503s it did not log.
    vi.setSystemTime(start + 61_000);
    mocks.getFreemiusWebhookVerification.mockResolvedValue(unverifiable('product_key_read_failed', '24851'));
    await post({ type: 'payment.refund', plugin_id: 24851 });
    expect(lines()).toHaveLength(3);
    expect(lines()[2]).toContain('product 24851 (product_key_read_failed; developer key pair: working)');
    expect(lines()[2]).toContain('19 more answered 503 for this reason since the previous line.');
    expectNothingProcessed();
  });

  it('refuses any outcome other than valid (fail closed on an unexpected shape)', async () => {
    mocks.getFreemiusWebhookVerification.mockResolvedValue({ outcome: 'maybe', productId: PRODUCT });

    const { status } = await post({ type: 'payment.created', plugin_id: 28609 });

    expect(status).toBe(401);
    expectNothingProcessed();
  });

  it('awaits the async check: a refusal that resolves later still refuses (a pending Promise is truthy)', async () => {
    mocks.getFreemiusWebhookVerification.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ outcome: 'invalid', productId: PRODUCT, reason: 'signature_mismatch' }), 5))
    );

    const { status } = await post({ type: 'payment.created', plugin_id: 28609 });

    expect(status).toBe(401);
    expect(mocks.syncFreemiusOrderFromWebhookEvent).not.toHaveBeenCalled();
  });

  it('checks the signature over the exact raw body and header it received', async () => {
    const raw = JSON.stringify({ type: 'payment.created', plugin_id: 43273 });
    mocks.getFreemiusWebhookVerification.mockResolvedValue({ outcome: 'valid', productId: '43273' });
    mocks.syncFreemiusOrderFromWebhookEvent.mockResolvedValue({ success: true, ignored: true });

    await POST(
      new Request('http://localhost:4200/api/webhooks/freemius', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': 'f'.repeat(64) },
        body: raw,
      })
    );

    expect(mocks.getFreemiusWebhookVerification).toHaveBeenCalledWith(raw, 'f'.repeat(64));
  });

  it.each(['payment.refund', 'payment.refunded', 'payment.dispute.lost', 'payment.dispute.closed'])(
    'handles %s instead of the order sync, for the verified product, then sweeps',
    async (type) => {
      const event = { id: 'evt_1', type, plugin_id: 28609, objects: { payment: { license_id: 'lic_1', is_renewal: false } } };
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
      // The verified product is handed over explicitly, not only as the event's plugin_id.
      expect(mocks.handleFreemiusRefundWebhookEvent).toHaveBeenCalledWith({ ...event, plugin_id: PRODUCT }, { productId: PRODUCT });
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

    const { status, body } = await post({ type: 'payment.refund', plugin_id: 28609, objects: { payment: { license_id: 'lic_1', is_renewal: true } } });

    expect(status).toBe(200);
    expect(body).toMatchObject({ received: true, handled: false, status: null });
    expect(mocks.syncFreemiusOrderFromWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });

  it('answers 200 without a sweep when the refund names an order of another product (skipped)', async () => {
    mocks.handleFreemiusRefundWebhookEvent.mockResolvedValue({
      handled: false,
      orderId: null,
      full: true,
      orderStatusUpdated: false,
      affiliate: 'skipped',
    });

    const { status, body } = await post({ type: 'payment.refund', plugin_id: 28609, objects: { payment: { license_id: 'lic_24851' } } });

    expect(status).toBe(200);
    expect(body).toEqual({ received: true, type: 'payment.refund', handled: false, orderId: null, status: null });
    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });

  it('answers 500 when refund handling fails, so Freemius redelivers', async () => {
    mocks.handleFreemiusRefundWebhookEvent.mockRejectedValue(new Error('affiliate void failed'));

    const { status, body } = await post({ type: 'payment.refund', plugin_id: 28609 });

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Webhook processing failed' });
  });

  it.each([
    ['payment.dispute.created', true, 'held'],
    ['payment.dispute.won', false, 'released'],
  ])('applies %s to the commission only, for the verified product: no order sync, no refund, no sweep', async (type, open, affiliate) => {
    const event = { type, plugin_id: '28609', objects: { payment: { license_id: 'lic_1' } } };
    mocks.handleFreemiusDisputeWebhookEvent.mockResolvedValue({ handled: true, orderId: ORDER_ID, open, affiliate });

    const { status, body } = await post(event);

    expect(status).toBe(200);
    expect(body).toEqual({ received: true, type, handled: true, orderId: ORDER_ID });
    expect(mocks.handleFreemiusDisputeWebhookEvent).toHaveBeenCalledWith({ ...event, plugin_id: PRODUCT }, { productId: PRODUCT });
    expect(mocks.handleFreemiusRefundWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.syncFreemiusOrderFromWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });

  it('answers 500 when the dispute hold fails, so Freemius redelivers', async () => {
    mocks.handleFreemiusDisputeWebhookEvent.mockRejectedValue(new Error('Affiliates: set_affiliate_commission_dispute failed'));

    const { status, body } = await post({ type: 'payment.dispute.created', plugin_id: 28609, objects: { payment: { license_id: 'lic_1' } } });

    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Webhook processing failed' });
    expect(mocks.syncFreemiusOrderFromWebhookEvent).not.toHaveBeenCalled();
  });

  it('syncs every other event for the verified product and sweeps once the order is paid', async () => {
    const event = { type: 'payment.created', plugin_id: 28609, objects: { payment: { license_id: 'lic_1', gross: 250 } } };
    mocks.syncFreemiusOrderFromWebhookEvent.mockResolvedValue({ success: true, orderId: ORDER_ID, status: 'paid', type: 'payment.created' });

    const { status, body } = await post(event);

    expect(status).toBe(200);
    expect(body).toEqual({ received: true, success: true, orderId: ORDER_ID, status: 'paid', type: 'payment.created' });
    expect(mocks.syncFreemiusOrderFromWebhookEvent).toHaveBeenCalledWith({ event: { ...event, plugin_id: PRODUCT }, productId: PRODUCT });
    expect(mocks.scheduleAffiliateCommissionSweep).toHaveBeenCalledTimes(1);
  });

  it('hands the handlers the id of the product that verified the event, normalized, whatever form the body used', async () => {
    mocks.getFreemiusWebhookVerification.mockResolvedValue({ outcome: 'valid', productId: '43273' });
    mocks.syncFreemiusOrderFromWebhookEvent.mockResolvedValue({ success: true, ignored: true, reason: 'unknown_license_id' });

    await post({ type: 'license.created', plugin_id: ' 43273 ', objects: { license: { id: 5001 } } });

    expect(mocks.syncFreemiusOrderFromWebhookEvent).toHaveBeenCalledWith({
      event: { type: 'license.created', plugin_id: '43273', objects: { license: { id: 5001 } } },
      productId: '43273',
    });
  });

  it('answers 200 without a sweep when the sync skips an order of another product', async () => {
    mocks.syncFreemiusOrderFromWebhookEvent.mockResolvedValue({
      success: true,
      ignored: true,
      reason: 'product_mismatch',
      licenseId: 'lic_24851',
      type: 'payment.created',
    });

    const { status, body } = await post({ type: 'payment.created', plugin_id: 28609, objects: { payment: { license_id: 'lic_24851', gross: 1 } } });

    expect(status).toBe(200);
    expect(body).toMatchObject({ received: true, ignored: true, reason: 'product_mismatch' });
    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });

  it('with the real verifier: 20 forged webhooks while Freemius throttles the key write one key-read line and one 503 line', async () => {
    // Review 2026-11-13, round 2: each forged webhook wrote two error lines (the lib's remembered
    // key-read failure, logged again with no request sent, and this route's 503 line).
    const sync = await vi.importActual<typeof import('../../../../../../libs/ecommerce/src/lib/freemius-order-sync')>(
      `${LIB}/freemius-order-sync`
    );
    mocks.getFreemiusWebhookVerification.mockImplementation(sync.getFreemiusWebhookVerification);
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    for (const name of ['FREEMIUS_CHECKOUT_PRODUCTS_JSON', 'FREEMIUS_SECRET_KEY', 'FREEMIUS_PUBLIC_KEY', 'FREEMIUS_PRODUCT_ID', 'FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY']) {
      vi.stubEnv(name, '');
    }
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url).replace(`https://api.freemius.com/v1/developers/${DEVELOPER_PAIR.developerId}`, '');
      if (path.startsWith('/plugins.json')) return new Response(JSON.stringify({ plugins: [{ id: 28609 }] }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: 'rate_limit', message: 'Too many requests.' } }), { status: 429 });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      for (let i = 0; i < 20; i += 1) {
        const { status } = await post({ id: `forged-${i}`, type: 'payment.refund', plugin_id: 28609, objects: { payment: { license_id: 9001 } } }, `${i}`.padStart(64, 'a'));
        expect(status).toBe(503);
      }

      const lines = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
      expect(lines.filter((line) => line.includes("Could not read product 28609's keys"))).toHaveLength(1);
      expect(lines.filter((line) => line.includes('Could not check the signature'))).toHaveLength(1);
      expect(lines).toHaveLength(2);
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/plugins/28609.json'))).toHaveLength(1);
      expectNothingProcessed();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it('with the real verifier: the one-product names as the only, refused, pair answer 503 while Freemius cannot confirm they are the product’s keys, then 401 once it refuses them', async () => {
    // Review 2026-11-13, round 3: such a "pair" stood in for every product, though it may be a
    // revoked developer pair whose leaked secret then verified every product's payments.
    const sync = await vi.importActual<typeof import('../../../../../../libs/ecommerce/src/lib/freemius-order-sync')>(
      `${LIB}/freemius-order-sync`
    );
    const developerApi = await vi.importActual<typeof import('../../../../../../libs/ecommerce/src/lib/freemius-developer-api')>(
      `${LIB}/freemius-developer-api`
    );
    developerApi.forgetFreemiusDeveloperCaches();
    mocks.getFreemiusWebhookVerification.mockImplementation(sync.getFreemiusWebhookVerification);
    const ONE_PRODUCT = { developerId: '4242', publicKey: 'pk_one_product_route', secretKey: 'sk_one_product_route', source: 'env-legacy' };
    mocks.developerCandidates.mockImplementation(async () => [ONE_PRODUCT]);
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    for (const name of ['FREEMIUS_CHECKOUT_PRODUCTS_JSON', 'FREEMIUS_PRODUCT_ID', 'FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY']) {
      vi.stubEnv(name, '');
    }
    vi.stubEnv('FREEMIUS_PUBLIC_KEY', ONE_PRODUCT.publicKey);
    vi.stubEnv('FREEMIUS_SECRET_KEY', ONE_PRODUCT.secretKey);
    // Freemius refuses the names as a developer pair; at the product's scope it first fails to answer.
    let confirmation = 503;
    const fetchMock = vi.fn(async (url: string) =>
      String(url).startsWith('https://api.freemius.com/v1/plugins/')
        ? new Response('{}', { status: confirmation })
        : new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const event = { id: 'evt-one-product', type: 'payment.created', plugin_id: 28609, objects: { payment: { license_id: 9001 } } };
    const signature = createHmac('sha256', ONE_PRODUCT.secretKey).update(JSON.stringify(event)).digest('hex');

    try {
      const unconfirmed = await post(event, signature);
      expect(unconfirmed.status).toBe(503);
      expect(unconfirmed.headers.get('Retry-After')).toBe('60');
      expect(vi.mocked(console.error).mock.calls.map((call) => String(call[0]))).toContainEqual(
        expect.stringContaining('(one_product_keys_unconfirmed; developer key pair: refused)')
      );

      // Asked again after 30 s, Freemius answers that these keys are not 28609's.
      confirmation = 401;
      vi.setSystemTime(new Date(clock + 31_000));
      const refused = await post(event, signature);
      expect(refused.status).toBe(401);
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === 'https://api.freemius.com/v1/plugins/28609.json')).toHaveLength(2);
      expectNothingProcessed();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it('does not sweep when the synced order is not paid', async () => {
    mocks.syncFreemiusOrderFromWebhookEvent.mockResolvedValue({ success: true, orderId: ORDER_ID, status: 'trial', type: 'license.created' });

    await post({ type: 'license.created', plugin_id: 28609 });
    mocks.syncFreemiusOrderFromWebhookEvent.mockResolvedValue({ success: true, ignored: true, reason: 'unknown_license_id', type: 'license.created' });
    await post({ type: 'license.created', plugin_id: 28609 });

    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });
});
