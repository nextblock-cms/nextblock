import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: vi.fn(),
}));

import {
  CORTEX_AI_ADMIN_HOURLY_REQUEST_CAP,
  CORTEX_AI_REQUEST_LOG_PRUNE_INTERVAL_MS,
  CORTEX_AI_REQUEST_LOG_RETENTION_MS,
  CORTEX_AI_REQUEST_QUOTA_WINDOW_MS,
  CORTEX_AI_WRITER_HOURLY_REQUEST_CAP,
  cortexAiQuotaDecisionToResponse,
  evaluateCortexAiRequestQuota,
  resolveCortexAiHourlyRequestCap,
  type CortexRequestLogClient,
} from './request-quota';

type FakeOptions = {
  /** Rows (created_at ISO, oldest first) the fake reports inside the window AFTER the insert. */
  windowRows?: string[];
  countError?: { message: string } | null;
  insertError?: { message: string } | null;
  rangeError?: { message: string } | null;
};

function thenable<T>(value: T): PromiseLike<T> {
  return { then: (onFulfilled) => Promise.resolve(value).then(onFulfilled) };
}

/**
 * A minimal stand-in for the Supabase builder chain the module uses. Records every call so
 * a test can assert what was written, counted and pruned.
 */
function createFakeClient(options: FakeOptions = {}) {
  const calls = {
    deletes: [] as string[],
    inserts: [] as Array<{ route: string; user_id: string }>,
    ranges: [] as Array<[number, number]>,
    selects: [] as Array<{ count?: 'exact'; head?: boolean } | undefined>,
  };
  const rows = options.windowRows ?? [];

  const client: CortexRequestLogClient = {
    from: () => ({
      delete: () => ({
        lt: (_column, value) => {
          calls.deletes.push(value);
          return thenable({ error: null });
        },
      }),
      insert: (row) => {
        calls.inserts.push(row);
        return thenable({ error: options.insertError ?? null });
      },
      select: (_columns, selectOptions) => {
        calls.selects.push(selectOptions);

        return {
          eq: () => ({
            gte: () => {
              const countResult = thenable({
                count: options.countError ? null : rows.length,
                error: options.countError ?? null,
              });

              return Object.assign(countResult, {
                order: () => ({
                  range: (from: number, to: number) => {
                    calls.ranges.push([from, to]);
                    return thenable({
                      data: options.rangeError
                        ? null
                        : rows.slice(from, to + 1).map((created_at) => ({ created_at })),
                      error: options.rangeError ?? null,
                    });
                  },
                }),
              });
            },
          }),
        };
      },
    }),
  };

  return { calls, client };
}

const NOW = new Date('2026-10-19T12:00:00.000Z');
const USER = '33333333-3333-3333-3333-333333333333';

/** `count` rows spread evenly over the last 50 minutes, oldest first. */
function rowsInWindow(count: number) {
  const span = 50 * 60 * 1000;
  return Array.from({ length: count }, (_, index) =>
    new Date(NOW.getTime() - span + Math.floor((span * index) / Math.max(1, count - 1))).toISOString()
  );
}

describe('resolveCortexAiHourlyRequestCap', () => {
  it('gives ADMIN the admin cap and everyone else the writer cap', () => {
    expect(resolveCortexAiHourlyRequestCap('ADMIN')).toBe(CORTEX_AI_ADMIN_HOURLY_REQUEST_CAP);
    expect(resolveCortexAiHourlyRequestCap('WRITER')).toBe(CORTEX_AI_WRITER_HOURLY_REQUEST_CAP);
    expect(resolveCortexAiHourlyRequestCap('USER')).toBe(CORTEX_AI_WRITER_HOURLY_REQUEST_CAP);
    expect(resolveCortexAiHourlyRequestCap(null)).toBe(CORTEX_AI_WRITER_HOURLY_REQUEST_CAP);
    expect(CORTEX_AI_WRITER_HOURLY_REQUEST_CAP).toBe(60);
    expect(CORTEX_AI_ADMIN_HOURLY_REQUEST_CAP).toBe(300);
  });
});

