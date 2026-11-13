import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  createCheckoutSession: vi.fn(),
  getPaymentProvider: vi.fn(),
  getProviderReadiness: vi.fn(),
  verifyPackageOnline: vi.fn(),
  createClient: vi.fn(),
  getUser: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  cookies: {} as Record<string, string>,
  cookieReads: [] as string[],
}));

vi.mock('@nextblock-cms/ecommerce/server', () => ({
  getPaymentProvider: mocks.getPaymentProvider,
  getProviderReadiness: mocks.getProviderReadiness,
}));
vi.mock('@nextblock-cms/db/server', async () => ({
  createClient: mocks.createClient,
  verifyPackageOnline: mocks.verifyPackageOnline,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
  // The real predicate (a dependency-free module): the refusal follows NEXT_PUBLIC_IS_SANDBOX exactly.
  isSandboxEnvironment: (
    await vi.importActual<{ isSandboxEnvironment: () => boolean }>('../../../../../libs/db/src/lib/config-resolve')
  ).isSandboxEnvironment,
}));
vi.mock('@nextblock-cms/ecommerce', () => ({
  normalizeCustomerAddress: (address: unknown) => address ?? null,
}));
// Attribution runs for real (app module + the lib resolver); only its edges are faked. Lib
// modules come in through vi.importActual, never import(), so Nx does not see a lazy-loaded lib.
vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/affiliates/src/lib/core/constants')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/affiliates/src/lib/core/handle')),
}));
vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/affiliates/src/lib/attribution/index')),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      mocks.cookieReads.push(name);
      return name in mocks.cookies ? { name, value: mocks.cookies[name] } : undefined;
    },
  }),
}));

import { mintAffiliateStorefrontToken } from '../../../lib/affiliates/storefront-token';
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

/* ------------------------------------------------------------ partner fixtures --- */

const JANE = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  handle: 'jane-doe',
  status: 'ACTIVE',
  first_published_at: '2026-09-01T00:00:00Z',
  tier: { cookie_duration_days: 30 },
};
const MARC = {
  id: '22222222-2222-4222-8222-222222222222',
  user_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  handle: 'marc-picks',
  status: 'ACTIVE',
  first_published_at: '2026-08-01T00:00:00Z',
  tier: { cookie_duration_days: 30 },
};
const PARTNER_EMAILS: Record<string, string> = { [JANE.user_id]: 'jane@gmail.com', [MARC.user_id]: 'marc@example.com' };

/** The service-role client the attribution resolver reads partners, the base currency and auth emails with. */
function fakeServiceClient(options: { profiles?: Row[]; failProfiles?: boolean } = {}) {
  const profiles = options.profiles ?? [JANE, MARC];

  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let single = false;
    const builder: Record<string, unknown> = {
      select: () => builder,
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      limit: () => builder,
      maybeSingle: () => {
        single = true;
        return builder;
      },
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
        if (table === 'affiliate_profiles' && options.failProfiles) {
          return Promise.resolve({ data: null, error: { code: '57014', message: 'statement timeout' } }).then(onFulfilled, onRejected);
        }
        const source: Row[] = table === 'affiliate_profiles' ? profiles : [{ code: 'USD', is_default: true }];
        const rows = source.filter((row) => filters.every((filter) => filter(row)));
        return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(onFulfilled, onRejected);
      },
    };
    return builder;
  };

  return {
    from,
    auth: {
      admin: {
        getUserById: async (userId: string) =>
          userId in PARTNER_EMAILS
            ? { data: { user: { id: userId, email: PARTNER_EMAILS[userId] } }, error: null }
            : { data: { user: null }, error: { status: 404, message: 'User not found' } },
      },
    },
  };
}

function attributionPassed() {
  return mocks.createCheckoutSession.mock.calls[0][0].attribution;
}

