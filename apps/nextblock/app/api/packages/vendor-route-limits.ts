import 'server-only';

import { maskAffiliateVisitorIp } from '../../../lib/affiliates/referral-cookie';

/**
 * Limits for the two vendor routes, `POST /api/packages/claim-license` and
 * `POST /api/packages/provision-trial`. They run only on the deployment that sells the packages
 * (nextblock.dev), are public, and every request they let through spends the Freemius developer key
 * pair that all of the store's Freemius flows share: checkouts (a cold instance reads a product's keys
 * with it), license links, claims, trials, coupon pushes and webhook checks (last-good secrets verify
 * for 70 minutes at most). A caller who pushes that key into Freemius 429s stops all of them.
 *
 * Until the 2026-11-13 review both routes bucketed by the full client address, read from headers a
 * client can set anywhere (`x-vercel-forwarded-for` off Vercel, `cf-connecting-ip`), so one IPv6 /64
 * could drive unbounded developer-key lookups and trial mints. Now (the checkout sync's model,
 * `app/api/checkout/freemius/sync/route.ts`):
 * - the address is read as partner signup and the checkout sync read it, and bucketed by its network
 *   (`maskAffiliateVisitorIp`: an IPv4 /24, an IPv6 /48; addresses it cannot read share one bucket);
 * - each route caps the work its instance sends to Freemius per minute, across all callers, and
 *   logs one line per minute while the cap refuses;
 * - a request is counted only when every limit admits it, so a caller looping one network, license or
 *   email cannot spend the instance budget the real buyers share, and refused requests cost nothing.
 *
 * Best-effort and per process: not shared across serverless instances, reset on a cold start. The
 * maps stay bounded twice over: a bucket is created only for admitted work (at most the instance cap
 * per minute), and a scope whose map is full refuses new keys until its buckets expire.
 */

export type VendorLimit = { max: number; windowMs: number };

type Bucket = { count: number; resetAt: number };

export type VendorLimitCheck = {
  /** What the bucket counts (`network`, `license`, `email`); also how a refusal names the limit. */
  scope: string;
  key: string;
  limit: VendorLimit;
};

export type VendorAdmission =
  | { admitted: true }
  | {
      admitted: false;
      /** The scope of the limit that refused, or `instance`. */
      refusedBy: string;
      /** Whole seconds until that limit admits again, at least 1. */
      retryAfterSeconds: number;
    };

/** The network `maskAffiliateVisitorIp` gives every address it cannot read. */
export const UNKNOWN_CLIENT_NETWORK = 'unknown';

function firstHop(headerValue: string | null): string | null {
  const [first] = (headerValue ?? '').split(',');
  const trimmed = first?.trim() ?? '';
  return trimmed || null;
}

/**
 * The caller's network. `x-vercel-forwarded-for` counts only on Vercel (`VERCEL=1`), which sets it:
 * anywhere else a client can send it and pick its own bucket. Then the proxy's `x-real-ip`, then the
 * first `x-forwarded-for` hop, last because a client can prepend to it on an appending proxy (the
 * instance cap holds there too). `cf-connecting-ip` is not read: off Cloudflare a client sets it.
 */
export function resolveVendorClientNetwork(request: Request): string {
  const vercelHop = process.env.VERCEL === '1' ? firstHop(request.headers.get('x-vercel-forwarded-for')) : null;

  return maskAffiliateVisitorIp(
    vercelHop ?? firstHop(request.headers.get('x-real-ip')) ?? firstHop(request.headers.get('x-forwarded-for'))
  );
}

/** Retry-After: whole seconds until `resetAt`, at least 1. */
function secondsUntil(resetAt: number, now: number) {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

/**
 * One route's admission gate: a bucket per key in each scope (client network, license, email) and one
 * cap for the whole instance per window. `admit(checks)` either refuses, naming the first limit that
 * did, or counts the request against every check and the instance cap at once.
 */
export function createVendorAdmission(options: {
  instance: VendorLimit;
  /** Logged (warn) the first time the instance cap refuses in a window: names no caller. */
  instanceRefusalLine: string;
  /** A scope whose map holds this many live buckets refuses new keys until some expire. */
  maxBucketsPerScope: number;
}) {
  const scopes = new Map<string, Map<string, Bucket>>();
  const instance = { count: 0, resetAt: 0, logged: false };

  const bucketsOf = (scope: string) => {
    let buckets = scopes.get(scope);

    if (!buckets) {
      buckets = new Map();
      scopes.set(scope, buckets);
    }

    return buckets;
  };

  return function admit(checks: readonly VendorLimitCheck[], now = Date.now()): VendorAdmission {
    for (const buckets of scopes.values()) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    }

    if (instance.resetAt <= now) {
      instance.count = 0;
      instance.resetAt = now + options.instance.windowMs;
      instance.logged = false;
    }

    for (const check of checks) {
      const buckets = bucketsOf(check.scope);
      const bucket = buckets.get(check.key);

      if (bucket && bucket.count >= check.limit.max) {
        return { admitted: false, refusedBy: check.scope, retryAfterSeconds: secondsUntil(bucket.resetAt, now) };
      }

      if (!bucket && buckets.size >= options.maxBucketsPerScope) {
        // Under a flood, new keys are refused rather than allowed to grow the map.
        return { admitted: false, refusedBy: check.scope, retryAfterSeconds: secondsUntil(now + check.limit.windowMs, now) };
      }
    }

    if (instance.count >= options.instance.max) {
      if (!instance.logged) {
        instance.logged = true;
        console.warn(options.instanceRefusalLine);
      }

      return { admitted: false, refusedBy: 'instance', retryAfterSeconds: secondsUntil(instance.resetAt, now) };
    }

    for (const check of checks) {
      const buckets = bucketsOf(check.scope);
      const bucket = buckets.get(check.key);

      if (bucket) {
        bucket.count += 1;
      } else {
        buckets.set(check.key, { count: 1, resetAt: now + check.limit.windowMs });
      }
    }

    instance.count += 1;

    return { admitted: true };
  };
}
