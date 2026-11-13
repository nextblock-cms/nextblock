import 'server-only';

import { NextResponse } from 'next/server';

import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

/**
 * Per-user request accounting for the Cortex AI routes (`/api/ai/*` and the partner copilot,
 * `/api/affiliates/cortex`, which also has a cap shared by every account: see the end of this file).
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

/**
 * Requests per window for a partner (`RTL`, Affiliates). Partner accounts are self-service
 * sign-ups, so their personal cap is the smallest; the partner copilot is the only AI route they
 * can reach (`/api/affiliates/cortex`).
 */
export const CORTEX_AI_RETAILER_HOURLY_REQUEST_CAP = 30;

/**
 * Partner-copilot requests per window across ALL accounts. Anyone can become a partner, so the
 * per-user cap alone would let a crowd of new accounts spend the operator's model credit without
 * bound; `evaluateRetailerCopilotGlobalQuota` refuses once this many are logged in the window
 * (only requests that went on to a model call stay logged on this route).
 */
export const CORTEX_AI_RETAILER_COPILOT_GLOBAL_HOURLY_REQUEST_CAP = 600;

/** The partner copilot's `route` value. */
export const CORTEX_AI_RETAILER_COPILOT_ROUTE = 'affiliates/cortex';

/** The partner role, compared as a string: the generated `user_role` type predates 02029's `RTL`. */
const RETAILER_ROLE = 'RTL';

/** Rows older than this serve no cap and are deleted opportunistically. */
export const CORTEX_AI_REQUEST_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

/** A prune runs at most this often per server instance, piggybacked on a request. */
export const CORTEX_AI_REQUEST_LOG_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

export const CORTEX_AI_REQUEST_LOG_TABLE = 'cortex_request_log';

/** The `route` column value: one per AI endpoint. */
export type CortexAiRequestRoute =
  | 'affiliates/cortex'
  | 'ai/cortex/build-widget'
  | 'ai/generate-blocks'
  | 'ai/global-agent'
  | 'ai/seo/alt-text'
  | 'ai/seo/metadata';

/**
 * Routes whose refused requests are taken back out of the log. Elsewhere a refused request keeps
 * counting (a caller hammering a 429 extends their own wait). The partner copilot also has a
 * cap shared by every account, which counts this route's rows, so there a request stays logged
 * only once it goes on to a model call: the per-user refusal deletes its row here, the shared
 * refusal in `evaluateRetailerCopilotGlobalQuota`, and the route releases it when it turns the
 * request away later (`enforceRetailerCopilotRequestQuotas`). If refused attempts stayed logged,
 * steady demand at the shared cap would keep the window full and no request would ever be
 * admitted again, for every partner.
 */
const ROUTES_THAT_FORGET_REFUSED_REQUESTS: ReadonlySet<CortexAiRequestRoute> = new Set([
  CORTEX_AI_RETAILER_COPILOT_ROUTE,
]);

