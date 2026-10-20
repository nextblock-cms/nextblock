import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `getOrders` builds a PostgREST `.or()` filter from the search term. That argument is a
 * filter-DSL string, so the only safe thing to splice into it is a validated uuid.
 *
 * Since migration 02023 the orders policies require `is_admin_mfa()`, so the read goes
 * through the service-role client after the caller's role is verified through the cookie
 * session (an aal1 "remember this device" admin would otherwise see nothing). A non-ADMIN
 * gets the empty result RLS always gave them, without a service read.
 */

const mocks = vi.hoisted(() => ({
  or: vi.fn(),
  range: vi.fn(),
  from: vi.fn(),
  cookieFrom: vi.fn(),
  user: { id: 'admin-1' } as { id: string } | null,
  role: 'ADMIN' as string | null,
}));

function chainableQuery() {
  const result = { data: [], error: null, count: 0 };
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'order', 'eq', 'in', 'single']) {
    query[method] = () => query;
  }
  query.range = (from: number, to: number) => {
    mocks.range(from, to);
    return query;
  };
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
    auth: { getUser: async () => ({ data: { user: mocks.user }, error: null }) },
    from: (table: string) => {
      mocks.cookieFrom(table);
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: mocks.role ? { role: mocks.role } : null, error: null }),
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

vi.mock('server-only', () => ({}));

import { getOrderDetails, getOrders } from './actions';

const UUID = 'DDDDDDDD-0000-4000-8000-00000000000A';

describe('getOrders search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { id: 'admin-1' };
    mocks.role = 'ADMIN';
  });

  it('searches both uuid columns with the normalised uuid', async () => {
    await getOrders(1, 'all', UUID);

    expect(mocks.or).toHaveBeenCalledTimes(1);
    expect(mocks.or).toHaveBeenCalledWith(
      'id.eq.dddddddd-0000-4000-8000-00000000000a,user_id.eq.dddddddd-0000-4000-8000-00000000000a'
    );
  });

  it('does not add a search filter when no term is given', async () => {
    await getOrders(1, 'paid');
    await getOrders(1, 'paid', '');

    expect(mocks.or).not.toHaveBeenCalled();
    expect(mocks.from).toHaveBeenCalledTimes(2);
  });

  it.each([
    '0),status.eq.paid,id.eq.(0',
    `${UUID},status.eq.paid`,
    `${UUID})`,
    'id.eq.x',
    'not-a-uuid',
    '*',
    ' ',
  ])('never forwards the non-uuid term %j to PostgREST', async (term) => {
    const result = await getOrders(1, 'all', term);

    expect(result).toEqual({ data: [], total: 0, totalPages: 0 });
    expect(mocks.or).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('clamps a non-positive or fractional page to the first page', async () => {
    await getOrders(0);
    await getOrders(-3);
    await getOrders(1.5);
    await getOrders(Number.NaN);

    for (const call of mocks.range.mock.calls) {
      expect(call).toEqual([0, 19]);
    }
    expect(mocks.range).toHaveBeenCalledTimes(4);
  });
});

describe('order reads are ADMIN-only and go through the service role', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { id: 'admin-1' };
    mocks.role = 'ADMIN';
  });

  it('reads orders with the service-role client, never the cookie client', async () => {
    await getOrders(1, 'all');

    expect(mocks.from).toHaveBeenCalledWith('orders');
    // The cookie client only serves the role check (the caller's own profile row).
    expect(mocks.cookieFrom.mock.calls.map((call) => call[0])).toEqual(['profiles']);
  });

  it.each(['WRITER', 'USER', null])('gives a %j caller the empty result without a service read', async (role) => {
    mocks.role = role;

    await expect(getOrders(1, 'all')).resolves.toEqual({ data: [], total: 0, totalPages: 0 });
    await expect(getOrderDetails('dddddddd-0000-4000-8000-00000000000a')).resolves.toBeNull();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('gives an anonymous caller the empty result without a service read', async () => {
    mocks.user = null;

    await expect(getOrders(1, 'all')).resolves.toEqual({ data: [], total: 0, totalPages: 0 });
    await expect(getOrderDetails('dddddddd-0000-4000-8000-00000000000a')).resolves.toBeNull();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
