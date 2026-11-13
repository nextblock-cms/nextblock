import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The guard every partner-portal page, action and route runs before it touches the service role.
 * The invariants mirror lib/auth/cms-actor.test.ts: the role comes from the caller's OWN profile
 * row through the cookie client, the service-role client is only built once identity, second
 * factor, role and package activation passed (the affiliate lookup itself is the first use), and
 * a missing session, a pending factor, a customer, staff or a suspended partner never gets it.
 */

const mocks = vi.hoisted(() => ({
  user: null as { id: string; email?: string | null } | null,
  role: null as string | null,
  twoFactor: 'satisfied' as 'not_required' | 'satisfied' | 'totp_required' | 'email_required',
  packageActive: true,
  affiliate: null as Record<string, unknown> | null,
  page: null as Record<string, unknown> | null,
  affiliateError: null as { message: string } | null,
  profileFrom: vi.fn(),
  serviceFrom: vi.fn(),
  serviceEq: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  verifyPackageOnline: vi.fn(),
}));

// The pre-created constants contract only, via vi.importActual (an import() of the lib would make
// Nx treat it as lazy-loaded and fail enforce-module-boundaries on its static imports).
vi.mock('@nextblock-cms/affiliates', () => vi.importActual('../../../../libs/affiliates/src/lib/core/constants'));

vi.mock('../auth/twoFactor', () => ({
  evaluateTwoFactor: async () => ({ status: mocks.twoFactor, userId: mocks.user?.id ?? null, mfaType: null }),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));

function serviceClient() {
  return {
    from: (table: string) => {
      mocks.serviceFrom(table);
      const filters: Array<[string, unknown]> = [];
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          mocks.serviceEq(table, column, value);
          filters.push([column, value]);
          return builder;
        },
        maybeSingle: async () => {
          if (table === 'affiliate_profiles') {
            return { data: mocks.affiliateError ? null : mocks.affiliate, error: mocks.affiliateError };
          }
          if (table === 'affiliate_pages') return { data: mocks.page, error: null };
          return { data: null, error: null };
        },
      };
      return builder;
    },
  };
}

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
  verifyPackageOnline: mocks.verifyPackageOnline,
}));

import { getRetailerActor, requireRetailer, requireRetailerPage } from './retailer-actor';

const SERVICE = serviceClient();

const ACTIVE_AFFILIATE = { id: 'aff-1', user_id: 'r-1', handle: 'jane', status: 'ACTIVE' };
const SUSPENDED_AFFILIATE = { ...ACTIVE_AFFILIATE, status: 'SUSPENDED' };
const PAGE = { id: 'page-1', affiliate_id: 'aff-1', user_id: 'r-1', approval_status: 'DRAFT' };

function reset() {
  vi.clearAllMocks();
  mocks.user = null;
  mocks.role = null;
  mocks.twoFactor = 'satisfied';
  mocks.packageActive = true;
  mocks.affiliate = null;
  mocks.page = null;
  mocks.affiliateError = null;
  mocks.getServiceRoleSupabaseClient.mockReturnValue(SERVICE);
  mocks.verifyPackageOnline.mockImplementation(async () => mocks.packageActive);
}

function signInAs(role: string | null, id = 'r-1') {
  mocks.user = { id, email: `${id}@shop.test` };
  mocks.role = role;
}

