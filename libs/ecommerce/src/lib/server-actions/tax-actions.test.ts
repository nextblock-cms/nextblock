import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getTaxEstimate` is reachable by anyone with the action id, and the tax it returns reflects
 * any coupon discount, so it is a second coupon-existence oracle beside `getCouponQuoteAction`.
 * These tests cover the throttle that closes it: a per-client token is spent on the SAME
 * in-memory bucket set the coupon action uses before the coupon is quoted, and once a client is
 * over budget the coupon is simply not applied (the tax is still computed, just without it).
 */

const mocks = vi.hoisted(() => ({
  requestHeaders: {} as Record<string, string>,
  createClient: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(() => ({ tag: 'service-client' })),
  getCouponQuote: vi.fn(),
  getQuoteLineDiscountMap: vi.fn(),
  buildCheckoutTaxableItemsFromCart: vi.fn(),
  calculateCheckoutTaxes: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => mocks.requestHeaders[name.toLowerCase()] ?? null,
  }),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: mocks.createClient,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));

vi.mock('../tax-calculation', () => ({
  buildCheckoutTaxableItemsFromCart: mocks.buildCheckoutTaxableItemsFromCart,
  calculateCheckoutTaxes: mocks.calculateCheckoutTaxes,
}));

// Keep the real throttle (it is what is under test) and stub only the quote resolution.
vi.mock('../coupon-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coupon-server')>()),
  getCouponQuote: mocks.getCouponQuote,
  getQuoteLineDiscountMap: mocks.getQuoteLineDiscountMap,
}));

import { getTaxEstimate } from './tax-actions';

const cart = [{ product_id: 'stripe-product', quantity: 1 }] as any[];
const taxResult = { total: 123 } as any;
const discountMap = new Map<string, number>([['stripe-product:base', 100]]);

/** A cookie-scoped client whose currency query resolves to an empty active-currency list. */
function makeSupabaseStub() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => Promise.resolve({ data: [] }),
        }),
      }),
    }),
  };
}

/** The process-wide bucket set is shared across tests: give each test its own address. */
let nextClientOctet = 1;
function useFreshClient() {
  const ip = `198.51.100.${nextClientOctet}`;
  nextClientOctet += 1;
  mocks.requestHeaders = { 'x-real-ip': ip };
  return ip;
}

/** The lineDiscounts map is the 5th argument to buildCheckoutTaxableItemsFromCart. */
function lineDiscountsOfCall(index: number) {
  return mocks.buildCheckoutTaxableItemsFromCart.mock.calls[index]?.[4];
}

describe('getTaxEstimate', () => {
  beforeEach(() => {
    mocks.createClient.mockReset();
    mocks.createClient.mockImplementation(() => makeSupabaseStub());
    mocks.getServiceRoleSupabaseClient.mockClear();
    mocks.getCouponQuote.mockReset();
    mocks.getCouponQuote.mockResolvedValue({ success: true, quote: { code: 'SAVE10' } });
    mocks.getQuoteLineDiscountMap.mockReset();
    mocks.getQuoteLineDiscountMap.mockReturnValue(discountMap);
    mocks.buildCheckoutTaxableItemsFromCart.mockReset();
    mocks.buildCheckoutTaxableItemsFromCart.mockResolvedValue([]);
    mocks.calculateCheckoutTaxes.mockReset();
    mocks.calculateCheckoutTaxes.mockResolvedValue(taxResult);
  });

  it('applies the coupon discount to the taxable base for a client within budget', async () => {
    useFreshClient();

    const result = await getTaxEstimate(cart, null, 'USD', 'SAVE10', cart);

    expect(result).toEqual({ success: true, tax: taxResult });
    expect(mocks.getCouponQuote).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SAVE10', currencyCode: 'USD' })
    );
    // The resolved discount map reaches the taxable-item builder.
    expect(lineDiscountsOfCall(0)).toBe(discountMap);
  });

  it('never quotes a coupon or consumes a token when no coupon code is given', async () => {
    useFreshClient();

    // Far more calls than the bucket capacity: a coupon-less estimate must never be throttled.
    for (let index = 0; index < 60; index += 1) {
      const result = await getTaxEstimate(cart, null, 'USD');
      expect(result).toEqual({ success: true, tax: taxResult });
    }

    expect(mocks.getCouponQuote).not.toHaveBeenCalled();
    // No coupon means no discount map is ever applied.
    for (let index = 0; index < 60; index += 1) {
      expect(lineDiscountsOfCall(index)).toBeUndefined();
    }
  });

  it('stops quoting the coupon once a client burns through its budget, but still returns tax', async () => {
    useFreshClient();
    const results: Awaited<ReturnType<typeof getTaxEstimate>>[] = [];

    for (let index = 0; index < 60; index += 1) {
      results.push(await getTaxEstimate(cart, null, 'USD', `GUESS${index}`, cart));
    }

    // Every call still succeeds with a tax figure: throttling degrades to "no coupon", not an error.
    expect(results.every((result) => result.success && result.tax === taxResult)).toBe(true);

    const quoted = mocks.getCouponQuote.mock.calls.length;
    expect(quoted).toBeGreaterThan(0);
    expect(quoted).toBeLessThan(60);

    // The coupon is quoted only while within budget; the rest compute tax with no discount applied.
    const discountedCalls = mocks.buildCheckoutTaxableItemsFromCart.mock.calls.filter(
      (call) => call[4] === discountMap
    );
    const undiscountedCalls = mocks.buildCheckoutTaxableItemsFromCart.mock.calls.filter(
      (call) => call[4] === undefined
    );
    expect(discountedCalls.length).toBe(quoted);
    expect(undiscountedCalls.length).toBe(60 - quoted);
  });

  it('throttles each client address independently', async () => {
    useFreshClient();
    for (let index = 0; index < 60; index += 1) {
      await getTaxEstimate(cart, null, 'USD', 'SAVE10', cart);
    }
    const exhaustedQuotes = mocks.getCouponQuote.mock.calls.length;

    // A fresh client gets its own full budget: the very next quote goes through.
    useFreshClient();
    await getTaxEstimate(cart, null, 'USD', 'SAVE10', cart);
    expect(mocks.getCouponQuote.mock.calls.length).toBe(exhaustedQuotes + 1);
  });

  it('throttles requests with no readable address as one shared client', async () => {
    mocks.requestHeaders = {};

    for (let index = 0; index < 60; index += 1) {
      await getTaxEstimate(cart, null, 'USD', 'SAVE10', cart);
    }

    // The shared unknown bucket caps the quotes well below the number of attempts.
    expect(mocks.getCouponQuote.mock.calls.length).toBeLessThan(60);
  });

  it('degrades to a failure result instead of throwing when tax calculation fails', async () => {
    useFreshClient();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.calculateCheckoutTaxes.mockRejectedValueOnce(new Error('tax backend unavailable'));

    const result = await getTaxEstimate(cart, null, 'USD', 'SAVE10', cart);

    expect(result.success).toBe(false);
    expect(result.tax).toBeUndefined();
    errorSpy.mockRestore();
  });
});
