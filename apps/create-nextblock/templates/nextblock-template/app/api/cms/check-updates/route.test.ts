import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The admin update check resolves the caller with the real getCmsActor() and evaluateTwoFactor()
 * over a faked cookie session before refreshUpstreamStatus(), which records its alerts and the
 * upstream status in system_configuration with the service role. Until 2026-11-14 it read the role
 * through the cookie client, so an admin password alone (the first factor) ran it: a route handler
 * never passes the CMS layout's 2FA redirect.
 */

const mocks = vi.hoisted(() => ({
  /**
   * The cookie session getCmsActor() reads: the user, their own profile role, the second factor
   * they enrolled, the session's assurance level.
   */
  session: {
    user: { id: 'admin-1' } as { id: string } | null,
    role: 'ADMIN' as string | null,
    mfa: null as { mfa_enabled: boolean; mfa_type: 'totp' | 'email' } | null,
    aal: 'aal1' as 'aal1' | 'aal2',
  },
  cookieReads: [] as string[],
  getServiceRoleSupabaseClient: vi.fn(),
  refreshUpstreamStatus: vi.fn(),
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
}));
// No trusted-device or email-code cookie: a second factor counts only through the session itself.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
// Read only by the trusted-device and reminder paths, never on the way to these decisions.
vi.mock('../../../../lib/privacy/settings', () => ({
  getSecuritySettings: async () => ({ enforce_staff_2fa: false, trusted_device_days: 30 }),
}));
vi.mock('../../../../lib/updates/check-upstream', () => ({
  refreshUpstreamStatus: mocks.refreshUpstreamStatus,
}));

import { POST } from './route';

const SECOND_FACTOR = 'Complete two-factor verification, then try again.';

const CHECK_RESULT = {
  update: { ok: true, currentVersion: '0.23.4', latestVersion: '0.23.4', updateAvailable: false },
  conflicts: { ok: true, openConflicts: 0 },
  snapshot: null,
};

function signIn(role: string | null, user: { id: string } | null = { id: 'admin-1' }) {
  mocks.session.user = user;
  mocks.session.role = role;
}

describe('POST /api/cms/check-updates', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    signIn('ADMIN');
    mocks.session.mfa = null;
    mocks.session.aal = 'aal1';
    mocks.cookieReads = [];
    mocks.refreshUpstreamStatus.mockResolvedValue(CHECK_RESULT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  // A route handler never passes the CMS layout's 2FA redirect. Until 2026-11-14 this route read
  // the role through the cookie client, so an admin password alone ran the check.
  it.each([
    ['whose enrolled authenticator app this session has not passed (aal1)', 'totp'],
    ['whose enrolled email code this session has not passed', 'email'],
  ] as const)('refuses an ADMIN %s before the check runs', async (_label, factor) => {
    mocks.session.mfa = { mfa_enabled: true, mfa_type: factor };

    const response = await POST();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: SECOND_FACTOR });
    expect(mocks.cookieReads).not.toContain('profiles');
    expect(mocks.refreshUpstreamStatus).not.toHaveBeenCalled();
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
  });

  it('answers 401 without a session', async () => {
    signIn(null, null);
    const response = await POST();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'Not authenticated.' });
    expect(mocks.refreshUpstreamStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['a WRITER', 'WRITER'],
    ['a customer (USER)', 'USER'],
    ['an account whose profile row is missing', null],
  ] as const)('refuses %s, also past an enrolled factor (aal2): the check is ADMIN-only', async (_label, role) => {
    signIn(role);
    mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.session.aal = 'aal2';
    const response = await POST();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'Administrator role required.' });
    expect(mocks.refreshUpstreamStatus).not.toHaveBeenCalled();
  });

  it('runs the check for an ADMIN whose session passed the enrolled authenticator app (aal2)', async () => {
    mocks.session.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.session.aal = 'aal2';
    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...CHECK_RESULT });
    expect(mocks.refreshUpstreamStatus).toHaveBeenCalledTimes(1);
  });

  it('runs the check for an ADMIN who enrolled no second factor, and keeps the 502 for a soft failure', async () => {
    mocks.refreshUpstreamStatus.mockResolvedValue({ ...CHECK_RESULT, update: { ...CHECK_RESULT.update, ok: false } });
    const response = await POST();
    expect(response.status).toBe(502);
    expect(mocks.refreshUpstreamStatus).toHaveBeenCalledTimes(1);
  });
});
