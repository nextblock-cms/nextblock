import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The CMS order status actions write with the service role, which no RLS policy (and no aal2
 * check inside one) can stop, so the action's own gate is the whole authorization. It must be
 * the lib's gate (server-actions/require-ecom-role.ts): a staff session that has passed its
 * enrolled second factor, an ADMIN for the financial statuses. Until 2026-10-27 the action read
 * the role with the cookie client and built the service client itself, so a first factor alone
 * could mark an order paid, refunded or cancelled; since 02030 the last two also void the
 * order's affiliate commission. These tests drive the real gate with a mocked Supabase.
 */

const state = vi.hoisted(() => ({
  user: { id: 'staff-1' } as { id: string } | null,
  role: 'ADMIN' as string | null,
  settings: null as { mfa_enabled: boolean; mfa_type: string | null } | null,
  aal: 'aal1',
  serviceThrows: false,
  updated: [{ id: 'order-1' }] as Array<{ id: string }> | null,
  updateError: null as { message: string } | null,
  cookieTables: [] as string[],
  writes: [] as Array<{ table: string; values: unknown; filter: [string, unknown] }>,
}));

const service = vi.hoisted(() => {
  const client = {
    from: (table: string) => ({
      update: (values: unknown) => ({
        eq: (column: string, value: unknown) => ({
          select: async () => {
            state.writes.push({ table, values, filter: [column, value] });
            return { data: state.updated, error: state.updateError };
          },
        }),
      }),
    }),
  };
  return {
    client,
    getServiceRoleSupabaseClient: vi.fn(() => {
      if (state.serviceThrows) throw new Error('Missing Supabase Service Role environment variables');
      return client;
    }),
  };
});

const sideEffects = vi.hoisted(() => ({
  assignInvoiceMetadata: vi.fn(async () => undefined),
  applyOrderInventoryDeduction: vi.fn(async () => undefined),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.aal } }) },
    },
    from: (table: string) => {
      state.cookieTables.push(table);
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: table === 'profiles' && state.role ? { role: state.role } : null }),
            maybeSingle: async () => ({ data: table === 'user_security_settings' ? state.settings : null }),
          }),
        }),
      };
    },
  }),
  getServiceRoleSupabaseClient: service.getServiceRoleSupabaseClient,
}));

vi.mock('../../../invoice-server', () => ({ assignInvoiceMetadata: sideEffects.assignInvoiceMetadata }));
vi.mock('../../../order-inventory', () => ({ applyOrderInventoryDeduction: sideEffects.applyOrderInventoryDeduction }));

import { markOrderAsPaid, updateOrderStatus, type ManageableOrderStatus } from './server-actions';

const GATE = Symbol.for('nextblock.cms.secondFactorGate');

function registerSecondFactorGate(passed: boolean) {
  (globalThis as Record<symbol, unknown>)[GATE] = async () => passed;
}

function expectNoServiceClient() {
  expect(service.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  expect(state.writes).toEqual([]);
  expect(sideEffects.assignInvoiceMetadata).not.toHaveBeenCalled();
  expect(sideEffects.applyOrderInventoryDeduction).not.toHaveBeenCalled();
}

const EVERY_STATUS: ManageableOrderStatus[] = ['pending', 'trial', 'paid', 'shipped', 'cancelled', 'refunded'];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  state.user = { id: 'staff-1' };
  state.role = 'ADMIN';
  state.settings = null;
  state.aal = 'aal1';
  state.serviceThrows = false;
  state.updated = [{ id: 'order-1' }];
  state.updateError = null;
  state.cookieTables = [];
  state.writes = [];
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[GATE];
  vi.restoreAllMocks();
});

