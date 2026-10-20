import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getCouponQuoteAction` is reachable by anyone with the action id, so these tests cover its
 * guarantees as a public endpoint: it spends a per-client token before the database is
 * touched, a tripped bucket never reaches the quote, and an internal failure never echoes
 * database text back to the caller.
 */

const mocks = vi.hoisted(() => ({
  requestHeaders: {} as Record<string, string>,
  getServiceRoleSupabaseClient: vi.fn(() => ({ tag: 'service-client' })),
  getCouponQuote: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => mocks.requestHeaders[name.toLowerCase()] ?? null,
  }),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));

// Keep the real throttle (it is what is under test) and stub only the quote itself.
vi.mock('../coupon-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coupon-server')>()),
  getCouponQuote: mocks.getCouponQuote,
}));

import { getCouponQuoteAction } from './coupon-actions';

const cart = [{ product_id: 'stripe-product', quantity: 1 }] as any[];
const okQuote = { success: true as const, quote: { couponId: 'coupon-1', code: 'SAVE10' } };

/** The process-wide bucket set is shared across tests: give each test its own address. */
let nextClientOctet = 1;
function useFreshClient() {
  const ip = `203.0.113.${nextClientOctet}`;
  nextClientOctet += 1;
  mocks.requestHeaders = { 'x-real-ip': ip };
  return ip;
}

describe('getCouponQuoteAction', () => {
  beforeEach(() => {
    mocks.getCouponQuote.mockReset();
    mocks.getCouponQuote.mockResolvedValue(okQuote);
    mocks.getServiceRoleSupabaseClient.mockClear();
  });

  it('passes the quote through for a client within its budget', async () => {
    useFreshClient();

    const result = await getCouponQuoteAction({ code: 'SAVE10', items: cart, currencyCode: 'USD' });

    expect(result).toEqual(okQuote);
    expect(mocks.getCouponQuote).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SAVE10', items: cart, currencyCode: 'USD' })
    );
    // Public caller: the quote must never be asked for the detailed rejection reason.
    expect(mocks.getCouponQuote.mock.calls[0][0]).not.toHaveProperty('detailedErrors');
  });

  it('stops answering a client that burns through its validation budget', async () => {
    useFreshClient();
    const attempts: Awaited<ReturnType<typeof getCouponQuoteAction>>[] = [];

    for (let index = 0; index < 60; index += 1) {
      attempts.push(await getCouponQuoteAction({ code: `GUESS${index}`, items: cart }));
    }

    const answered = attempts.filter((attempt) => attempt.success);
    const throttled = attempts.filter(
      (attempt) => !attempt.success && attempt.errorKey === 'ecommerce.coupon_validation_failed'
    );

    expect(answered.length).toBeGreaterThan(0);
    expect(answered.length).toBeLessThan(60);
    expect(throttled.length).toBe(60 - answered.length);
    // Once throttled, the database is never consulted.
    expect(mocks.getCouponQuote).toHaveBeenCalledTimes(answered.length);
    expect(mocks.getServiceRoleSupabaseClient).toHaveBeenCalledTimes(answered.length);
    expect(attempts[attempts.length - 1]).toEqual({
      success: false,
      error: 'Too many coupon attempts. Wait a moment and try again.',
      errorKey: 'ecommerce.coupon_validation_failed',
    });
  });

  it('throttles each client address independently', async () => {
    useFreshClient();
    for (let index = 0; index < 60; index += 1) {
      await getCouponQuoteAction({ code: 'SAVE10', items: cart });
    }
    expect((await getCouponQuoteAction({ code: 'SAVE10', items: cart })).success).toBe(false);

    useFreshClient();
    expect((await getCouponQuoteAction({ code: 'SAVE10', items: cart })).success).toBe(true);
  });

  it('throttles requests with no readable address as one shared client', async () => {
    mocks.requestHeaders = {};

    const attempts: boolean[] = [];
    for (let index = 0; index < 60; index += 1) {
      attempts.push((await getCouponQuoteAction({ code: 'SAVE10', items: cart })).success);
    }

    expect(attempts).toContain(false);
  });

  it('coerces a malformed items payload to an empty cart', async () => {
    useFreshClient();

    await getCouponQuoteAction({ code: 'SAVE10', items: 'nope' as any });

    expect(mocks.getCouponQuote).toHaveBeenCalledWith(expect.objectContaining({ items: [] }));
  });

  it('never echoes an internal error message to the caller', async () => {
    useFreshClient();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.getCouponQuote.mockRejectedValueOnce(
      new Error('permission denied for table coupons')
    );

    const result = await getCouponQuoteAction({ code: 'SAVE10', items: cart });

    expect(result).toEqual({
      success: false,
      error: "We couldn't validate this coupon. Try again.",
      errorKey: 'ecommerce.coupon_validation_failed',
    });
    expect(JSON.stringify(result)).not.toContain('permission denied');
    errorSpy.mockRestore();
  });
});
