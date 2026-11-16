import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The GitHub connect actions (app/cms/components/github-connect-actions.ts): the device flow that
 * installs the upstream sync workflow. pollGithubConnect ends in a service-role write
 * (markSyncWorkflowInstalled writes system_configuration, ADMIN-only behind is_admin_mfa() since
 * 02028), and a server action never passes the CMS layout's 2FA redirect. Until 2026-11-13 the gate
 * read the role through the cookie client, so an ADMIN password alone (the first factor) reached it.
 * The gate now resolves getCmsActor(), and this file runs the real one, with evaluateTwoFactor()
 * behind it, against a faked cookie session, as app/actions/package-actions.test.ts does. Who may
 * act is unchanged: ADMIN only. A signed-in caller whose enrolled factor is pending is told to
 * complete it, like the other actions fixed that day; until 2026-11-14 an ADMIN in that state was
 * told "Administrator role required." (the 0.23.4 verification's F16).
 */

const DEVICE_COOKIE = 'nb_gh_device';

const mocks = vi.hoisted(() => ({
  user: { id: 'admin-1' } as { id: string } | null,
  role: 'ADMIN' as string | null,
  /** The caller's `user_security_settings` row: the second factor they enrolled, if any. */
  mfa: null as { mfa_enabled: boolean; mfa_type: 'totp' | 'email' } | null,
  /** The assurance level of this session (a TOTP factor is verified at aal2). */
  aal: 'aal1' as 'aal1' | 'aal2',
  /** The request's cookies: the device code, and never a trusted-device or email-code cookie. */
  jar: new Map<string, string>(),
  createCookieClient: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  startDeviceFlow: vi.fn(),
  pollDeviceFlowOnce: vi.fn(),
  installSyncWorkflow: vi.fn(),
  markSyncWorkflowInstalled: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: mocks.createCookieClient,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (mocks.jar.has(name) ? { name, value: mocks.jar.get(name) } : undefined),
    set: (nameOrCookie: string | { name: string; value: string }, value?: string) => {
      if (typeof nameOrCookie === 'string') mocks.jar.set(nameOrCookie, String(value));
      else mocks.jar.set(nameOrCookie.name, nameOrCookie.value);
    },
    delete: (nameOrCookie: string | { name: string }) => {
      mocks.jar.delete(typeof nameOrCookie === 'string' ? nameOrCookie : nameOrCookie.name);
    },
  }),
}));
vi.mock('../../../lib/updates/github-device', () => ({
  startDeviceFlow: mocks.startDeviceFlow,
  pollDeviceFlowOnce: mocks.pollDeviceFlowOnce,
  installSyncWorkflow: mocks.installSyncWorkflow,
}));
vi.mock('../../../lib/updates/check-upstream', () => ({
  markSyncWorkflowInstalled: mocks.markSyncWorkflowInstalled,
}));
// Read only by the trusted-device and reminder paths, never on the way to these decisions.
vi.mock('../../../lib/privacy/settings', () => ({
  getSecuritySettings: async () => ({ enforce_staff_2fa: false, trusted_device_days: 30 }),
}));

import { pollGithubConnect, startGithubConnect } from './github-connect-actions';

/** The cookie session: the signed-in user, their own profile role and second factor, the session's assurance level. */
function fakeCookieClient() {
  const read = async (table: string) => {
    if (table === 'profiles') return { data: mocks.role ? { role: mocks.role } : null, error: null };
    if (table === 'user_security_settings') return { data: mocks.mfa, error: null };
    throw new Error(`Unexpected cookie-client read of ${table}`);
  };
  return {
    auth: {
      getUser: async () => ({ data: { user: mocks.user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: mocks.aal, nextLevel: 'aal2' }, error: null }),
      },
    },
    from: (table: string) => ({
      // `single` too: the pre-2026-11-13 gate read the role that way, so a return to it is judged
      // by the refusals below rather than by a missing method.
      select: () => ({ eq: () => ({ maybeSingle: () => read(table), single: () => read(table) }) }),
    }),
  };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.user = { id: 'admin-1' };
  mocks.role = 'ADMIN';
  mocks.mfa = null;
  mocks.aal = 'aal1';
  mocks.jar = new Map([[DEVICE_COOKIE, 'device-code-1']]);
  mocks.createCookieClient.mockReset().mockImplementation(() => fakeCookieClient());
  mocks.getServiceRoleSupabaseClient.mockReset();
  mocks.startDeviceFlow.mockReset().mockResolvedValue({
    deviceCode: 'device-code-2',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    interval: 5,
    expiresIn: 900,
  });
  mocks.pollDeviceFlowOnce.mockReset().mockResolvedValue({ status: 'authorized', token: 'gho_user_token' });
  mocks.installSyncWorkflow.mockReset().mockResolvedValue({ ok: true, htmlUrl: 'https://github.com/acme/site/actions' });
  mocks.markSyncWorkflowInstalled.mockReset().mockResolvedValue(undefined);
  mocks.revalidatePath.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ADMIN_REQUIRED = 'Administrator role required.';
