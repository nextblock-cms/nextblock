import { NextResponse } from 'next/server';

import { provisionFreemiusTrialLicense } from '@nextblock-cms/ecommerce/server';
import { getPackageById } from '@nextblock-cms/utils';

/**
 * Vendor-side endpoint: mint a free trial key for a headless install.
 *
 * `create-nextblock --non-interactive --name … --email …` calls this so a coding agent
 * can scaffold a site with Cortex AI (and therefore the MCP server) working, without
 * anyone opening the dashboard to click "Start free trial". Only the deployment that
 * sells the packages (nextblock.dev) enables it — the same
 * `NEXTBLOCK_LICENSE_CLAIM_ENABLED=true` and vendor Freemius credentials as
 * `/api/packages/claim-license`; every other install answers 404.
 *
 * The CLI writes the returned key to the project's env as NEXTBLOCK_LICENSE_KEY and the
 * app activates it on first use (lib/packages/env-license.ts). Nothing here reveals
 * whether an arbitrary email exists beyond the "already has a license" refusal, which
 * only the email's owner has any use for; the rate limits below blunt probing.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_PACKAGE_ID = 'cortex-ai';

const RATE_LIMIT_MAX_BUCKETS = 10_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Per address: a person scaffolds a handful of projects a day, not dozens an hour. */
const PER_ADDRESS_LIMIT = { max: 5, windowMs: HOUR_MS };
/** Callers whose address cannot be determined share one stricter bucket. */
const UNKNOWN_ADDRESS_LIMIT = { max: 20, windowMs: HOUR_MS };
/** Per email: retries after a transient failure, not a farm. */
const PER_EMAIL_LIMIT = { max: 3, windowMs: DAY_MS };

/**
 * Best-effort, per-process limiter (not shared across serverless instances, resets on
 * cold start). The real ceiling is Freemius-side: one license per email per product.
 */
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(key: string, limit: { max: number; windowMs: number }, now = Date.now()) {
  for (const [bucketKey, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) {
      rateLimitBuckets.delete(bucketKey);
    }
  }

  if (rateLimitBuckets.size >= RATE_LIMIT_MAX_BUCKETS && !rateLimitBuckets.has(key)) {
    return true;
  }

  const bucket = rateLimitBuckets.get(key);

  if (!bucket) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + limit.windowMs });
    return false;
  }

  bucket.count += 1;

  return bucket.count > limit.max;
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

/** Practical email check (the WHATWG form-validation pattern), not a full RFC 5322 parser. */
const EMAIL_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function json(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' }, status });
}

export async function POST(request: Request) {
  if (process.env.NEXTBLOCK_LICENSE_CLAIM_ENABLED !== 'true') {
    return json({ error: 'Not found.', ok: false }, 404);
  }

  const address = resolveClientAddress(request);

  if (
    address
      ? isRateLimited(`ip:${address}`, PER_ADDRESS_LIMIT)
      : isRateLimited('unknown', UNKNOWN_ADDRESS_LIMIT)
  ) {
    return json(
      { code: 'RATE_LIMITED', error: 'Too many trial requests from this address. Try again later.', ok: false },
      429
    );
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (!body) {
    return json({ code: 'INVALID_REQUEST', error: 'Invalid request body.', ok: false }, 400);
  }

  const email = readString(body['email'], 320)?.toLowerCase() ?? null;
  const name = readString(body['name'], 120);
  const packageId = readString(body['packageId'], 64) ?? DEFAULT_PACKAGE_ID;

  if (!email || !EMAIL_PATTERN.test(email) || !name) {
    return json(
      { code: 'INVALID_REQUEST', error: 'A name and a valid email are required.', ok: false },
      400
    );
  }

  const pkg = getPackageById(packageId);

  if (!pkg || !pkg.fm_product_id || !pkg.fm_plan_id) {
    return json({ code: 'UNKNOWN_PACKAGE', error: 'Unknown NextBlock package.', ok: false }, 400);
  }

  if (!pkg.trial) {
    return json(
      { code: 'NO_TRIAL', error: `${pkg.name} does not offer a free trial.`, ok: false },
      400
    );
  }

  if (isRateLimited(`email:${email}`, PER_EMAIL_LIMIT)) {
    return json(
      { code: 'RATE_LIMITED', error: 'Too many trial requests for this email. Try again tomorrow.', ok: false },
      429
    );
  }

  const result = await provisionFreemiusTrialLicense({
    email,
    name,
    planId: pkg.fm_plan_id,
    productId: pkg.fm_product_id,
    trialDays: pkg.trial.days,
  });

  if (!result.ok) {
    if (result.reason === 'already_licensed') {
      return json({ code: 'TRIAL_ALREADY_USED', error: result.error, ok: false }, result.status);
    }

    console.error(`[Trial provision] ${result.reason} for package ${pkg.id}: ${result.error}`);

    return json(
      { code: result.reason === 'not_configured' ? 'NOT_CONFIGURED' : 'UPSTREAM_ERROR', error: result.error, ok: false },
      result.status
    );
  }

  return json(
    {
      assigned: result.assigned,
      expiresAt: result.expiresAt,
      kind: 'trial',
      licenseKey: result.licenseKey,
      ok: true,
      packageId: pkg.id,
      planId: result.planId,
      trialDays: pkg.trial.days,
    },
    200
  );
}
