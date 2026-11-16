import { NextResponse } from 'next/server';

import { provisionFreemiusTrialLicense } from '@nextblock-cms/ecommerce/server';
import { getPackageById } from '@nextblock-cms/utils';

import {
  UNKNOWN_CLIENT_NETWORK,
  createVendorAdmission,
  resolveVendorClientNetwork,
  type VendorLimit,
} from '../vendor-route-limits';

/**
 * Vendor-side endpoint: mint a free trial key for a headless install.
 *
 * `create-nextblock --non-interactive --name … --email …` calls this so a coding agent
 * can scaffold a site with Cortex AI (and therefore the MCP server) working, without
 * anyone opening the dashboard to click "Start free trial". Only the deployment that
 * sells the packages (nextblock.dev) enables it — the same
 * `NEXTBLOCK_LICENSE_CLAIM_ENABLED=true` and vendor Freemius credentials (the developer key
 * pair) as `/api/packages/claim-license`; every other install answers 404.
 *
 * It mints Cortex AI trials only (`TRIAL_PACKAGE_IDS`): the CLI never asks for anything else, and
 * turning the vendor flag on for claims must not open trial minting for every package in the
 * registry. Another package id gets the unknown-package answer.
 *
 * The CLI writes the returned key to the project's env as NEXTBLOCK_LICENSE_KEY and the
 * app activates it on first use (lib/packages/env-license.ts). Nothing here reveals
 * whether an arbitrary email exists beyond the "already has a license" refusal, which
 * only the email's owner has any use for. Each provision spends the developer key pair the store's
 * other Freemius flows share (`vendor-route-limits.ts`): limited per client network, per email and
 * per instance.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_PACKAGE_ID = 'cortex-ai';
/** The packages this route mints trials for: the one the CLI asks for. */
const TRIAL_PACKAGE_IDS: ReadonlySet<string> = new Set([DEFAULT_PACKAGE_ID]);

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Per client network (an IPv4 /24, an IPv6 /48): a person scaffolds a handful of projects a day, not dozens an hour. */
const NETWORK_LIMIT: VendorLimit = { max: 5, windowMs: HOUR_MS };
/** Callers whose address cannot be read share one bucket, so it gets more room, never a free pass. */
const UNKNOWN_NETWORK_LIMIT: VendorLimit = { max: 20, windowMs: HOUR_MS };
/** Per email: retries after a transient failure, not a farm. */
const EMAIL_LIMIT: VendorLimit = { max: 3, windowMs: DAY_MS };
/** Provisions this instance runs per window, all callers together (each sends up to five Freemius requests). */
const INSTANCE_LIMIT: VendorLimit = { max: 10, windowMs: 60_000 };
const MAX_BUCKETS_PER_SCOPE = 10_000;

const admitProvision = createVendorAdmission({
  instance: INSTANCE_LIMIT,
  instanceRefusalLine: `[Trial provision] ${INSTANCE_LIMIT.max} trial provisions ran on this instance this minute; refusing more until the minute is over.`,
  maxBucketsPerScope: MAX_BUCKETS_PER_SCOPE,
});

function readString(value: unknown, maxLength: number) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
    ? value.trim()
    : null;
}

/** Practical email check (the WHATWG form-validation pattern), not a full RFC 5322 parser. */
const EMAIL_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function json(body: Record<string, unknown>, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store', ...headers }, status });
}

const REFUSALS: Record<string, string> = {
  email: 'Too many trial requests for this email. Try again tomorrow.',
  instance: 'The trial service is busy. Try again in a minute.',
  network: 'Too many trial requests from your network. Try again later.',
};

export async function POST(request: Request) {
  // The public sandbox never mints licenses, even with the vendor flag copied into its env: a trial
  // minted there is a real license on the operator's Freemius product.
  if (process.env.NEXTBLOCK_LICENSE_CLAIM_ENABLED !== 'true' || process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    return json({ error: 'Not found.', ok: false }, 404);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
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

  const pkg = TRIAL_PACKAGE_IDS.has(packageId) ? getPackageById(packageId) : null;

  if (!pkg || !pkg.fm_product_id || !pkg.fm_plan_id) {
    return json({ code: 'UNKNOWN_PACKAGE', error: 'Unknown NextBlock package.', ok: false }, 400);
  }

  if (!pkg.trial) {
    return json(
      { code: 'NO_TRIAL', error: `${pkg.name} does not offer a free trial.`, ok: false },
      400
    );
  }

  const network = resolveVendorClientNetwork(request);
  const admission = admitProvision([
    { scope: 'network', key: network, limit: network === UNKNOWN_CLIENT_NETWORK ? UNKNOWN_NETWORK_LIMIT : NETWORK_LIMIT },
    { scope: 'email', key: email, limit: EMAIL_LIMIT },
  ]);

  if (!admission.admitted) {
    return json(
      { code: 'RATE_LIMITED', error: REFUSALS[admission.refusedBy] ?? REFUSALS['network'], ok: false },
      429,
      { 'Retry-After': String(admission.retryAfterSeconds) }
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
