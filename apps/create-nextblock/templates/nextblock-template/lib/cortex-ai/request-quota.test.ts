import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: vi.fn(),
}));

import {
  CORTEX_AI_ADMIN_HOURLY_REQUEST_CAP,
  CORTEX_AI_REQUEST_LOG_PRUNE_INTERVAL_MS,
  CORTEX_AI_REQUEST_LOG_RETENTION_MS,
  CORTEX_AI_REQUEST_QUOTA_WINDOW_MS,
  CORTEX_AI_RETAILER_COPILOT_GLOBAL_HOURLY_REQUEST_CAP,
  CORTEX_AI_RETAILER_COPILOT_ROUTE,
  CORTEX_AI_RETAILER_HOURLY_REQUEST_CAP,
  CORTEX_AI_WRITER_HOURLY_REQUEST_CAP,
  cortexAiQuotaDecisionToResponse,
  enforceRetailerCopilotRequestQuotas,
  evaluateCortexAiRequestQuota,
  evaluateRetailerCopilotGlobalQuota,
  resolveCortexAiHourlyRequestCap,
  retailerCopilotGlobalQuotaDecisionToResponse,
  type CortexRequestLogClient,
  type RetailerCopilotRequestLogClient,
} from './request-quota';

type FakeOptions = {
  /** Rows (created_at ISO, oldest first) the fake reports inside the window AFTER the insert. */
  windowRows?: string[];
  countError?: { message: string } | null;
  insertError?: { message: string } | null;
  rangeError?: { message: string } | null;
  /** Error of `delete().eq('id', …)`, the refused-row take-back. */
  deleteError?: { message: string } | null;
  /** `insert().select('id').single()` answers no row. */
  noInsertedId?: boolean;
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
    deletedIds: [] as string[],
    inserts: [] as Array<{ route: string; user_id: string }>,
    insertSelects: 0,
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
        eq: (_column, value) => {
          calls.deletedIds.push(value);
          return thenable({ error: options.deleteError ?? null });
        },
      }),
      insert: (row) => {
        calls.inserts.push(row);
        return Object.assign(thenable({ error: options.insertError ?? null }), {
          select: () => ({
            single: () => {
              calls.insertSelects += 1;
              return thenable({
                data: options.insertError || options.noInsertedId ? null : { id: 'log-row-1' },
                error: options.insertError ?? null,
              });
            },
          }),
        });
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

  it('gives a partner (RTL) the explicit, smallest cap, matched exactly', () => {
    expect(resolveCortexAiHourlyRequestCap('RTL')).toBe(CORTEX_AI_RETAILER_HOURLY_REQUEST_CAP);
    expect(CORTEX_AI_RETAILER_HOURLY_REQUEST_CAP).toBe(30);
    expect(resolveCortexAiHourlyRequestCap('rtl')).toBe(CORTEX_AI_WRITER_HOURLY_REQUEST_CAP);
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
    expect(body.code).toBe('quota_unavailable');
  });

  it('tags the per-user 429 so a client can localize it', async () => {
    const response = cortexAiQuotaDecisionToResponse({
      allowed: false,
      limit: 30,
      reason: 'exceeded',
      retryAfterSeconds: 60,
      used: 31,
    });
    if (!response) throw new Error('expected a 429 response');
    expect((await response.json()).code).toBe('rate_limited');
  });
});

