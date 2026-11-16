import 'server-only';

import { NextResponse } from 'next/server';
import { syncFreemiusCheckoutOrder, verifyOrderAccessToken } from '@nextblock-cms/ecommerce/server';

import { maskAffiliateVisitorIp } from '../../../../../lib/affiliates/referral-cookie';

/**
 * The Freemius overlay's browser callback reports which license the checkout created. This
 * route is public, so it trusts nothing in the body: the caller must hold the order's access
 * token (minted at checkout and handed only to the buyer's browser), and the sync itself links
 * a license only after Freemius confirms it belongs to this order (see
 * `evaluateFreemiusCheckoutLicense`). Before 2026-10-21 neither held, and any guest could
 * attach any license id to their own order and read its key on the success page.
 *
 * Each sync asks Freemius about the license with the store's credentials. On nextblock.dev that is
 * the developer key pair every Freemius flow of the store shares (license links, claims, trials,
 * coupon pushes), so a flood of syncs could push the key into Freemius's rate limit and stop all of
 * them. The token limits nothing on its own: POST /api/checkout mints one for anyone, one per
 * checkout, and it never expires. So syncs are limited three ways (review 2026-11-13): per order,
 * per client network and for the whole instance. The overlay sends one sync per checkout
 * (Checkout.tsx memoizes it), so a buyer never meets any of these limits.
 */

type Bucket = { count: number; resetAt: number };
type Limit = { max: number; windowMs: number };

/** Syncs one order may run per window. */
const ORDER_LIMIT: Limit = { max: 5, windowMs: 60_000 };
/** Syncs one client network (an IPv4 /24, an IPv6 /48) may run per window, whatever the order. */
const NETWORK_LIMIT: Limit = { max: 20, windowMs: 10 * 60_000 };
/** Callers whose address cannot be read share one bucket, so it gets more room, never a free pass. */
const UNKNOWN_NETWORK_LIMIT: Limit = { max: 60, windowMs: 10 * 60_000 };
/** Syncs this instance runs per window, all callers together: what this route may spend of the key. */
const INSTANCE_LIMIT: Limit = { max: 60, windowMs: 60_000 };
/** The network `maskAffiliateVisitorIp` gives every address it cannot read. */
const UNKNOWN_NETWORK = 'unknown';

/**
 * Best-effort, per-process limiters (not shared across serverless instances, reset on a cold
 * start). A sync is counted only once the order's access token verifies, so nobody without the
 * token can spend a buyer's syncs, and only when every limit admits it: a request one limit
 * refuses costs nothing against the others, so a caller looping one order or one network cannot
 * use up the instance budget the store's buyers share. Expired buckets are pruned on every call.
 * The instance limit also bounds memory: a bucket is created only for an admitted sync, and at most
 * INSTANCE_LIMIT.max syncs are admitted per instance window. A live order bucket was created within
 * the last minute, which overlaps at most 2 instance windows (120 buckets); a live network bucket
 * within the last 10 minutes, at most 11 (660). That is why a full map needs no rule here, unlike
 * claim-license, which has no instance limit and refuses new addresses once its map is full.
 */
const orderBuckets = new Map<string, Bucket>();
const networkBuckets = new Map<string, Bucket>();
const instanceBucket: Bucket = { count: 0, resetAt: 0 };
/** Whether this instance window's refusal was logged: one line per minute, however many follow. */
let instanceLimitLogged = false;

type SyncAdmission = { admitted: true } | { admitted: false; error: string; retryAfterSeconds: number };

