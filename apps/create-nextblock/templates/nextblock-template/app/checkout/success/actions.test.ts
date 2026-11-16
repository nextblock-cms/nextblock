import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The checkout success page's action (app/checkout/success/actions.ts). It finalizes the order (it
 * is what marks a Stripe order paid when no webhook arrived) and shows the invoice, the buyer's
 * details and, for Freemius, the license key, all read with the service role.
 *
 * Who may see a Freemius order: the guest holding the access token minted into the success redirect
 * (the real HMAC module runs here), the owning account, or an ADMIN whose session passed its enrolled
 * second factor. Until 2026-11-13 the staff branch read the role through the cookie client, so an
 * ADMIN password alone (aal1, factor pending) revealed any order. This file runs the real
 * getCmsActor() and evaluateTwoFactor() against a faked cookie session, like
 * app/actions/package-actions.test.ts. Every refused caller gets the generic "Order not found", and
 * no order row comes back for it: an orders read, if any, is filtered on the caller's own user id.
 *
 * Stripe: a session id is a capability Stripe shows only to the buyer, but this action is a public
 * POST and every `stripe.checkout.sessions.retrieve` spends the operator's Stripe rate limit. Until
 * 2026-11-13 any `cs_` string, random ones included, cost one Stripe call. Checkout hands out a
 * session's URL only once its order stores the id, and expires the session when that write fails
 * (providers/stripe.ts, stripe/checkout.ts and their tests), so every session checkout hands a buyer
 * is found here, Stripe is asked only about a session an order names, and a malformed id reaches
 * neither the database nor Stripe. After a paid finalization the action schedules the affiliate
 * commission sweep.
 */

const ORDER_ID = '77777777-7777-4777-8777-777777777777';
const BUYER_ID = 'buyer-1';
/** The shape Stripe issues: `cs_test_` and a 58-character alphanumeric suffix. */
const STRIPE_SESSION_ID = 'cs_test_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ0123456789AbCdEfGhIjKl';

type Filter = readonly [column: string, value: unknown];

