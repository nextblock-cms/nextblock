import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The partner signup service is the gate of a public, unauthenticated POST endpoint. These cases pin
 * its guarantees rather than its happy path: nothing is created before the package, bot protection,
 * identity and throttle checks pass; a signed-in customer is upgraded without a new auth user; an
 * auth user is created exactly like `signUpAction` and removed again only when THIS request created
 * it; an existing account is never attached to a partner profile from an anonymous request; and the
 * public sandbox, whose logins are public, runs every check but creates and sends nothing.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const NEW_USER_ID = '22222222-2222-4222-8222-222222222222';

type RpcResult = { data: unknown; error: unknown };

const mocks = vi.hoisted(() => ({
  headers: {} as Record<string, string>,
  packageActive: true,
  botCheck: { ok: true } as { ok: true } | { ok: false; reason: 'honeypot' } | { ok: false; reason: 'captcha'; message: string },
  sessionUser: null as null | { id: string; email: string | null; user_metadata?: Record<string, unknown> },
  twoFactorStatus: 'satisfied' as string,
  profile: null as null | { role: string | null; full_name: string | null },
  autoAccept: false,
  locale: 'en',
  throttleCount: 0,
  handleCount: 0,
  ownAffiliateCount: 0,
  /** The active tiers' capacity columns (`affiliate_tiers`), or null for a failed lookup. */
  tiers: null as null | Array<{ max_ambassadors_cap: number | null; member_count: number }>,
  rpcResult: null as RpcResult | null,
  createUserResult: null as { data: { user: { id: string } | null } | null; error: unknown } | null,
  signUpResult: null as {
    data: { user: { id: string; created_at: string; identities?: unknown[] } | null; session: unknown };
    error: unknown;
  } | null,
  signInError: null as unknown,
  deleteUserError: null as unknown,
  calls: {
    rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    createUser: [] as unknown[],
    deleteUser: [] as string[],
    signUp: [] as unknown[],
    signIn: [] as unknown[],
    countFilters: [] as Array<Record<string, unknown>>,
    serviceClients: 0,
  },
  scheduleNotification: vi.fn(),
  evictTiers: vi.fn(),
  evaluateTwoFactor: vi.fn(),
  verifyBotProtection: vi.fn(),
  /** Read only by prepareAccount() (the starter page's language): a call means one was prepared. */
  getRequestLocale: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => mocks.headers[name.toLowerCase()] ?? null }),
}));

function countBuilder(table: string) {
  const filters: Record<string, unknown> = { table };
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return builder;
    },
    gte: (column: string, value: unknown) => {
      filters[`${column}>=`] = value;
      return builder;
    },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
      mocks.calls.countFilters.push({ ...filters });
      const count =
        'signup_ip_masked' in filters
          ? mocks.throttleCount
          : 'handle' in filters
            ? mocks.handleCount
            : 'user_id' in filters
              ? mocks.ownAffiliateCount
              : 0;
      if (table === 'affiliate_tiers') {
        const failed = mocks.tiers === null;
        return Promise.resolve({ data: mocks.tiers, error: failed ? { message: 'lookup failed' } : null }).then(resolve, reject);
      }
      return Promise.resolve({ count, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock('@nextblock-cms/db/server', () => ({
  verifyPackageOnline: async () => mocks.packageActive,
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: mocks.sessionUser } }),
      signUp: async (payload: unknown) => {
        mocks.calls.signUp.push(payload);
        return mocks.signUpResult ?? { data: { user: null, session: null }, error: { message: 'no result' } };
      },
      signInWithPassword: async (payload: unknown) => {
        mocks.calls.signIn.push(payload);
        return { data: {}, error: mocks.signInError };
      },
    },
    from: (table: string) => {
      if (table !== 'profiles') throw new Error(`cookie client read ${table}`);
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.profile }) }) }) };
    },
  }),
  getServiceRoleSupabaseClient: () => {
    mocks.calls.serviceClients += 1;
    return {
      from: (table: string) => countBuilder(table),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        mocks.calls.rpc.push({ fn, args });
        return mocks.rpcResult ?? { data: null, error: { message: 'no result' } };
      },
      auth: {
        admin: {
          createUser: async (payload: unknown) => {
            mocks.calls.createUser.push(payload);
            return mocks.createUserResult ?? { data: null, error: { message: 'no result' } };
          },
          deleteUser: async (id: string) => {
            mocks.calls.deleteUser.push(id);
            return { data: null, error: mocks.deleteUserError };
          },
        },
      },
    };
  },
}));

