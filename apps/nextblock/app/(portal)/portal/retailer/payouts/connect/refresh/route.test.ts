import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Stripe's `refresh_url`: a partner whose onboarding link expired gets a fresh one (302 to
 * Stripe). Everything else, including a missing session, lands on the payouts page with
 * `?connect_error=1`, and the redirect never leaves for a non-Stripe host.
 */

const mocks = vi.hoisted(() => ({
  requireRetailer: vi.fn(),
  createRefreshLink: vi.fn(),
}));

vi.mock('../../../../../../../lib/affiliates/retailer-actor', () => ({ requireRetailer: mocks.requireRetailer }));
vi.mock('../../../../../../../lib/affiliates/connect-service', () => ({ createAffiliateConnectRefreshLink: mocks.createRefreshLink }));
// The real redirect guard of portal-data; only its I/O dependencies are stubbed.
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@nextblock-cms/db/server', () => ({ getSsgSupabaseClient: vi.fn() }));
vi.mock('@nextblock-cms/ecommerce', () => vi.importActual('../../../../../../../../../libs/ecommerce/src/lib/currency'));
vi.mock('@nextblock-cms/affiliates/server', () => vi.importActual('../../../../../../../../../libs/affiliates/src/lib/repository'));
vi.mock('../../../../../../../lib/storage/provider', () => ({ resolveMediaBaseUrl: () => '' }));
vi.mock('../../../../../../../lib/affiliates/image-origins', () => ({ getStorefrontImageOrigins: () => [] }));
vi.mock('../../../../../../../lib/affiliates/settings', () => ({ getAffiliatesSettings: vi.fn() }));

import { GET } from './route';

const ERROR_TARGET = 'https://shop.test/portal/retailer/payouts?connect_error=1';
const request = () => new NextRequest('https://shop.test/portal/retailer/payouts/connect/refresh');
const ACTOR = { userId: 'u-1', email: null, role: 'RTL', affiliate: { id: 'a-1' }, page: null };

describe('GET /portal/retailer/payouts/connect/refresh', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('redirects to a fresh Stripe onboarding link', async () => {
    mocks.requireRetailer.mockResolvedValue({ supabase: {}, actor: ACTOR });
    mocks.createRefreshLink.mockResolvedValue({ ok: true, url: 'https://connect.stripe.com/setup/e/acct_1/new' });

    const response = await GET(request());

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://connect.stripe.com/setup/e/acct_1/new');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.createRefreshLink).toHaveBeenCalledWith(ACTOR);
  });

  it.each(['Unauthorized', 'Forbidden', 'Suspended', 'PackageInactive'])(
    'sends a %s caller back to the payouts page without creating a link',
    async (message) => {
      mocks.requireRetailer.mockRejectedValue(new Error(message));
      const response = await GET(request());
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(ERROR_TARGET);
      expect(mocks.createRefreshLink).not.toHaveBeenCalled();
    },
  );

  it('falls back when the service refuses, throws, or returns a non-Stripe URL', async () => {
    mocks.requireRetailer.mockResolvedValue({ supabase: {}, actor: ACTOR });
    for (const outcome of [
      Promise.resolve({ ok: false, error: 'no_account' }),
      Promise.reject(new Error('boom')),
      Promise.resolve({ ok: true, url: 'https://evil.test/phish' }),
    ]) {
      outcome.catch(() => undefined);
      mocks.createRefreshLink.mockReturnValueOnce(outcome);
      const response = await GET(request());
      expect(response.headers.get('location')).toBe(ERROR_TARGET);
    }
  });

  it('is off in the sandbox', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const response = await GET(request());
    expect(response.headers.get('location')).toBe(ERROR_TARGET);
    expect(mocks.requireRetailer).not.toHaveBeenCalled();
  });
});
