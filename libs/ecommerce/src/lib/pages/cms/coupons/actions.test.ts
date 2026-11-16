import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The CMS coupon actions write with the service role and push the coupon to Freemius, where the
 * developer key pair reaches every product of the account (a coupon with no product scope applies
 * to all of them). Until 2026-11-13 they authorized through a local getAdminClient() that read the
 * role only, so an ADMIN password without the second factor (an aal1 session: proxy.ts lets it
 * through, and a server action never meets the CMS layout's 2FA redirect) could create a live,
 * unlimited 100% coupon at Freemius. Each action now starts with the real requireEcomAdmin(),
 * exercised here against a stubbed cookie session and the app's second-factor gate.
 */

const COUPON_ID = 'cccccccc-0000-4000-8000-000000000001';
const GATE = Symbol.for('nextblock.cms.secondFactorGate');

const mocks = vi.hoisted(() => ({
  user: { id: 'admin-1' } as { id: string } | null,
  role: 'ADMIN' as string | null,
  secondFactorPassed: true,
  securitySettings: null as { mfa_enabled: boolean; mfa_type: string } | null,
  aal: 'aal1',
  serviceClientCreated: vi.fn(),
  serviceFrom: vi.fn(),
  serviceWrite: vi.fn(),
  syncCouponToFreemius: vi.fn(),
  deleteCouponFromFreemius: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
}));

/** Every query on the service client resolves; writes are recorded with their table. */
function makeServiceClient() {
  return {
    from: (table: string) => {
      mocks.serviceFrom(table);
      const chain: Record<string, unknown> = {};
      chain.insert = (values: unknown) => {
        mocks.serviceWrite('insert', table, values);
        return chain;
      };
      chain.update = (values: unknown) => {
        mocks.serviceWrite('update', table, values);
        return chain;
      };
      chain.delete = () => {
        mocks.serviceWrite('delete', table);
        return chain;
      };
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.single = async () => ({ data: { id: COUPON_ID }, error: null });
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve, reject);
      return chain;
    },
  };
}