// The repository area only: the real RPC wrapper and error mapper, without the whole server barrel.
vi.mock('@nextblock-cms/affiliates/server', () => vi.importActual('../../../../libs/affiliates/src/lib/repository'));
vi.mock('../auth/twoFactor', () => ({ evaluateTwoFactor: mocks.evaluateTwoFactor }));
vi.mock('../botProtection/verify', () => ({ verifyBotProtection: mocks.verifyBotProtection }));
vi.mock('../setup/system-config', () => ({
  getSystemConfiguration: async () => ({ auto_accept_signups: mocks.autoAccept, settings: {} }),
}));
vi.mock('./cache', () => ({ evictAffiliateTiersCache: mocks.evictTiers }));
vi.mock('./notify', () => ({ scheduleAffiliateLifecycleNotification: mocks.scheduleNotification }));
vi.mock('./request-locale', () => ({
  getRequestLocale: mocks.getRequestLocale,
  toAffiliatesLocale: (locale: string | null | undefined) =>
    typeof locale === 'string' && locale.toLowerCase().startsWith('fr') ? 'fr' : 'en',
}));

import {
  AFFILIATE_SIGNUP_THROTTLE_MAX,
  checkAffiliateHandleAvailability,
  isAffiliateHandleCheckRateLimited,
  isAffiliateSignupBrandNewUser,
  maskAffiliateSignupIp,
  resetAffiliateHandleCheckRateLimit,
  resolveAffiliateSignupClientIp,
  resolvePartnerSignupViewer,
  submitAffiliateSignup,
  type AffiliateSignupInput,
} from './signup';

const SUCCESS_ROW: RpcResult = {
  data: [
    {
      affiliate_id: 'aff-1',
      page_id: 'page-1',
      tier_id: 'tier-4',
      tier_name: 'Founding Ambassador',
      tier_slug: 'founding-ambassador',
      commission_percentage: 50,
      is_limited_time_promo: true,
      spots_remaining: 48,
    },
  ],
  error: null,
};

const ANONYMOUS_INPUT: AffiliateSignupInput = {
  handle: 'Jane-Picks',
  displayName: 'Jane Doe',
  email: 'jane@example.com',
  password: 'correct horse battery',
};

function formData(): FormData {
  return new FormData();
}

function rpcCall() {
  return mocks.calls.rpc.find((call) => call.fn === 'create_affiliate_account');
}