describe('partner copilot per-user cap (route affiliates/cortex)', () => {
  let pruneState: { lastPrunedAt: number };

  beforeEach(() => {
    pruneState = { lastPrunedAt: NOW.getTime() };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  const run = (fake: ReturnType<typeof createFakeClient>, role = 'RTL') =>
    evaluateCortexAiRequestQuota({
      client: fake.client,
      now: NOW,
      pruneState,
      role,
      route: CORTEX_AI_RETAILER_COPILOT_ROUTE,
      userId: USER,
    });

  it('admits a partner under 30 per hour and keeps the row, handing back its id', async () => {
    const fake = createFakeClient({ windowRows: rowsInWindow(30) });
    // The id lets the shared cap, or the route, take the request back out later.
    expect(await run(fake)).toEqual({ allowed: true, limit: 30, used: 30, rowId: 'log-row-1' });
    expect(fake.calls.inserts).toEqual([{ route: 'affiliates/cortex', user_id: USER }]);
    expect(fake.calls.insertSelects).toBe(1);
    expect(fake.calls.deletedIds).toEqual([]);
  });

  it('refuses the 31st request and takes its row back out of the log', async () => {
    const rows = rowsInWindow(31);
    const fake = createFakeClient({ windowRows: rows });
    const decision = await run(fake);

    expect(decision).toMatchObject({ allowed: false, limit: 30, reason: 'exceeded', used: 31 });
    expect(fake.calls.deletedIds).toEqual(['log-row-1']);
    // With the refused row gone, 30 rows remain: the oldest (index 0) must age out.
    expect(fake.calls.ranges).toEqual([[0, 0]]);
    if (decision.allowed || decision.reason !== 'exceeded') throw new Error('expected exceeded');
    expect(decision.retryAfterSeconds).toBe(
      Math.ceil((Date.parse(rows[0]) + CORTEX_AI_REQUEST_QUOTA_WINDOW_MS - NOW.getTime()) / 1000)
    );
  });

  it('still refuses (and keeps counting the row) when the take-back fails', async () => {
    const fake = createFakeClient({ windowRows: rowsInWindow(31), deleteError: { message: 'permission denied' } });
    expect(await run(fake)).toMatchObject({ allowed: false, reason: 'exceeded' });
    expect(fake.calls.ranges).toEqual([[1, 1]]);
  });

  it('fails closed when the inserted row id does not come back', async () => {
    const fake = createFakeClient({ windowRows: rowsInWindow(1), noInsertedId: true });
    expect(await run(fake)).toEqual({ allowed: false, reason: 'unavailable' });
  });

  it('takes its row back out when it fails closed on the count, so the refusal never counts', async () => {
    const fake = createFakeClient({ windowRows: rowsInWindow(1), countError: { message: 'timeout' } });
    expect(await run(fake)).toEqual({ allowed: false, reason: 'unavailable' });
    expect(fake.calls.deletedIds).toEqual(['log-row-1']);

    // Every other route keeps the row, as before.
    const other = createFakeClient({ windowRows: rowsInWindow(1), countError: { message: 'timeout' } });
    expect(
      await evaluateCortexAiRequestQuota({
        client: other.client,
        now: NOW,
        pruneState,
        role: 'WRITER',
        route: 'ai/generate-blocks',
        userId: USER,
      })
    ).toEqual({ allowed: false, reason: 'unavailable' });
    expect(other.calls.deletedIds).toEqual([]);
  });

  it('keeps refused requests counting on every other route', async () => {
    const fake = createFakeClient({ windowRows: rowsInWindow(61) });
    const decision = await evaluateCortexAiRequestQuota({
      client: fake.client,
      now: NOW,
      pruneState,
      role: 'WRITER',
      route: 'ai/generate-blocks',
      userId: USER,
    });
    expect(decision).toMatchObject({ allowed: false, reason: 'exceeded' });
    expect(fake.calls.insertSelects).toBe(0);
    expect(fake.calls.deletedIds).toEqual([]);
  });
});

type GlobalFakeOptions = {
  windowRows?: string[];
  countError?: { message: string } | null;
  rangeError?: { message: string } | null;
  /** Error of `delete().eq('id', …)`, the refused-row take-back. */
  deleteError?: { message: string } | null;
  throwOnFrom?: boolean;
};

function createGlobalFake(options: GlobalFakeOptions = {}) {
  const calls = {
    deletedIds: [] as string[],
    routes: [] as string[],
    ranges: [] as Array<[number, number]>,
    windowStarts: [] as string[],
  };
  const rows = options.windowRows ?? [];

  const client: RetailerCopilotRequestLogClient = {
    from: () => {
      if (options.throwOnFrom) throw new Error('offline');
      return {
        delete: () => ({
          eq: (_column, value) => {
            calls.deletedIds.push(value);
            return thenable({ error: options.deleteError ?? null });
          },
        }),
        select: () => ({
          eq: (_column, value) => {
            calls.routes.push(value);
            return {
              gte: (_gteColumn, start) => {
                calls.windowStarts.push(start);
                return Object.assign(
                  thenable({ count: options.countError ? null : rows.length, error: options.countError ?? null }),
                  {
                    order: () => ({
                      range: (from: number, to: number) => {
                        calls.ranges.push([from, to]);
                        return thenable({
                          data: options.rangeError ? null : rows.slice(from, to + 1).map((created_at) => ({ created_at })),
                          error: options.rangeError ?? null,
                        });
                      },
                    }),
                  }
                );
              },
            };
          },
        }),
      };
    },
  };

  return { calls, client };
}

describe('partner copilot cap shared by every account', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('counts every account’s affiliates/cortex rows of the last hour', async () => {
    const fake = createGlobalFake({ windowRows: rowsInWindow(599) });
    expect(await evaluateRetailerCopilotGlobalQuota({ client: fake.client, now: NOW })).toEqual({
      allowed: true,
      limit: 600,
      used: 599,
    });
    expect(CORTEX_AI_RETAILER_COPILOT_GLOBAL_HOURLY_REQUEST_CAP).toBe(600);
    expect(fake.calls.routes).toEqual(['affiliates/cortex']);
    expect(fake.calls.windowStarts).toEqual([new Date(NOW.getTime() - CORTEX_AI_REQUEST_QUOTA_WINDOW_MS).toISOString()]);
  });

  it('refuses once 600 are logged, with the time until room frees up', async () => {
    const rows = rowsInWindow(600);
    const fake = createGlobalFake({ windowRows: rows });
    const decision = await evaluateRetailerCopilotGlobalQuota({ client: fake.client, now: NOW });

    expect(decision).toMatchObject({ allowed: false, limit: 600, reason: 'exceeded', used: 600 });
    // Without this request's row id, 600 rows stay; the next one fits once two have aged out.
    expect(fake.calls.ranges).toEqual([[1, 1]]);
    expect(fake.calls.deletedIds).toEqual([]);
    if (decision.allowed || decision.reason !== 'exceeded') throw new Error('expected exceeded');
    expect(decision.retryAfterSeconds).toBe(
      Math.ceil((Date.parse(rows[1]) + CORTEX_AI_REQUEST_QUOTA_WINDOW_MS - NOW.getTime()) / 1000)
    );
  });

  it('takes a refused request back out of the shared window, then waits for the oldest row', async () => {
    const rows = rowsInWindow(600);
    const fake = createGlobalFake({ windowRows: rows });
    const decision = await evaluateRetailerCopilotGlobalQuota({ client: fake.client, now: NOW, requestRowId: 'log-row-1' });

    expect(decision).toMatchObject({ allowed: false, limit: 600, reason: 'exceeded', used: 600 });
    expect(fake.calls.deletedIds).toEqual(['log-row-1']);
    // 599 rows remain: the next request fits once the oldest (index 0) has aged out.
    expect(fake.calls.ranges).toEqual([[0, 0]]);
    if (decision.allowed || decision.reason !== 'exceeded') throw new Error('expected exceeded');
    expect(decision.retryAfterSeconds).toBe(
      Math.ceil((Date.parse(rows[0]) + CORTEX_AI_REQUEST_QUOTA_WINDOW_MS - NOW.getTime()) / 1000)
    );

    // When the take-back fails, the row keeps counting and the wait accounts for it.
    const stuck = createGlobalFake({ windowRows: rows, deleteError: { message: 'permission denied' } });
    expect(
      await evaluateRetailerCopilotGlobalQuota({ client: stuck.client, now: NOW, requestRowId: 'log-row-1' })
    ).toMatchObject({ allowed: false, reason: 'exceeded' });
    expect(stuck.calls.ranges).toEqual([[1, 1]]);
  });

  it('keeps an admitted request logged, and forgets one it could not count', async () => {
    const fake = createGlobalFake({ windowRows: rowsInWindow(10) });
    expect(
      await evaluateRetailerCopilotGlobalQuota({ client: fake.client, now: NOW, requestRowId: 'log-row-1' })
    ).toEqual({ allowed: true, limit: 600, used: 10 });
    expect(fake.calls.deletedIds).toEqual([]);

    const down = createGlobalFake({ countError: { message: 'timeout' } });
    expect(
      await evaluateRetailerCopilotGlobalQuota({ client: down.client, now: NOW, requestRowId: 'log-row-1' })
    ).toEqual({ allowed: false, reason: 'unavailable' });
    expect(down.calls.deletedIds).toEqual(['log-row-1']);
  });

  it('falls back to the whole window when the retry lookup fails', async () => {
    const fake = createGlobalFake({ windowRows: rowsInWindow(700), rangeError: { message: 'boom' } });
    expect(await evaluateRetailerCopilotGlobalQuota({ client: fake.client, now: NOW })).toMatchObject({
      allowed: false,
      reason: 'exceeded',
      retryAfterSeconds: 3600,
    });
  });

  it('fails closed when the count cannot be read', async () => {
    expect(
      await evaluateRetailerCopilotGlobalQuota({ client: createGlobalFake({ countError: { message: 'timeout' } }).client, now: NOW })
    ).toEqual({ allowed: false, reason: 'unavailable' });
    expect(
      await evaluateRetailerCopilotGlobalQuota({ client: createGlobalFake({ throwOnFrom: true }).client, now: NOW })
    ).toEqual({ allowed: false, reason: 'unavailable' });
  });

  it('answers 429 with Retry-After, or 503 when accounting is down', async () => {
    const busy = retailerCopilotGlobalQuotaDecisionToResponse({
      allowed: false,
      limit: 600,
      reason: 'exceeded',
      retryAfterSeconds: 90,
      used: 600,
    });
    expect(busy?.status).toBe(429);
    expect(busy?.headers.get('Retry-After')).toBe('90');
    const body = await busy?.json();
    expect(body).toMatchObject({ code: 'retailer_copilot_busy', retryAfterSeconds: 90 });
    expect(body.error).toMatch(/about 2 minutes/);

    const down = retailerCopilotGlobalQuotaDecisionToResponse({ allowed: false, reason: 'unavailable' });
    expect(down?.status).toBe(503);
    expect(down?.headers.get('Retry-After')).toBe('5');

    expect(retailerCopilotGlobalQuotaDecisionToResponse({ allowed: true, limit: 600, used: 3 })).toBeNull();
  });

});

type LoggedRow = { id: string; route: string; user_id: string; created_at: string };

/**
 * An in-memory `cortex_request_log` that keeps its rows across calls: insert (with an id), count
 * and oldest-first range filtered by `user_id` or `route` and `created_at`, delete by id or by age.
 * `clock.now` stamps new rows.
 */
function createStatefulLog(clock: { now: number }) {
  const rows: LoggedRow[] = [];
  const deletedIds: string[] = [];
  let sequence = 0;
  const inWindow = (column: string, value: string, start: string) =>
    rows
      .filter((row) => row[column as 'route' | 'user_id'] === value && row.created_at >= start)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  const client = {
    from: () => ({
      insert: (row: { route: string; user_id: string }) => {
        sequence += 1;
        const stored: LoggedRow = { ...row, id: `row-${sequence}`, created_at: new Date(clock.now).toISOString() };
        rows.push(stored);
        return Object.assign(thenable({ error: null }), {
          select: () => ({ single: () => thenable({ data: { id: stored.id }, error: null }) }),
        });
      },
      select: () => ({
        eq: (column: string, value: string) => ({
          gte: (_column: string, start: string) =>
            Object.assign(thenable({ count: inWindow(column, value, start).length, error: null }), {
              order: () => ({
                range: (from: number, to: number) =>
                  thenable({
                    data: inWindow(column, value, start)
                      .slice(from, to + 1)
                      .map(({ created_at }) => ({ created_at })),
                    error: null,
                  }),
              }),
            }),
        }),
      }),
      delete: () => ({
        eq: (_column: string, id: string) => {
          deletedIds.push(id);
          const index = rows.findIndex((row) => row.id === id);
          if (index >= 0) rows.splice(index, 1);
          return thenable({ error: null });
        },
        lt: (_column: string, cutoff: string) => {
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            if ((rows[index]?.created_at ?? '') < cutoff) rows.splice(index, 1);
          }
          return thenable({ error: null });
        },
      }),
    }),
  };

  return { rows, deletedIds, client: client as unknown as CortexRequestLogClient & RetailerCopilotRequestLogClient };
}

