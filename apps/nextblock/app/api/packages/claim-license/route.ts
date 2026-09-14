import { NextResponse } from 'next/server';

import { FREEMIUS_LICENSE_CLAIM_REFUSED_MESSAGE, claimFreemiusLicenseKey } from '@nextblock-cms/ecommerce/server';
import { getPackageByFreemiusId } from '@nextblock-cms/utils';

/**
 * Vendor-side endpoint: hand a freshly purchased NextBlock package key back to the
 * buyer's CMS so it can activate without the operator pasting anything.
 *
 * Only the deployment that sells the packages (nextblock.dev) enables this, with
 * `NEXTBLOCK_LICENSE_CLAIM_ENABLED=true` and the vendor Freemius credentials for
 * products 24851 / 28609. Every other install answers 404. The buyer's CMS calls it
 * server-to-server from `activatePurchasedPackage` right after the Freemius checkout
 * overlay reports success; see libs/ecommerce/src/lib/freemius-license-claim.ts for
 * the checks that decide whether a claim is honoured. Refusals are deliberately
 * uniform (same status, same message) so the endpoint is not an oracle for which
 * licenses, users, or emails exist.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;
/** Callers whose address cannot be determined share one stricter bucket. */
const RATE_LIMIT_MAX_UNKNOWN_REQUESTS = 60;
const RATE_LIMIT_MAX_BUCKETS = 10_000;

/**
 * Best-effort, per-process limiter: it is not shared across serverless instances and
 * resets on cold start. The real ceiling on abuse is the claim policy itself (fresh,
 * never-activated license + matching user id + matching email); this only blunts
 * brute-force probing from one address. Expired buckets are pruned on every call so
 * the map cannot grow without bound.
 */
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(key: string, limit: number, now = Date.now()) {
  for (const [bucketKey, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) {
      rateLimitBuckets.delete(bucketKey);
    }
  }

  if (rateLimitBuckets.size >= RATE_LIMIT_MAX_BUCKETS && !rateLimitBuckets.has(key)) {
    // Under a flood, new addresses are refused rather than allowed to grow the map.
    return true;
  }

  const bucket = rateLimitBuckets.get(key);

  if (!bucket) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  bucket.count += 1;

  return bucket.count > limit;
}

/** Prefer the platform-set address headers over the client-appendable x-forwarded-for. */
function resolveClientAddress(request: Request) {
  const candidates = [
    request.headers.get('x-vercel-forwarded-for'),
    request.headers.get('x-real-ip'),
    request.headers.get('cf-connecting-ip'),
    request.headers.get('x-forwarded-for')?.split(',')[0],
  ];

  for (const candidate of candidates) {
    const trimmed = candidate?.trim();

    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

function readString(value: unknown, maxLength: number) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
    ? value.trim()
    : null;
}

function json(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' }, status });
}

const refused = () => json({ error: FREEMIUS_LICENSE_CLAIM_REFUSED_MESSAGE, ok: false }, 403);

export async function POST(request: Request) {
  if (process.env.NEXTBLOCK_LICENSE_CLAIM_ENABLED !== 'true') {
    return json({ error: 'Not found.', ok: false }, 404);
  }

  const address = resolveClientAddress(request);

  if (
    address
      ? isRateLimited(`ip:${address}`, RATE_LIMIT_MAX_REQUESTS)
      : isRateLimited('unknown', RATE_LIMIT_MAX_UNKNOWN_REQUESTS)
  ) {
    return json({ error: 'Too many claims from this address. Try again later.', ok: false }, 429);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (!body) {
    return json({ error: 'Invalid request body.', ok: false }, 400);
  }

  const productId = readString(body['productId'], 32);
  const licenseId = readString(body['licenseId'], 32);
  const email = readString(body['email'], 320);
  const userId = readString(body['userId'], 32);
  const kind = body['kind'] === 'trial' ? 'trial' : body['kind'] === 'purchase' ? 'purchase' : null;

  if (
    !productId ||
    !licenseId ||
    !email ||
    !userId ||
    !kind ||
    !/^\d+$/.test(productId) ||
    !/^\d+$/.test(licenseId) ||
    !/^\d+$/.test(userId)
  ) {
    return json({ error: 'productId, licenseId, userId, email, and kind are required.', ok: false }, 400);
  }

  if (!getPackageByFreemiusId(productId)) {
    return json({ error: 'Unknown NextBlock package.', ok: false }, 400);
  }

  // Per-license bucket too, so one license cannot be hammered from many addresses.
  if (isRateLimited(`license:${licenseId}`, 10)) {
    return refused();
  }

  const result = await claimFreemiusLicenseKey({ email, kind, licenseId, productId, userId });

  if (!result.ok) {
    if (result.reason === 'not_configured' || result.reason === 'upstream_error') {
      console.error('[License claim] unavailable:', result.reason);
      return json({ error: result.error, ok: false }, result.status);
    }

    console.warn(`[License claim] refused license ${licenseId} for product ${productId}: ${result.reason}`);
    return refused();
  }

  return json(
    {
      expiration: result.expiration,
      licenseKey: result.licenseKey,
      ok: true,
      planId: result.planId,
    },
    200
  );
}