beforeEach(() => {
  // Not the sandbox unless a case says so, whatever the shell running the tests exports.
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.headers = { 'x-forwarded-for': '203.0.113.7' };
  mocks.packageActive = true;
  mocks.botCheck = { ok: true };
  mocks.sessionUser = null;
  mocks.twoFactorStatus = 'satisfied';
  mocks.profile = null;
  mocks.autoAccept = false;
  mocks.locale = 'en';
  mocks.throttleCount = 0;
  mocks.handleCount = 0;
  mocks.ownAffiliateCount = 0;
  mocks.tiers = [
    { max_ambassadors_cap: null, member_count: 3 },
    { max_ambassadors_cap: 50, member_count: 49 },
  ];
  mocks.rpcResult = SUCCESS_ROW;
  mocks.createUserResult = { data: { user: { id: NEW_USER_ID } }, error: null };
  mocks.signUpResult = {
    data: { user: { id: NEW_USER_ID, created_at: new Date().toISOString(), identities: [{ id: 'identity' }] }, session: null },
    error: null,
  };
  mocks.signInError = null;
  mocks.deleteUserError = null;
  mocks.calls = { rpc: [], createUser: [], deleteUser: [], signUp: [], signIn: [], countFilters: [], serviceClients: 0 };
  mocks.scheduleNotification.mockReset();
  mocks.evictTiers.mockReset();
  mocks.evaluateTwoFactor.mockReset();
  mocks.evaluateTwoFactor.mockImplementation(async () => ({ status: mocks.twoFactorStatus, userId: mocks.sessionUser?.id ?? null, mfaType: null }));
  mocks.verifyBotProtection.mockReset();
  mocks.verifyBotProtection.mockImplementation(async () => mocks.botCheck);
  mocks.getRequestLocale.mockReset();
  mocks.getRequestLocale.mockImplementation(async () => mocks.locale);
  resetAffiliateHandleCheckRateLimit();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('submitAffiliateSignup: gates before any account work', () => {
  it('refuses while the package is inactive, before bot protection or any client', async () => {
    mocks.packageActive = false;
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'error', code: 'package_inactive' });
    expect(mocks.verifyBotProtection).not.toHaveBeenCalled();
    expect(mocks.calls.serviceClients).toBe(0);
  });

  it('answers a tripped honeypot like a normal signup and creates nothing', async () => {
    mocks.botCheck = { ok: false, reason: 'honeypot' };
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'confirm_email' });
    expect(mocks.calls.signUp).toEqual([]);
    expect(mocks.calls.createUser).toEqual([]);
    expect(rpcCall()).toBeUndefined();
    expect(mocks.calls.serviceClients).toBe(0);
  });

  it('reports a failed captcha without creating anything', async () => {
    mocks.botCheck = { ok: false, reason: 'captcha', message: 'Security verification failed.' };
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'error', code: 'captcha' });
    expect(mocks.calls.serviceClients).toBe(0);
  });

  it('refuses malformed and reserved handles before reading the session', async () => {
    await expect(submitAffiliateSignup({ ...ANONYMOUS_INPUT, handle: 'a_b' }, formData())).resolves.toEqual({
      kind: 'error',
      code: 'handle_invalid',
    });
    await expect(submitAffiliateSignup({ ...ANONYMOUS_INPUT, handle: 'Admin' }, formData())).resolves.toEqual({
      kind: 'error',
      code: 'handle_reserved',
    });
    expect(mocks.calls.serviceClients).toBe(0);
  });

  it('throttles a masked address after five partner accounts in an hour', async () => {
    mocks.throttleCount = AFFILIATE_SIGNUP_THROTTLE_MAX;
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'error', code: 'throttled' });
    const throttle = mocks.calls.countFilters.find((filters) => 'signup_ip_masked' in filters);
    expect(throttle?.['signup_ip_masked']).toBe('203.0.113.0/24');
    expect(throttle?.['table']).toBe('affiliate_profiles');
    expect(Date.parse(String(throttle?.['created_at>=']))).toBeLessThanOrEqual(Date.now() - 59 * 60_000);
    expect(mocks.calls.signUp).toEqual([]);
    expect(mocks.calls.createUser).toEqual([]);
  });

  it('refuses a taken handle before creating an auth user', async () => {
    mocks.handleCount = 1;
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'error', code: 'handle_taken' });
    expect(mocks.calls.countFilters.find((filters) => 'handle' in filters)?.['handle']).toBe('jane-picks');
    expect(mocks.calls.signUp).toEqual([]);
    expect(mocks.calls.createUser).toEqual([]);
  });

  it('refuses a full program before creating an auth user (the RPC would only run after confirmation)', async () => {
    mocks.tiers = [
      { max_ambassadors_cap: 50, member_count: 50 },
      { max_ambassadors_cap: 0, member_count: 0 },
    ];
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'error', code: 'program_full' });
    expect(mocks.calls.countFilters.find((filters) => filters['table'] === 'affiliate_tiers')?.['is_active']).toBe(true);
    expect(mocks.calls.signUp).toEqual([]);
    expect(mocks.calls.createUser).toEqual([]);

    mocks.autoAccept = true;
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'error', code: 'program_full' });
    expect(mocks.calls.createUser).toEqual([]);
    expect(rpcCall()).toBeUndefined();
  });

  it('leaves the decision to the RPC when the tier lookup fails', async () => {
    mocks.tiers = null;
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'confirm_email' });
    expect(mocks.calls.signUp).toHaveLength(1);
  });
});

