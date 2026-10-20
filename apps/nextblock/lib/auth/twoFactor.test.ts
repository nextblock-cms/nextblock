import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbServerMocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getServiceRoleSupabaseClient: vi.fn(),
}));

vi.mock('@nextblock-cms/db/server', () => dbServerMocks);
vi.mock('./cookies', () => ({
  TWO_FACTOR_COOKIE: 'nb_2fa',
  clearCookie: vi.fn(),
  getCookieValue: vi.fn(),
  setSecureCookie: vi.fn(),
}));
vi.mock('./trustedDevices', () => ({ hasValidTrustedDevice: vi.fn() }));
vi.mock('../privacy/settings', () => ({ getSecuritySettings: vi.fn() }));
vi.mock('server-only', () => ({}));

import {
  createEmailChallenge,
  getEmailResendCooldownSeconds,
  hasPendingEmailChallenge,
  verifyEmailChallenge,
} from './twoFactor';

type ChallengeRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
  attempts?: number;
};

/**
 * Minimal in-memory stand-in for the `email_2fa_challenges` table, supporting exactly the
 * PostgREST chains twoFactor.ts builds. Rows get strictly increasing `created_at` values so
 * the "newest N codes" window is deterministic rather than clock-resolution dependent.
 */
function createFakeDb() {
  const rows: ChallengeRow[] = [];
  let sequence = 0;

  function makeQuery(kind: 'select' | 'update', patch?: Partial<ChallengeRow>) {
    const filters: Array<(row: ChallengeRow) => boolean> = [];
    let newestFirst = false;
    let max = Number.POSITIVE_INFINITY;

    const run = () => {
      let matched = rows.filter((row) => filters.every((keep) => keep(row)));
      if (newestFirst) {
        matched = [...matched].sort((a, b) => b.created_at.localeCompare(a.created_at));
      }
      matched = matched.slice(0, max);
      if (kind === 'update') {
        matched.forEach((row) => Object.assign(row, patch));
      }
      return { data: matched.map((row) => ({ ...row })), error: null };
    };

    const query = {
      eq(column: keyof ChallengeRow, value: unknown) {
        filters.push((row) => row[column] === value);
        return query;
      },
      is(column: keyof ChallengeRow, value: unknown) {
        filters.push((row) => row[column] === value);
        return query;
      },
      gt(column: keyof ChallengeRow, value: string) {
        filters.push((row) => String(row[column]) > value);
        return query;
      },
      order(_column: string, options?: { ascending?: boolean }) {
        newestFirst = options?.ascending === false;
        return query;
      },
      limit(count: number) {
        max = count;
        return query;
      },
      then<TResult>(
        onFulfilled: (value: ReturnType<typeof run>) => TResult,
        onRejected?: (reason: unknown) => TResult,
      ) {
        return Promise.resolve(run()).then(onFulfilled, onRejected);
      },
    };
    return query;
  }

  const client = {
    from(table: string) {
      if (table !== 'email_2fa_challenges') {
        throw new Error(`Unexpected table in test: ${table}`);
      }
      return {
        insert(values: Omit<ChallengeRow, 'id' | 'consumed_at' | 'created_at'>) {
          sequence += 1;
          rows.push({
            id: `row-${sequence}`,
            consumed_at: null,
            // Distinct, ordered timestamps regardless of how fast the test runs.
            created_at: new Date(Date.UTC(2026, 0, 1) + sequence).toISOString(),
            attempts: 0,
            ...values,
          });
          return Promise.resolve({ data: null, error: null });
        },
        select: () => makeQuery('select'),
        update: (patch: Partial<ChallengeRow>) => makeQuery('update', patch),
      };
    },
    // Mirrors public.bump_email_2fa_attempts(uuid): atomically increments attempts on every live
    // code for the user and returns the new maximum.
    rpc(fn: string, args: { p_user_id?: string }) {
      if (fn !== 'bump_email_2fa_attempts') {
        return Promise.resolve({ data: null, error: null });
      }
      const nowIso = new Date().toISOString();
      let max = 0;
      for (const row of rows) {
        if (row.user_id === args.p_user_id && row.consumed_at === null && row.expires_at > nowIso) {
          row.attempts = (row.attempts ?? 0) + 1;
          if (row.attempts > max) max = row.attempts;
        }
      }
      return Promise.resolve({ data: max, error: null });
    },
  };

  return { client, rows };
}

const USER = 'user-1';