describe('getRetailerActor', () => {
  beforeEach(reset);

  it('is null without a session and never reads profiles or builds the service client', async () => {
    await expect(getRetailerActor()).resolves.toBeNull();
    expect(mocks.profileFrom).not.toHaveBeenCalled();
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it.each(['USER', 'WRITER', null, 'SUPERADMIN'])('is null for a %j account, without the service client', async (role) => {
    signInAs(role);
    await expect(getRetailerActor()).resolves.toBeNull();
    expect(mocks.profileFrom).toHaveBeenCalledWith('profiles');
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('loads the partner account (profile + own page) after the role check', async () => {
    signInAs('RTL');
    mocks.affiliate = ACTIVE_AFFILIATE;
    mocks.page = PAGE;

    await expect(getRetailerActor()).resolves.toEqual({
      userId: 'r-1',
      email: 'r-1@shop.test',
      role: 'RTL',
      affiliate: ACTIVE_AFFILIATE,
      page: PAGE,
    });
    expect(mocks.serviceEq).toHaveBeenCalledWith('affiliate_profiles', 'user_id', 'r-1');
    // The page is pinned to the caller twice over: their affiliate id AND their user id.
    expect(mocks.serviceEq).toHaveBeenCalledWith('affiliate_pages', 'affiliate_id', 'aff-1');
    expect(mocks.serviceEq).toHaveBeenCalledWith('affiliate_pages', 'user_id', 'r-1');
  });

  it('does not look up a page when the partner has no affiliate row', async () => {
    signInAs('RTL');
    await expect(getRetailerActor()).resolves.toMatchObject({ affiliate: null, page: null });
    expect(mocks.serviceFrom).not.toHaveBeenCalledWith('affiliate_pages');
  });
});

describe('requireRetailer', () => {
  beforeEach(reset);

  it('throws Unauthorized without a session, before creating the service client', async () => {
    await expect(requireRetailer()).rejects.toThrow('Unauthorized');
    await expect(requireRetailer({ allowAdmin: true, allowSuspended: true })).rejects.toThrow('Unauthorized');
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();
  });

  it.each(['totp_required', 'email_required'] as const)(
    'refuses a partner whose enrolled second factor is still owed (%s)',
    async (status) => {
      signInAs('RTL');
      mocks.affiliate = ACTIVE_AFFILIATE;
      mocks.twoFactor = status;

      await expect(getRetailerActor()).resolves.toBeNull();
      await expect(requireRetailer()).rejects.toThrow('Unauthorized');
      expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
      // The role is not even read: a password alone learns nothing about the account.
      expect(mocks.profileFrom).not.toHaveBeenCalled();
    },
  );

  it.each(['USER', 'WRITER', 'ADMIN', null, 'rtl', 'SUPERADMIN'])(
    'refuses a %j account with Forbidden, before creating the service client',
    async (role) => {
      signInAs(role);
      mocks.affiliate = ACTIVE_AFFILIATE;

      await expect(requireRetailer()).rejects.toThrow('Forbidden');
      await expect(requireRetailer({ allowSuspended: true })).rejects.toThrow('Forbidden');
      expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
      expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();
    },
  );

  it('still refuses WRITER and USER when allowAdmin is set', async () => {
    for (const role of ['WRITER', 'USER']) {
      signInAs(role);
      await expect(requireRetailer({ allowAdmin: true })).rejects.toThrow('Forbidden');
    }
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('hands an active partner the service-role client and their actor', async () => {
    signInAs('RTL');
    mocks.affiliate = ACTIVE_AFFILIATE;
    mocks.page = PAGE;

    await expect(requireRetailer()).resolves.toEqual({
      supabase: SERVICE,
      actor: { userId: 'r-1', email: 'r-1@shop.test', role: 'RTL', affiliate: ACTIVE_AFFILIATE, page: PAGE },
    });
    expect(mocks.verifyPackageOnline).toHaveBeenCalledWith('affiliates');
  });

  it('admits a partner whose session passed its second factor or has none enrolled', async () => {
    signInAs('RTL');
    mocks.affiliate = ACTIVE_AFFILIATE;
    mocks.twoFactor = 'not_required';
    await expect(requireRetailer()).resolves.toMatchObject({ actor: { role: 'RTL' } });
  });

  it('throws PackageInactive when the Affiliates package is off, before the affiliate lookup', async () => {
    signInAs('RTL');
    mocks.affiliate = ACTIVE_AFFILIATE;
    mocks.packageActive = false;

    await expect(requireRetailer()).rejects.toThrow('PackageInactive');
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('treats a failing activation check as inactive', async () => {
    signInAs('RTL');
    mocks.affiliate = ACTIVE_AFFILIATE;
    mocks.verifyPackageOnline.mockRejectedValue(new Error('network'));

    await expect(requireRetailer()).rejects.toThrow('PackageInactive');
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('refuses an RTL account with no affiliate row (Forbidden), handing out no client', async () => {
    signInAs('RTL');

    await expect(requireRetailer()).rejects.toThrow('Forbidden');
    // The lookup itself is the only service-role use: no client was returned to the caller.
    expect(mocks.getServiceRoleSupabaseClient).toHaveBeenCalledTimes(1);
  });

  it('refuses a suspended partner unless the caller allows it', async () => {
    signInAs('RTL');
    mocks.affiliate = SUSPENDED_AFFILIATE;

    await expect(requireRetailer()).rejects.toThrow('Suspended');
    await expect(requireRetailer({ allowSuspended: true })).resolves.toMatchObject({
      supabase: SERVICE,
      actor: { affiliate: SUSPENDED_AFFILIATE },
    });
  });

  it('treats an unknown affiliate status as suspended (fails closed)', async () => {
    signInAs('RTL');
    mocks.affiliate = { ...ACTIVE_AFFILIATE, status: 'PENDING' };
    await expect(requireRetailer()).rejects.toThrow('Suspended');
  });

  it('admits an ADMIN only with allowAdmin, with or without an affiliate row', async () => {
    signInAs('ADMIN', 'a-1');

    await expect(requireRetailer()).rejects.toThrow('Forbidden');
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();

    await expect(requireRetailer({ allowAdmin: true })).resolves.toEqual({
      supabase: SERVICE,
      actor: { userId: 'a-1', email: 'a-1@shop.test', role: 'ADMIN', affiliate: null, page: null },
    });
  });

  it('fails closed with a generic error when the affiliate lookup fails', async () => {
    signInAs('RTL');
    mocks.affiliateError = { message: 'relation "affiliate_profiles" does not exist' };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(requireRetailer()).rejects.toThrow('AffiliateLookupFailed');
    consoleError.mockRestore();
  });
});

describe('requireRetailerPage', () => {
  beforeEach(reset);

  const PATH = '/portal/retailer/storefront';

  it('sends a visitor without a session to sign-in, coming back to the page', async () => {
    await expect(requireRetailerPage(PATH)).rejects.toThrow(
      `REDIRECT:/sign-in?redirect=${encodeURIComponent(PATH)}`,
    );
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('sends a pending second factor to the 2FA screen', async () => {
    signInAs('RTL');
    mocks.twoFactor = 'totp_required';
    await expect(requireRetailerPage(PATH)).rejects.toThrow(
      `REDIRECT:/two-factor?redirect_to=${encodeURIComponent(PATH)}`,
    );
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('sends a customer to the partner program page', async () => {
    signInAs('USER');
    await expect(requireRetailerPage(PATH)).rejects.toThrow('REDIRECT:/partners');
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it.each(['WRITER', 'ADMIN'])('sends %s to /unauthorized (partners only)', async (role) => {
    signInAs(role);
    await expect(requireRetailerPage(PATH)).rejects.toThrow('REDIRECT:/unauthorized?reason=retailer_only');
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('sends a signed-in partner home when the package is inactive (sign-in lands them on the portal)', async () => {
    signInAs('RTL');
    mocks.affiliate = ACTIVE_AFFILIATE;
    mocks.packageActive = false;
    await expect(requireRetailerPage(PATH)).rejects.toThrow(/^REDIRECT:\/$/);
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('sends a visitor without a session to sign-in even while the package is inactive (only partners go home)', async () => {
    mocks.packageActive = false;
    await expect(requireRetailerPage(PATH)).rejects.toThrow(`REDIRECT:/sign-in?redirect=${encodeURIComponent(PATH)}`);
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('sends an RTL without an affiliate account to the partner program page', async () => {
    signInAs('RTL');
    await expect(requireRetailerPage(PATH)).rejects.toThrow('REDIRECT:/partners');
  });

  it('sends a suspended partner to /unauthorized unless allowed', async () => {
    signInAs('RTL');
    mocks.affiliate = SUSPENDED_AFFILIATE;
    await expect(requireRetailerPage(PATH)).rejects.toThrow('REDIRECT:/unauthorized?reason=retailer_suspended');
    await expect(requireRetailerPage(PATH, { allowSuspended: true })).resolves.toMatchObject({
      actor: { affiliate: SUSPENDED_AFFILIATE },
    });
  });

  it('never echoes an unsafe return path into the sign-in redirect', async () => {
    for (const unsafe of ['//evil.example', 'https://evil.example', '/\\evil.example', '/%2f/evil.example', '']) {
      await expect(requireRetailerPage(unsafe)).rejects.toThrow(
        `REDIRECT:/sign-in?redirect=${encodeURIComponent('/portal/retailer')}`,
      );
    }
  });

  it('admits an active partner', async () => {
    signInAs('RTL');
    mocks.affiliate = ACTIVE_AFFILIATE;
    mocks.page = PAGE;
    await expect(requireRetailerPage(PATH)).resolves.toMatchObject({
      supabase: SERVICE,
      actor: { role: 'RTL', affiliate: ACTIVE_AFFILIATE, page: PAGE },
    });
  });

  it('admits an ADMIN with allowAdmin', async () => {
    signInAs('ADMIN', 'a-1');
    await expect(requireRetailerPage(PATH, { allowAdmin: true })).resolves.toMatchObject({
      actor: { role: 'ADMIN', affiliate: null },
    });
  });
});

describe('service-role boundary', () => {
  it('treats both helpers as verified-role-then-service-role markers', async () => {
    // tools/scripts/lib/service-role-boundary.js (npm run security:check): every module that
    // calls them must import 'server-only' and stay out of client graphs.
    const boundary = await vi.importActual<{
      default?: { serviceRoleMarkers: (code: string) => string[] };
      serviceRoleMarkers?: (code: string) => string[];
    }>('../../../../tools/scripts/lib/service-role-boundary.js');
    const serviceRoleMarkers = boundary.serviceRoleMarkers ?? boundary.default?.serviceRoleMarkers;
    expect(serviceRoleMarkers).toBeTypeOf('function');
    expect(serviceRoleMarkers?.('const { supabase } = await requireRetailer();')).toEqual([
      'verified-role-then-service-role helper',
    ]);
    expect(serviceRoleMarkers?.("const { actor } = await requireRetailerPage('/portal/retailer');")).toEqual([
      'verified-role-then-service-role helper',
    ]);
  });
});