describe('submitAffiliateSignup: a signed-in visitor', () => {
  beforeEach(() => {
    mocks.sessionUser = { id: USER_ID, email: 'customer@example.com' };
    mocks.profile = { role: 'USER', full_name: 'Casey Customer' };
  });

  it('upgrades a customer without creating an auth user', async () => {
    const outcome = await submitAffiliateSignup({ ...ANONYMOUS_INPUT, email: null, password: null }, formData());

    expect(outcome).toMatchObject({ kind: 'signed_in', account: { affiliateId: 'aff-1', tierName: 'Founding Ambassador', spotsRemaining: 48 } });
    expect(mocks.calls.signUp).toEqual([]);
    expect(mocks.calls.createUser).toEqual([]);
    expect(rpcCall()?.args).toMatchObject({ p_user_id: USER_ID, p_handle: 'jane-picks', p_display_name: 'Jane Doe', p_locale: 'en' });
    expect(mocks.scheduleNotification).toHaveBeenCalledWith('SIGNED_UP', {
      affiliateId: 'aff-1',
      tierName: 'Founding Ambassador',
      spotsRemaining: 48,
    });
    expect(mocks.evictTiers).toHaveBeenCalledWith('action');
  });

  it('ignores an email and password sent with a session (the session decides who signs up)', async () => {
    await submitAffiliateSignup({ ...ANONYMOUS_INPUT, email: 'someone-else@example.com', password: 'whatever123' }, formData());
    expect(rpcCall()?.args['p_user_id']).toBe(USER_ID);
    expect(mocks.calls.signUp).toEqual([]);
    expect(mocks.calls.signIn).toEqual([]);
  });

  it('lets the RPC answer affiliate_exists for a partner who already has a profile', async () => {
    mocks.profile = { role: 'RTL', full_name: null };
    mocks.rpcResult = { data: null, error: { code: 'P0001', message: 'affiliate_exists' } };
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'error', code: 'affiliate_exists' });
    expect(mocks.calls.deleteUser).toEqual([]);
    expect(mocks.scheduleNotification).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'WRITER', 'SOMETHING_ELSE'])('refuses a %s account before the RPC', async (role) => {
    mocks.profile = { role, full_name: null };
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'error', code: 'role_conflict' });
    expect(rpcCall()).toBeUndefined();
    expect(mocks.calls.serviceClients).toBe(0);
  });

  it('refuses a session that still owes its second factor', async () => {
    mocks.twoFactorStatus = 'totp_required';
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'error', code: 'factor_pending' });
    expect(rpcCall()).toBeUndefined();
    expect(mocks.calls.serviceClients).toBe(0);
  });

  it('builds the French starter page for a French visitor', async () => {
    mocks.locale = 'fr';
    await submitAffiliateSignup(ANONYMOUS_INPUT, formData());
    const args = rpcCall()?.args ?? {};
    expect(args['p_locale']).toBe('fr');
    expect(args['p_title']).toBe('La sélection de Jane Doe');
    expect(JSON.stringify(args['p_starter_doc'])).toContain('Bienvenue dans la sélection de Jane Doe');
    expect(String(args['p_meta_description']).length).toBeGreaterThanOrEqual(70);
    expect(args['p_signup_ip_masked']).toBe('203.0.113.0/24');
  });
});

describe('submitAffiliateSignup: auto-accepted signups (system_configuration.auto_accept_signups)', () => {
  beforeEach(() => {
    mocks.autoAccept = true;
  });

  it('creates a confirmed user with the display name, records the partner, then signs in', async () => {
    const outcome = await submitAffiliateSignup(ANONYMOUS_INPUT, formData());

    expect(outcome).toMatchObject({ kind: 'signed_in' });
    expect(mocks.calls.createUser).toEqual([
      { email: 'jane@example.com', password: 'correct horse battery', email_confirm: true, user_metadata: { full_name: 'Jane Doe' } },
    ]);
    expect(rpcCall()?.args['p_user_id']).toBe(NEW_USER_ID);
    expect(mocks.calls.signIn).toEqual([{ email: 'jane@example.com', password: 'correct horse battery' }]);
    expect(mocks.calls.signUp).toEqual([]);
  });

  it('removes the user it just created when the RPC refuses the signup', async () => {
    mocks.rpcResult = { data: null, error: { code: 'P0001', message: 'affiliate_program_full' } };
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'error', code: 'program_full' });
    expect(mocks.calls.deleteUser).toEqual([NEW_USER_ID]);
    expect(mocks.calls.signIn).toEqual([]);
    expect(mocks.scheduleNotification).not.toHaveBeenCalled();
  });

  it('maps an existing address to account_exists and touches nothing else', async () => {
    mocks.createUserResult = { data: { user: null }, error: { message: 'A user with this email address has already been registered' } };
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'error', code: 'account_exists' });
    expect(rpcCall()).toBeUndefined();
    expect(mocks.calls.deleteUser).toEqual([]);
  });

  it('asks the visitor to sign in when the account exists but signing in failed', async () => {
    mocks.signInError = { message: 'Invalid login credentials' };
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'sign_in' });
    expect(mocks.scheduleNotification).toHaveBeenCalledTimes(1);
    expect(mocks.calls.deleteUser).toEqual([]);
  });

  it('refuses a missing email or a short password before creating anything', async () => {
    await expect(submitAffiliateSignup({ ...ANONYMOUS_INPUT, email: null }, formData())).resolves.toEqual({
      kind: 'error',
      code: 'email_invalid',
    });
    await expect(submitAffiliateSignup({ ...ANONYMOUS_INPUT, password: 'short' }, formData())).resolves.toEqual({
      kind: 'error',
      code: 'password_invalid',
    });
    expect(mocks.calls.createUser).toEqual([]);
  });
});