describe('partner copilot caps under sustained demand', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('keeps admitting about 600 an hour while demand stays above the shared cap', async () => {
    // 60 partners x 15 requests an hour (900/h, each well inside their own 30), for three hours,
    // through both real caps over one log. Refused attempts used to stay logged, so the shared
    // window never drained: 599 admitted in the first hour, then none at all.
    const start = NOW.getTime();
    const clock = { now: start };
    const log = createStatefulLog(clock);
    const pruneState = { lastPrunedAt: start };
    const perHour = 900;
    const spacing = CORTEX_AI_REQUEST_QUOTA_WINDOW_MS / perHour;
    const admitted = [0, 0, 0];

    for (let index = 0; index < perHour * admitted.length; index += 1) {
      clock.now = start + index * spacing;
      const now = new Date(clock.now);
      const own = await evaluateCortexAiRequestQuota({
        client: log.client,
        now,
        pruneState,
        role: 'RTL',
        route: CORTEX_AI_RETAILER_COPILOT_ROUTE,
        userId: `partner-${index % 60}`,
      });
      if (!own.allowed) continue;
      const shared = await evaluateRetailerCopilotGlobalQuota({ client: log.client, now, requestRowId: own.rowId });
      const hour = Math.floor(index / perHour);
      if (shared.allowed) admitted[hour] = (admitted[hour] ?? 0) + 1;
    }

    expect(admitted[0]).toBe(CORTEX_AI_RETAILER_COPILOT_GLOBAL_HOURLY_REQUEST_CAP - 1);
    expect(admitted[1]).toBeGreaterThanOrEqual(590);
    expect(admitted[2]).toBeGreaterThanOrEqual(590);
    // Only admitted requests stay logged, never more than the cap in a window.
    const windowStart = new Date(clock.now - CORTEX_AI_REQUEST_QUOTA_WINDOW_MS).toISOString();
    expect(log.rows.filter((row) => row.created_at >= windowStart).length).toBeLessThan(
      CORTEX_AI_RETAILER_COPILOT_GLOBAL_HOURLY_REQUEST_CAP
    );
  });
});