const mocks = vi.hoisted(() => ({
  /** The cookie session's user, their own profile role, enrolled factor and assurance level. */
  user: null as { id: string } | null,
  role: null as string | null,
  mfa: null as { mfa_enabled: boolean; mfa_type: 'totp' | 'email' } | null,
  aal: 'aal1' as 'aal1' | 'aal2',
  /** The orders table, and the filters of every read the service-role client served from it. */
  orders: [] as Array<Record<string, unknown>>,
  orderReads: [] as Array<ReadonlyArray<readonly [string, unknown]>>,
  session: { id: 'cs_test_x', payment_status: 'paid' } as Record<string, unknown>,
  createCookieClient: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  getStripeClient: vi.fn(),
  retrieve: vi.fn(),
  syncStripeOrderFromSession: vi.fn(),
  scheduleAffiliateCommissionSweep: vi.fn(),
  applyOrderInventoryDeduction: vi.fn(),
  assignInvoiceMetadata: vi.fn(),
  getInvoicePresentationData: vi.fn(),
  getFreemiusOrderLicense: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: mocks.createCookieClient,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));
// The module takes its service-role client from getServiceRoleSupabaseClient() (and
// tools/scripts/server-action-actors.test.ts fails if it builds its own again). Should it, these
// route that client to the same fake, so the cases below still judge who may see what.
vi.mock('@supabase/supabase-js', () => ({ createClient: () => mocks.getServiceRoleSupabaseClient() }));
vi.mock('../../../lib/setup/env-status', () => ({ resolveSupabaseUrl: () => 'http://127.0.0.1:54321' }));
vi.mock('../../../lib/setup/service-key', () => ({ resolveSupabaseServiceKey: () => 'service-role-test-key' }));
// No trusted-device or email-code cookie: the second factor counts only through the session itself.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
// Read only by the trusted-device and reminder paths, never on the way to these decisions.
vi.mock('../../../lib/privacy/settings', () => ({
  getSecuritySettings: async () => ({ enforce_staff_2fa: false, trusted_device_days: 30 }),
}));
// The action imports each of these from its own module, never the /server barrel (which would
// put every CMS commerce screen in the checkout success route; tools/scripts/commerce-chunking).
vi.mock('@nextblock-cms/ecommerce/order-inventory', () => ({
  applyOrderInventoryDeduction: mocks.applyOrderInventoryDeduction,
}));
vi.mock('@nextblock-cms/ecommerce/invoice-server', () => ({
  assignInvoiceMetadata: mocks.assignInvoiceMetadata,
  getInvoicePresentationData: mocks.getInvoicePresentationData,
}));
vi.mock('@nextblock-cms/ecommerce/freemius-license', () => ({
  getFreemiusOrderLicense: mocks.getFreemiusOrderLicense,
}));
vi.mock('@nextblock-cms/ecommerce/stripe/client', () => ({
  getStripeClient: mocks.getStripeClient,
}));
vi.mock('@nextblock-cms/ecommerce/stripe/order-sync', () => ({
  syncStripeOrderFromSession: mocks.syncStripeOrderFromSession,
}));
vi.mock('../../../lib/affiliates/refunds', () => ({
  scheduleAffiliateCommissionSweep: mocks.scheduleAffiliateCommissionSweep,
}));

import { mintOrderAccessToken } from '@nextblock-cms/ecommerce/order-access-token';
import { fulfillOrderAction } from './actions';

/** The service-role client: serves `orders` reads from `mocks.orders`, applying every eq filter. */
function fakeServiceClient() {
  return {
    from: (table: string) => {
      if (table !== 'orders') throw new Error(`Unexpected service-role read of ${table}`);
      const filters: Filter[] = [];
      const run = () => {
        mocks.orderReads.push([...filters]);
        return mocks.orders.find((row) => filters.every(([column, value]) => row[column] === value)) ?? null;
      };
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return query;
        },
        limit: () => query,
        maybeSingle: async () => ({ data: run(), error: null }),
        single: async () => {
          const row = run();
          return row ? { data: row, error: null } : { data: null, error: { message: 'no rows' } };
        },
      };
      return query;
    },
  };
}

/** The cookie session: the signed-in user, their own profile role and second factor, the session's assurance level. */
function fakeCookieClient() {
  const read = (table: string) => {
    if (table === 'profiles') return { data: mocks.role ? { role: mocks.role } : null, error: null };
    if (table === 'user_security_settings') return { data: mocks.mfa, error: null };
    throw new Error(`Unexpected cookie-client read of ${table}`);
  };
  return {
    auth: {
      getUser: async () => ({ data: { user: mocks.user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: mocks.aal, nextLevel: 'aal2' }, error: null }),
      },
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => read(table),
          single: async () => read(table),
        }),
      }),
    }),
  };
}

const INVOICE = { order: { id: ORDER_ID, status: 'paid', items: [] } };
const LICENSE = { licenseKey: 'sk_buyer_license_key' };
const NOT_FOUND = { success: false, error: 'Order not found', errorKey: 'ecommerce.checkout_success_order_not_found' };

function paidFreemiusOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    user_id: BUYER_ID,
    status: 'paid',
    provider: 'freemius',
    paid_at: '2026-10-01T00:00:00Z',
    stripe_session_id: null,
    ...overrides,
  };
}

/** Nothing of the order left the server: no invoice, buyer details, license key, inventory or invoice write. */
function expectNothingRevealed() {
  expect(mocks.getInvoicePresentationData).not.toHaveBeenCalled();
  expect(mocks.getFreemiusOrderLicense).not.toHaveBeenCalled();
  expect(mocks.applyOrderInventoryDeduction).not.toHaveBeenCalled();
  expect(mocks.assignInvoiceMetadata).not.toHaveBeenCalled();
  expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
}

