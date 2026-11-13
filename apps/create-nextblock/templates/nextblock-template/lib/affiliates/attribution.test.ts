import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The app side of checkout attribution: nothing runs while the Affiliates package is off, a
 * visitor who declined marketing cookies is never attributed (token or cookie), the storefront
 * token counts only when its signature verifies, the referral cookie is read from the request
 * (never from the body), the buyer's identity comes from the session, and nothing here can fail
 * a checkout.
 */

const mocks = vi.hoisted(() => ({
  serviceKey: 'test-service-role-key' as string | undefined,
  packageActive: true,
  /** The request's cookies by name. */
  cookies: {} as Record<string, string>,
  cookiesThrow: false,
  serviceClient: { tag: 'service-role' } as Record<string, unknown>,
  serviceClientThrows: false,
  resolveCheckoutAttribution: vi.fn(),
  verifyPackageOnline: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  cookieReads: [] as string[],
}));

// The constants and handle modules only, via vi.importActual (an import() would mark the lib
// lazy-loaded for Nx's boundary rule).
vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/constants')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/handle')),
}));
vi.mock('@nextblock-cms/affiliates/server', () => ({
  resolveCheckoutAttribution: mocks.resolveCheckoutAttribution,
}));
vi.mock('@nextblock-cms/db/server', () => ({
  verifyPackageOnline: mocks.verifyPackageOnline,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));
vi.mock('next/headers', () => ({
  cookies: async () => {
    if (mocks.cookiesThrow) throw new Error('`cookies` was called outside a request scope.');
    return {
      get: (name: string) => {
        mocks.cookieReads.push(name);
        return name in mocks.cookies ? { name, value: mocks.cookies[name] } : undefined;
      },
    };
  },
}));
vi.mock('../setup/service-key', () => ({ resolveSupabaseServiceKey: () => mocks.serviceKey }));

import { AFFILIATE_HANDLE_PATTERN } from '@nextblock-cms/affiliates';
import { REFERRAL_HANDLE_PATTERN, normalizeReferralHandle } from '@nextblock-cms/ecommerce/components/AddToCartButton';
import { resolveAttributionForCheckout } from './attribution';
import { mintAffiliateStorefrontToken } from './storefront-token';

const PARTNER_ATTRIBUTION = {
  affiliateId: '11111111-1111-4111-8111-111111111111',
  handle: 'jane-doe',
  source: 'storefront' as const,
  baseCurrency: 'USD',
};

beforeEach(() => {
  mocks.serviceKey = 'test-service-role-key';
  mocks.packageActive = true;
  mocks.cookies = {};
  mocks.cookiesThrow = false;
  mocks.serviceClientThrows = false;
  mocks.cookieReads = [];
  mocks.resolveCheckoutAttribution.mockReset();
  mocks.resolveCheckoutAttribution.mockResolvedValue(PARTNER_ATTRIBUTION);
  mocks.verifyPackageOnline.mockReset();
  // The program runs only while Affiliates AND Commerce Pro are active (lib/affiliates/package-state.ts).
  mocks.verifyPackageOnline.mockImplementation(async (id: string) => (id === 'affiliates' || id === 'ecommerce') && mocks.packageActive);
  mocks.getServiceRoleSupabaseClient.mockReset();
  mocks.getServiceRoleSupabaseClient.mockImplementation(() => {
    if (mocks.serviceClientThrows) throw new Error('Missing Supabase Service Role environment variables');
    return mocks.serviceClient;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveAttributionForCheckout', () => {
  it('does nothing while the Affiliates package is inactive', async () => {
    mocks.packageActive = false;
    mocks.cookies = { nb_affiliate_ref: 'jane-doe' };

    await expect(
      resolveAttributionForCheckout({ body: { affiliateRef: mintAffiliateStorefrontToken('jane-doe') }, user: null })
    ).resolves.toBeNull();
    expect(mocks.verifyPackageOnline).toHaveBeenCalledWith('affiliates');
    expect(mocks.cookieReads).toEqual([]);
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.resolveCheckoutAttribution).not.toHaveBeenCalled();
  });

  it('returns null without the service role when there is neither a token nor a cookie', async () => {
    await expect(resolveAttributionForCheckout({ body: { items: [] }, user: null })).resolves.toBeNull();
    expect(mocks.cookieReads).toEqual(['nb_affiliate_ref', 'nb_consent_preference']);
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.resolveCheckoutAttribution).not.toHaveBeenCalled();
  });

  it('hands a verified storefront token, the cookie and the session buyer to the resolver', async () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    mocks.cookies = { nb_affiliate_ref: 'marc-picks' };

    const result = await resolveAttributionForCheckout({
      body: { affiliateRef: mintAffiliateStorefrontToken('jane-doe'), customerEmail: 'typed@example.com' },
      user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'account@example.com' },
    });

    expect(result).toEqual(PARTNER_ATTRIBUTION);
    expect(mocks.resolveCheckoutAttribution).toHaveBeenCalledTimes(1);
    const input = mocks.resolveCheckoutAttribution.mock.calls[0][0];
    expect(input.supabase).toBe(mocks.serviceClient);
    expect(input.token).toEqual({ handle: 'jane-doe', issuedAt: expect.any(Number) });
    expect(Math.abs(input.token.issuedAt - issuedAt)).toBeLessThanOrEqual(1);
    expect(input).toMatchObject({
      cookieHandle: 'marc-picks',
      buyerUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      // The account email wins over what the form says.
      buyerEmail: 'account@example.com',
    });
  });

  it('drops a forged or tampered token and keeps the cookie', async () => {
    const genuine = mintAffiliateStorefrontToken('jane-doe') as string;
    const forged = `v1.marc-picks.${genuine.split('.')[2]}.${genuine.split('.')[3]}`;
    mocks.cookies = { nb_affiliate_ref: 'jane-doe' };

    await resolveAttributionForCheckout({ body: { affiliateRef: forged, customerEmail: 'guest@example.com' }, user: null });

    expect(mocks.resolveCheckoutAttribution.mock.calls[0][0]).toMatchObject({
      token: null,
      cookieHandle: 'jane-doe',
      buyerUserId: null,
      buyerEmail: 'guest@example.com',
    });
  });

  it('never trusts an affiliate id, handle or object in the body', async () => {
    await expect(
      resolveAttributionForCheckout({
        body: { affiliateRef: { handle: 'jane-doe', issuedAt: 1 }, affiliateId: PARTNER_ATTRIBUTION.affiliateId },
        user: null,
      })
    ).resolves.toBeNull();
    expect(mocks.resolveCheckoutAttribution).not.toHaveBeenCalled();
  });

  it('ignores an oversized cookie value', async () => {
    mocks.cookies = { nb_affiliate_ref: 'x'.repeat(65) };

    await expect(resolveAttributionForCheckout({ body: {}, user: null })).resolves.toBeNull();
    expect(mocks.resolveCheckoutAttribution).not.toHaveBeenCalled();
  });

  it('treats an unreadable cookie store as no cookie', async () => {
    mocks.cookiesThrow = true;

    await expect(
      resolveAttributionForCheckout({ body: { affiliateRef: mintAffiliateStorefrontToken('jane-doe') }, user: null })
    ).resolves.toEqual(PARTNER_ATTRIBUTION);
    expect(mocks.resolveCheckoutAttribution.mock.calls[0][0]).toMatchObject({ cookieHandle: null });
  });

  describe('marketing consent', () => {
    /** The consent banner's record (lib/privacy/consent-client.ts writes it percent-encoded). */
    const consentRecord = (marketing: boolean) =>
      JSON.stringify({ necessary: true, analytics: true, marketing, token: 'consent-token', ts: 1793102400000 });

    it.each([
      ['as the banner writes it (percent-encoded)', encodeURIComponent(consentRecord(false))],
      ['decoded', consentRecord(false)],
    ])(
      'attributes nothing, token or referral cookie, once the visitor declined marketing (%s)',
      async (_label, consent) => {
        mocks.cookies = { nb_affiliate_ref: 'marc-picks', nb_consent_preference: consent };

        await expect(
          resolveAttributionForCheckout({
            body: { affiliateRef: mintAffiliateStorefrontToken('jane-doe'), customerEmail: 'guest@example.com' },
            user: null,
          })
        ).resolves.toBeNull();
        expect(mocks.cookieReads).toContain('nb_consent_preference');
        expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
        expect(mocks.resolveCheckoutAttribution).not.toHaveBeenCalled();
      }
    );

    it.each([
      ['accepted marketing', { nb_consent_preference: encodeURIComponent(consentRecord(true)) }],
      ['not decided yet (no consent cookie)', {}],
      ['an unreadable consent cookie', { nb_consent_preference: 'not json' }],
      ['a consent record without a marketing answer', { nb_consent_preference: JSON.stringify({ necessary: true }) }],
    ])('keeps attributing a visitor who has %s', async (_label, consentCookies) => {
      mocks.cookies = { nb_affiliate_ref: 'marc-picks', ...consentCookies };

      await expect(
        resolveAttributionForCheckout({ body: { affiliateRef: mintAffiliateStorefrontToken('jane-doe') }, user: null })
      ).resolves.toEqual(PARTNER_ATTRIBUTION);
      expect(mocks.resolveCheckoutAttribution.mock.calls[0][0]).toMatchObject({
        token: { handle: 'jane-doe' },
        cookieHandle: 'marc-picks',
      });
    });
  });

  it.each([
    ['the resolver rejects', () => mocks.resolveCheckoutAttribution.mockRejectedValue(new Error('boom'))],
    ['the service client cannot be built', () => (mocks.serviceClientThrows = true)],
    ['the package check rejects', () => mocks.verifyPackageOnline.mockRejectedValue(new Error('network'))],
  ])('never throws: null when %s', async (_label, arrange) => {
    arrange();
    mocks.cookies = { nb_affiliate_ref: 'jane-doe' };

    await expect(resolveAttributionForCheckout({ body: {}, user: null })).resolves.toBeNull();
  });
});

describe('referral handle parity', () => {
  it('product links accept exactly the partner handles the affiliates package accepts', () => {
    expect(REFERRAL_HANDLE_PATTERN.source).toBe(AFFILIATE_HANDLE_PATTERN.source);
    for (const handle of ['jane-doe', 'abc', 'a1b', 'x'.repeat(32), 'ab', '-ab', 'ab-', 'a_b', 'x'.repeat(33), 'Jane']) {
      expect(normalizeReferralHandle(handle) !== null, handle).toBe(AFFILIATE_HANDLE_PATTERN.test(handle.toLowerCase()));
    }
  });
});
