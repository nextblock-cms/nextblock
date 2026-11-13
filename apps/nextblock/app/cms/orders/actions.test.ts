import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The app-local copy of the orders actions. `getOrders` must never splice raw input into
 * the PostgREST `.or()` DSL, reads orders with the service role only after the caller is
 * verified as ADMIN (migration 02023 gates the orders policies behind `is_admin_mfa()`),
 * and `markOrderAsPaid` writes with the service role, so it must insist on an ADMIN who has
 * passed their enrolled second factor (requireCmsAdmin -> getCmsActor) rather than any
 * signed-in account or a bare first factor. Until 2026-10-27 it read the role with the cookie
 * client and built the service client from the env keys itself, with no second factor.
 */

const ORDER_ID = 'dddddddd-0000-4000-8000-0000000000aa';

const mocks = vi.hoisted(() => ({
  or: vi.fn(),
  from: vi.fn(),
  cookieFrom: vi.fn(),
  user: null as { id: string } | null,
  role: null as string | null,
  twoFactorStatus: 'satisfied' as string,
  serviceClientMissing: false,
  serviceClientCreated: vi.fn(),
  serviceUpdate: vi.fn(),
  serviceUpdateEq: vi.fn(),
  updateResult: { data: [] as unknown[] | null, error: null as { message: string } | null },
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

/**
 * The service client's query surface: reads chain to an empty page; an update records its
 * table, values and filter, and resolves to `mocks.updateResult`.
 */
const serviceClient = {
  from: (table: string) => {
    mocks.from(table);
    const query = chainableQuery();
    query.update = (values: unknown) => {
      mocks.serviceUpdate(table, values);
      return {
        eq: (column: string, value: unknown) => {
          mocks.serviceUpdateEq(column, value);
          return { select: async () => mocks.updateResult };
        },
      };
    };
    return query;
  },
};

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
  getServiceRoleSupabaseClient: () => {
    mocks.serviceClientCreated();
    if (mocks.serviceClientMissing) {
      throw new Error('Missing Supabase Service Role environment variables');
    }
    return serviceClient;
  },
}));

vi.mock('@nextblock-cms/ecommerce/server', () => ({
  assignInvoiceMetadata: mocks.assignInvoiceMetadata,
  applyOrderInventoryDeduction: mocks.applyOrderInventoryDeduction,
}));

vi.mock('server-only', () => ({}));
// The second factor is driven per test; its own logic is covered by lib/auth/cms-actor.test.ts.
vi.mock('../../../lib/auth/twoFactor', () => ({
  evaluateTwoFactor: async () => ({ status: mocks.twoFactorStatus, userId: null, mfaType: null }),
}));

import { getOrders, markOrderAsPaid } from './actions';

const UUID = 'dddddddd-0000-4000-8000-00000000000a';

describe('getOrders search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { id: 'admin-1' };
    mocks.role = 'ADMIN';
    mocks.twoFactorStatus = 'satisfied';
    mocks.serviceClientMissing = false;
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
    mocks.user = null;
    mocks.role = null;
    mocks.twoFactorStatus = 'satisfied';
    mocks.serviceClientMissing = false;
    mocks.updateResult = { data: [{ id: ORDER_ID, status: 'paid' }], error: null };
    mocks.assignInvoiceMetadata.mockResolvedValue(undefined);
    mocks.applyOrderInventoryDeduction.mockResolvedValue(undefined);
  });

  it('refuses an anonymous caller', async () => {
    const result = await markOrderAsPaid(ORDER_ID);

    expect(result).toEqual({ success: false, error: 'Unauthorized' });
    expect(mocks.serviceClientCreated).not.toHaveBeenCalled();
  });

  it.each(['USER', 'WRITER'])('refuses a signed-in %s before creating the service client', async (role) => {
    mocks.user = { id: 'someone' };
    mocks.role = role;

    const result = await markOrderAsPaid(ORDER_ID);

    expect(result).toEqual({ success: false, error: 'Forbidden' });
    expect(mocks.serviceClientCreated).not.toHaveBeenCalled();
    expect(mocks.serviceUpdate).not.toHaveBeenCalled();
  });

  it.each(['totp_required', 'email_required'])(
    'refuses an ADMIN whose session has not passed its second factor (%s) before creating the service client',
    async (status) => {
      mocks.user = { id: 'admin-1' };
      mocks.role = 'ADMIN';
      mocks.twoFactorStatus = status;

      const result = await markOrderAsPaid(ORDER_ID);

      expect(result).toEqual({ success: false, error: 'Unauthorized' });
      expect(mocks.serviceClientCreated).not.toHaveBeenCalled();
      expect(mocks.serviceUpdate).not.toHaveBeenCalled();
      expect(mocks.assignInvoiceMetadata).not.toHaveBeenCalled();
    }
  );

  it('lets an ADMIN who passed their factor record the payment with the service client', async () => {
    mocks.user = { id: 'admin-1' };
    mocks.role = 'ADMIN';

    const result = await markOrderAsPaid(ORDER_ID);

    expect(result).toEqual({ success: true });
    expect(mocks.serviceClientCreated).toHaveBeenCalledTimes(1);
    expect(mocks.serviceUpdate).toHaveBeenCalledWith('orders', { status: 'paid' });
    expect(mocks.serviceUpdateEq).toHaveBeenCalledWith('id', ORDER_ID);
    expect(mocks.assignInvoiceMetadata).toHaveBeenCalledWith({ orderId: ORDER_ID, client: serviceClient });
    expect(mocks.applyOrderInventoryDeduction).toHaveBeenCalledWith(serviceClient, ORDER_ID);
  });

  it.each(['', 'not-a-uuid', `${ORDER_ID},status.eq.refunded`])(
    'refuses the order id %j without writing',
    async (orderId) => {
      mocks.user = { id: 'admin-1' };
      mocks.role = 'ADMIN';

      const result = await markOrderAsPaid(orderId);

      expect(result).toEqual({ success: false, error: 'Order not found or update failed.' });
      expect(mocks.serviceUpdate).not.toHaveBeenCalled();
    }
  );

  it('reports a missing order without the paid side effects', async () => {
    mocks.user = { id: 'admin-1' };
    mocks.role = 'ADMIN';
    mocks.updateResult = { data: [], error: null };

    const result = await markOrderAsPaid(ORDER_ID);

    expect(result).toEqual({ success: false, error: 'Order not found or update failed.' });
    expect(mocks.assignInvoiceMetadata).not.toHaveBeenCalled();
    expect(mocks.applyOrderInventoryDeduction).not.toHaveBeenCalled();
  });

  it('reports a missing service configuration as a configuration error', async () => {
    mocks.user = { id: 'admin-1' };
    mocks.role = 'ADMIN';
    mocks.serviceClientMissing = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await markOrderAsPaid(ORDER_ID);

    expect(result).toEqual({ success: false, error: 'Server configuration error' });
    expect(mocks.serviceUpdate).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