describe('evaluateCortexAiRequestQuota', () => {
  let pruneState: { lastPrunedAt: number };

  beforeEach(() => {
    pruneState = { lastPrunedAt: NOW.getTime() };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('records one row for the request and admits a WRITER under the cap', async () => {
    const fake = createFakeClient({ windowRows: rowsInWindow(10) });

    const decision = await evaluateCortexAiRequestQuota({
      client: fake.client,
      now: NOW,
      pruneState,
      role: 'WRITER',
      route: 'ai/generate-blocks',
      userId: USER,
    });

    expect(decision).toEqual({ allowed: true, limit: 60, used: 10 });
    expect(fake.calls.inserts).toEqual([{ route: 'ai/generate-blocks', user_id: USER }]);
    // The count is a head request (no rows transferred) over the window.
    expect(fake.calls.selects[0]).toEqual({ count: 'exact', head: true });
  });

  it('admits exactly the cap and refuses the request after it', async () => {
    const atCap = await evaluateCortexAiRequestQuota({
      client: createFakeClient({ windowRows: rowsInWindow(60) }).client,
      now: NOW,
      pruneState,
      role: 'WRITER',
      route: 'ai/seo/metadata',
      userId: USER,
    });
    expect(atCap.allowed).toBe(true);

    const fake = createFakeClient({ windowRows: rowsInWindow(61) });
    const overCap = await evaluateCortexAiRequestQuota({
      client: fake.client,
      now: NOW,
      pruneState,
      role: 'WRITER',
      route: 'ai/seo/metadata',
      userId: USER,
    });

    expect(overCap).toMatchObject({ allowed: false, limit: 60, reason: 'exceeded', used: 61 });
    // The row that must age out is index count - limit = 1 (the second oldest).
    expect(fake.calls.ranges).toEqual([[1, 1]]);
    if (overCap.allowed || overCap.reason !== 'exceeded') throw new Error('expected exceeded');
    const freesAt = Date.parse(fake.calls.deletes[0] ?? '') || 0;
    expect(freesAt).toBe(0); // no prune ran (state says it just ran)
    const expected = Math.ceil(
      (Date.parse(rowsInWindow(61)[1]) + CORTEX_AI_REQUEST_QUOTA_WINDOW_MS - NOW.getTime()) / 1000
    );
    expect(overCap.retryAfterSeconds).toBe(expected);
    expect(overCap.retryAfterSeconds).toBeGreaterThan(0);
    expect(overCap.retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it('gives an ADMIN the larger cap', async () => {
    const under = await evaluateCortexAiRequestQuota({
      client: createFakeClient({ windowRows: rowsInWindow(200) }).client,
      now: NOW,
      pruneState,
      role: 'ADMIN',
      route: 'ai/global-agent',
      userId: USER,
    });
    expect(under).toEqual({ allowed: true, limit: 300, used: 200 });

    const over = await evaluateCortexAiRequestQuota({
      client: createFakeClient({ windowRows: rowsInWindow(301) }).client,
      now: NOW,
      pruneState,
      role: 'ADMIN',
      route: 'ai/global-agent',
      userId: USER,
    });
    expect(over).toMatchObject({ allowed: false, limit: 300, reason: 'exceeded', used: 301 });
  });

  it('falls back to the whole window when the retry lookup fails', async () => {
    const decision = await evaluateCortexAiRequestQuota({
      client: createFakeClient({ rangeError: { message: 'boom' }, windowRows: rowsInWindow(70) })
        .client,
      now: NOW,
      pruneState,
      role: 'WRITER',
      route: 'ai/seo/alt-text',
      userId: USER,
    });

    expect(decision).toMatchObject({ allowed: false, reason: 'exceeded', retryAfterSeconds: 3600 });
  });

  it('fails closed when the row cannot be written or counted', async () => {
    const insertFailed = await evaluateCortexAiRequestQuota({
      client: createFakeClient({ insertError: { message: 'relation does not exist' } }).client,
      now: NOW,
      pruneState,
      role: 'WRITER',
      route: 'ai/cortex/build-widget',
      userId: USER,
    });
    expect(insertFailed).toEqual({ allowed: false, reason: 'unavailable' });

    const countFailed = await evaluateCortexAiRequestQuota({
      client: createFakeClient({ countError: { message: 'timeout' } }).client,
      now: NOW,
      pruneState,
      role: 'WRITER',
      route: 'ai/cortex/build-widget',
      userId: USER,
    });
    expect(countFailed).toEqual({ allowed: false, reason: 'unavailable' });

    const threw = await evaluateCortexAiRequestQuota({
      client: { from: () => { throw new Error('offline'); } } as unknown as CortexRequestLogClient,
      now: NOW,
      pruneState,
      role: 'WRITER',
      route: 'ai/cortex/build-widget',
      userId: USER,
    });
    expect(threw).toEqual({ allowed: false, reason: 'unavailable' });
  });

  it('prunes rows older than the retention window, at most once per interval', async () => {
    const fake = createFakeClient({ windowRows: rowsInWindow(1) });
    const state = { lastPrunedAt: 0 };
    const run = (now: Date) =>
      evaluateCortexAiRequestQuota({
        client: fake.client,
        now,
        pruneState: state,
        role: 'WRITER',
        route: 'ai/generate-blocks',
        userId: USER,
      });

    await run(NOW);
    await Promise.resolve();
    expect(fake.calls.deletes).toEqual([
      new Date(NOW.getTime() - CORTEX_AI_REQUEST_LOG_RETENTION_MS).toISOString(),
    ]);

    // Inside the interval: no second prune.
    await run(new Date(NOW.getTime() + CORTEX_AI_REQUEST_LOG_PRUNE_INTERVAL_MS - 1));
    await Promise.resolve();
    expect(fake.calls.deletes).toHaveLength(1);

    // Past the interval: prunes again.
    await run(new Date(NOW.getTime() + CORTEX_AI_REQUEST_LOG_PRUNE_INTERVAL_MS));
    await Promise.resolve();
    expect(fake.calls.deletes).toHaveLength(2);
  });
});

describe('cortexAiQuotaDecisionToResponse', () => {
  it('lets an allowed decision through', () => {
    expect(cortexAiQuotaDecisionToResponse({ allowed: true, limit: 60, used: 1 })).toBeNull();
  });

  it('answers 429 with Retry-After when the cap is exceeded', async () => {
    const response = cortexAiQuotaDecisionToResponse({
      allowed: false,
      limit: 60,
      reason: 'exceeded',
      retryAfterSeconds: 125,
      used: 61,
    });

    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('125');
    expect(response?.headers.get('X-RateLimit-Limit')).toBe('60');
    const body = await response?.json();
    expect(body.error).toMatch(/60 requests per hour/);
    expect(body.error).toMatch(/about 3 minutes/);
    expect(body.retryAfterSeconds).toBe(125);
  });

  it('answers 503 when accounting is unavailable (fail closed)', async () => {
    const response = cortexAiQuotaDecisionToResponse({ allowed: false, reason: 'unavailable' });

    expect(response?.status).toBe(503);
    expect(response?.headers.get('Retry-After')).toBe('5');
    const body = await response?.json();
    expect(body.error).toMatch(/temporarily unavailable/);
  });
});
