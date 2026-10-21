import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The app-local copy of the orders actions. `getOrders` must never splice raw input into
 * the PostgREST `.or()` DSL, reads orders with the service role only after the caller is
 * verified as ADMIN (migration 02023 gates the orders policies behind `is_admin_mfa()`),
 * and `markOrderAsPaid` writes with the service role, so it must insist on an ADMIN rather
 * than any signed-in account.
 */

const mocks = vi.hoisted(() => ({
  or: vi.fn(),
  from: vi.fn(),
  cookieFrom: vi.fn(),
  user: null as { id: string } | null,
  role: null as string | null,
  createServiceClient: vi.fn(),
  serviceUpdate: vi.fn(),
  assignInvoiceMetadata: vi.fn(),
  applyOrderInventoryDeduction: vi.fn(),
}));

function chainableQuery() {
  const result = { data: [], error: null, count: 0 };
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'order', 'range', 'eq', 'in', 'single']) {
    query[method] = () => query;
  }
  query.or = (filter: string) => {
    mocks.or(filter);
    return query;
  };
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return query;
}

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: mocks.user }, error: null }),
    },
    from: (table: string) => {
      mocks.cookieFrom(table);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: mocks.role ? { role: mocks.role } : null,
              error: null,
            }),
          }),
        }),
      };
    },
  }),
  getServiceRoleSupabaseClient: () => ({
    from: (table: string) => {
      mocks.from(table);
      return chainableQuery();
    },
  }),
}));

vi.mock('@nextblock-cms/ecommerce/server', () => ({
  assignInvoiceMetadata: mocks.assignInvoiceMetadata,
  applyOrderInventoryDeduction: mocks.applyOrderInventoryDeduction,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => {
    mocks.createServiceClient(...args);
    return {
      from: () => ({
        update: (values: unknown) => {
          mocks.serviceUpdate(values);
          return {
            eq: () => ({
              select: async () => ({ data: [{ id: 'order-1', status: 'paid' }], error: null }),
            }),
          };
        },
      }),
    };
  },
}));

vi.mock('server-only', () => ({}));
// The caller has passed any enrolled second factor; 2FA itself is covered by lib/auth/cms-actor.test.ts.
vi.mock('../../../lib/auth/twoFactor', () => ({
  evaluateTwoFactor: async () => ({ status: 'satisfied', userId: null, mfaType: null }),
}));

import { getOrders, markOrderAsPaid } from './actions';

const UUID = 'dddddddd-0000-4000-8000-00000000000a';

describe('getOrders search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { id: 'admin-1' };
    mocks.role = 'ADMIN';
  });

  it('searches both uuid columns with the normalised uuid', async () => {
    await getOrders(1, 'all', UUID.toUpperCase());

    expect(mocks.or).toHaveBeenCalledWith(`id.eq.${UUID},user_id.eq.${UUID}`);
    // The orders read itself goes through the service role, not the cookie client.
    expect(mocks.from).toHaveBeenCalledWith('orders');
    expect(mocks.cookieFrom.mock.calls.map((call) => call[0])).toEqual(['profiles']);
  });

  it.each(['0),status.eq.paid,id.eq.(0', `${UUID},status.eq.paid`, 'not-a-uuid'])(
    'never forwards the non-uuid term %j to PostgREST',
    async (term) => {
      const result = await getOrders(1, 'all', term);

      expect(result).toEqual({ data: [], total: 0, totalPages: 0 });
      expect(mocks.or).not.toHaveBeenCalled();
      expect(mocks.from).not.toHaveBeenCalled();
    }
  );

  it.each(['WRITER', 'USER'])('gives a signed-in %s the empty result without a service read', async (role) => {
    mocks.role = role;

    await expect(getOrders(1, 'all')).resolves.toEqual({ data: [], total: 0, totalPages: 0 });
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe('markOrderAsPaid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:3998');
    mocks.user = null;
    mocks.role = null;
    mocks.assignInvoiceMetadata.mockResolvedValue(undefined);
    mocks.applyOrderInventoryDeduction.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses an anonymous caller', async () => {
    const result = await markOrderAsPaid('order-1');

    expect(result).toEqual({ success: false, error: 'Unauthorized' });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });

  it.each(['USER', 'WRITER'])('refuses a signed-in %s before creating the service client', async (role) => {
    mocks.user = { id: 'someone' };
    mocks.role = role;

    const result = await markOrderAsPaid('order-1');

    expect(result).toEqual({ success: false, error: 'Forbidden' });
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.serviceUpdate).not.toHaveBeenCalled();
  });

  it('lets an ADMIN record the payment', async () => {
    mocks.user = { id: 'admin-1' };
    mocks.role = 'ADMIN';

    const result = await markOrderAsPaid('order-1');

    expect(result).toEqual({ success: true });
    expect(mocks.serviceUpdate).toHaveBeenCalledWith({ status: 'paid' });
    expect(mocks.assignInvoiceMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.applyOrderInventoryDeduction).toHaveBeenCalledTimes(1);
  });
});
