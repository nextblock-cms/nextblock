import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The language settings actions (app/cms/settings/languages/actions.ts).
 *
 * updateLanguageDetectionSettings writes `site_settings.language_detection_settings` with the
 * service role (the key is in the ADMIN-only write tier behind is_admin_mfa(), 02023). Until
 * 2026-11-13 its gate, verifyAdmin, read the role through the cookie client, so an ADMIN password
 * alone (the first factor) wrote it: server actions never pass the CMS layout's 2FA redirect. The
 * module now resolves getCmsActor() for every mutating action (create, update and delete keep the
 * cookie client and RLS), and this file runs the real one, with evaluateTwoFactor() behind it,
 * against a faked cookie session, as app/actions/package-actions.test.ts does. Who may act is
 * unchanged: ADMIN only.
 */

type LanguageWrite = { op: string; payload?: unknown; filters: Array<[string, string, unknown]> };

const mocks = vi.hoisted(() => ({
  user: { id: 'admin-1' } as { id: string } | null,
  role: 'ADMIN' as string | null,
  /** The caller's `user_security_settings` row: the second factor they enrolled, if any. */
  mfa: null as { mfa_enabled: boolean; mfa_type: 'totp' | 'email' } | null,
  /** The assurance level of this session (a TOTP factor is verified at aal2). */
  aal: 'aal1' as 'aal1' | 'aal2',
  languageWrites: [] as Array<{ op: string; payload?: unknown; filters: Array<[string, string, unknown]> }>,
  settingsWrites: [] as Array<Record<string, unknown>>,
  createCookieClient: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  createClient: mocks.createCookieClient,
  getServiceRoleSupabaseClient: mocks.getServiceRoleSupabaseClient,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath, updateTag: mocks.updateTag }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
// No trusted-device or email-code cookie: the second factor counts only through the session itself.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
// Read only by the trusted-device and reminder paths, never on the way to these decisions.
vi.mock('../../../../lib/privacy/settings', () => ({
  getSecuritySettings: async () => ({ enforce_staff_2fa: false, trusted_device_days: 30 }),
}));

import {
  createLanguage,
  deleteLanguage,
  updateLanguage,
  updateLanguageDetectionSettings,
} from './actions';

/** A `languages` query through the cookie client: reads answer a non-default language, writes are recorded. */
function languagesQuery() {
  const call: LanguageWrite = { op: 'select', filters: [] };
  const settle = () => {
    if (call.op !== 'select') mocks.languageWrites.push({ ...call, filters: [...call.filters] });
    if (call.op === 'insert') return { data: { id: 9, code: 'de' }, error: null };
    if (call.op === 'select') return { data: { is_default: false, code: 'de' }, error: null, count: 2 };
    return { data: null, error: null };
  };
  const query: Record<string, unknown> = {
    select: () => query,
    insert: (payload: unknown) => {
      call.op = 'insert';
      call.payload = payload;
      return query;
    },
    update: (payload: unknown) => {
      call.op = 'update';
      call.payload = payload;
      return query;
    },
    delete: () => {
      call.op = 'delete';
      return query;
    },
    eq: (column: string, value: unknown) => {
      call.filters.push(['eq', column, value]);
      return query;
    },
    neq: (column: string, value: unknown) => {
      call.filters.push(['neq', column, value]);
      return query;
    },
    single: async () => settle(),
    maybeSingle: async () => settle(),
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(settle()).then(onFulfilled, onRejected),
  };
  return query;
}

/** The cookie session: the signed-in user, their own profile role and second factor, the session's assurance level. */
function fakeCookieClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: mocks.user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: mocks.aal, nextLevel: 'aal2' }, error: null }),
      },
    },
    from: (table: string) => {
      if (table === 'languages') return languagesQuery();
      const read = async () => {
        if (table === 'profiles') return { data: mocks.role ? { role: mocks.role } : null, error: null };
        if (table === 'user_security_settings') return { data: mocks.mfa, error: null };
        throw new Error(`Unexpected cookie-client read of ${table}`);
      };
      // `single` too: the pre-2026-11-13 verifyAdmin read the role that way, so a return to it is
      // judged by the refusals below rather than by a missing method.
      return { select: () => ({ eq: () => ({ maybeSingle: read, single: read }) }) };
    },
  };
}