export type CortexAiQuotaDecision =
  | {
      allowed: true;
      limit: number;
      used: number;
      /** This request's log row, on a route that forgets refused requests (so it can be taken back out). */
      rowId?: string;
    }
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
      /** Takes a refused request's own row back out (`ROUTES_THAT_FORGET_REFUSED_REQUESTS`). */
      eq(column: 'id', value: string): PromiseLike<{ error: QueryError }>;
    };
    insert(row: { route: string; user_id: string }): PromiseLike<{ error: QueryError }> & {
      /** The inserted row's id, for routes that may take a refused request back out. */
      select(columns: 'id'): {
        single(): PromiseLike<{ data: { id: string } | null; error: QueryError }>;
      };
    };
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
  if (role === 'ADMIN') {
    return CORTEX_AI_ADMIN_HOURLY_REQUEST_CAP;
  }
  if (String(role) === RETAILER_ROLE) {
    return CORTEX_AI_RETAILER_HOURLY_REQUEST_CAP;
  }
  return CORTEX_AI_WRITER_HOURLY_REQUEST_CAP;
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
  const forgetsRefusals = ROUTES_THAT_FORGET_REFUSED_REQUESTS.has(params.route);
  // Set on a route that forgets refusals, once this request's row is logged.
  let insertedId: string | null = null;

  try {
    const row = { route: params.route, user_id: params.userId };

    if (forgetsRefusals) {
      // The id is needed to take this row back out if the request is refused.
      const { data, error: insertError } = await params.client
        .from(CORTEX_AI_REQUEST_LOG_TABLE)
        .insert(row)
        .select('id')
        .single();

      if (insertError || !data?.id) {
        console.error(
          '[Cortex AI] request log insert failed:',
          insertError?.message ?? 'no row id returned'
        );
        return { allowed: false, reason: 'unavailable' };
      }
      insertedId = data.id;
    } else {
      const { error: insertError } = await params.client.from(CORTEX_AI_REQUEST_LOG_TABLE).insert(row);

      if (insertError) {
        console.error('[Cortex AI] request log insert failed:', insertError.message);
        return { allowed: false, reason: 'unavailable' };
      }
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
      // Refused (fail closed): on a route that forgets refusals it stops counting too.
      if (insertedId) await forgetRefusedRequest(params.client, insertedId);
      return { allowed: false, reason: 'unavailable' };
    }

    pruneOpportunistically(params.client, now, params.pruneState ?? modulePruneState);

    if (count <= limit) {
      return insertedId ? { allowed: true, limit, used: count, rowId: insertedId } : { allowed: true, limit, used: count };
    }

    // Refused. On a route that forgets refusals this request stops counting (see
    // ROUTES_THAT_FORGET_REFUSED_REQUESTS); if the delete fails it keeps counting, as elsewhere.
    const forgotten = insertedId ? await forgetRefusedRequest(params.client, insertedId) : false;

    const retryAfterSeconds = await resolveRetryAfterSeconds({
      client: params.client,
      count: forgotten ? count - 1 : count,
      limit,
      now,
      userId: params.userId,
      windowStartIso,
    });

    return { allowed: false, limit, reason: 'exceeded', retryAfterSeconds, used: count };
  } catch (error) {
    console.error('[Cortex AI] request quota check failed:', error);
    if (insertedId) await forgetRefusedRequest(params.client, insertedId);
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

/** The slice of the client that deletes one request's row (both structural clients have it). */
type RequestLogRowDeleteClient = {
  from(table: typeof CORTEX_AI_REQUEST_LOG_TABLE): {
    delete(): { eq(column: 'id', value: string): PromiseLike<{ error: QueryError }> };
  };
};

/** Delete a refused request's own row. True when it is gone; never throws. */
async function forgetRefusedRequest(client: RequestLogRowDeleteClient, rowId: string): Promise<boolean> {
  try {
    const { error } = await client.from(CORTEX_AI_REQUEST_LOG_TABLE).delete().eq('id', rowId);
    if (error) {
      console.warn('[Cortex AI] could not take a refused request out of the log:', error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[Cortex AI] could not take a refused request out of the log:', error);
    return false;
  }
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
      {
        code: 'quota_unavailable',
        error: 'Cortex AI request accounting is temporarily unavailable. Try again shortly.',
      },
      { headers: { 'Retry-After': '5' }, status: 503 }
    );
  }

  const minutes = Math.max(1, Math.ceil(decision.retryAfterSeconds / 60));

  return NextResponse.json(
    {
      code: 'rate_limited',
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

// ---------------------------------------------------------------------------
// Partner copilot: one hourly cap shared by every account
// ---------------------------------------------------------------------------

/** The slice of the client the shared partner-copilot count uses (structural, like the one above). */
export type RetailerCopilotRequestLogClient = {
  from(table: typeof CORTEX_AI_REQUEST_LOG_TABLE): {
    /** Takes a refused request's own row back out. */
    delete(): { eq(column: 'id', value: string): PromiseLike<{ error: QueryError }> };
    select(
      columns: 'created_at',
      options?: { count?: 'exact'; head?: boolean }
    ): {
      eq(
        column: 'route',
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

export type RetailerCopilotGlobalQuotaDecision =
  | { allowed: true; limit: number; used: number }
  | { allowed: false; limit: number; reason: 'exceeded'; retryAfterSeconds: number; used: number }
  | { allowed: false; reason: 'unavailable' };

/**
 * Count every account's partner-copilot requests in the window and decide whether the shared cap
 * has room. It runs after `evaluateCortexAiRequestQuota({ route: 'affiliates/cortex', ... })`,
 * whose row for this request (`requestRowId`) is already in the log, so the window is full at
 * `count >= cap`. Only requests that went on to a model call stay in the count: the per-user cap
 * forgets the requests it refuses, this function deletes `requestRowId` when it refuses, and the
 * route releases the row of a request it turns away later. So under steady demand at or above the
 * cap, rows keep aging out and about `cap` requests an hour keep being admitted.
 *
 * Fails closed like the per-user cap: a count that cannot be read refuses with `unavailable`.
 * Pure with respect to its inputs (client and clock injected); `enforceRetailerCopilotRequestQuotas`
 * is the route-facing wrapper.
 */
export async function evaluateRetailerCopilotGlobalQuota(params: {
  client: RetailerCopilotRequestLogClient;
  now?: Date;
  /** This request's own row (from the per-user step), deleted when the shared cap refuses it. */
  requestRowId?: string | null;
}): Promise<RetailerCopilotGlobalQuotaDecision> {
  const now = params.now ?? new Date();
  const limit = CORTEX_AI_RETAILER_COPILOT_GLOBAL_HOURLY_REQUEST_CAP;
  const windowStartIso = new Date(now.getTime() - CORTEX_AI_REQUEST_QUOTA_WINDOW_MS).toISOString();
  const forgetThisRequest = async () =>
    params.requestRowId ? forgetRefusedRequest(params.client, params.requestRowId) : false;

  try {
    const { count, error } = await params.client
      .from(CORTEX_AI_REQUEST_LOG_TABLE)
      .select('created_at', { count: 'exact', head: true })
      .eq('route', CORTEX_AI_RETAILER_COPILOT_ROUTE)
      .gte('created_at', windowStartIso);

    if (error || typeof count !== 'number') {
      console.error(
        '[Cortex AI] partner copilot request count failed:',
        error?.message ?? 'no count returned'
      );
      await forgetThisRequest();
      return { allowed: false, reason: 'unavailable' };
    }

    if (count < limit) {
      return { allowed: true, limit, used: count };
    }

    // Refused: this request stops counting. A refused attempt that stayed logged would hold a
    // slot of the shared window; if the delete fails it does, and the wait below accounts for it.
    const forgotten = await forgetThisRequest();

    const retryAfterSeconds = await resolveSharedRetryAfterSeconds({
      client: params.client,
      count: forgotten ? count - 1 : count,
      limit,
      now,
      windowStartIso,
    });

    return { allowed: false, limit, reason: 'exceeded', retryAfterSeconds, used: count };
  } catch (error) {
    console.error('[Cortex AI] partner copilot request quota check failed:', error);
    await forgetThisRequest();
    return { allowed: false, reason: 'unavailable' };
  }
}

/**
 * Seconds until the shared window has room again. `count` rows are in the window now, oldest
 * first (the refused request's own row only when it could not be taken back out). A later request
 * is admitted when, with its own row, fewer than `limit` are logged: `count - limit + 2` rows must
 * age out, the last of them at 0-based index `count - limit + 1`. The whole window on any doubt.
 */
async function resolveSharedRetryAfterSeconds(params: {
  client: RetailerCopilotRequestLogClient;
  count: number;
  limit: number;
  now: Date;
  windowStartIso: string;
}): Promise<number> {
  const fullWindowSeconds = Math.ceil(CORTEX_AI_REQUEST_QUOTA_WINDOW_MS / 1000);
  const index = Math.min(params.count - 1, Math.max(0, params.count - params.limit + 1));

  try {
    const { data, error } = await params.client
      .from(CORTEX_AI_REQUEST_LOG_TABLE)
      .select('created_at')
      .eq('route', CORTEX_AI_RETAILER_COPILOT_ROUTE)
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

/** `null` when the request may proceed, otherwise the 429/503 the route must return. */
export function retailerCopilotGlobalQuotaDecisionToResponse(
  decision: RetailerCopilotGlobalQuotaDecision
): NextResponse | null {
  if (decision.allowed) {
    return null;
  }

  if (decision.reason === 'unavailable') {
    return cortexAiQuotaDecisionToResponse({ allowed: false, reason: 'unavailable' });
  }

  const minutes = Math.max(1, Math.ceil(decision.retryAfterSeconds / 60));

  return NextResponse.json(
    {
      code: 'retailer_copilot_busy',
      error: `The partner copilot has reached its hourly limit for this store. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      retryAfterSeconds: decision.retryAfterSeconds,
    },
    {
      headers: { 'Retry-After': String(decision.retryAfterSeconds) },
      status: 429,
    }
  );
}

/** What `enforceRetailerCopilotRequestQuotas` hands the partner-copilot route. */
export type RetailerCopilotQuotaGate = {
  /** `null` when both caps admitted the request; otherwise the 429 or 503 to return as-is. */
  response: NextResponse | null;
  /**
   * Takes the admitted request's log row back out, so neither cap counts it any more. The route
   * calls it when it turns the request away before any model call (403, 400, 503, 500). Runs at
   * most once, never throws, and does nothing for a refused request (its row is already gone).
   */
  release: () => Promise<void>;
};

const releaseNothing = async (): Promise<void> => undefined;

/**
 * Partner-copilot route entry point (`/api/affiliates/cortex`): call right after the auth gate,
 * before anything that can reach a model. Records the request once (route `affiliates/cortex`)
 * with the service role and checks both caps on that row: the caller's own hourly cap
 * (`evaluateCortexAiRequestQuota`), then the cap shared by every account
 * (`evaluateRetailerCopilotGlobalQuota`). A refusal by either cap takes the row back out, and
 * `release()` does the same for a request the route refuses later, so the shared window only
 * counts requests that reached a model call. Fails closed with 503 when the log cannot be used.
 */
export async function enforceRetailerCopilotRequestQuotas(params: {
  role: string | null | undefined;
  userId: string;
}): Promise<RetailerCopilotQuotaGate> {
  let client: CortexRequestLogClient & RetailerCopilotRequestLogClient;

  try {
    client = getServiceRoleSupabaseClient() as unknown as CortexRequestLogClient & RetailerCopilotRequestLogClient;
  } catch (error) {
    console.error('[Cortex AI] partner copilot quota: service client unavailable:', error);
    return { response: cortexAiQuotaDecisionToResponse({ allowed: false, reason: 'unavailable' }), release: releaseNothing };
  }

  const own = await evaluateCortexAiRequestQuota({
    client,
    role: params.role,
    route: CORTEX_AI_RETAILER_COPILOT_ROUTE,
    userId: params.userId,
  });
  if (!own.allowed) {
    return { response: cortexAiQuotaDecisionToResponse(own), release: releaseNothing };
  }

  const rowId = own.rowId ?? null;
  const shared = await evaluateRetailerCopilotGlobalQuota({ client, requestRowId: rowId });
  if (!shared.allowed) {
    return { response: retailerCopilotGlobalQuotaDecisionToResponse(shared), release: releaseNothing };
  }

  let released = false;
  return {
    response: null,
    release: async () => {
      if (released || rowId === null) return;
      released = true;
      await forgetRefusedRequest(client, rowId);
    },
  };
}