const serviceClient = makeServiceClient();

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({
  // The cookie client requireEcomAdmin() reads the session, the caller's own role and (without
  // the app's gate) the enrolled factor through.
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: mocks.user } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: mocks.aal } }) },
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: table === 'profiles' && mocks.role ? { role: mocks.role } : null }),
          maybeSingle: async () => ({ data: table === 'user_security_settings' ? mocks.securitySettings : null }),
        }),
      }),
    }),
  }),
  getServiceRoleSupabaseClient: () => {
    mocks.serviceClientCreated();
    return serviceClient;
  },
}));
vi.mock('../../../freemius-coupons', () => ({
  syncCouponToFreemius: mocks.syncCouponToFreemius,
  deleteCouponFromFreemius: mocks.deleteCouponFromFreemius,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import {
  createCouponAction,
  deleteCouponAction,
  syncCouponAction,
  toggleCouponActiveAction,
  updateCouponAction,
} from './actions';

function couponForm(overrides: Record<string, string> = {}) {
  const form = new FormData();
  const fields: Record<string, string> = {
    code: 'free100',
    name: 'Everything free',
    provider_scope: 'freemius',
    discount_type: 'percent',
    discount_amount: '100',
    currency_code: 'USD',
    is_active: 'true',
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

const ACTIONS: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
  ['createCouponAction', () => createCouponAction(couponForm())],
  ['updateCouponAction', () => updateCouponAction(COUPON_ID, couponForm())],
  ['toggleCouponActiveAction', () => toggleCouponActiveAction(COUPON_ID, true)],
  ['syncCouponAction', () => syncCouponAction(COUPON_ID)],
  ['deleteCouponAction', () => deleteCouponAction(COUPON_ID)],
];

function expectNothingPrivilegedRan() {
  expect(mocks.serviceClientCreated).not.toHaveBeenCalled();
  expect(mocks.serviceFrom).not.toHaveBeenCalled();
  expect(mocks.syncCouponToFreemius).not.toHaveBeenCalled();
  expect(mocks.deleteCouponFromFreemius).not.toHaveBeenCalled();
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
  expect(mocks.redirect).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: 'admin-1' };
  mocks.role = 'ADMIN';
  mocks.secondFactorPassed = true;
  mocks.securitySettings = null;
  mocks.aal = 'aal1';
  // The app's gate, as instrumentation.ts / cms-actor.ts register it at server start.
  (globalThis as Record<symbol, unknown>)[GATE] = async () => mocks.secondFactorPassed;
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[GATE];
});

describe('coupon actions authorize through requireEcomAdmin() before anything else', () => {
  it.each(ACTIONS)(
    '%s refuses an ADMIN whose second factor is still pending, before any read, write or Freemius call',
    async (_name, run) => {
      mocks.secondFactorPassed = false;

      await expect(run()).rejects.toThrow('Unauthorized');
      expectNothingPrivilegedRan();
    }
  );

  it.each(ACTIONS)('%s refuses a TOTP-enrolled ADMIN at aal1 when the app gate is not registered', async (_name, run) => {
    delete (globalThis as Record<symbol, unknown>)[GATE];
    mocks.securitySettings = { mfa_enabled: true, mfa_type: 'totp' };

    await expect(run()).rejects.toThrow('Unauthorized');
    expectNothingPrivilegedRan();
  });

  it.each(ACTIONS)('%s refuses a WRITER with Forbidden', async (_name, run) => {
    mocks.role = 'WRITER';

    await expect(run()).rejects.toThrow('Forbidden');
    expectNothingPrivilegedRan();
  });

  it.each(ACTIONS)('%s refuses an anonymous caller', async (_name, run) => {
    mocks.user = null;
    mocks.role = null;

    await expect(run()).rejects.toThrow('Unauthorized');
    expectNothingPrivilegedRan();
  });
});

describe('an ADMIN who passed the second factor keeps the existing behaviour', () => {
  it('createCouponAction saves the coupon, pushes it with the service client and redirects', async () => {
    await createCouponAction(couponForm());

    expect(mocks.serviceWrite).toHaveBeenCalledWith(
      'insert',
      'coupons',
      expect.objectContaining({ code: 'FREE100', discount_amount: 100, freemius_sync_status: 'pending' })
    );
    expect(mocks.syncCouponToFreemius).toHaveBeenCalledWith({ couponId: COUPON_ID, client: serviceClient });
    expect(mocks.redirect).toHaveBeenCalledWith('/cms/coupons');
  });

  it('updateCouponAction pushes the coupon, or deletes its Freemius copy once it is Stripe-only', async () => {
    await updateCouponAction(COUPON_ID, couponForm());
    expect(mocks.syncCouponToFreemius).toHaveBeenCalledWith({ couponId: COUPON_ID, client: serviceClient });
    expect(mocks.deleteCouponFromFreemius).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await updateCouponAction(COUPON_ID, couponForm({ provider_scope: 'stripe' }));
    expect(mocks.deleteCouponFromFreemius).toHaveBeenCalledWith({ couponId: COUPON_ID, client: serviceClient });
    expect(mocks.syncCouponToFreemius).not.toHaveBeenCalled();
  });

  it('toggle and sync push with the service client; delete removes the Freemius copy, then the row', async () => {
    await toggleCouponActiveAction(COUPON_ID, false);
    expect(mocks.serviceWrite).toHaveBeenCalledWith('update', 'coupons', expect.objectContaining({ is_active: false }));
    expect(mocks.syncCouponToFreemius).toHaveBeenCalledWith({ couponId: COUPON_ID, client: serviceClient });

    vi.clearAllMocks();
    await syncCouponAction(COUPON_ID);
    expect(mocks.syncCouponToFreemius).toHaveBeenCalledWith({ couponId: COUPON_ID, client: serviceClient });

    vi.clearAllMocks();
    await deleteCouponAction(COUPON_ID);
    expect(mocks.deleteCouponFromFreemius).toHaveBeenCalledWith({ couponId: COUPON_ID, client: serviceClient });
    expect(mocks.serviceWrite).toHaveBeenCalledWith('delete', 'coupons');
    expect(mocks.deleteCouponFromFreemius.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.serviceWrite.mock.invocationCallOrder[0]
    );
  });
});
