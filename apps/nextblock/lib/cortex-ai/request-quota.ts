import 'server-only';

import { NextResponse } from 'next/server';

import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

/**
 * Per-user request accounting for the Cortex AI routes (`/api/ai/*`).
 *
 * Every one of those routes spends the operator's OpenRouter credential (or the shared
 * house key) and, before this module, accepted an unbounded number of calls from any
 * WRITER. The routes now call `enforceCortexAiRequestQuota` right after their auth gate:
 * it records one `public.cortex_request_log` row per request through the service-role
 * client and answers 429 once the caller has more rows in the sliding window than their
 * role allows. The cap is per USER across every AI route; `route` is kept for auditing.
 *
 * The row is written BEFORE the count on purpose. Counting first and inserting only when
 * under the cap lets a burst of concurrent requests all pass the count before any of them
 * lands a row, which is exactly the abuse the cap exists to stop; insert-then-count means
 * a burst of N requests admits at most the cap and refuses the rest. The cost is that a
 * refused request still counts, so a caller who keeps hammering a 429 extends their own
 * wait. That is acceptable for an abuse control, and `Retry-After` tells a well-behaved
 * client when to come back.
 *
 * Fail closed: when the log cannot be written or counted the request is refused with 503
 * rather than let through uncounted, because an accounting outage is not a reason to
 * spend an uncapped credential. The table ships in migration 02022 alongside this code.
 *
 * The table is service-role only (RLS on, no anon/authenticated policy), so a browser
 * session can neither read other users' activity nor pad or purge its own counter. Only
 * this module touches it; the generated `Database` type does not know it, hence the
 * structural `CortexRequestLogClient` below, which is also what the tests fake.
 */

/** Sliding window every cap below is measured over. */
export const CORTEX_AI_REQUEST_QUOTA_WINDOW_MS = 60 * 60 * 1000;

/** Requests per window for a WRITER (a content editor; also the fallback for any other role). */
export const CORTEX_AI_WRITER_HOURLY_REQUEST_CAP = 60;

/** Requests per window for an ADMIN. */
export const CORTEX_AI_ADMIN_HOURLY_REQUEST_CAP = 300;

/** Rows older than this serve no cap and are deleted opportunistically. */
export const CORTEX_AI_REQUEST_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

/** A prune runs at most this often per server instance, piggybacked on a request. */
export const CORTEX_AI_REQUEST_LOG_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

export const CORTEX_AI_REQUEST_LOG_TABLE = 'cortex_request_log';

/** The `route` column value: one per AI endpoint. */
export type CortexAiRequestRoute =
  | 'ai/cortex/build-widget'
  | 'ai/generate-blocks'
  | 'ai/global-agent'
  | 'ai/seo/alt-text'
  | 'ai/seo/metadata';

export type CortexAiQuotaDecision =
  | { allowed: true; limit: number; used: number }
  | { allowed: false; limit: number; reason: 'exceeded'; retryAfterSeconds: number; used: number }
  | { allowed: false; reason: 'unavailable' };

type QueryError = { message: string } | null;

/**
 * The slice of the Supabase client this module uses. Structural rather than the generated
 * `Database` type so the table can be accounted for without regenerating types, and so a
 * test can hand in a fake.
 */
export type CortexRequestLogClient = {
  from(table: typeof CORTEX_AI_REQUEST_LOG_TABLE): {
    delete(): {
      lt(column: 'created_at', value: string): PromiseLike<{ error: QueryError }>;
    };
    insert(row: { route: string; user_id: string }): PromiseLike<{ error: QueryError }>;
    select(
      columns: 'created_at',
      options?: { count?: 'exact'; head?: boolean }
    ): {
      eq(
        column: 'user_id',
        value: string
      ): {
        gte(
          column: 'created_at',
          value: string
        ): PromiseLike<{ count: number | null; error: QueryError }> & {
          order(
            column: 'created_at',
            options: { ascending: boolean }
          ): {
            range(
              from: number,
              to: number
            ): PromiseLike<{ data: Array<{ created_at: string }> | null; error: QueryError }>;
          };
        };
      };
    };
  };
};

/** Mutable per-instance prune bookkeeping; injectable so tests do not share state. */
export type CortexAiRequestLogPruneState = { lastPrunedAt: number };

const modulePruneState: CortexAiRequestLogPruneState = { lastPrunedAt: 0 };

export function resolveCortexAiHourlyRequestCap(role: string | null | undefined): number {
  return role === 'ADMIN' ? CORTEX_AI_ADMIN_HOURLY_REQUEST_CAP : CORTEX_AI_WRITER_HOURLY_REQUEST_CAP;
}

/**
 * Record this request and decide whether it is within the caller's hourly cap.
 *
 * Pure with respect to its inputs: the client, the clock and the prune state are all
 * injected. `enforceCortexAiRequestQuota` is the route-facing wrapper.
 */
