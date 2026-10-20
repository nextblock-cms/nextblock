import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createCheckoutSession: vi.fn(),
  getProviderReadiness: vi.fn(),
  verifyPackageOnline: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock('@nextblock-cms/ecommerce/server', () => ({
  getPaymentProvider: () => ({ createCheckoutSession: mocks.createCheckoutSession }),
  getProviderReadiness: mocks.getProviderReadiness,
}));
vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({ auth: { getUser: mocks.getUser } }),
  verifyPackageOnline: mocks.verifyPackageOnline,
}));
vi.mock('@nextblock-cms/ecommerce', () => ({
  normalizeCustomerAddress: (address: unknown) => address ?? null,
}));

import { POST } from './route';

const PRODUCT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const STANDARD_ID = 'ea112a82-e05c-46bc-a5e7-5bb62528aa5d';
const US_ADDRESS = {
  recipient_name: 'Guest Shopper',
  line1: '1 Main St',
  city: 'New York',
  state: 'NY',
  postal_code: '10001',
  country_code: 'US',
};

function physicalLine(overrides: Record<string, unknown> = {}) {
  return {
    id: PRODUCT_A,
    product_id: PRODUCT_A,
    title: 'Live Product',
    product_type: 'physical',
    provider: 'stripe',
    quantity: 1,
    ...overrides,
  };
}

async function post(body: Record<string, unknown>) {
  const response = await POST(
    new Request('http://localhost:4200/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [physicalLine()],
        customerEmail: 'guest@example.test',
        billingAddress: US_ADDRESS,
        shippingAddress: US_ADDRESS,
        shippingMethodId: STANDARD_ID,
        currencyCode: 'USD',
        locale: 'en',
        ...body,
      }),
    })
  );

  return { status: response.status, body: await response.json() };
}

describe('POST /api/checkout', () => {
  beforeEach(() => {
    mocks.verifyPackageOnline.mockResolvedValue(true);
    mocks.getProviderReadiness.mockResolvedValue({ ready: true, label: 'Stripe', missing: [] });
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    mocks.createCheckoutSession.mockReset();
    mocks.createCheckoutSession.mockResolvedValue({ url: 'https://checkout.stripe.test/cs_test' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['a negative line beside a positive one (the repro)', [physicalLine({ quantity: 1 }), physicalLine({ quantity: -5 })]],
    ['a zero quantity', [physicalLine({ quantity: 0 })]],
    ['a fractional quantity', [physicalLine({ quantity: 1.5 })]],
    ['a string quantity', [physicalLine({ quantity: '2' })]],
    ['an absurd quantity', [physicalLine({ quantity: 10_001 })]],
    ['a missing quantity', [physicalLine({ quantity: undefined })]],
    ['a non-uuid product id', [physicalLine({ product_id: "1' OR 1=1" })]],
    ['a non-uuid variant id', [physicalLine({ variant_id: 'base' })]],
    ['an empty cart', []],
    ['a non-array', { product_id: PRODUCT_A, quantity: 1 }],
    ['no items at all', undefined],
  ])('rejects %s with 400 before the provider runs', async (_label, items) => {
    const { status, body } = await post({ items });

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invalid items data', errorKey: 'ecommerce.checkout_invalid_items' });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects invalid coupon-context lines the same way', async () => {
    const { status, body } = await post({
      couponContextItems: [physicalLine({ quantity: 1 }), physicalLine({ quantity: -1 })],
    });

    expect(status).toBe(400);
    expect(body.errorKey).toBe('ecommerce.checkout_invalid_items');
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('passes a valid guest checkout through with the method id for the provider to re-read', async () => {
    const items = [physicalLine({ quantity: 2 }), physicalLine({ quantity: 1, variant_id: '' })];
    const { status, body } = await post({ items, shippingMethodId: ` ${STANDARD_ID} ` });

    expect(status).toBe(200);
    expect(body).toEqual({ url: 'https://checkout.stripe.test/cs_test' });
    expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(mocks.createCheckoutSession.mock.calls[0][0]).toMatchObject({
      items,
      customerEmail: 'guest@example.test',
      userId: undefined,
      shippingMethodId: STANDARD_ID,
      shippingAddress: US_ADDRESS,
      currencyCode: 'USD',
      couponContextItems: items,
    });
  });

  it('forwards only a string shipping method id; anything else becomes null', async () => {
    await post({ shippingMethodId: { id: STANDARD_ID } });
    await post({ shippingMethodId: '   ' });

    expect(mocks.createCheckoutSession.mock.calls.map((call) => call[0].shippingMethodId)).toEqual([
      null,
      null,
    ]);
  });

  it('surfaces the provider rejection with its status', async () => {
    mocks.createCheckoutSession.mockResolvedValue({
      url: null,
      error: 'The selected shipping method is not available for this order.',
      errorKey: 'ecommerce.checkout_invalid_shipping_method',
      errorStatus: 400,
    });

    const { status, body } = await post({});

    expect(status).toBe(400);
    expect(body).toEqual({
      error: 'The selected shipping method is not available for this order.',
      errorKey: 'ecommerce.checkout_invalid_shipping_method',
    });
  });
});
