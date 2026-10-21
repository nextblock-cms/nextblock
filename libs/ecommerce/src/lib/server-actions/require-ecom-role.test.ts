import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  user: { id: 'a-1' } as { id: string } | null,
  role: 'ADMIN' as string | null,
  settings: null as { mfa_enabled: boolean; mfa_type: string | null } | null,
  aal: 'aal1',
  service: { from: () => undefined },
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.aal } }) },
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: table === 'profiles' ? { role: state.role } : null }),
          maybeSingle: async () => ({ data: table === 'user_security_settings' ? state.settings : null }),
        }),
      }),
    }),
  }),
  getServiceRoleSupabaseClient: () => state.service,
}));

import { getEcomActorRole, requireEcomAdmin, requireEcomStaff } from './require-ecom-role';

const GATE = Symbol.for('nextblock.cms.secondFactorGate');

// 2026-10-21: these helpers hand out the service-role client for payments, coupons, taxes and
// orders, and checked the role only, so a stolen password (first factor) was enough.

describe('ecommerce role helpers enforce the second factor', () => {
  beforeEach(() => {
    state.user = { id: 'a-1' };
    state.role = 'ADMIN';
    state.settings = null;
    state.aal = 'aal1';
  });
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[GATE];
  });

  it('defers to the app gate when it is registered', async () => {
    (globalThis as Record<symbol, unknown>)[GATE] = async () => false;
    await expect(requireEcomAdmin()).rejects.toThrow('Unauthorized');
    await expect(requireEcomStaff()).rejects.toThrow('Unauthorized');
    await expect(getEcomActorRole()).resolves.toBeNull();

    (globalThis as Record<symbol, unknown>)[GATE] = async () => true;
    await expect(requireEcomAdmin()).resolves.toBe(state.service);
  });

  it('without a gate, admits an account with no factor enrolled', async () => {
    await expect(requireEcomAdmin()).resolves.toBe(state.service);
  });

  it('without a gate, refuses an email-factor account and a TOTP account below aal2', async () => {
    state.settings = { mfa_enabled: true, mfa_type: 'email' };
    await expect(requireEcomAdmin()).rejects.toThrow('Unauthorized');

    state.settings = { mfa_enabled: true, mfa_type: 'totp' };
    await expect(requireEcomAdmin()).rejects.toThrow('Unauthorized');

    state.aal = 'aal2';
    await expect(requireEcomAdmin()).resolves.toBe(state.service);
  });

  it('still refuses a WRITER as admin and a customer outright', async () => {
    state.role = 'WRITER';
    await expect(requireEcomAdmin()).rejects.toThrow('Forbidden');
    await expect(requireEcomStaff()).resolves.toBe(state.service);
    state.role = 'USER';
    await expect(requireEcomStaff()).rejects.toThrow('Unauthorized');
  });
});
