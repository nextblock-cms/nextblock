import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /cms/users server actions, driven with a fake service-role client.
 *
 * - 2026-10-21: an MCP token acts as the admin who minted it, and nothing revoked it when that
 *   admin was demoted or deleted. The tokens are revoked first, and a failed revoke stops the change.
 * - Every action authorizes through requireCmsAdmin() (session, ADMIN role, second factor) before
 *   it touches the service role; the old local verifyAdmin skipped the second factor.
 * - Affiliates: the partner role RTL is accepted, and deleting a partner who has commission or
 *   payout history is refused (ADDENDUM A24) because the ledger cascades from the account.
 * - 2026-11-03: the public sandbox publishes its admin login, so every visitor shares every account.
 *   Every write action refuses there right after the admin check, before any parsing, read, MCP
 *   token revoke, auth admin call, revalidation or redirect. Off the sandbox ('', 'false', 'TRUE',
 *   '1') every case below runs unchanged.
 */

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const NEW_USER_ID = '33333333-3333-4333-8333-333333333333';
const AFFILIATE_ID = '44444444-4444-4444-8444-444444444444';

type DbError = { code?: string; message: string } | null;

const calls: string[] = [];
const reads: string[] = [];

const mocks = vi.hoisted(() => ({
  authorize: null as null | (() => Promise<unknown>),
  currentRole: 'ADMIN' as string,
  adminCount: 2,
  revokeError: null as string | null,
  createError: null as { code?: string; message: string } | null,
  updateError: null as DbError,
  deleteError: null as DbError,
  affiliateLookup: { data: null, error: null } as { data: { id: string; handle?: string } | null; error: DbError },
  payouts: 0,
  liveCommissions: 0,
  voidedWithAmount: 0,
  ledgerCountError: null as DbError,
  evictStorefront: vi.fn(),
  evictTiers: vi.fn(),
  revalidatePath: vi.fn(),
  upsertAddresses: vi.fn(async () => undefined),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  }),
}));