describe('submitAffiliateSignup: signups that confirm their email', () => {
  /** What GoTrue answers when the project has no email confirmation: a session at once. */
  function signUpWithSession() {
    mocks.signUpResult = {
      data: { user: { id: NEW_USER_ID, created_at: new Date().toISOString(), identities: [{ id: 'identity' }] }, session: { access_token: 'x' } },
      error: null,
    };
  }

  it('creates only the auth user while the address is unconfirmed', async () => {
    vi.stubEnv('NEXT_PUBLIC_URL', 'https://shop.example.com');
    try {
      await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'confirm_email' });
    } finally {
      vi.unstubAllEnvs();
    }

    // The handle waits in the metadata; the confirmation link returns to the signup page.
    expect(mocks.calls.signUp).toEqual([
      {
        email: 'jane@example.com',
        password: 'correct horse battery',
        options: {
          data: { full_name: 'Jane Doe', affiliate_handle: 'jane-picks' },
          emailRedirectTo: 'https://shop.example.com/auth/callback?redirect_to=%2Fpartners',
        },
      },
    ]);
    // No seat, handle, page or "new partner" alert for an address nobody confirmed.
    expect(rpcCall()).toBeUndefined();
    expect(mocks.scheduleNotification).not.toHaveBeenCalled();
    expect(mocks.evictTiers).not.toHaveBeenCalled();
    expect(mocks.calls.deleteUser).toEqual([]);
    expect(mocks.calls.createUser).toEqual([]);
  });

  it('creates the partner account at once when the project returns a session', async () => {
    signUpWithSession();
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toMatchObject({
      kind: 'signed_in',
      account: { affiliateId: 'aff-1', tierName: 'Founding Ambassador' },
    });
    expect(rpcCall()?.args).toMatchObject({ p_user_id: NEW_USER_ID, p_handle: 'jane-picks', p_signup_ip_masked: '203.0.113.0/24' });
    expect(mocks.scheduleNotification).toHaveBeenCalledWith('SIGNED_UP', expect.objectContaining({ affiliateId: 'aff-1' }));
    expect(mocks.evictTiers).toHaveBeenCalledWith('action');
  });

  it('answers an obfuscated existing account (no identities) with "check your email" and creates nothing', async () => {
    mocks.signUpResult = {
      data: { user: { id: NEW_USER_ID, created_at: new Date().toISOString(), identities: [] }, session: null },
      error: null,
    };
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'confirm_email' });
    expect(rpcCall()).toBeUndefined();
    expect(mocks.calls.deleteUser).toEqual([]);
  });

  it('never attaches a profile to, or deletes, an older unconfirmed account', async () => {
    mocks.signUpResult = {
      data: { user: { id: NEW_USER_ID, created_at: '2026-01-01T00:00:00.000Z', identities: [{ id: 'identity' }] }, session: null },
      error: null,
    };
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'confirm_email' });
    expect(rpcCall()).toBeUndefined();
    expect(mocks.calls.deleteUser).toEqual([]);
  });

  it('removes the brand-new user when the handle was taken in a race (23505)', async () => {
    signUpWithSession();
    mocks.rpcResult = {
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "affiliate_profiles_handle_key"' },
    };
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'error', code: 'handle_taken' });
    expect(mocks.calls.deleteUser).toEqual([NEW_USER_ID]);
  });

  it('maps rate limits and existing accounts without echoing the auth error', async () => {
    mocks.signUpResult = { data: { user: null, session: null }, error: { message: 'email rate limit exceeded', status: 429 } };
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'error', code: 'rate_limited' });

    mocks.signUpResult = { data: { user: null, session: null }, error: { message: 'User already registered', code: 'user_already_exists' } };
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'error', code: 'account_exists' });

    mocks.signUpResult = { data: { user: null, session: null }, error: { message: 'database exploded at row 7' } };
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'error', code: 'unknown' });
  });
});