describe('POST /api/checkout', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    mocks.verifyPackageOnline.mockReset();
    mocks.verifyPackageOnline.mockResolvedValue(true);
    mocks.getPaymentProvider.mockReset();
    mocks.getPaymentProvider.mockImplementation(() => ({ createCheckoutSession: mocks.createCheckoutSession }));
    mocks.getProviderReadiness.mockReset();
    mocks.getProviderReadiness.mockResolvedValue({ ready: true, label: 'Stripe', missing: [] });
    mocks.createClient.mockReset();
    mocks.createClient.mockImplementation(() => ({ auth: { getUser: mocks.getUser } }));
    mocks.getUser.mockReset();
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    mocks.getServiceRoleSupabaseClient.mockReset();
    mocks.getServiceRoleSupabaseClient.mockImplementation(() => fakeServiceClient());
    mocks.cookies = {};
    mocks.cookieReads = [];
    mocks.createCheckoutSession.mockReset();
    mocks.createCheckoutSession.mockResolvedValue({ url: 'https://checkout.stripe.test/cs_test' });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('on the public sandbox', () => {
    function checkoutRequest(body: string) {
      return new Request('http://localhost:4200/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    }

    function expectNothingRan() {
      for (const [name, spy] of Object.entries({
        verifyPackageOnline: mocks.verifyPackageOnline,
        getProviderReadiness: mocks.getProviderReadiness,
        getPaymentProvider: mocks.getPaymentProvider,
        createCheckoutSession: mocks.createCheckoutSession,
        createClient: mocks.createClient,
        getUser: mocks.getUser,
        getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
      })) {
        expect(spy, name).not.toHaveBeenCalled();
      }
      // Attribution never ran: no consent or referral cookie was read.
      expect(mocks.cookieReads).toEqual([]);
    }

    it('answers 403 before the package check, the body, attribution or any provider or database call', async () => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
      mocks.cookies = { nb_affiliate_ref: 'marc-picks' };
      const request = checkoutRequest(
        JSON.stringify({
          items: [physicalLine()],
          customerEmail: 'guest@example.test',
          billingAddress: US_ADDRESS,
          shippingAddress: US_ADDRESS,
          shippingMethodId: STANDARD_ID,
          couponCode: 'WELCOME10',
          affiliateRef: mintAffiliateStorefrontToken('jane-doe'),
        })
      );
      const readBody = vi.spyOn(request, 'json');

      const response = await POST(request);

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'This is a Sandbox environment. The Freemius checkout is skipped here for demo purposes.',
        errorKey: 'ecommerce.sandbox_notice',
      });
      expect(readBody).not.toHaveBeenCalled();
      expect(request.bodyUsed).toBe(false);
      expectNothingRan();
    });

    it('refuses the same way whatever the body holds', async () => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

      for (const body of ['{not json', JSON.stringify({ items: [] })]) {
        const response = await POST(checkoutRequest(body));
        expect(response.status, body).toBe(403);
        expect((await response.json()).errorKey, body).toBe('ecommerce.sandbox_notice');
      }
      expectNothingRan();
    });

    it('checks out as before anywhere else (only the exact value "true" is the sandbox)', async () => {
      for (const value of ['', 'false', 'TRUE', '1']) {
        vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
        const { status, body } = await post({});
        expect(status, value).toBe(200);
        expect(body, value).toEqual({ url: 'https://checkout.stripe.test/cs_test' });
      }

      expect(mocks.verifyPackageOnline).toHaveBeenCalledWith('ecommerce');
      expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(4);
    });
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
      attribution: null,
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

  describe('affiliate attribution', () => {
    it('attributes a checkout carrying a genuine storefront token to its partner', async () => {
      const { status } = await post({ affiliateRef: mintAffiliateStorefrontToken('jane-doe') });

      expect(status).toBe(200);
      expect(attributionPassed()).toEqual({ affiliateId: JANE.id, source: 'storefront', baseCurrency: 'USD' });
    });

    it('lets the storefront token win over a referral cookie for another partner', async () => {
      mocks.cookies = { nb_affiliate_ref: 'marc-picks' };

      await post({ affiliateRef: mintAffiliateStorefrontToken('jane-doe') });

      expect(attributionPassed()).toMatchObject({ affiliateId: JANE.id, source: 'storefront' });
    });

    it('attributes a checkout to the referral cookie partner', async () => {
      mocks.cookies = { nb_affiliate_ref: 'marc-picks' };

      await post({});

      expect(attributionPassed()).toEqual({ affiliateId: MARC.id, source: 'referral_link', baseCurrency: 'USD' });
    });

    it('does not attribute a visitor who declined marketing cookies, token or referral cookie', async () => {
      const declined = { necessary: true, analytics: false, marketing: false, token: 'consent-token', ts: 1793102400000 };
      mocks.cookies = {
        nb_affiliate_ref: 'marc-picks',
        nb_consent_preference: encodeURIComponent(JSON.stringify(declined)),
      };

      const { status } = await post({ affiliateRef: mintAffiliateStorefrontToken('jane-doe') });

      expect(status).toBe(200);
      expect(attributionPassed()).toBeNull();
      expect(mocks.cookieReads).toContain('nb_consent_preference');
      expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    });

    it('still attributes a visitor who accepted marketing cookies', async () => {
      const accepted = { necessary: true, analytics: false, marketing: true, token: 'consent-token', ts: 1793102400000 };
      mocks.cookies = { nb_consent_preference: encodeURIComponent(JSON.stringify(accepted)) };

      await post({ affiliateRef: mintAffiliateStorefrontToken('jane-doe') });

      expect(attributionPassed()).toEqual({ affiliateId: JANE.id, source: 'storefront', baseCurrency: 'USD' });
    });

    it('ignores a forged token and an affiliate id in the body', async () => {
      const genuine = mintAffiliateStorefrontToken('jane-doe') as string;
      const [, , issuedAt, signature] = genuine.split('.');

      await post({ affiliateRef: `v1.marc-picks.${issuedAt}.${signature}`, affiliateId: MARC.id });

      expect(attributionPassed()).toBeNull();
      expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    });

    it('does not attribute a partner buying on their own storefront while signed in', async () => {
      mocks.getUser.mockResolvedValue({ data: { user: { id: JANE.user_id, email: 'jane@gmail.com' } } });

      await post({ affiliateRef: mintAffiliateStorefrontToken('jane-doe') });

      expect(attributionPassed()).toBeNull();
      expect(mocks.createCheckoutSession.mock.calls[0][0]).toMatchObject({ userId: JANE.user_id });
    });

    it('does not attribute a partner checking out as a guest with a variant of their own email', async () => {
      mocks.cookies = { nb_affiliate_ref: 'jane-doe' };

      await post({ customerEmail: 'J.A.N.E+deals@googlemail.com' });

      expect(attributionPassed()).toBeNull();
    });

    it('does nothing while the Affiliates package is inactive (the cookie is not even read)', async () => {
      mocks.verifyPackageOnline.mockImplementation(async (id: string) => id !== 'affiliates');
      mocks.cookies = { nb_affiliate_ref: 'marc-picks' };

      const { status } = await post({ affiliateRef: mintAffiliateStorefrontToken('jane-doe') });

      expect(status).toBe(200);
      expect(attributionPassed()).toBeNull();
      expect(mocks.cookieReads).toEqual([]);
      expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    });

    it('never attributes to a partner whose storefront was never approved', async () => {
      mocks.getServiceRoleSupabaseClient.mockImplementation(() =>
        fakeServiceClient({ profiles: [{ ...MARC, first_published_at: null }] })
      );
      mocks.cookies = { nb_affiliate_ref: 'marc-picks' };

      await post({});

      expect(attributionPassed()).toBeNull();
    });

    it('still checks out, unattributed, when the attribution lookup fails', async () => {
      mocks.getServiceRoleSupabaseClient.mockImplementation(() => fakeServiceClient({ failProfiles: true }));
      mocks.cookies = { nb_affiliate_ref: 'marc-picks' };

      const { status, body } = await post({});

      expect(status).toBe(200);
      expect(body).toEqual({ url: 'https://checkout.stripe.test/cs_test' });
      expect(attributionPassed()).toBeNull();
    });
  });
});