describe('enforceRetailerCopilotRequestQuotas', () => {
  const serviceClient = vi.mocked(getServiceRoleSupabaseClient);

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  /** `count` copilot rows of `userId` in the last hour. */
  function seed(log: ReturnType<typeof createStatefulLog>, count: number, userId: string) {
    for (let index = 0; index < count; index += 1) {
      log.rows.push({
        id: `seed-${userId}-${index}`,
        route: CORTEX_AI_RETAILER_COPILOT_ROUTE,
        user_id: userId,
        created_at: new Date(Date.now() - (index + 1) * 1000).toISOString(),
      });
    }
  }

  it('admits under both caps with one row, and release() takes it back out exactly once', async () => {
    const log = createStatefulLog({ now: Date.now() });
    serviceClient.mockReturnValueOnce(log.client as never);

    const gate = await enforceRetailerCopilotRequestQuotas({ role: 'RTL', userId: USER });

    expect(gate.response).toBeNull();
    expect(log.rows).toEqual([expect.objectContaining({ id: 'row-1', route: 'affiliates/cortex', user_id: USER })]);
    await gate.release();
    await gate.release();
    expect(log.rows).toEqual([]);
    expect(log.deletedIds).toEqual(['row-1']);
  });

  it('returns the per-user 429 with the request already out of the log', async () => {
    const log = createStatefulLog({ now: Date.now() });
    seed(log, CORTEX_AI_RETAILER_HOURLY_REQUEST_CAP, USER);
    serviceClient.mockReturnValueOnce(log.client as never);

    const gate = await enforceRetailerCopilotRequestQuotas({ role: 'RTL', userId: USER });

    if (!gate.response) throw new Error('expected a 429 response');
    expect(gate.response.status).toBe(429);
    expect((await gate.response.json()).code).toBe('rate_limited');
    expect(log.rows).toHaveLength(CORTEX_AI_RETAILER_HOURLY_REQUEST_CAP);
    await gate.release();
    expect(log.deletedIds).toEqual(['row-1']);
  });

  it('returns the shared 429 and takes the request back out of the shared window', async () => {
    const log = createStatefulLog({ now: Date.now() });
    seed(log, CORTEX_AI_RETAILER_COPILOT_GLOBAL_HOURLY_REQUEST_CAP - 1, 'other-partners');
    serviceClient.mockReturnValueOnce(log.client as never);

    const gate = await enforceRetailerCopilotRequestQuotas({ role: 'RTL', userId: USER });

    expect(gate.response?.status).toBe(429);
    const body = await gate.response?.json();
    expect(body.code).toBe('retailer_copilot_busy');
    expect(gate.response?.headers.get('Retry-After')).toBe(String(body.retryAfterSeconds));
    expect(log.rows).toHaveLength(CORTEX_AI_RETAILER_COPILOT_GLOBAL_HOURLY_REQUEST_CAP - 1);
    expect(log.rows.some((row) => row.user_id === USER)).toBe(false);
    await gate.release();
    expect(log.deletedIds).toEqual(['row-1']);
  });

  it('fails closed with 503 when the service client is unavailable', async () => {
    serviceClient.mockImplementationOnce(() => {
      throw new Error('Missing Supabase Service Role environment variables');
    });

    const gate = await enforceRetailerCopilotRequestQuotas({ role: 'RTL', userId: USER });

    expect(gate.response?.status).toBe(503);
    await expect(gate.release()).resolves.toBeUndefined();
  });
});