describe('submitAffiliateSignup: the public sandbox runs every check and writes nothing', () => {
  const DEMO = { kind: 'sandbox_demo', handle: 'jane-picks' };

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
  });

  /** No starter page, partner account, auth user, sign-in, alert or email: nothing a real signup writes. */
  function expectNothingWritten() {
    expect(mocks.getRequestLocale).not.toHaveBeenCalled();
    expect(mocks.calls.rpc).toEqual([]);
    expect(mocks.calls.createUser).toEqual([]);
    expect(mocks.calls.signUp).toEqual([]);
    expect(mocks.calls.signIn).toEqual([]);
    expect(mocks.calls.deleteUser).toEqual([]);
    expect(mocks.scheduleNotification).not.toHaveBeenCalled();
    expect(mocks.evictTiers).not.toHaveBeenCalled();
  }

  /** The read-only lookups that ran, in order. */
  function lookups(): string[] {
    return mocks.calls.countFilters.map((filters) =>
      'signup_ip_masked' in filters ? 'throttle' : 'handle' in filters ? 'handle' : String(filters['table']),
    );
  }

  it.each([false, true])('answers an anonymous signup with the demo, auto-accept %s', async (autoAccept) => {
    mocks.autoAccept = autoAccept;
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual(DEMO);
    expect(mocks.verifyBotProtection).toHaveBeenCalledTimes(1);
    expect(lookups()).toEqual(['throttle', 'handle', 'affiliate_tiers']);
    expectNothingWritten();
  });

  it('answers a signed-in customer upgrade with the demo, without the RPC', async () => {
    mocks.sessionUser = { id: USER_ID, email: 'customer@example.com' };
    mocks.profile = { role: 'USER', full_name: 'Casey Customer' };
    await expect(submitAffiliateSignup({ ...ANONYMOUS_INPUT, email: null, password: null }, formData())).resolves.toEqual(DEMO);
    expect(mocks.evaluateTwoFactor).toHaveBeenCalledTimes(1);
    expect(lookups()).toEqual(['throttle', 'handle', 'affiliate_tiers']);
    expectNothingWritten();
  });

  const session = { id: USER_ID, email: 'someone@example.com' };

  it.each<[string, Partial<typeof mocks>, Partial<AffiliateSignupInput>, unknown]>([
    ['an inactive package', { packageActive: false }, {}, { kind: 'error', code: 'package_inactive' }],
    ['a failed captcha', { botCheck: { ok: false, reason: 'captcha', message: 'x' } }, {}, { kind: 'error', code: 'captcha' }],
    ['a tripped honeypot, with the usual answer', { botCheck: { ok: false, reason: 'honeypot' } }, {}, { kind: 'confirm_email' }],
    ['a malformed handle', {}, { handle: 'a_b' }, { kind: 'error', code: 'handle_invalid' }],
    ['a reserved handle', {}, { handle: 'Admin' }, { kind: 'error', code: 'handle_reserved' }],
    ['an empty display name', {}, { displayName: '   ' }, { kind: 'error', code: 'name_invalid' }],
    [
      'a session owing its second factor',
      { sessionUser: session, profile: { role: 'USER', full_name: null }, twoFactorStatus: 'totp_required' },
      {},
      { kind: 'error', code: 'factor_pending' },
    ],
    ['a staff account', { sessionUser: session, profile: { role: 'ADMIN', full_name: null } }, {}, { kind: 'error', code: 'role_conflict' }],
    ['a throttled network', { throttleCount: AFFILIATE_SIGNUP_THROTTLE_MAX }, {}, { kind: 'error', code: 'throttled' }],
    ['a taken handle', { handleCount: 1 }, {}, { kind: 'error', code: 'handle_taken' }],
    ['a full program', { tiers: [{ max_ambassadors_cap: 5, member_count: 5 }] }, {}, { kind: 'error', code: 'program_full' }],
    ['a missing email', {}, { email: null }, { kind: 'error', code: 'email_invalid' }],
    ['a short password', {}, { password: 'short' }, { kind: 'error', code: 'password_invalid' }],
  ])('still refuses %s, as a real signup would', async (_label, state, input, expected) => {
    Object.assign(mocks, state);
    await expect(submitAffiliateSignup({ ...ANONYMOUS_INPUT, ...input }, formData())).resolves.toEqual(expected);
    expectNothingWritten();
  });

  it.each(['', 'false', '1', 'TRUE'])('signs up for real when NEXT_PUBLIC_IS_SANDBOX is %j', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
    await expect(submitAffiliateSignup(ANONYMOUS_INPUT, formData())).resolves.toEqual({ kind: 'confirm_email' });
    expect(mocks.calls.signUp).toHaveLength(1);
    expect(mocks.getRequestLocale).toHaveBeenCalledTimes(1);
  });
});