export async function evaluateCortexAiRequestQuota(params: {
  client: CortexRequestLogClient;
  now?: Date;
  pruneState?: CortexAiRequestLogPruneState;
  role: string | null | undefined;
  route: CortexAiRequestRoute;
  userId: string;
}): Promise<CortexAiQuotaDecision> {
  const now = params.now ?? new Date();
  const limit = resolveCortexAiHourlyRequestCap(params.role);
  const windowStartIso = new Date(now.getTime() - CORTEX_AI_REQUEST_QUOTA_WINDOW_MS).toISOString();

  try {
    const { error: insertError } = await params.client
      .from(CORTEX_AI_REQUEST_LOG_TABLE)
      .insert({ route: params.route, user_id: params.userId });

    if (insertError) {
      console.error('[Cortex AI] request log insert failed:', insertError.message);
      return { allowed: false, reason: 'unavailable' };
    }

    const { count, error: countError } = await params.client
      .from(CORTEX_AI_REQUEST_LOG_TABLE)
      .select('created_at', { count: 'exact', head: true })
      .eq('user_id', params.userId)
      .gte('created_at', windowStartIso);

    if (countError || typeof count !== 'number') {
      console.error(
        '[Cortex AI] request log count failed:',
        countError?.message ?? 'no count returned'
      );
      return { allowed: false, reason: 'unavailable' };
    }

    pruneOpportunistically(params.client, now, params.pruneState ?? modulePruneState);

    if (count <= limit) {
      return { allowed: true, limit, used: count };
    }

    const retryAfterSeconds = await resolveRetryAfterSeconds({
      client: params.client,
      count,
      limit,
      now,
      userId: params.userId,
      windowStartIso,
    });

    return { allowed: false, limit, reason: 'exceeded', retryAfterSeconds, used: count };
  } catch (error) {
    console.error('[Cortex AI] request quota check failed:', error);
    return { allowed: false, reason: 'unavailable' };
  }
}

/**
 * Delete rows past the retention window, at most once per interval per instance, without
 * ever delaying or failing the request that triggered it.
 */
function pruneOpportunistically(
  client: CortexRequestLogClient,
  now: Date,
  state: CortexAiRequestLogPruneState
) {
  if (now.getTime() - state.lastPrunedAt < CORTEX_AI_REQUEST_LOG_PRUNE_INTERVAL_MS) {
    return;
  }

  state.lastPrunedAt = now.getTime();

  const cutoffIso = new Date(now.getTime() - CORTEX_AI_REQUEST_LOG_RETENTION_MS).toISOString();

  void Promise.resolve(client.from(CORTEX_AI_REQUEST_LOG_TABLE).delete().lt('created_at', cutoffIso))
    .then(({ error }) => {
      if (error) {
        console.warn('[Cortex AI] request log prune failed:', error.message);
      }
    })
    .catch((error: unknown) => {
      console.warn('[Cortex AI] request log prune failed:', error);
    });
}

/**
 * Seconds until a new request would fit under the cap again.
 *
 * After this request's own row there are `count` rows in the window, oldest first. A later
 * request adds one more and is admitted when `rows + 1 <= limit`, i.e. once `count + 1 -
 * limit` of the oldest rows have aged out — the row at 0-based index `count - limit` is
 * the last of those. Falls back to the whole window when the lookup fails, which only
 * makes a client wait longer than strictly necessary.
 */
async function resolveRetryAfterSeconds(params: {
  client: CortexRequestLogClient;
  count: number;
  limit: number;
  now: Date;
  userId: string;
  windowStartIso: string;
}): Promise<number> {
  const fullWindowSeconds = Math.ceil(CORTEX_AI_REQUEST_QUOTA_WINDOW_MS / 1000);
  const index = Math.max(0, params.count - params.limit);

  try {
    const { data, error } = await params.client
      .from(CORTEX_AI_REQUEST_LOG_TABLE)
      .select('created_at')
      .eq('user_id', params.userId)
      .gte('created_at', params.windowStartIso)
      .order('created_at', { ascending: true })
      .range(index, index);

    if (error || !data?.[0]?.created_at) {
      return fullWindowSeconds;
    }

    const freesAt = Date.parse(data[0].created_at) + CORTEX_AI_REQUEST_QUOTA_WINDOW_MS;

    if (!Number.isFinite(freesAt)) {
      return fullWindowSeconds;
    }

    return Math.min(fullWindowSeconds, Math.max(1, Math.ceil((freesAt - params.now.getTime()) / 1000)));
  } catch {
    return fullWindowSeconds;
  }
}

/** `null` when the request may proceed, otherwise the response the route must return. */
export function cortexAiQuotaDecisionToResponse(decision: CortexAiQuotaDecision): NextResponse | null {
  if (decision.allowed) {
    return null;
  }

  if (decision.reason === 'unavailable') {
    return NextResponse.json(
      { error: 'Cortex AI request accounting is temporarily unavailable. Try again shortly.' },
      { headers: { 'Retry-After': '5' }, status: 503 }
    );
  }

  const minutes = Math.max(1, Math.ceil(decision.retryAfterSeconds / 60));

  return NextResponse.json(
    {
      error: `Cortex AI hourly request limit reached (${decision.limit} requests per hour for your role). Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      limit: decision.limit,
      retryAfterSeconds: decision.retryAfterSeconds,
    },
    {
      headers: {
        'Retry-After': String(decision.retryAfterSeconds),
        'X-RateLimit-Limit': String(decision.limit),
        'X-RateLimit-Remaining': '0',
      },
      status: 429,
    }
  );
}

/**
 * Route entry point: call right after the auth gate, before anything that can reach a
 * model. Returns `null` to proceed or the 429/503 response to return as-is.
 */
export async function enforceCortexAiRequestQuota(params: {
  role: string | null | undefined;
  route: CortexAiRequestRoute;
  userId: string;
}): Promise<NextResponse | null> {
  let client: CortexRequestLogClient;

  try {
    client = getServiceRoleSupabaseClient() as unknown as CortexRequestLogClient;
  } catch (error) {
    console.error('[Cortex AI] request quota: service client unavailable:', error);
    return cortexAiQuotaDecisionToResponse({ allowed: false, reason: 'unavailable' });
  }

  const decision = await evaluateCortexAiRequestQuota({ client, ...params });

  return cortexAiQuotaDecisionToResponse(decision);
}
