import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * getFormEndpointForEditor (app/cms/messages/actions.ts): the contact-form block editor's read of
 * where a form's submissions go (label, recipient address), for ADMINs and WRITERs. It reads
 * `form_endpoints` with the service role, and a server action never passes the CMS layout's 2FA
 * redirect. Until 2026-11-13 the staff check read the role through the cookie client, so a session
 * whose enrolled second factor was still pending passed it. It now resolves getCmsActor(), and this
 * file runs the real one, with evaluateTwoFactor() behind it, against a faked cookie session, as
 * app/actions/package-actions.test.ts does. Who may read is unchanged: ADMIN and WRITER, and only an
 * ADMIN is told it may edit.
 */

const FORM_KEY = 'contact-main';

const mocks = vi.hoisted(() => ({
  user: { id: 'admin-1' } as { id: string } | null,
  role: 'ADMIN' as string | null,
  /** The caller's `user_security_settings` row: the second factor they enrolled, if any. */
  mfa: null as { mfa_enabled: boolean; mfa_type: 'totp' | 'email' } | null,
  /** The assurance level of this session (a TOTP factor is verified at aal2). */
  aal: 'aal1' as 'aal1' | 'aal2',
  endpoint: { label: 'Contact form', recipient_email: 'sales@site.example' } as Record<string, unknown> | null,
  endpointReads: [] as unknown[],
  createCookieClient: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: mocks.createCookieClient,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// No trusted-device or email-code cookie: the second factor counts only through the session itself.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
// The thread and mail helpers the other Messages actions use; none runs here.
vi.mock('../../../lib/messages/threads', () => ({ ensureThreadToken: vi.fn(), sendThreadNotice: vi.fn() }));
vi.mock('../../../lib/config/email-settings', () => ({ invalidateEmailConfigCache: vi.fn() }));
// Read only by the trusted-device and reminder paths, never on the way to these decisions.
vi.mock('../../../lib/privacy/settings', () => ({
  getSecuritySettings: async () => ({ enforce_staff_2fa: false, trusted_device_days: 30 }),
}));

import { getFormEndpointForEditor } from './actions';

/** The service-role client: the one `form_endpoints` read. */
function fakeServiceClient() {
  return {
    from: (table: string) => {
      expect(table).toBe('form_endpoints');
      return {
        select: () => ({
          eq: (column: string, value: unknown) => ({
            maybeSingle: async () => {
              mocks.endpointReads.push([column, value]);
              return { data: mocks.endpoint, error: null };
            },
          }),
        }),
      };
    },
  };
}

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
  mocks.endpoint = { label: 'Contact form', recipient_email: 'sales@site.example' };
  mocks.endpointReads = [];
  mocks.createCookieClient.mockReset().mockImplementation(() => fakeCookieClient());
  mocks.getServiceRoleSupabaseClient.mockReset().mockImplementation(() => fakeServiceClient());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('getFormEndpointForEditor authorizes through getCmsActor()', () => {
  it.each<readonly [string, () => void]>([
    ['a caller with no session', () => {
      mocks.user = null;
      mocks.role = null;
    }],
    ['a signed-in customer (USER)', () => {
      mocks.role = 'USER';
    }],
    ['an ADMIN whose enrolled authenticator app this session has not passed (aal1)', () => {
      mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
      mocks.aal = 'aal1';
    }],
    ['an ADMIN whose enrolled email code this session has not passed', () => {
      mocks.mfa = { mfa_enabled: true, mfa_type: 'email' };
    }],
    ['a WRITER whose enrolled authenticator app this session has not passed (aal1)', () => {
      mocks.role = 'WRITER';
      mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    }],
  ])('refuses %s without reading the endpoint', async (_label, arrange) => {
    arrange();

    expect(await getFormEndpointForEditor(FORM_KEY)).toBeNull();
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.endpointReads).toEqual([]);
  });

  it('reads it for an ADMIN whose session passed the enrolled second factor (aal2), who may edit', async () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.aal = 'aal2';

    expect(await getFormEndpointForEditor(FORM_KEY)).toEqual({
      label: 'Contact form',
      recipientEmail: 'sales@site.example',
      canEdit: true,
    });
    expect(mocks.endpointReads).toEqual([['form_key', FORM_KEY]]);
  });

  it('reads it for an ADMIN who enrolled no second factor, who may edit', async () => {
    expect(await getFormEndpointForEditor(FORM_KEY)).toEqual({
      label: 'Contact form',
      recipientEmail: 'sales@site.example',
      canEdit: true,
    });
  });

  it('reads it for a WRITER who enrolled no second factor, who may not edit (unchanged)', async () => {
    mocks.role = 'WRITER';

    expect(await getFormEndpointForEditor(FORM_KEY)).toEqual({
      label: 'Contact form',
      recipientEmail: 'sales@site.example',
      canEdit: false,
    });
  });

  it('answers empty fields when the form has no endpoint yet', async () => {
    mocks.endpoint = null;

    expect(await getFormEndpointForEditor(FORM_KEY)).toEqual({ label: '', recipientEmail: '', canEdit: true });
  });
});