/** Every orders read, if any, was filtered on this caller's own user id (so the buyer's row never came back). */
function expectOnlyOwnOrdersRead(userId: string) {
  for (const filters of mocks.orderReads) {
    expect(filters).toContainEqual(['user_id', userId]);
  }
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  // The real order access token module signs with this.
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
  mocks.user = null;
  mocks.role = null;
  mocks.mfa = null;
  mocks.aal = 'aal1';
  mocks.orders = [];
  mocks.orderReads = [];
  mocks.session = { id: STRIPE_SESSION_ID, payment_status: 'paid' };
  mocks.createCookieClient.mockReset().mockImplementation(() => fakeCookieClient());
  mocks.getServiceRoleSupabaseClient.mockReset().mockImplementation(() => fakeServiceClient());
  mocks.retrieve.mockReset().mockImplementation(async () => mocks.session);
  mocks.getStripeClient.mockReset().mockImplementation(async () => ({ checkout: { sessions: { retrieve: mocks.retrieve } } }));
  mocks.syncStripeOrderFromSession.mockReset().mockResolvedValue({ orderId: ORDER_ID, alreadyPaid: false });
  mocks.scheduleAffiliateCommissionSweep.mockReset();
  mocks.applyOrderInventoryDeduction.mockReset().mockResolvedValue(undefined);
  mocks.assignInvoiceMetadata.mockReset().mockResolvedValue({ invoiceNumber: 'INV-1', paidAt: '2026-10-01T00:00:00Z' });
  mocks.getInvoicePresentationData.mockReset().mockResolvedValue(INVOICE);
  mocks.getFreemiusOrderLicense.mockReset().mockResolvedValue(LICENSE);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('fulfillOrderAction: who may see a Freemius order', () => {
  beforeEach(() => {
    mocks.orders = [paidFreemiusOrder()];
  });

  /** Callers that get the generic answer, and who they are signed in as (null: no session). */
  const REFUSED: ReadonlyArray<readonly [string, () => void, string | null]> = [
    ['a caller with no session and no token', () => undefined, null],
    ['a caller with no session and a token minted for another order', () => undefined, null],
    ['a signed-in customer who does not own the order', () => {
      mocks.user = { id: 'stranger-1' };
      mocks.role = 'USER';
    }, 'stranger-1'],
    ['a WRITER who does not own the order (orders are ADMIN-only)', () => {
      mocks.user = { id: 'writer-1' };
      mocks.role = 'WRITER';
    }, 'writer-1'],
    ['an ADMIN whose enrolled authenticator app this session has not passed (aal1)', () => {
      mocks.user = { id: 'admin-1' };
      mocks.role = 'ADMIN';
      mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
      mocks.aal = 'aal1';
    }, 'admin-1'],
    ['an ADMIN whose enrolled email code this session has not passed', () => {
      mocks.user = { id: 'admin-1' };
      mocks.role = 'ADMIN';
      mocks.mfa = { mfa_enabled: true, mfa_type: 'email' };
    }, 'admin-1'],
  ];

  it.each(REFUSED)('answers "Order not found" to %s, and reads none of the order', async (label, arrange, signedInAs) => {
    arrange();
    const token = label.includes('another order') ? mintOrderAccessToken('88888888-8888-4888-8888-888888888888') : null;

    expect(await fulfillOrderAction(ORDER_ID, token)).toEqual(NOT_FOUND);

    expectNothingRevealed();
    if (signedInAs === null) {
      expect(mocks.orderReads).toEqual([]);
    } else {
      expectOnlyOwnOrdersRead(signedInAs);
    }
  });

  it('shows the order to an ADMIN whose session passed the enrolled second factor (aal2)', async () => {
    mocks.user = { id: 'admin-1' };
    mocks.role = 'ADMIN';
    mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.aal = 'aal2';

    expect(await fulfillOrderAction(ORDER_ID)).toEqual({
      success: true,
      alreadyPaid: true,
      status: 'paid',
      invoice: INVOICE,
      license: LICENSE,
    });
    expect(mocks.getFreemiusOrderLicense).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER_ID }));
  });

  it('shows the order to an ADMIN who enrolled no second factor', async () => {
    mocks.user = { id: 'admin-1' };
    mocks.role = 'ADMIN';

    expect(await fulfillOrderAction(ORDER_ID)).toMatchObject({ success: true, status: 'paid', license: LICENSE });
  });

  it('shows the order to the guest holding its access token, with no session at all', async () => {
    expect(await fulfillOrderAction(ORDER_ID, mintOrderAccessToken(ORDER_ID))).toMatchObject({
      success: true,
      status: 'paid',
      invoice: INVOICE,
      license: LICENSE,
    });
    // The token alone decides: no cookie session is consulted.
    expect(mocks.createCookieClient).not.toHaveBeenCalled();
  });

  it('accepts the token for the id in any letter case, as the database canonicalizes it', async () => {
    expect(await fulfillOrderAction(ORDER_ID.toUpperCase(), mintOrderAccessToken(ORDER_ID))).toMatchObject({ success: true });
  });

  it('shows the order to the account that owns it, reading only that account’s orders', async () => {
    mocks.user = { id: BUYER_ID };
    mocks.role = 'USER';

    expect(await fulfillOrderAction(ORDER_ID)).toMatchObject({ success: true, status: 'paid', license: LICENSE });
    expectOnlyOwnOrdersRead(BUYER_ID);
  });

  it('still shows the owner their own order while an enrolled second factor is pending', async () => {
    mocks.user = { id: BUYER_ID };
    mocks.role = 'ADMIN';
    mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.aal = 'aal1';

    expect(await fulfillOrderAction(ORDER_ID)).toMatchObject({ success: true, license: LICENSE });
    expectOnlyOwnOrdersRead(BUYER_ID);
  });

  it('answers "Order not found" to a reference that is not an order id, before any read', async () => {
    mocks.user = { id: 'admin-1' };
    mocks.role = 'ADMIN';

    for (const reference of ['not-an-order', `${ORDER_ID}x`, `'; drop table orders; --`]) {
      expect(await fulfillOrderAction(reference, null), reference).toEqual(NOT_FOUND);
    }
    expect(mocks.orderReads).toEqual([]);
    expectNothingRevealed();
  });
});

