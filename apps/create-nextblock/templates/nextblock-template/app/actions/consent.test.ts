import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `logConsentDecision` is an unauthenticated server action that inserts with the
 * service-role client, so these tests pin its only two defences: the payload must be
 * exactly a banner decision, and a single source cannot flood the compliance log.
 */

const mocks = vi.hoisted(() => ({
  requestHeaders: {} as Record<string, string>,
  throttleCount: vi.fn(),
  throttleIs: vi.fn(),
  throttleEq: vi.fn(),
  insert: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => mocks.requestHeaders[name.toLowerCase()] ?? null,
  }),
}));

vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: () => ({
    from: (table: string) => {
      if (table !== 'privacy_consent_logs') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          gte: () => ({
            is: (column: string, value: unknown) => {
              mocks.throttleIs(column, value);
              return mocks.throttleCount();
            },
            eq: (column: string, value: unknown) => {
              mocks.throttleEq(column, value);
              return mocks.throttleCount();
            },
          }),
        }),
        insert: mocks.insert,
      };
    },
  }),
}));

import { logConsentDecision } from './consent';

const VALID_TOKEN = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

describe('logConsentDecision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.requestHeaders = { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'vitest' };
    mocks.throttleCount.mockResolvedValue({ count: 0 });
    mocks.insert.mockResolvedValue({ error: null });
  });

  it('records a well-formed decision with a masked address and coerced categories', async () => {
    const result = await logConsentDecision({ token: VALID_TOKEN, analytics: true, marketing: false });

    expect(result).toEqual({ ok: true });
    expect(mocks.throttleEq).toHaveBeenCalledWith('ip_masked', '203.0.113.x');
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insert).toHaveBeenCalledWith({
      consent_token: VALID_TOKEN,
      categories: { necessary: true, analytics: true, marketing: false },
      ip_masked: '203.0.113.x',
      user_agent: 'vitest',
    });
  });

  it.each([
    [{ token: 'x', analytics: true, marketing: true }, 'token too short'],
    [{ token: 'a'.repeat(65), analytics: true, marketing: true }, 'token too long'],
    [{ token: "tok'); drop table--", analytics: true, marketing: true }, 'token outside the alphabet'],
    [{ token: VALID_TOKEN, analytics: 'yes', marketing: true }, 'non-boolean analytics'],
    [{ token: VALID_TOKEN, analytics: true, marketing: 1 }, 'non-boolean marketing'],
    [{ token: VALID_TOKEN, analytics: true }, 'missing marketing'],
    [null, 'null payload'],
    ['string', 'string payload'],
  ])('rejects %j (%s) without touching the database', async (payload) => {
    const result = await logConsentDecision(payload as never);

    expect(result).toEqual({ ok: false });
    expect(mocks.throttleCount).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('ignores extra keys and never lets the caller override necessary', async () => {
    await logConsentDecision({
      token: VALID_TOKEN,
      analytics: false,
      marketing: false,
      necessary: false,
      ip_masked: '1.2.3.4',
    } as never);

    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        categories: { necessary: true, analytics: false, marketing: false },
        ip_masked: '203.0.113.x',
      })
    );
  });

  it('stops inserting once a source hits the window cap', async () => {
    mocks.throttleCount.mockResolvedValue({ count: 20 });

    const result = await logConsentDecision({ token: VALID_TOKEN, analytics: true, marketing: true });

    expect(result).toEqual({ ok: false });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('throttles requests with no readable address together in the null bucket', async () => {
    mocks.requestHeaders = {};
    mocks.throttleCount.mockResolvedValue({ count: 20 });

    const result = await logConsentDecision({ token: VALID_TOKEN, analytics: true, marketing: true });

    expect(mocks.throttleIs).toHaveBeenCalledWith('ip_masked', null);
    expect(mocks.throttleEq).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('prefers the proxy-set address over a client-prependable x-forwarded-for', async () => {
    mocks.requestHeaders = {
      'x-forwarded-for': '10.0.0.1, 203.0.113.7',
      'x-real-ip': '198.51.100.9',
    };

    await logConsentDecision({ token: VALID_TOKEN, analytics: true, marketing: true });

    expect(mocks.throttleEq).toHaveBeenCalledWith('ip_masked', '198.51.100.x');
  });

  it('treats a replayed token as already recorded', async () => {
    mocks.insert.mockResolvedValue({ error: { code: '23505', message: 'duplicate key' } });

    const result = await logConsentDecision({ token: VALID_TOKEN, analytics: true, marketing: true });

    expect(result).toEqual({ ok: true });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reports any other insert failure as not recorded', async () => {
    mocks.insert.mockResolvedValue({ error: { code: '42501', message: 'rls' } });

    const result = await logConsentDecision({ token: VALID_TOKEN, analytics: true, marketing: true });

    expect(result).toEqual({ ok: false });
  });
});