describe('client address helpers', () => {
  it('prefers the platform headers over x-forwarded-for', () => {
    vi.stubEnv('VERCEL', '');
    try {
      const headers = new Headers({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1', 'x-real-ip': '203.0.113.9' });
      expect(resolveAffiliateSignupClientIp(headers)).toBe('203.0.113.9');
      expect(resolveAffiliateSignupClientIp(new Headers({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }))).toBe('198.51.100.1');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('trusts x-vercel-forwarded-for only on Vercel, where the platform sets it', () => {
    const spoofed = new Headers({ 'x-vercel-forwarded-for': '192.0.2.4', 'x-real-ip': '203.0.113.9' });
    vi.stubEnv('VERCEL', '');
    try {
      // Anywhere else a client sends it and would choose its own throttle bucket.
      expect(resolveAffiliateSignupClientIp(spoofed)).toBe('203.0.113.9');
      expect(resolveAffiliateSignupClientIp(new Headers({ 'x-vercel-forwarded-for': '192.0.2.4' }))).toBeNull();
      vi.stubEnv('VERCEL', '1');
      expect(resolveAffiliateSignupClientIp(spoofed)).toBe('192.0.2.4');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('masks addresses to the /24 or /48 network, never the address', () => {
    for (const ipv4 of ['203.0.113.7', '::ffff:203.0.113.7', '203.0.113.7:51234', ' 203.0.113.250 ']) {
      expect(maskAffiliateSignupIp(ipv4)).toBe('203.0.113.0/24');
    }
    // One /48, whatever the compression.
    expect(maskAffiliateSignupIp('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(maskAffiliateSignupIp('2001:db8::2')).toBe('2001:db8:0::/48');
    expect(maskAffiliateSignupIp('[2001:db8::1]:443')).toBe('2001:db8:0::/48');
    expect(maskAffiliateSignupIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:85a3::/48');
    expect(maskAffiliateSignupIp('2001::1234:5678:9abc:def0')).toBe('2001:0:0::/48');
  });

  it('puts every unreadable address in one shared, bounded bucket', () => {
    expect(maskAffiliateSignupIp(null)).toBe('unknown');
    expect(maskAffiliateSignupIp('not an address')).toBe('unknown');
    expect(maskAffiliateSignupIp('999.1.1.1')).toBe('unknown');
    expect(maskAffiliateSignupIp(`${'a'.repeat(300)}:b:c`)).toBe('unknown');
    expect(maskAffiliateSignupIp('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff').length).toBeLessThanOrEqual(64);
  });

  it('treats only a user created during this request as brand new', () => {
    const now = Date.now();
    expect(isAffiliateSignupBrandNewUser({ created_at: new Date(now).toISOString() }, now)).toBe(true);
    expect(isAffiliateSignupBrandNewUser({ created_at: new Date(now - 10 * 60_000).toISOString() }, now)).toBe(false);
    expect(isAffiliateSignupBrandNewUser({ created_at: 'garbage' }, now)).toBe(false);
  });
});

describe('checkAffiliateHandleAvailability', () => {
  it('answers shape problems locally and asks the database only for a well-formed handle', async () => {
    await expect(checkAffiliateHandleAvailability('partners')).resolves.toEqual({ ok: true, status: 'reserved' });
    await expect(checkAffiliateHandleAvailability('-bad-')).resolves.toEqual({ ok: true, status: 'invalid' });
    expect(mocks.calls.serviceClients).toBe(0);

    await expect(checkAffiliateHandleAvailability('Fresh-Handle')).resolves.toEqual({ ok: true, status: 'available' });
    expect(mocks.calls.countFilters.at(-1)?.['handle']).toBe('fresh-handle');

    mocks.handleCount = 1;
    await expect(checkAffiliateHandleAvailability('fresh-handle')).resolves.toEqual({ ok: true, status: 'taken' });
  });

  it('refuses while the package is inactive', async () => {
    mocks.packageActive = false;
    await expect(checkAffiliateHandleAvailability('fresh-handle')).resolves.toEqual({ ok: false, error: 'unavailable' });
  });

  it('rate-limits one masked address', async () => {
    let limited = false;
    for (let attempt = 0; attempt < 60 && !limited; attempt += 1) {
      const result = await checkAffiliateHandleAvailability('fresh-handle');
      limited = !result.ok && result.error === 'rate_limited';
    }
    expect(limited).toBe(true);
    // Another address still gets answers.
    mocks.headers = { 'x-forwarded-for': '198.51.100.20' };
    await expect(checkAffiliateHandleAvailability('fresh-handle')).resolves.toMatchObject({ ok: true });
  });

  it('expires buckets and refuses new addresses under a flood', () => {
    const start = 1_000_000;
    for (let index = 0; index < 40; index += 1) expect(isAffiliateHandleCheckRateLimited('bucket-a', start)).toBe(false);
    expect(isAffiliateHandleCheckRateLimited('bucket-a', start)).toBe(true);
    expect(isAffiliateHandleCheckRateLimited('bucket-a', start + 5 * 60_000 + 1)).toBe(false);
  });
});

describe('resolvePartnerSignupViewer', () => {
  it('is anonymous without a session', async () => {
    await expect(resolvePartnerSignupViewer()).resolves.toEqual({ kind: 'anonymous' });
  });

  it('offers a customer the upgrade form with their own email and name', async () => {
    mocks.sessionUser = { id: USER_ID, email: 'customer@example.com' };
    mocks.profile = { role: 'USER', full_name: 'Casey Customer' };
    await expect(resolvePartnerSignupViewer()).resolves.toEqual({
      kind: 'customer',
      email: 'customer@example.com',
      fullName: 'Casey Customer',
      pendingHandle: null,
    });
  });

  it('prefills the handle a confirmed signup chose, normalized, and drops an invalid one', async () => {
    mocks.sessionUser = { id: USER_ID, email: 'jane@example.com', user_metadata: { full_name: 'Jane Doe', affiliate_handle: 'Jane-Picks' } };
    mocks.profile = { role: 'USER', full_name: 'Jane Doe' };
    await expect(resolvePartnerSignupViewer()).resolves.toMatchObject({ kind: 'customer', pendingHandle: 'jane-picks' });

    for (const affiliate_handle of ['-bad-', 'admin', 42, null]) {
      mocks.sessionUser = { id: USER_ID, email: 'jane@example.com', user_metadata: { affiliate_handle } };
      await expect(resolvePartnerSignupViewer()).resolves.toMatchObject({ kind: 'customer', pendingHandle: null });
    }
    mocks.sessionUser = { id: USER_ID, email: 'jane@example.com', user_metadata: {} };
    await expect(resolvePartnerSignupViewer()).resolves.toMatchObject({ kind: 'customer', pendingHandle: null });
  });

  it('sends a partner to the portal, and lets an RTL account without a profile finish', async () => {
    mocks.sessionUser = { id: USER_ID, email: 'partner@example.com' };
    mocks.profile = { role: 'RTL', full_name: null };
    mocks.ownAffiliateCount = 1;
    await expect(resolvePartnerSignupViewer()).resolves.toEqual({ kind: 'partner' });

    mocks.ownAffiliateCount = 0;
    await expect(resolvePartnerSignupViewer()).resolves.toEqual({
      kind: 'customer',
      email: 'partner@example.com',
      fullName: null,
      pendingHandle: null,
    });
  });

  it('refuses staff and pending second factors', async () => {
    mocks.sessionUser = { id: USER_ID, email: 'admin@example.com' };
    mocks.profile = { role: 'ADMIN', full_name: null };
    await expect(resolvePartnerSignupViewer()).resolves.toEqual({ kind: 'staff' });

    mocks.twoFactorStatus = 'email_required';
    await expect(resolvePartnerSignupViewer()).resolves.toEqual({ kind: 'factor_pending' });
  });
});
