import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getDashboardStats` reads three things that RLS gates behind `public.is_admin_mfa()`:
 * `package_activations` (migration 02022) and `orders` plus other accounts' `profiles` rows
 * (migration 02023). Those reads must use the service-role client after the actor's role is
 * verified through the cookie session, or an ADMIN on an aal1 ("remember this device")
 * session sees every feature as inactive, an empty ledger and a user count of one. These
 * tests pin the client each read goes through and the role gate in front of them.
 */

type QueryResult = { data?: unknown; count?: number; error?: unknown };

/**
 * A chainable Supabase query-builder stub: every builder method returns the same object,
 * and the object is awaitable (thenable) so `await supabase.from(t).select()....` resolves
 * to `result` whichever method happens to terminate the chain.
 */
function chainable(result: QueryResult) {
  const builder: Record<string, unknown> = {};
  const methods = [
    'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'order', 'limit', 'range', 'maybeSingle', 'single',
  ];
  for (const method of methods) {
    builder[method] = vi.fn(() => builder);
  }
  builder['then'] = (resolve: (value: QueryResult) => unknown) => resolve(result);
  return builder;
}

const mocks = vi.hoisted(() => ({
  cookieFrom: vi.fn(),
  serviceFrom: vi.fn(),
  createClient: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  user: { id: 'admin-1' } as { id: string } | null,
  role: 'ADMIN' as string | null,
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: mocks.createClient,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));

import { getDashboardStats } from './actions';

function installClients(
  activationRows: Array<{ package_id: string; status: string }>,
  options: { orders?: Array<Record<string, unknown>>; serviceAvailable?: boolean } = {}
) {
  mocks.cookieFrom.mockImplementation((table: string) => {
    // The actor's own profile row (the role check) is the only profiles read the cookie
    // client is expected to serve.
    if (table === 'profiles') return chainable({ data: mocks.role ? { role: mocks.role } : null, error: null });
    return chainable({ data: [], count: 0, error: null });
  });
  mocks.serviceFrom.mockImplementation((table: string) => {
    if (table === 'package_activations') {
      return chainable({ data: activationRows, error: null });
    }
    if (table === 'orders') {
      return chainable({ data: options.orders ?? [], error: null });
    }
    return chainable({ data: [], count: 0, error: null });
  });
  mocks.createClient.mockReturnValue({
    auth: { getUser: async () => ({ data: { user: mocks.user }, error: null }) },
    from: mocks.cookieFrom,
  });
  if (options.serviceAvailable === false) {
    mocks.getServiceRoleSupabaseClient.mockImplementation(() => {
      throw new Error('Missing Supabase Service Role environment variables');
    });
  } else {
    mocks.getServiceRoleSupabaseClient.mockReturnValue({ from: mocks.serviceFrom });
  }
}

const cookieTables = () => mocks.cookieFrom.mock.calls.map((call) => call[0]);
const serviceTables = () => mocks.serviceFrom.mock.calls.map((call) => call[0]);

describe('getDashboardStats package-activation read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { id: 'admin-1' };
    mocks.role = 'ADMIN';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('reads package_activations with the service-role client, never the cookie client', async () => {
    installClients([
      { package_id: 'ecommerce', status: 'active' },
      { package_id: 'cortex-ai', status: 'active' },
    ]);

    const stats = await getDashboardStats();

    expect(mocks.getServiceRoleSupabaseClient).toHaveBeenCalledTimes(1);
    expect(serviceTables()).toContain('package_activations');

    // The regression guard: the signed-in (cookie) client must not touch package_activations,
    // or an aal1 ADMIN is wrongly locked out by the is_admin_mfa() RLS policy.
    expect(cookieTables()).not.toContain('package_activations');

    expect(stats.isEcommerceActive).toBe(true);
    expect(stats.isAiActive).toBe(true);
  });

  it('treats features as inactive when no active activation rows exist', async () => {
    installClients([]);

    const stats = await getDashboardStats();

    expect(serviceTables()).toContain('package_activations');
    expect(stats.isEcommerceActive).toBe(false);
    expect(stats.isAiActive).toBe(false);
  });

  it('falls back to inactive (and does not throw) when the service client is unavailable', async () => {
    installClients([], { serviceAvailable: false });

    const stats = await getDashboardStats();

    expect(stats.isEcommerceActive).toBe(false);
    expect(stats.isAiActive).toBe(false);
    expect(cookieTables()).not.toContain('package_activations');
    // Without the service key the staff reads fall back to the cookie client (as before).
    expect(cookieTables()).toContain('profiles');
  });
});

describe('getDashboardStats gated reads (02023)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { id: 'admin-1' };
    mocks.role = 'ADMIN';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('reads orders and the ledger profiles with the service-role client for an ADMIN', async () => {
    installClients([{ package_id: 'ecommerce', status: 'active' }], {
      orders: [{ id: 'o-1', total: 1500, user_id: 'customer-1', status: 'paid' }],
    });

    const stats = await getDashboardStats();

    expect(serviceTables()).toContain('orders');
    expect(cookieTables()).not.toContain('orders');
    // Every profiles read except the actor's own role check goes through the service role.
    expect(serviceTables().filter((t) => t === 'profiles').length).toBeGreaterThan(0);
    expect(cookieTables().filter((t) => t === 'profiles')).toHaveLength(1);
    expect(stats.ecommerce?.recentSales).toHaveLength(1);
  });

  it('never reads orders for a WRITER and hands them the zeroed ledger RLS used to produce', async () => {
    mocks.user = { id: 'writer-1' };
    mocks.role = 'WRITER';
    installClients([{ package_id: 'ecommerce', status: 'active' }], {
      orders: [{ id: 'o-1', total: 1500, user_id: 'customer-1', status: 'paid' }],
    });

    const stats = await getDashboardStats();

    expect(serviceTables()).not.toContain('orders');
    expect(cookieTables()).not.toContain('orders');
    expect(stats.isEcommerceActive).toBe(true);
    expect(stats.ecommerce).toEqual({
      monthlyRevenue: 0,
      taxLiability: 0,
      recentSales: [],
      revenueTrend: { value: '0%', positive: true },
    });
  });

  it('refuses a signed-in customer before any privileged read', async () => {
    mocks.user = { id: 'customer-1' };
    mocks.role = 'USER';
    installClients([{ package_id: 'ecommerce', status: 'active' }]);

    await expect(getDashboardStats()).rejects.toThrow('Forbidden');
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(serviceTables()).toHaveLength(0);
  });

  it('refuses an anonymous caller', async () => {
    mocks.user = null;
    installClients([]);

    await expect(getDashboardStats()).rejects.toThrow('Unauthorized');
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });
});
