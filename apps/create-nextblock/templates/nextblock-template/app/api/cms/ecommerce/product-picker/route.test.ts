import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Product Grid picker route resolves the caller with the real getCmsActor() and
 * evaluateTwoFactor() over a faked cookie session, before the package check and the service-role
 * catalog read. Until 2026-11-14 it read the role through the cookie client, so a staff password
 * alone (the first factor) read every product and category, drafts included: a route handler never
 * passes the CMS layout's 2FA redirect.
 */

const mocks = vi.hoisted(() => ({
  /**
   * The cookie session getCmsActor() reads: the user, their own profile role, the second factor
   * they enrolled, the session's assurance level.
   */
  session: {
    user: { id: 'writer-1' } as { id: string } | null,
    role: 'WRITER' as string | null,
    mfa: null as { mfa_enabled: boolean; mfa_type: 'totp' | 'email' } | null,
    aal: 'aal1' as 'aal1' | 'aal2',
  },
  cookieReads: [] as string[],
  serviceReads: [] as string[],
  getServiceRoleSupabaseClient: vi.fn(),
  verifyPackageOnline: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: mocks.session.user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: mocks.session.aal, nextLevel: 'aal2' },
          error: null,
        }),
      },
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => {
          const read = async () => {
            mocks.cookieReads.push(table);
            if (table === 'profiles') {
              return { data: mocks.session.role ? { role: mocks.session.role } : null, error: null };
            }
            if (table === 'user_security_settings') return { data: mocks.session.mfa, error: null };
            throw new Error(`Unexpected cookie-client read of ${table}`);
          };
          // `single` too: the pre-2026-11-14 route read the role that way, so a return to it is
          // judged by the refusals below rather than by a missing method.
          return { maybeSingle: read, single: read };
        },
      }),
    }),
  }),
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
  verifyPackageOnline: mocks.verifyPackageOnline,
}));
// No trusted-device or email-code cookie: a second factor counts only through the session itself.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
// Read only by the trusted-device and reminder paths, never on the way to these decisions.
vi.mock('../../../../../lib/privacy/settings', () => ({
  getSecuritySettings: async () => ({ enforce_staff_2fa: false, trusted_device_days: 30 }),
}));

import { GET } from './route';

const SECOND_FACTOR = 'Complete two-factor verification, then try again.';

const PRODUCT_ROW = {
  id: 'product-1',
  title: 'Ceramic mug',
  slug: 'ceramic-mug',
  sku: 'MUG-1',
  status: 'draft',
  translation_group_id: 'group-1',
  languages: { code: 'en' },
};

/** The service-role client the route reads the catalog with: every chain resolves to its table's rows. */
function serviceClient() {
  return {
    from(table: string) {
      mocks.serviceReads.push(table);
      const result =
        table === 'categories'
          ? { data: [{ id: 'category-1', name: 'Mugs', slug: 'mugs' }], error: null }
          : { data: [PRODUCT_ROW], error: null };
      const builder = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        or: () => builder,
        in: () => builder,
        then: (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return builder;
    },
  };
}

function request(query = '') {
  return new Request(`http://localhost/api/cms/ecommerce/product-picker${query}`);
}

function signIn(role: string | null, user: { id: string } | null = { id: 'writer-1' }) {
  mocks.session.user = user;
  mocks.session.role = role;
}

function expectNoCatalogRead() {
  expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();
  expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  expect(mocks.serviceReads).toEqual([]);
}

describe('GET /api/cms/ecommerce/product-picker', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    signIn('WRITER');
    mocks.session.mfa = null;
    mocks.session.aal = 'aal1';
    mocks.cookieReads = [];
    mocks.serviceReads = [];
    mocks.verifyPackageOnline.mockResolvedValue(true);
    mocks.getServiceRoleSupabaseClient.mockImplementation(serviceClient);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // A route handler never passes the CMS layout's 2FA redirect. Until 2026-11-14 this route read
  // the role through the cookie client, so a staff password alone read the catalog.
  it.each([
    ['a WRITER whose enrolled authenticator app this session has not passed (aal1)', 'WRITER', 'totp'],
    ['an ADMIN whose enrolled email code this session has not passed', 'ADMIN', 'email'],
  ] as const)('refuses %s before the package check and the catalog read', async (_label, role, factor) => {
    signIn(role);
    mocks.session.mfa = { mfa_enabled: true, mfa_type: factor };

    const response = await GET(request('?search=mug'));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: SECOND_FACTOR });
    expect(mocks.cookieReads).not.toContain('profiles');
    expectNoCatalogRead();
  });

  it('answers 401 without a session', async () => {
    signIn(null, null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expectNoCatalogRead();
  });

  it('refuses a signed-in customer (USER), also past an enrolled factor (aal2)', async () => {
    signIn('USER');
    mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.session.aal = 'aal2';
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden: Insufficient permissions' });
    expectNoCatalogRead();
  });

  it('refuses an account whose profile row is missing', async () => {
    signIn(null);
    expect((await GET(request())).status).toBe(403);
    expectNoCatalogRead();
  });

  it.each(['WRITER', 'ADMIN'])('serves a %s whose session passed the enrolled authenticator app (aal2)', async (role) => {
    signIn(role, { id: 'staff-1' });
    mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.session.aal = 'aal2';

    const response = await GET(request('?ids=product-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      categories: [{ id: 'category-1', name: 'Mugs', slug: 'mugs' }],
      products: [
        {
          id: 'product-1',
          title: 'Ceramic mug',
          slug: 'ceramic-mug',
          sku: 'MUG-1',
          status: 'draft',
          languageCode: 'en',
          translationGroupId: 'group-1',
        },
      ],
      hasMore: false,
    });
    expect(mocks.verifyPackageOnline).toHaveBeenCalledWith('ecommerce');
    expect(mocks.serviceReads).toEqual(['products', 'categories', 'products']);
  });

  it('serves a WRITER who enrolled no second factor', async () => {
    expect((await GET(request())).status).toBe(200);
  });

  it('keeps the package check after the gate: no ecommerce package, no catalog', async () => {
    mocks.verifyPackageOnline.mockResolvedValue(false);
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'The ecommerce package is not active.' });
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });
});
