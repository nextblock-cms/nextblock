import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `updateFreemiusOverride` used to UPDATE `freemius_pricing` through the cookie client. No RLS
 * policy lets `authenticated` UPDATE that table, so it matched zero rows while returning success
 * (the dashboard toasted "Pricing override saved" and nothing was saved); 02026 then revoked the
 * grant. It now gates on the real `requireEcomAdmin()` (exercised here against a stubbed cookie
 * session) and writes with the service role, and a write that touched no row is an error.
 */

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  role: null as string | null,
  createClient: vi.fn(),
  updateResult: { data: [{ id: 'pricing-1' }], error: null } as { data: unknown; error: unknown },
  update: vi.fn(),
  eq: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: mocks.createClient,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock('../../../providers/freemius', () => ({
  syncFreemiusProductsToSupabase: vi.fn(),
  syncSingleFreemiusProduct: vi.fn(),
}));

vi.mock('../../../product-actions', () => ({
  getProduct: vi.fn(),
  getProducts: vi.fn(),
  copyProductFromLanguage: vi.fn(),
}));

// The app's second-factor gate, as registered at server start: this caller has passed it.
// 2FA itself is covered by server-actions/require-ecom-role.test.ts.
(globalThis as Record<symbol, unknown>)[Symbol.for('nextblock.cms.secondFactorGate')] = async () => true;

import { updateFreemiusOverride } from './actions';

/** The cookie-scoped client `requireEcomAdmin()` reads the session and profile role through. */
function makeCookieClient() {
  return {
    auth: { getUser: async () => ({ data: { user: mocks.user } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: mocks.role ? { role: mocks.role } : null }),
        }),
      }),
    }),
  };
}

/** The service-role client: records the update payload and the row filter. */
function makeServiceClient() {
  return {
    from: (table: string) => {
      expect(table).toBe('freemius_pricing');
      return {
        update: (payload: unknown) => {
          mocks.update(payload);
          return {
            eq: (column: string, value: unknown) => {
              mocks.eq(column, value);
              return { select: async () => mocks.updateResult };
            },
          };
        },
      };
    },
  };
}

function signInAs(role: string | null) {
  mocks.user = { id: 'user-1' };
  mocks.role = role;
}

describe('updateFreemiusOverride', () => {
  beforeEach(() => {
    mocks.user = null;
    mocks.role = null;
    mocks.updateResult = { data: [{ id: 'pricing-1' }], error: null };
    mocks.createClient.mockReset();
    mocks.createClient.mockImplementation(() => makeCookieClient());
    mocks.getServiceRoleSupabaseClient.mockReset();
    mocks.getServiceRoleSupabaseClient.mockImplementation(() => makeServiceClient());
    mocks.update.mockReset();
    mocks.eq.mockReset();
    mocks.revalidatePath.mockReset();
  });

  it('saves an ADMIN override with the service-role client', async () => {
    signInAs('ADMIN');

    const result = await updateFreemiusOverride('pricing-1', { override_annual_price: 49.5 });

    expect(result).toEqual({ success: true });
    expect(mocks.getServiceRoleSupabaseClient).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith({
      override_annual_price: 49.5,
      updated_at: expect.any(String),
    });
    expect(mocks.eq).toHaveBeenCalledWith('id', 'pricing-1');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/cms/products');
  });

  it('clears an override when the value is null', async () => {
    signInAs('ADMIN');

    const result = await updateFreemiusOverride('pricing-1', { override_monthly_price: null });

    expect(result).toEqual({ success: true });
    expect(mocks.update).toHaveBeenCalledWith({
      override_monthly_price: null,
      updated_at: expect.any(String),
    });
  });

  it.each([
    ['a WRITER', 'WRITER', 'Only administrators can change Freemius price overrides.'],
    ['a customer', 'USER', 'Sign in as an administrator to change Freemius price overrides.'],
    ['an anonymous caller', undefined, 'Sign in as an administrator to change Freemius price overrides.'],
  ])('refuses %s before touching the service role', async (_label, role, message) => {
    if (role !== undefined) signInAs(role);

    const result = await updateFreemiusOverride('pricing-1', { override_annual_price: 1 });

    expect(result).toEqual({ success: false, error: message });
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('reports an update that matched no row instead of a false success', async () => {
    signInAs('ADMIN');
    mocks.updateResult = { data: [], error: null };

    const result = await updateFreemiusOverride('missing-row', { override_annual_price: 10 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no longer exists/);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('passes a database error through', async () => {
    signInAs('ADMIN');
    mocks.updateResult = { data: null, error: { message: 'boom' } };

    const result = await updateFreemiusOverride('pricing-1', { override_annual_price: 10 });

    expect(result).toEqual({ success: false, error: 'boom' });
  });

  it('writes only the override columns, whatever else the caller sends', async () => {
    signInAs('ADMIN');

    const result = await updateFreemiusOverride('pricing-1', {
      override_lifetime_price: 199,
      api_lifetime_price: 1,
      plan_id: 'other-plan',
    } as any);

    expect(result).toEqual({ success: true });
    expect(mocks.update).toHaveBeenCalledWith({
      override_lifetime_price: 199,
      updated_at: expect.any(String),
    });
  });

  it.each([
    ['a negative price', { override_annual_price: -1 }],
    ['an infinite price', { override_annual_price: Number.POSITIVE_INFINITY }],
    ['NaN', { override_annual_price: Number.NaN }],
    ['a string', { override_annual_price: '10' }],
  ])('rejects %s without writing', async (_label, overrides) => {
    signInAs('ADMIN');

    const result = await updateFreemiusOverride('pricing-1', overrides as any);

    expect(result.success).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects a call with no override field without writing', async () => {
    signInAs('ADMIN');

    const result = await updateFreemiusOverride('pricing-1', {});

    expect(result).toEqual({ success: false, error: 'No price override to save.' });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