/** The service-role client: only the detection settings upsert. */
function fakeServiceClient() {
  return {
    from: (table: string) => {
      expect(table).toBe('site_settings');
      return {
        upsert: async (row: Record<string, unknown>) => {
          mocks.settingsWrites.push(row);
          return { error: null };
        },
      };
    },
  };
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.user = { id: 'admin-1' };
  mocks.role = 'ADMIN';
  mocks.mfa = null;
  mocks.aal = 'aal1';
  mocks.languageWrites = [];
  mocks.settingsWrites = [];
  mocks.createCookieClient.mockReset().mockImplementation(() => fakeCookieClient());
  mocks.getServiceRoleSupabaseClient.mockReset().mockImplementation(() => fakeServiceClient());
  mocks.revalidatePath.mockReset();
  mocks.updateTag.mockReset();
  mocks.redirect.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ADMIN_REQUIRED = 'Unauthorized: Admin role required.';
const SECOND_FACTOR = 'Complete two-factor verification, then try again.';

/** Callers the module refuses, each with the message it returns. */
const REFUSED_CALLERS: ReadonlyArray<readonly [string, () => void, string]> = [
  ['a caller with no session', () => {
    mocks.user = null;
    mocks.role = null;
  }, ADMIN_REQUIRED],
  ['a WRITER', () => {
    mocks.role = 'WRITER';
  }, ADMIN_REQUIRED],
  ['an ADMIN whose enrolled authenticator app this session has not passed (aal1)', () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.aal = 'aal1';
  }, SECOND_FACTOR],
  ['an ADMIN whose enrolled email code this session has not passed', () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: 'email' };
  }, SECOND_FACTOR],
];

/** Each mutating export, how it is called, and what it does once allowed. */
const ACTIONS: ReadonlyArray<readonly [string, () => Promise<unknown>, () => void]> = [
  [
    'updateLanguageDetectionSettings',
    () => updateLanguageDetectionSettings({ mode: 'country', rememberVisitorChoice: false }),
    () => {
      expect(mocks.settingsWrites).toEqual([
        { key: 'language_detection_settings', value: { mode: 'country', rememberVisitorChoice: false } },
      ]);
      expect(mocks.updateTag).toHaveBeenCalledWith('public-language-detection');
    },
  ],
  [
    'createLanguage',
    () => createLanguage(form({ code: 'de', name: 'Deutsch', is_active: 'on' })),
    () => {
      expect(mocks.languageWrites).toEqual([
        { op: 'insert', payload: { code: 'de', name: 'Deutsch', is_default: false, is_active: true }, filters: [] },
      ]);
      expect(mocks.redirect).toHaveBeenCalledTimes(1);
    },
  ],
  [
    'updateLanguage',
    () => updateLanguage(5, form({ code: 'de', name: 'Deutsch', is_default: 'on', is_active: 'on' })),
    () => {
      expect(mocks.languageWrites).toEqual([
        { op: 'update', payload: { is_default: false }, filters: [['eq', 'is_default', true], ['neq', 'id', 5]] },
        { op: 'update', payload: { code: 'de', name: 'Deutsch', is_default: true, is_active: true }, filters: [['eq', 'id', 5]] },
      ]);
      expect(mocks.redirect).toHaveBeenCalledTimes(1);
    },
  ],
  [
    'deleteLanguage',
    () => deleteLanguage(5),
    () => {
      expect(mocks.languageWrites).toEqual([{ op: 'delete', filters: [['eq', 'id', 5]] }]);
      expect(mocks.redirect).toHaveBeenCalledTimes(1);
    },
  ],
];

describe.each(ACTIONS)('%s authorizes through getCmsActor()', (_name, run, expectAllowedEffects) => {
  it.each(REFUSED_CALLERS)('refuses %s with nothing written', async (_label, arrange, message) => {
    arrange();

    expect(await run()).toEqual({ error: message });
    expect(mocks.getServiceRoleSupabaseClient).not.toHaveBeenCalled();
    expect(mocks.settingsWrites).toEqual([]);
    expect(mocks.languageWrites).toEqual([]);
    expect(mocks.updateTag).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('runs for an ADMIN whose session passed the enrolled second factor (aal2)', async () => {
    mocks.mfa = { mfa_enabled: true, mfa_type: 'totp' };
    mocks.aal = 'aal2';

    await run();
    expectAllowedEffects();
  });

  it('runs for an ADMIN who enrolled no second factor', async () => {
    await run();
    expectAllowedEffects();
  });
});

describe('updateLanguageDetectionSettings', () => {
  it('writes only with the service role, never through the cookie client', async () => {
    expect(await updateLanguageDetectionSettings({ mode: 'browser', rememberVisitorChoice: true })).toEqual({
      success: 'Language detection settings saved. Changes reach new visitors within about a minute.',
    });
    expect(mocks.getServiceRoleSupabaseClient).toHaveBeenCalledTimes(1);
    expect(mocks.languageWrites).toEqual([]);
  });
});