const SECOND_FACTOR = 'Complete two-factor verification, then try again.';

/** Callers the gate refuses, and the refusal each one reads. */
const REFUSED_CALLERS: ReadonlyArray<readonly [string, () => void, string]> = [
  ['a caller with no session', () => {
    mocks.user = null;
    mocks.role = null;
  }, ADMIN_REQUIRED],
  ['a WRITER', () => {
    mocks.role = 'WRITER';
  }, ADMIN_REQUIRED],
  ['a WRITER past an enrolled authenticator app (aal2)', () => {
    mocks.role = 'WRITER';
    mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.aal = 'aal2';
  }, ADMIN_REQUIRED],
  ['an ADMIN whose enrolled authenticator app this session has not passed (aal1)', () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.aal = 'aal1';
  }, SECOND_FACTOR],
  ['an ADMIN whose enrolled email code this session has not passed', () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: 'email' };
  }, SECOND_FACTOR],
];

describe('pollGithubConnect authorizes through getCmsActor()', () => {
  it.each(REFUSED_CALLERS)('refuses %s before GitHub or the system_configuration write', async (_label, arrange, error) => {
    arrange();

    expect(await pollGithubConnect()).toEqual({ status: 'error', error });
    expect(mocks.pollDeviceFlowOnce).not.toHaveBeenCalled();
    expect(mocks.installSyncWorkflow).not.toHaveBeenCalled();
    expect(mocks.markSyncWorkflowInstalled).not.toHaveBeenCalled();
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.jar.get(DEVICE_COOKIE)).toBe('device-code-1');
  });

  const expectInstalled = () => {
    expect(mocks.pollDeviceFlowOnce).toHaveBeenCalledWith('device-code-1');
    expect(mocks.installSyncWorkflow).toHaveBeenCalledWith('gho_user_token');
    expect(mocks.markSyncWorkflowInstalled).toHaveBeenCalledTimes(1);
    expect(mocks.jar.has(DEVICE_COOKIE)).toBe(false);
  };

  it('installs for an ADMIN whose session passed the enrolled second factor (aal2)', async () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.aal = 'aal2';

    expect(await pollGithubConnect()).toEqual({ status: 'installed', htmlUrl: 'https://github.com/acme/site/actions' });
    expectInstalled();
  });

  it('installs for an ADMIN who enrolled no second factor', async () => {
    expect(await pollGithubConnect()).toEqual({ status: 'installed', htmlUrl: 'https://github.com/acme/site/actions' });
    expectInstalled();
  });
});

describe('startGithubConnect authorizes through getCmsActor()', () => {
  it.each(REFUSED_CALLERS)('refuses %s before starting a device flow', async (_label, arrange, error) => {
    arrange();
    mocks.jar.clear();

    expect(await startGithubConnect()).toEqual({ ok: false, error });
    expect(mocks.startDeviceFlow).not.toHaveBeenCalled();
    expect(mocks.jar.size).toBe(0);
  });

  it('starts a device flow for an ADMIN who enrolled no second factor', async () => {
    mocks.jar.clear();

    expect(await startGithubConnect()).toMatchObject({ ok: true, userCode: 'ABCD-1234' });
    expect(mocks.jar.get(DEVICE_COOKIE)).toBe('device-code-2');
  });
});