function serviceClient() {
  return {
    auth: {
      admin: {
        createUser: async (params: { email: string }) => {
          calls.push(`auth.createUser:${params.email}`);
          return mocks.createError
            ? { data: { user: null }, error: mocks.createError }
            : { data: { user: { id: NEW_USER_ID } }, error: null };
        },
        deleteUser: async (id: string) => {
          calls.push(`auth.deleteUser:${id}`);
          return { error: mocks.deleteError };
        },
      },
    },
    from(table: string) {
      const state: { op: string; values?: unknown; head?: boolean; filters: string[] } = { op: 'select', filters: [] };
      const result = () => {
        if (state.op === 'update') {
          calls.push(`${table}.update:${JSON.stringify(state.values)}:${state.filters.join('&')}`);
          return { data: null, error: mocks.updateError };
        }
        reads.push(`${table}:${state.filters.join('&')}`);
        if (table === 'profiles') return { count: mocks.adminCount, data: null, error: null };
        if (table === 'affiliate_payouts') return { count: mocks.payouts, data: null, error: mocks.ledgerCountError };
        if (table === 'affiliate_commissions') {
          const live = state.filters.includes('status!=VOIDED_REFUND');
          return { count: live ? mocks.liveCommissions : mocks.voidedWithAmount, data: null, error: mocks.ledgerCountError };
        }
        return { count: 0, data: null, error: null };
      };
      const chain: any = {
        select(_columns: string, options?: { head?: boolean }) {
          state.head = options?.head;
          return chain;
        },
        update(values: unknown) {
          state.op = 'update';
          state.values = values;
          return chain;
        },
        eq(column: string, value: unknown) {
          state.filters.push(`${column}=${value}`);
          return chain;
        },
        neq(column: string, value: unknown) {
          state.filters.push(`${column}!=${value}`);
          return chain;
        },
        gt(column: string, value: unknown) {
          state.filters.push(`${column}>${value}`);
          return chain;
        },
        maybeSingle: async () => {
          reads.push(`${table}:${state.filters.join('&')}`);
          if (table === 'affiliate_profiles') return mocks.affiliateLookup;
          return { data: { role: mocks.currentRole }, error: null };
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return Promise.resolve(result()).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

vi.mock('../../../lib/auth/cms-actor', () => ({
  requireCmsAdmin: async () => {
    if (mocks.authorize) await mocks.authorize();
    return { supabase: serviceClient(), userId: ADMIN_ID };
  },
}));

vi.mock('@nextblock-cms/cortex', () => ({
  revokeCortexAiMcpTokensForUser: async (_client: unknown, userId: string) => {
    calls.push(`revokeMcpTokens:${userId}`);
    return { error: mocks.revokeError };
  },
}));

// Deleting a partner evicts the public storefront and tier caches (recorded in `calls` so the order
// against the delete itself is visible).
vi.mock('../../../lib/affiliates/cache', () => ({
  evictAffiliateStorefrontCache: (handle: string | null, context: string) => {
    mocks.evictStorefront(handle, context);
    calls.push(`evictStorefront:${handle}:${context}`);
  },
  evictAffiliateTiersCache: (context: string) => {
    mocks.evictTiers(context);
    calls.push(`evictTiers:${context}`);
  },
}));

vi.mock('@nextblock-cms/ecommerce', () => ({ normalizeCustomerAddress: (value: unknown) => value }));
vi.mock('@nextblock-cms/ecommerce/server', () => ({ upsertDefaultUserAddresses: mocks.upsertAddresses }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
// The real sandbox predicate (exactly 'true'), without the rest of the server barrel.
vi.mock('@nextblock-cms/db/server', async () => {
  const { isSandboxEnvironment } = await vi.importActual<typeof import('../../../../../libs/db/src/lib/config-resolve')>(
    '../../../../../libs/db/src/lib/config-resolve'
  );
  return { isSandboxEnvironment };
});

import { createUser, deleteUserAndProfile, updateUserProfile } from './actions';
import { USERS_LOCKED_IN_SANDBOX } from './sandbox-lock';

/** NEXT_PUBLIC_IS_SANDBOX values that are not the sandbox: only the exact string 'true' is. */
const OFF_SANDBOX = ['', 'false', 'TRUE', '1'] as const;

function profileForm(role: string | null, fields: Record<string, string> = {}) {
  const form = new FormData();
  if (role !== null) form.set('role', role);
  form.set('full_name', 'Former Admin');
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

function createForm(fields: Record<string, string> = {}) {
  const form = new FormData();
  const values = { email: 'New.Partner@Example.com', password: 'correct-horse-battery', full_name: 'New Partner', role: 'USER', ...fields };
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { url?: string }).url ?? '';
  }
  throw new Error('expected a redirect');
}

beforeEach(() => {
  calls.length = 0;
  reads.length = 0;
  mocks.authorize = null;
  mocks.currentRole = 'ADMIN';
  mocks.adminCount = 2;
  mocks.revokeError = null;
  mocks.createError = null;
  mocks.updateError = null;
  mocks.deleteError = null;
  mocks.affiliateLookup = { data: null, error: null };
  mocks.payouts = 0;
  mocks.liveCommissions = 0;
  mocks.voidedWithAmount = 0;
  mocks.ledgerCountError = null;
  mocks.evictStorefront.mockClear();
  mocks.evictTiers.mockClear();
  mocks.revalidatePath.mockClear();
  mocks.upsertAddresses.mockClear();
  mocks.redirect.mockClear();
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(OFF_SANDBOX)('off the sandbox (NEXT_PUBLIC_IS_SANDBOX=%j): unchanged', (value) => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
  });

  describe('authorization (requireCmsAdmin: session, ADMIN role, second factor)', () => {
    it.each([
      ['Unauthorized', 'Authentication required.'],
      ['Forbidden', 'Admin privileges required.'],
    ])('refuses on %s before touching anything', async (thrown, message) => {
      mocks.authorize = async () => {
        throw new Error(thrown);
      };

      await expect(createUser(createForm())).resolves.toEqual({ ok: false, error: message });
      await expect(updateUserProfile(USER_ID, profileForm('WRITER'))).resolves.toEqual({ ok: false, error: message });
      await expect(deleteUserAndProfile(USER_ID)).resolves.toEqual({ ok: false, error: message });
      expect(calls).toEqual([]);
      expect(reads).toEqual([]);
    });
  });

  describe('createUser', () => {
    it('creates a partner (RTL) account and applies the role untyped', async () => {
      const url = await redirectOf(createUser(createForm({ role: 'RTL' })));
      expect(url).toBe(`/cms/users/${NEW_USER_ID}/edit?success=User created successfully`);
      expect(calls).toEqual([
        'auth.createUser:new.partner@example.com',
        `profiles.update:{"role":"RTL","full_name":"New Partner"}:id=${NEW_USER_ID}`,
      ]);
    });

    it.each([
      [{ role: 'SUPERADMIN' }, 'Invalid role specified.'],
      [{ role: 'rtl' }, 'Invalid role specified.'],
      [{ email: 'not-an-email' }, 'Enter a valid email address.'],
      [{ email: `${'a'.repeat(250)}@x.io` }, 'Enter a valid email address.'],
      [{ password: 'short' }, 'Password must be at least 8 characters.'],
      [{ password: 'x'.repeat(73) }, 'Password must be at most 72 characters.'],
      [{ full_name: 'n'.repeat(201) }, 'Full name must be at most 200 characters.'],
    ])('refuses %j before calling the auth API', async (fields, message) => {
      await expect(createUser(createForm(fields))).resolves.toEqual({ ok: false, error: message });
      expect(calls).toEqual([]);
    });

    it('explains a duplicate email and never echoes an unknown auth error', async () => {
      mocks.createError = { code: 'email_exists', message: 'A user with this email address has already been registered' };
      await expect(createUser(createForm())).resolves.toEqual({ ok: false, error: 'An account with this email already exists.' });

      mocks.createError = { code: 'unexpected_failure', message: 'duplicate key value violates unique constraint "users_pkey"' };
      const result = await createUser(createForm());
      expect(result.ok).toBe(false);
      expect(result.error).not.toContain('users_pkey');
    });
  });

  describe('updateUserProfile', () => {
    it('accepts the partner role (RTL) and writes it untyped', async () => {
      mocks.currentRole = 'USER';
      await expect(updateUserProfile(USER_ID, profileForm('RTL'))).rejects.toThrow('NEXT_REDIRECT');
      expect(calls[0]).toBe(`revokeMcpTokens:${USER_ID}`);
      expect(calls[1]).toMatch(new RegExp(`^profiles\\.update:.*"role":"RTL".*:id=${USER_ID}$`));
    });

    it('refuses an unknown or missing role', async () => {
      await expect(updateUserProfile(USER_ID, profileForm('OWNER'))).resolves.toEqual({ ok: false, error: 'Invalid role specified.' });
      await expect(updateUserProfile(USER_ID, profileForm(null))).resolves.toEqual({ ok: false, error: 'Role is a required field.' });
      expect(calls).toEqual([]);
    });

    it('refuses a target that is not a user id', async () => {
      await expect(updateUserProfile('user-2', profileForm('WRITER'))).resolves.toEqual({ ok: false, error: 'Unknown user.' });
      await expect(updateUserProfile(`${USER_ID}' or 1=1`, profileForm('WRITER'))).resolves.toEqual({ ok: false, error: 'Unknown user.' });
    });

    it('refuses oversized fields', async () => {
      const result = await updateUserProfile(USER_ID, profileForm('USER', { website: `https://x.io/${'a'.repeat(3000)}` }));
      expect(result).toEqual({ ok: false, error: 'Website must be at most 2048 characters.' });
      expect(calls).toEqual([]);
    });

    it('keeps the last admin an admin', async () => {
      mocks.adminCount = 1;
      await expect(updateUserProfile(ADMIN_ID, profileForm('RTL'))).resolves.toEqual({
        ok: false,
        error: "Cannot remove the last admin's role.",
      });
      expect(calls).toEqual([]);
    });

    it('does not echo the database error of a failed update', async () => {
      mocks.updateError = { code: '23514', message: 'new row violates check constraint "profiles_role_check"' };
      const result = await updateUserProfile(USER_ID, profileForm('ADMIN'));
      expect(result.ok).toBe(false);
      expect(result.error).not.toContain('profiles_role_check');
    });
  });

  describe('MCP token revocation on role changes', () => {
    it('revokes the user’s tokens before changing their role', async () => {
      await expect(updateUserProfile(USER_ID, profileForm('WRITER'))).rejects.toThrow('NEXT_REDIRECT');

      expect(calls[0]).toBe(`revokeMcpTokens:${USER_ID}`);
      expect(calls[1]).toMatch(new RegExp(`^profiles\\.update:.*"role":"WRITER".*:id=${USER_ID}$`));
    });

    it('leaves tokens alone when the role does not change', async () => {
      await expect(updateUserProfile(USER_ID, profileForm('ADMIN'))).rejects.toThrow('NEXT_REDIRECT');

      expect(calls.some((call) => call.startsWith('revokeMcpTokens'))).toBe(false);
    });

    it('changes nothing when the revoke fails', async () => {
      mocks.revokeError = 'denied';

      await expect(updateUserProfile(USER_ID, profileForm('USER'))).resolves.toEqual({
        ok: false,
        error: expect.stringMatching(/MCP tokens could not be revoked/),
      });
      expect(calls).toEqual([`revokeMcpTokens:${USER_ID}`]);
    });
  });

  describe('MCP token revocation on delete', () => {
    it('revokes the user’s tokens before deleting the account', async () => {
      await expect(deleteUserAndProfile(USER_ID)).rejects.toThrow('NEXT_REDIRECT');

      expect(calls).toEqual([`revokeMcpTokens:${USER_ID}`, `auth.deleteUser:${USER_ID}`]);
    });

    it('keeps the account when the revoke fails', async () => {
      mocks.revokeError = 'denied';

      await expect(deleteUserAndProfile(USER_ID)).resolves.toEqual({
        ok: false,
        error: expect.stringMatching(/MCP tokens could not be revoked/),
      });
      expect(calls).toEqual([`revokeMcpTokens:${USER_ID}`]);
    });

    it('refuses to delete the caller and a malformed id', async () => {
      await expect(deleteUserAndProfile(ADMIN_ID)).resolves.toEqual({
        ok: false,
        error: 'Admins cannot delete their own account through this panel.',
      });
      await expect(deleteUserAndProfile('../etc')).resolves.toEqual({ ok: false, error: 'Unknown user.' });
      expect(calls).toEqual([]);
    });

    it('does not echo the auth error of a failed delete', async () => {
      mocks.deleteError = { message: 'Database error deleting user: update or delete violates foreign key' };
      const result = await deleteUserAndProfile(USER_ID);
      expect(result).toEqual({ ok: false, error: 'Failed to delete the user. Check the server logs for details.' });
    });
  });

  describe('partner ledger delete guard (ADDENDUM A24)', () => {
    const partner = () => {
      mocks.affiliateLookup = { data: { id: AFFILIATE_ID, handle: 'jane-doe' }, error: null };
    };

    it.each([
      ['a payout', () => { mocks.payouts = 1; }],
      ['a live commission', () => { mocks.liveCommissions = 2; }],
      ['a voided commission that carried money', () => { mocks.voidedWithAmount = 1; }],
    ])('refuses to delete a partner with %s, before any change', async (_label, arrange) => {
      partner();
      arrange();

      const result = await deleteUserAndProfile(USER_ID);
      // The Affiliates control is "Pause partner" (the CMS's word for a suspension).
      expect(result).toEqual({ ok: false, error: expect.stringContaining('Pause the partner in Affiliates instead') });
      expect(calls).toEqual([]);
    });

    it('deletes a partner whose only commissions are zero-amount refund tombstones', async () => {
      partner();
      await expect(deleteUserAndProfile(USER_ID)).rejects.toThrow('NEXT_REDIRECT');
      expect(calls).toEqual([
        `revokeMcpTokens:${USER_ID}`,
        `auth.deleteUser:${USER_ID}`,
        'evictStorefront:jane-doe:action',
        'evictTiers:action',
      ]);
      expect(reads).toEqual([
        `affiliate_profiles:user_id=${USER_ID}`,
        `affiliate_payouts:affiliate_id=${AFFILIATE_ID}`,
        `affiliate_commissions:affiliate_id=${AFFILIATE_ID}&status!=VOIDED_REFUND`,
        `affiliate_commissions:affiliate_id=${AFFILIATE_ID}&status=VOIDED_REFUND&commission_amount_cents>0`,
      ]);
    });

    it('deletes a user who is not a partner, and one on an install without the Affiliates schema', async () => {
      await expect(deleteUserAndProfile(USER_ID)).rejects.toThrow('NEXT_REDIRECT');
      expect(reads).toEqual([`affiliate_profiles:user_id=${USER_ID}`]);
      expect(calls).toEqual([`revokeMcpTokens:${USER_ID}`, `auth.deleteUser:${USER_ID}`]);

      calls.length = 0;
      mocks.affiliateLookup = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.affiliate_profiles' in the schema cache" } };
      await expect(deleteUserAndProfile(USER_ID)).rejects.toThrow('NEXT_REDIRECT');
      expect(calls).toEqual([`revokeMcpTokens:${USER_ID}`, `auth.deleteUser:${USER_ID}`]);
      // Nobody's storefront went away: the public caches stay warm.
      expect(mocks.evictStorefront).not.toHaveBeenCalled();
      expect(mocks.evictTiers).not.toHaveBeenCalled();
    });

    it('evicts the storefront and tier caches once a partner is deleted, and only then', async () => {
      // The storefront (unstable_cache, 5 min), the tier list (member count, founding spots) and the
      // sitemap would otherwise keep serving the deleted partner (review AE).
      partner();
      const url = await redirectOf(deleteUserAndProfile(USER_ID));
      expect(url).toBe('/cms/users?success=User deleted successfully');
      expect(mocks.evictStorefront).toHaveBeenCalledExactlyOnceWith('jane-doe', 'action');
      expect(mocks.evictTiers).toHaveBeenCalledExactlyOnceWith('action');
      expect(calls.indexOf('evictStorefront:jane-doe:action')).toBeGreaterThan(calls.indexOf(`auth.deleteUser:${USER_ID}`));

      // A failed delete, a failed MCP revoke or a blocked ledger keeps the partner, and the caches.
      for (const arrange of [
        () => { mocks.deleteError = { message: 'Database error deleting user' }; },
        () => { mocks.revokeError = 'denied'; },
        () => { mocks.payouts = 1; },
      ]) {
        mocks.evictStorefront.mockClear();
        mocks.evictTiers.mockClear();
        mocks.deleteError = null;
        mocks.revokeError = null;
        mocks.payouts = 0;
        arrange();
        await expect(deleteUserAndProfile(USER_ID)).resolves.toMatchObject({ ok: false });
        expect(mocks.evictStorefront).not.toHaveBeenCalled();
        expect(mocks.evictTiers).not.toHaveBeenCalled();
      }
    });

    it('fails closed when the partner records cannot be read', async () => {
      mocks.affiliateLookup = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
      await expect(deleteUserAndProfile(USER_ID)).resolves.toEqual({
        ok: false,
        error: expect.stringMatching(/Could not check this user's partner records/),
      });

      partner();
      mocks.ledgerCountError = { code: '57014', message: 'timeout' };
      await expect(deleteUserAndProfile(USER_ID)).resolves.toEqual({
        ok: false,
        error: expect.stringMatching(/Could not check this user's partner records/),
      });
      expect(calls).toEqual([]);
    });
  });
});

describe('the public sandbox (NEXT_PUBLIC_IS_SANDBOX=true): every account is shared', () => {
  // Step A of the 15-minute reset keeps exactly these two accounts by fixed id (the first is
  // demo@nextblock.dev): deleting either there is permanent. The demo partner is re-created on
  // every reset, and demoting it from RTL locks every visitor out of the portal.
  const DEMO_ADMIN_ID = '63a8aa07-ef6e-4cc7-bafa-ece023c74366';
  const OTHER_PRESERVED_ID = 'e3a2c121-70a4-4239-a9df-f70ce717f5a1';
  const LOCKED = {
    ok: false,
    error: "User accounts can't be created, changed or deleted in the sandbox: every visitor shares them.",
  };

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    // Whatever a later check would find (a partner with a storefront), nothing may be asked.
    mocks.affiliateLookup = { data: { id: AFFILIATE_ID, handle: 'studio-nova' }, error: null };
    mocks.currentRole = 'RTL';
  });

  /** Nothing that creates, changes, deletes, revokes, reads, revalidates or redirects ran. */
  function expectNothingTouched() {
    // auth.admin.createUser / deleteUser, every profiles update, every MCP token revoke and
    // cache eviction is recorded in `calls`; every profiles / ledger read in `reads`.
    expect(calls).toEqual([]);
    expect(reads).toEqual([]);
    expect(mocks.upsertAddresses).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.evictStorefront).not.toHaveBeenCalled();
    expect(mocks.evictTiers).not.toHaveBeenCalled();
  }

  it('shares its sentence with the UI note', () => {
    expect(USERS_LOCKED_IN_SANDBOX).toBe(LOCKED.error);
  });

  it.each([
    ['a USER account', () => createForm()],
    ['an ADMIN account', () => createForm({ role: 'ADMIN' })],
    ['a partner (RTL) account', () => createForm({ role: 'RTL' })],
    ['an account taken by an existing email', () => createForm({ email: 'demo@nextblock.dev' })],
    ['an invalid role, email and password', () => createForm({ role: 'SUPERADMIN', email: 'not-an-email', password: 'short' })],
    ['an empty form', () => new FormData()],
  ])('createUser refuses %s before parsing it or calling auth.admin.createUser', async (_label, form) => {
    await expect(createUser(form())).resolves.toEqual(LOCKED);
    expectNothingTouched();
  });

  it.each([
    ['demoting the demo partner from RTL to USER', USER_ID, () => profileForm('USER')],
    ['promoting the demo partner to ADMIN', USER_ID, () => profileForm('ADMIN')],
    ['demoting the demo admin', DEMO_ADMIN_ID, () => profileForm('WRITER')],
    ['demoting the caller', ADMIN_ID, () => profileForm('USER')],
    ['an invalid role', USER_ID, () => profileForm('OWNER')],
    ['a missing role', USER_ID, () => profileForm(null)],
    ['an oversized field', USER_ID, () => profileForm('USER', { website: `https://x.io/${'a'.repeat(3000)}` })],
    ['an address that is not JSON', USER_ID, () => profileForm('USER', { billing_address: '{not json' })],
    ['a target that is not a user id', `${USER_ID}' or 1=1`, () => profileForm('WRITER')],
  ])('updateUserProfile refuses %s before parsing it, reading the role or revoking MCP tokens', async (_label, target, form) => {
    await expect(updateUserProfile(target, form())).resolves.toEqual(LOCKED);
    expectNothingTouched();
  });

  it.each([
    ['the demo admin (a preserved fixed id)', DEMO_ADMIN_ID],
    ['the other preserved account (a fixed id)', OTHER_PRESERVED_ID],
    ['the demo partner (storefront and ledger)', USER_ID],
    ['the caller', ADMIN_ID],
    ['a target that is not a user id', '../etc'],
  ])('deleteUserAndProfile refuses %s before the ledger check, the MCP revoke or auth.admin.deleteUser', async (_label, target) => {
    await expect(deleteUserAndProfile(target)).resolves.toEqual(LOCKED);
    expectNothingTouched();
  });

  it.each([
    ['Unauthorized', 'Authentication required.'],
    ['Forbidden', 'Admin privileges required.'],
  ])('still answers a non-admin (%s) with the admin refusal, not the sandbox one', async (thrown, message) => {
    mocks.authorize = async () => {
      throw new Error(thrown);
    };

    await expect(createUser(createForm())).resolves.toEqual({ ok: false, error: message });
    await expect(updateUserProfile(USER_ID, profileForm('WRITER'))).resolves.toEqual({ ok: false, error: message });
    await expect(deleteUserAndProfile(USER_ID)).resolves.toEqual({ ok: false, error: message });
    expectNothingTouched();
  });
});