describe('email 2FA challenges', () => {
  let db: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NB_2FA_SECRET = 'test-secret';
    db = createFakeDb();
    dbServerMocks.getServiceRoleSupabaseClient.mockReturnValue(db.client);
  });

  it('keeps an earlier code valid after a resend', async () => {
    // The regression: relays deliver out of order, so the code a user receives first is
    // often the one requested first. Issuing a new code must not kill it.
    const first = await createEmailChallenge(USER);
    const second = await createEmailChallenge(USER);
    expect(first).not.toBe(second);

    await expect(verifyEmailChallenge(USER, first)).resolves.toBe(true);
  });

  it('accepts the newest code too', async () => {
    await createEmailChallenge(USER);
    const second = await createEmailChallenge(USER);

    await expect(verifyEmailChallenge(USER, second)).resolves.toBe(true);
  });

  it('burns every live sibling once one code succeeds', async () => {
    const first = await createEmailChallenge(USER);
    const second = await createEmailChallenge(USER);

    await expect(verifyEmailChallenge(USER, first)).resolves.toBe(true);
    // The unused sibling must not stay redeemable after the factor is satisfied.
    await expect(verifyEmailChallenge(USER, second)).resolves.toBe(false);
  });

  it('drops the fourth-oldest code out of the usable window', async () => {
    const oldest = await createEmailChallenge(USER);
    await createEmailChallenge(USER);
    await createEmailChallenge(USER);
    await createEmailChallenge(USER);

    // Unreachable even though its row has not expired — the window caps the guess surface.
    await expect(verifyEmailChallenge(USER, oldest)).resolves.toBe(false);
  });

  it('burns the live pool after too many wrong guesses (brute-force lockout)', async () => {
    const code = await createEmailChallenge(USER);
    const wrong = code === '000000' ? '111111' : '000000';

    // Five wrong guesses exhaust the shared attempt budget and burn the pool.
    for (let i = 0; i < 5; i += 1) {
      await expect(verifyEmailChallenge(USER, wrong)).resolves.toBe(false);
    }

    // The correct code no longer verifies: the user must request a fresh one.
    await expect(verifyEmailChallenge(USER, code)).resolves.toBe(false);
  });

  it('keeps all three in-window codes usable', async () => {
    await createEmailChallenge(USER);
    const second = await createEmailChallenge(USER);
    await createEmailChallenge(USER);
    await createEmailChallenge(USER);

    // Second-oldest of four is the boundary of the three-code window.
    await expect(verifyEmailChallenge(USER, second)).resolves.toBe(true);
  });

  it('rejects expired codes', async () => {
    const code = await createEmailChallenge(USER);
    db.rows.forEach((row) => {
      row.expires_at = new Date(Date.now() - 1000).toISOString();
    });

    await expect(verifyEmailChallenge(USER, code)).resolves.toBe(false);
  });

  it('rejects malformed codes without touching the database', async () => {
    await createEmailChallenge(USER);
    const fromSpy = vi.spyOn(db.client, 'from');

    await expect(verifyEmailChallenge(USER, 'abc')).resolves.toBe(false);
    await expect(verifyEmailChallenge(USER, '12345')).resolves.toBe(false);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it('does not leak codes across users', async () => {
    const code = await createEmailChallenge(USER);

    await expect(verifyEmailChallenge('user-2', code)).resolves.toBe(false);
    await expect(verifyEmailChallenge(USER, code)).resolves.toBe(true);
  });

  describe('resend throttle', () => {
    /** The fake stamps rows at a fixed epoch; move the newest one to a chosen age. */
    const ageNewestBy = (ms: number) => {
      const newest = [...db.rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      newest.created_at = new Date(Date.now() - ms).toISOString();
    };

    it('allows the first send', async () => {
      await expect(getEmailResendCooldownSeconds(USER)).resolves.toBe(0);
    });

    it('blocks a send immediately after one', async () => {
      await createEmailChallenge(USER);
      ageNewestBy(0);

      const wait = await getEmailResendCooldownSeconds(USER);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(20);
    });

    it('allows another send once the window passes', async () => {
      await createEmailChallenge(USER);
      ageNewestBy(25_000);

      await expect(getEmailResendCooldownSeconds(USER)).resolves.toBe(0);
    });

    it('measures time since the last send, not the last live code', async () => {
      const code = await createEmailChallenge(USER);
      await verifyEmailChallenge(USER, code); // consumes it
      ageNewestBy(0);

      // A consumed row still represents an email that just went out.
      await expect(getEmailResendCooldownSeconds(USER)).resolves.toBeGreaterThan(0);
    });

    it('throttles per user', async () => {
      await createEmailChallenge(USER);
      ageNewestBy(0);

      await expect(getEmailResendCooldownSeconds('user-2')).resolves.toBe(0);
    });
  });

  it('reports a pending challenge only while one is live', async () => {
    await expect(hasPendingEmailChallenge(USER)).resolves.toBe(false);

    const code = await createEmailChallenge(USER);
    await expect(hasPendingEmailChallenge(USER)).resolves.toBe(true);

    await verifyEmailChallenge(USER, code);
    await expect(hasPendingEmailChallenge(USER)).resolves.toBe(false);
  });
});