describe('order status actions: second factor', () => {
  it('refuses an ADMIN whose second factor is pending (app gate) before the service client is built', async () => {
    registerSecondFactorGate(false);

    for (const status of EVERY_STATUS) {
      await expect(updateOrderStatus('order-1', status)).resolves.toEqual({ success: false, error: 'Unauthorized' });
    }
    await expect(markOrderAsPaid('order-1')).resolves.toEqual({ success: false, error: 'Unauthorized' });
    expectNoServiceClient();
  });

  it('refuses a WRITER whose second factor is pending, fulfillment statuses included', async () => {
    registerSecondFactorGate(false);
    state.role = 'WRITER';

    await expect(updateOrderStatus('order-1', 'shipped')).resolves.toEqual({ success: false, error: 'Unauthorized' });
    expectNoServiceClient();
  });

  it('without the app gate, refuses a TOTP account at aal1 and an email-factor account', async () => {
    state.settings = { mfa_enabled: true, mfa_type: 'totp' };
    await expect(updateOrderStatus('order-1', 'refunded')).resolves.toEqual({ success: false, error: 'Unauthorized' });

    state.settings = { mfa_enabled: true, mfa_type: 'email' };
    await expect(updateOrderStatus('order-1', 'cancelled')).resolves.toEqual({ success: false, error: 'Unauthorized' });
    expectNoServiceClient();

    state.settings = { mfa_enabled: true, mfa_type: 'totp' };
    state.aal = 'aal2';
    await expect(updateOrderStatus('order-1', 'refunded')).resolves.toEqual({ success: true });
    expect(state.writes).toEqual([{ table: 'orders', values: { status: 'refunded' }, filter: ['id', 'order-1'] }]);
  });

  it('writes with the service client once the gate passes, never with the cookie client', async () => {
    registerSecondFactorGate(true);

    await expect(updateOrderStatus('order-1', 'cancelled')).resolves.toEqual({ success: true });

    expect(service.getServiceRoleSupabaseClient).toHaveBeenCalledTimes(1);
    expect(state.writes).toEqual([{ table: 'orders', values: { status: 'cancelled' }, filter: ['id', 'order-1'] }]);
    expect(state.cookieTables).not.toContain('orders');
    expect(sideEffects.assignInvoiceMetadata).not.toHaveBeenCalled();
  });
});

describe('order status actions: ADMIN / WRITER split', () => {
  beforeEach(() => registerSecondFactorGate(true));

  it('keeps paid, cancelled and refunded ADMIN-only', async () => {
    state.role = 'WRITER';

    for (const status of ['paid', 'cancelled', 'refunded'] as const) {
      await expect(updateOrderStatus('order-1', status)).resolves.toEqual({ success: false, error: 'Forbidden' });
    }
    await expect(markOrderAsPaid('order-1')).resolves.toEqual({ success: false, error: 'Forbidden' });
    expectNoServiceClient();
  });

  it('lets a WRITER move an order through fulfillment', async () => {
    state.role = 'WRITER';

    await expect(updateOrderStatus('order-1', 'shipped')).resolves.toEqual({ success: true });
    expect(state.writes).toEqual([{ table: 'orders', values: { status: 'shipped' }, filter: ['id', 'order-1'] }]);
  });

  it('marks paid with the invoice and inventory side effects on the service client', async () => {
    await expect(markOrderAsPaid('order-1')).resolves.toEqual({ success: true });

    expect(state.writes).toEqual([{ table: 'orders', values: { status: 'paid' }, filter: ['id', 'order-1'] }]);
    expect(sideEffects.assignInvoiceMetadata).toHaveBeenCalledWith({ orderId: 'order-1', client: service.client });
    expect(sideEffects.applyOrderInventoryDeduction).toHaveBeenCalledWith(service.client, 'order-1');
  });

  it('refuses a customer, a partner and an anonymous caller', async () => {
    for (const role of ['USER', 'RTL', null]) {
      state.role = role;
      await expect(updateOrderStatus('order-1', 'shipped')).resolves.toEqual({ success: false, error: 'Unauthorized' });
      await expect(updateOrderStatus('order-1', 'refunded')).resolves.toEqual({ success: false, error: 'Unauthorized' });
    }
    state.role = 'ADMIN';
    state.user = null;
    await expect(updateOrderStatus('order-1', 'paid')).resolves.toEqual({ success: false, error: 'Unauthorized' });
    expectNoServiceClient();
  });
});

describe('order status actions: input and failures', () => {
  beforeEach(() => registerSecondFactorGate(true));

  it('refuses a status outside the managed list without writing', async () => {
    const result = await updateOrderStatus('order-1', 'processing' as unknown as ManageableOrderStatus);

    expect(result).toEqual({ success: false, error: 'Invalid order status' });
    expect(state.writes).toEqual([]);
  });

  it('reports a missing service configuration without leaking the cause', async () => {
    state.serviceThrows = true;

    await expect(updateOrderStatus('order-1', 'shipped')).resolves.toEqual({
      success: false,
      error: 'Server configuration error',
    });
    expect(state.writes).toEqual([]);
  });

  it('reports an order that matched no row', async () => {
    state.updated = [];

    await expect(updateOrderStatus('missing', 'refunded')).resolves.toEqual({
      success: false,
      error: 'Order not found or update failed.',
    });
  });
});