describe('fulfillOrderAction: Stripe sessions', () => {
  it('asks Stripe nothing about a well-formed session id that no order names', async () => {
    mocks.orders = [paidFreemiusOrder({ stripe_session_id: 'cs_test_SomeOtherSession0000000000000000000000000000000000000000' })];

    expect(await fulfillOrderAction(STRIPE_SESSION_ID)).toEqual(NOT_FOUND);

    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.orderReads).toEqual([[['stripe_session_id', STRIPE_SESSION_ID]]]);
    expect(mocks.syncStripeOrderFromSession).not.toHaveBeenCalled();
    expectNothingRevealed();
  });

  it('sends a flood of random well-formed ids to the database only, never to Stripe', async () => {
    for (let i = 0; i < 50; i += 1) {
      const randomId = `cs_live_${i.toString(36).padStart(4, '0')}${'Z'.repeat(54)}`;
      expect(await fulfillOrderAction(randomId)).toEqual(NOT_FOUND);
    }

    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it.each([
    ['too short', 'cs_1'],
    ['an empty suffix', 'cs_test_'],
    ['an unknown mode', 'cs_prod_a1B2c3D4e5F6g7H8'],
    ['a character outside the alphabet', 'cs_test_a1B2c3$4e5F6g7H8'],
    ['a trailing newline', 'cs_test_a1B2c3D4e5F6g7H8\n'],
    ['a leading space', ' cs_test_a1B2c3D4e5F6g7H8'],
    ['more than 255 characters', `cs_live_${'a'.repeat(248)}`],
  ])('refuses a session id with %s before the database or Stripe', async (_label, sessionId) => {
    expect(await fulfillOrderAction(sessionId)).toEqual(NOT_FOUND);

    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it('accepts the longest id Stripe issues (255 characters)', async () => {
    const longest = `cs_live_${'a'.repeat(247)}`;
    mocks.orders = [paidFreemiusOrder({ provider: 'stripe', stripe_session_id: longest })];

    expect(await fulfillOrderAction(longest)).toMatchObject({ success: true, status: 'paid' });
    expect(mocks.retrieve).toHaveBeenCalledWith(longest);
  });

  it('refuses a session id that is not a string', async () => {
    for (const sessionId of [123, { id: STRIPE_SESSION_ID }, ['cs_test_x']]) {
      expect(await fulfillOrderAction(sessionId as unknown as string)).toMatchObject({
        success: false,
        errorKey: 'ecommerce.checkout_missing_session_id',
      });
    }
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
  });

  it('syncs a paid session that one of the store’s orders names, with no webhook needed', async () => {
    mocks.orders = [paidFreemiusOrder({ provider: 'stripe', status: 'pending', stripe_session_id: STRIPE_SESSION_ID })];

    expect(await fulfillOrderAction(STRIPE_SESSION_ID)).toEqual({
      success: true,
      alreadyPaid: false,
      status: 'paid',
      invoice: INVOICE,
    });

    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
    expect(mocks.retrieve).toHaveBeenCalledWith(STRIPE_SESSION_ID);
    expect(mocks.syncStripeOrderFromSession).toHaveBeenCalledWith(mocks.session);
    expect(mocks.getInvoicePresentationData).toHaveBeenCalledWith(ORDER_ID, expect.anything());
    // The id is the capability on this path: no cookie session is consulted.
    expect(mocks.createCookieClient).not.toHaveBeenCalled();
  });

  it('answers "Internal server error" when the order lookup fails, without asking Stripe', async () => {
    mocks.getServiceRoleSupabaseClient.mockImplementation(() => ({
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          limit: () => query,
          maybeSingle: async () => ({ data: null, error: { message: 'connection refused' } }),
        };
        return query;
      },
    }));

    expect(await fulfillOrderAction(STRIPE_SESSION_ID)).toMatchObject({
      success: false,
      errorKey: 'ecommerce.checkout_internal_server_error',
    });
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
});

describe('fulfillOrderAction commission sweep', () => {
  beforeEach(() => {
    mocks.orders = [paidFreemiusOrder({ provider: 'stripe', status: 'pending', stripe_session_id: STRIPE_SESSION_ID })];
  });

  it('sweeps after a paid Stripe session is synced', async () => {
    const result = await fulfillOrderAction(STRIPE_SESSION_ID);

    expect(result).toMatchObject({ success: true, status: 'paid' });
    expect(mocks.syncStripeOrderFromSession).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleAffiliateCommissionSweep).toHaveBeenCalledTimes(1);
  });

  it('does not sweep while the Stripe payment is pending', async () => {
    mocks.session = { id: STRIPE_SESSION_ID, payment_status: 'unpaid' };

    const result = await fulfillOrderAction(STRIPE_SESSION_ID);

    expect(result).toMatchObject({ success: false, errorKey: 'ecommerce.checkout_payment_pending' });
    expect(mocks.syncStripeOrderFromSession).not.toHaveBeenCalled();
    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });

  it('does not sweep when the Stripe sync fails', async () => {
    mocks.syncStripeOrderFromSession.mockRejectedValue(new Error('Order lookup failed'));

    const result = await fulfillOrderAction(STRIPE_SESSION_ID);

    expect(result).toMatchObject({ success: false, errorKey: 'ecommerce.checkout_internal_server_error' });
    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });

  it('sweeps for a paid Freemius order its buyer may see', async () => {
    mocks.orders = [paidFreemiusOrder({ user_id: null })];

    const result = await fulfillOrderAction(ORDER_ID, mintOrderAccessToken(ORDER_ID));

    expect(result).toMatchObject({ success: true, status: 'paid' });
    expect(mocks.scheduleAffiliateCommissionSweep).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a trial', { status: 'trial' }, true],
    ['an order the caller may not see', { status: 'paid' }, false],
  ])('does not sweep for %s', async (_label, overrides, tokenValid) => {
    mocks.orders = [paidFreemiusOrder({ user_id: null, paid_at: null, ...overrides })];
    const token = tokenValid ? mintOrderAccessToken(ORDER_ID) : 'not-the-token';

    await fulfillOrderAction(ORDER_ID, token);

    expect(mocks.scheduleAffiliateCommissionSweep).not.toHaveBeenCalled();
  });
});
