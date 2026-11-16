import { NextResponse } from 'next/server';

import { FREEMIUS_LICENSE_CLAIM_REFUSED_MESSAGE, claimFreemiusLicenseKey } from '@nextblock-cms/ecommerce/server';
import { getPackageByFreemiusId } from '@nextblock-cms/utils';

import {
  UNKNOWN_CLIENT_NETWORK,
  createVendorAdmission,
  resolveVendorClientNetwork,
  type VendorLimit,
} from '../vendor-route-limits';

/**
 * Vendor-side endpoint: hand a freshly purchased NextBlock package key back to the
 * buyer's CMS so it can activate without the operator pasting anything.
 *
 * Only the deployment that sells the packages (nextblock.dev) enables this, with
 * `NEXTBLOCK_LICENSE_CLAIM_ENABLED=true` and the vendor's Freemius developer key pair, which
 * reaches every product it sells (24851 / 28609 / 43273; per-product keys are only the
 * fallback). Every other install answers 404, and so does the public sandbox whatever its env
 * says: copied there, the flag would let any visitor's claims spend the operator's keys. The buyer's
 * CMS calls it server-to-server from `activatePurchasedPackage` right after the Freemius checkout
 * overlay reports success; see libs/ecommerce/src/lib/freemius-license-claim.ts for
 * the checks that decide whether a claim is honoured. Refusals are deliberately
 * uniform (same status, same message) so the endpoint is not an oracle for which
 * licenses, users, or emails exist.
 *
 * Every lookup spends the developer key pair the store's other Freemius flows share
 * (`vendor-route-limits.ts`), so claims are limited per client network, per license and per
 * instance, and a license id Freemius just answered "no such license" for is refused from memory
 * for a minute instead of being looked up again.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TEN_MINUTES_MS = 10 * 60_000;
/** Claims one client network (an IPv4 /24, an IPv6 /48) may send to Freemius per window. */
const NETWORK_LIMIT: VendorLimit = { max: 30, windowMs: TEN_MINUTES_MS };
/** Callers whose address cannot be read share one bucket, so it gets more room, never a free pass. */
const UNKNOWN_NETWORK_LIMIT: VendorLimit = { max: 60, windowMs: TEN_MINUTES_MS };
/** Lookups of one license per window, whatever the network: one license cannot be hammered from many. */
const LICENSE_LIMIT: VendorLimit = { max: 10, windowMs: TEN_MINUTES_MS };
/** Lookups this instance sends to Freemius per window, all callers together. A buyer claims once. */
const INSTANCE_LIMIT: VendorLimit = { max: 30, windowMs: 60_000 };
const MAX_BUCKETS_PER_SCOPE = 10_000;

/** How long a license Freemius answered "no such license" for is refused without asking again. */
const MISS_TTL_MS = 60_000;
const MAX_REMEMBERED_MISSES = 1_000;

const admitLookup = createVendorAdmission({
  instance: INSTANCE_LIMIT,
  instanceRefusalLine: `[License claim] ${INSTANCE_LIMIT.max} Freemius lookups ran on this instance this minute; refusing more claims until the minute is over.`,
  maxBucketsPerScope: MAX_BUCKETS_PER_SCOPE,
});

/**
 * `<product id>:<license id>` → when the miss expires. Repeated claims of the same random license id
 * then cost one lookup a minute, not one each. Only an answered miss is remembered (never a failed
 * lookup or a refused key), and only for admitted lookups, so at most INSTANCE_LIMIT.max new
 * entries a minute; the oldest goes first past MAX_REMEMBERED_MISSES.
 */
const recentMisses = new Map<string, number>();

function isRecentMiss(key: string, now: number) {
  const until = recentMisses.get(key);

  if (until === undefined) {
    return false;
  }

  if (until <= now) {
    recentMisses.delete(key);
    return false;
  }

  return true;
}

function rememberMiss(key: string, now: number) {
  for (const [entry, until] of recentMisses) {
    if (until <= now) recentMisses.delete(entry);
  }

  recentMisses.delete(key);

  for (const oldest of recentMisses.keys()) {
    if (recentMisses.size < MAX_REMEMBERED_MISSES) break;
    recentMisses.delete(oldest);
  }

  recentMisses.set(key, now + MISS_TTL_MS);
}

function readString(value: unknown, maxLength: number) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
    ? value.trim()
    : null;
}

function json(body: Record<string, unknown>, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store', ...headers }, status });
}

const refused = () => json({ error: FREEMIUS_LICENSE_CLAIM_REFUSED_MESSAGE, ok: false }, 403);

export async function POST(request: Request) {
  // Off the vendor deployment, and on the public sandbox even with the flag copied into its env,
  // there is no claim service: nothing is read, nothing is counted, no key is resolved.
  if (process.env.NEXTBLOCK_LICENSE_CLAIM_ENABLED !== 'true' || process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    return json({ error: 'Not found.', ok: false }, 404);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
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

  // Only the NextBlock packages sold here can be claimed: the vendor keys reach every product of the
  // account, and nothing else may be looked up with them.
  if (!getPackageByFreemiusId(productId)) {
    return json({ error: 'Unknown NextBlock package.', ok: false }, 400);
  }

  const now = Date.now();
  const missKey = `${productId}:${licenseId}`;

  if (isRecentMiss(missKey, now)) {
    return refused();
  }

  const network = resolveVendorClientNetwork(request);
  const admission = admitLookup(
    [
      { scope: 'network', key: network, limit: network === UNKNOWN_CLIENT_NETWORK ? UNKNOWN_NETWORK_LIMIT : NETWORK_LIMIT },
      { scope: 'license', key: licenseId, limit: LICENSE_LIMIT },
    ],
    now
  );

  if (!admission.admitted) {
    const retryAfter = { 'Retry-After': String(admission.retryAfterSeconds) };

    if (admission.refusedBy === 'license') {
      // The uniform refusal: a busy license id must not read differently from a refused one.
      return refused();
    }

    return admission.refusedBy === 'instance'
      ? json({ error: 'License claims are busy. Try again in a minute.', ok: false }, 429, retryAfter)
      : json({ error: 'Too many claims from your network. Try again later.', ok: false }, 429, retryAfter);
  }

  const result = await claimFreemiusLicenseKey({ email, kind, licenseId, productId, userId });

  if (!result.ok) {
    if (result.reason === 'not_configured' || result.reason === 'upstream_error') {
      console.error('[License claim] unavailable:', result.reason);
      return json({ error: result.error, ok: false }, result.status);
    }

    if (result.reason === 'license_not_found') {
      rememberMiss(missKey, Date.now());
    }

    // A refused vendor key is a configuration error the claim module already logged (throttled).
    if (result.reason !== 'credentials_refused') {
      console.warn(`[License claim] refused license ${licenseId} for product ${productId}: ${result.reason}`);
    }

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
