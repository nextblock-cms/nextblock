import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-10-21: `validateCheckoutEligibility` is a server action that read the profile of
 * whatever `userId` the caller passed. It now reads the session user's profile and ignores
 * the argument (kept so existing callers compile).
 */

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  profiles: {} as Record<string, { full_name: string | null }>,
  profileReads: [] as string[],
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@nextblock-cms/db/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: () => ({
      select: () => ({
        eq: (_column: string, id: string) => ({
          single: async () => {
            state.profileReads.push(id);
            const profile = state.profiles[id];
            return profile ? { data: profile, error: null } : { data: null, error: { message: 'not found' } };
          },
        }),
      }),
    }),
  }),
}));

import { validateCheckoutEligibility } from './customer-actions';

beforeEach(() => {
  state.user = null;
  state.profiles = { 'admin-1': { full_name: 'Admin' }, 'customer-1': { full_name: '' } };
  state.profileReads = [];
});

describe('validateCheckoutEligibility', () => {
  it('refuses a signed-out caller that names another user, without reading any profile', async () => {
    await expect(validateCheckoutEligibility('admin-1')).resolves.toEqual({
      ready: false,
      missingFields: ['profile_not_found'],
    });
    expect(state.profileReads).toEqual([]);
  });

  it("checks the session user's profile, whatever id the caller passes", async () => {
    state.user = { id: 'customer-1' };

    await expect(validateCheckoutEligibility('admin-1')).resolves.toEqual({
      ready: false,
      missingFields: ['full_name'],
    });
    expect(state.profileReads).toEqual(['customer-1']);
  });
});
