import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The role check every CMS server action and page runs before reading or writing a table
 * that migration 02023 gates behind `public.is_admin_mfa()`. The invariants: the role comes
 * from the caller's OWN profile row through the cookie client (the one branch no aal check
 * touches), the service-role client is only handed out after the role passed, and a missing
 * session, a customer or an unknown role never gets it.
 */

const mocks = vi.hoisted(() => ({
  user: null as { id: string } | null,
  role: null as string | null,
  twoFactor: 'satisfied' as 'not_required' | 'satisfied' | 'totp_required' | 'email_required',
  profileFrom: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
}));

vi.mock('./twoFactor', () => ({
  evaluateTwoFactor: async () => ({ status: mocks.twoFactor, userId: mocks.user?.id ?? null, mfaType: null }),
}));
vi.mock('./second-factor-gate', () => ({ registerSecondFactorGate: () => undefined }));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user }, error: null }) },
    from: (table: string) => {
      mocks.profileFrom(table);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: mocks.role ? { role: mocks.role } : null, error: null }),
          }),
        }),
      };
    },
  }),
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));

import { getCmsActor, isCmsStaffRole, requireCmsAdmin, requireCmsStaff } from './cms-actor';

const SERVICE = { from: vi.fn() };

describe('getCmsActor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = null;
    mocks.role = null;
    mocks.twoFactor = 'satisfied';
    mocks.getServiceRoleSupabaseClient.mockReturnValue(SERVICE);
  });

  it('is null without a session and never touches profiles', async () => {
    await expect(getCmsActor()).resolves.toBeNull();
    expect(mocks.profileFrom).not.toHaveBeenCalled();
  });

  it.each([
    ['ADMIN', 'ADMIN'],
    ['WRITER', 'WRITER'],
    ['USER', 'USER'],
    [null, 'USER'],
    ['SUPERADMIN', 'USER'],
  ])('maps a stored role of %j to %s', async (stored, expected) => {
    mocks.user = { id: 'u-1' };
    mocks.role = stored;

    await expect(getCmsActor()).resolves.toEqual({ userId: 'u-1', role: expected });
    expect(mocks.profileFrom).toHaveBeenCalledWith('profiles');
  });
});

describe('requireCmsAdmin / requireCmsStaff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = null;
    mocks.role = null;
    mocks.twoFactor = 'satisfied';
    mocks.getServiceRoleSupabaseClient.mockReturnValue(SERVICE);
  });

  it('throw Unauthorized without a session, before creating the service client', async () => {
    await expect(requireCmsAdmin()).rejects.toThrow('Unauthorized');
    await expect(requireCmsStaff()).rejects.toThrow('Unauthorized');
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it.each(['USER', null, 'OWNER'])('refuse a signed-in non-staff role %j with Forbidden', async (role) => {
    mocks.user = { id: 'u-1' };
    mocks.role = role;

    await expect(requireCmsAdmin()).rejects.toThrow('Forbidden');
    await expect(requireCmsStaff()).rejects.toThrow('Forbidden');
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('requireCmsAdmin refuses a WRITER but requireCmsStaff admits them', async () => {
    mocks.user = { id: 'w-1' };
    mocks.role = 'WRITER';

    await expect(requireCmsAdmin()).rejects.toThrow('Forbidden');
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();

    await expect(requireCmsStaff()).resolves.toEqual({ supabase: SERVICE, userId: 'w-1', role: 'WRITER' });
    expect(mocks.getServiceRoleSupabaseClient).toHaveBeenCalledTimes(1);
  });

  it.each(['totp_required', 'email_required'] as const)(
    'refuse an ADMIN whose session has not passed the enrolled second factor (%s)',
    async (status) => {
      // 2026-10-21: a stolen password (first factor only) reached the service role here, because
      // a server action never passes through the CMS layout's 2FA redirect.
      mocks.user = { id: 'a-1' };
      mocks.role = 'ADMIN';
      mocks.twoFactor = status;

      await expect(getCmsActor()).resolves.toBeNull();
      await expect(requireCmsAdmin()).rejects.toThrow('Unauthorized');
      await expect(requireCmsStaff()).rejects.toThrow('Unauthorized');
      expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    },
  );

  it('admits an ADMIN with no factor enrolled', async () => {
    mocks.user = { id: 'a-1' };
    mocks.role = 'ADMIN';
    mocks.twoFactor = 'not_required';

    await expect(requireCmsAdmin()).resolves.toEqual({ supabase: SERVICE, userId: 'a-1' });
  });

  it('hands an ADMIN the service-role client from both helpers', async () => {
    mocks.user = { id: 'a-1' };
    mocks.role = 'ADMIN';

    await expect(requireCmsAdmin()).resolves.toEqual({ supabase: SERVICE, userId: 'a-1' });
    await expect(requireCmsStaff()).resolves.toEqual({ supabase: SERVICE, userId: 'a-1', role: 'ADMIN' });
  });
});

describe('isCmsStaffRole', () => {
  it('accepts exactly ADMIN and WRITER', () => {
    expect(isCmsStaffRole('ADMIN')).toBe(true);
    expect(isCmsStaffRole('WRITER')).toBe(true);
    expect(isCmsStaffRole('USER')).toBe(false);
    expect(isCmsStaffRole('admin')).toBe(false);
    expect(isCmsStaffRole(null)).toBe(false);
    expect(isCmsStaffRole(undefined)).toBe(false);
  });
});