function pruneExpired(buckets: Map<string, Bucket>, now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

/** Retry-After: whole seconds until `resetAt`, at least 1. */
function secondsUntil(resetAt: number, now: number) {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

function count(buckets: Map<string, Bucket>, key: string, limit: Limit, now: number) {
  const bucket = buckets.get(key);

  if (bucket) {
    bucket.count += 1;
  } else {
    buckets.set(key, { count: 1, resetAt: now + limit.windowMs });
  }
}

/** Whether a sync of `orderId` from `network` may run now; counts it against all three limits when it may. */
function admitSync(orderId: string, network: string, now = Date.now()): SyncAdmission {
  pruneExpired(orderBuckets, now);
  pruneExpired(networkBuckets, now);

  if (instanceBucket.resetAt <= now) {
    instanceBucket.count = 0;
    instanceBucket.resetAt = now + INSTANCE_LIMIT.windowMs;
    instanceLimitLogged = false;
  }

  const order = orderBuckets.get(orderId);

  if (order && order.count >= ORDER_LIMIT.max) {
    return {
      admitted: false,
      error: 'Too many sync requests for this order. Try again in a minute.',
      retryAfterSeconds: secondsUntil(order.resetAt, now),
    };
  }

  const networkLimit = network === UNKNOWN_NETWORK ? UNKNOWN_NETWORK_LIMIT : NETWORK_LIMIT;
  const fromNetwork = networkBuckets.get(network);

  if (fromNetwork && fromNetwork.count >= networkLimit.max) {
    return {
      admitted: false,
      error: 'Too many sync requests from your network. Try again later.',
      retryAfterSeconds: secondsUntil(fromNetwork.resetAt, now),
    };
  }

  if (instanceBucket.count >= INSTANCE_LIMIT.max) {
    if (!instanceLimitLogged) {
      instanceLimitLogged = true;
      // No address or order id: the line only tells the operator that the cap is working.
      console.warn(
        `[Freemius Checkout Sync] ${INSTANCE_LIMIT.max} syncs ran on this instance this minute; refusing more until the minute is over. A flood of scripted checkouts does this.`
      );
    }

    return {
      admitted: false,
      error: 'Checkout sync is busy. Try again in a minute.',
      retryAfterSeconds: secondsUntil(instanceBucket.resetAt, now),
    };
  }

  count(orderBuckets, orderId, ORDER_LIMIT, now);
  count(networkBuckets, network, networkLimit, now);
  instanceBucket.count += 1;

  return { admitted: true };
}

function firstHop(headerValue: string | null): string | null {
  const [first] = (headerValue ?? '').split(',');
  const trimmed = first?.trim() ?? '';
  return trimmed || null;
}

/**
 * The caller's address, read the way partner signup reads it since its 2026-10-29 fix.
 * `x-vercel-forwarded-for` counts only on Vercel, which sets it: anywhere else a client can send it
 * and pick its own bucket (the vendor claim and trial routes read it the same way:
 * `resolveVendorClientNetwork` in app/api/packages/vendor-route-limits.ts). Then
 * the proxy's `x-real-ip`, then the first `x-forwarded-for` hop, last because a client can prepend
 * to it on an appending proxy and a directly exposed `next start` keeps a client-sent one; the
 * instance limit holds there too. `maskAffiliateVisitorIp` then reduces the address to its network,
 * so a host cannot rotate through the addresses of its IPv6 block (or write one address several
 * ways) for fresh buckets.
 */
function resolveClientAddress(request: Request): string | null {
  const vercelHop = process.env.VERCEL === '1' ? firstHop(request.headers.get('x-vercel-forwarded-for')) : null;

  return vercelHop ?? firstHop(request.headers.get('x-real-ip')) ?? firstHop(request.headers.get('x-forwarded-for'));
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const orderId = typeof body.orderId === 'string' ? body.orderId : null;
    const token = typeof body.token === 'string' ? body.token : null;

    if (!orderId) {
      return NextResponse.json(
        { success: false, error: 'Missing Freemius order ID' },
        { status: 400 }
      );
    }

    if (!verifyOrderAccessToken(orderId, token)) {
      return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
    }

    const admission = admitSync(orderId, maskAffiliateVisitorIp(resolveClientAddress(req)));

    if (!admission.admitted) {
      return NextResponse.json(
        { success: false, error: admission.error },
        { status: 429, headers: { 'Retry-After': String(admission.retryAfterSeconds) } }
      );
    }

    const result = await syncFreemiusCheckoutOrder({
      orderId,
      checkoutResponse: body.checkoutResponse ?? body.response ?? null,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (error) {
    console.error('[Freemius Checkout Sync] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Freemius checkout sync failed' },
      { status: 500 }
    );
  }
}
