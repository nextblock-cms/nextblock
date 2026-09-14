import { Freemius } from '@freemius/sdk';

import { hydrateFreemiusEnvFromDb } from './payment-config';
import { resolveFreemiusCheckoutCredentials } from './providers/freemius';

/**
 * Vendor-side license claim.
 *
 * The Freemius checkout overlay tells the buyer's browser only WHICH license was
 * created (`purchase.license_id` / `trial.license_id`, the buyer's user id and email),
 * never the key itself; the key is emailed, and the API only reveals it to the vendor.
 * So a CMS that just sold itself a NextBlock package cannot activate on its own.
 *
 * This module runs on the vendor deployment (nextblock.dev): given the ids the buyer's
 * CMS got back from the checkout, it looks the license up with the vendor's Freemius
 * credentials, checks that the claim is plausible, and returns the key so the buyer's
 * CMS can activate it immediately. Everything here is server code.
 *
 * Threat model: license ids and user ids are sequential and an email is guessable, so
 * a claim is honoured only when ALL of these hold — the license was created minutes
 * ago, it belongs to the product, to the claimed user, whose email matches, it is not
 * cancelled, and it has never been activated (the buyer's own activation happens right
 * after the claim, so a second claim for the same license is refused). Rejections are
 * reported to the caller as one opaque message; the reason is logged server-side only.
 */

export type FreemiusLicenseClaimRequest = {
  /** Buyer email as reported by the checkout (`user.email`). */
  email: string;
  /** 'trial' when the checkout returned a `trial` object, 'purchase' otherwise. */
  kind: 'purchase' | 'trial';
  /** `purchase.license_id` or `trial.license_id` from the checkout response. */
  licenseId: string;
  /** Freemius product id the license must belong to. */
  productId: string;
  /** `user.id` from the checkout response. Required: it is the second factor of the claim. */
  userId: string;
};

export type FreemiusLicenseRecordLike = {
  activated?: number | null;
  created?: string | null;
  expiration?: string | null;
  id?: string | number | null;
  is_cancelled?: boolean | null;
  plan_id?: string | number | null;
  plugin_id?: string | number | null;
  secret_key?: string | null;
  user_id?: string | number | null;
};

export type FreemiusUserRecordLike = {
  email?: string | null;
  id?: string | number | null;
};

export type FreemiusLicenseClaimRejection =
  | 'already_activated'
  | 'cancelled'
  | 'email_mismatch'
  | 'license_not_found'
  | 'no_key'
  | 'product_mismatch'
  | 'too_old'
  | 'user_mismatch';

export type FreemiusLicenseClaimDecision =
  | { ok: true }
  | { ok: false; reason: FreemiusLicenseClaimRejection };

/** A claim must follow the checkout closely; the callback fires within seconds. */
export const FREEMIUS_LICENSE_CLAIM_MAX_AGE_MINUTES = 20;

/** What every refused claim tells the caller, whatever the reason. */
export const FREEMIUS_LICENSE_CLAIM_REFUSED_MESSAGE =
  'This license cannot be claimed automatically. Use the key from your purchase email.';

/** Freemius timestamps are "YYYY-MM-DD HH:mm:ss" in UTC, without a zone marker. */
export function parseFreemiusTimestamp(value: string | null | undefined): number | null {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const normalized = hasZone ? trimmed : `${trimmed.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);

  return Number.isFinite(parsed) ? parsed : null;
}

function sameId(left: string | number | null | undefined, right: string | number | null | undefined) {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }

  return String(left).trim() === String(right).trim();
}

function normalizeEmail(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Pure decision: is this claim the buyer's own, fresh, never-activated license?
 *
 * The freshness window is checked before any identity comparison so the outcome never
 * reveals whether an older license's owner or email matched.
 */
export function evaluateFreemiusLicenseClaim(input: {
  license: FreemiusLicenseRecordLike | null | undefined;
  maxAgeMinutes?: number;
  now?: Date;
  request: FreemiusLicenseClaimRequest;
  user: FreemiusUserRecordLike | null | undefined;
}): FreemiusLicenseClaimDecision {
  const { license, request, user } = input;
  const maxAgeMinutes = input.maxAgeMinutes ?? FREEMIUS_LICENSE_CLAIM_MAX_AGE_MINUTES;
  const now = (input.now ?? new Date()).getTime();

  if (!license || !sameId(license.id, request.licenseId)) {
    return { ok: false, reason: 'license_not_found' };
  }

  const created = parseFreemiusTimestamp(license.created);

  if (created === null || now - created > maxAgeMinutes * 60_000 || created - now > 5 * 60_000) {
    return { ok: false, reason: 'too_old' };
  }

  if (!sameId(license.plugin_id, request.productId)) {
    return { ok: false, reason: 'product_mismatch' };
  }

  if (license.is_cancelled) {
    return { ok: false, reason: 'cancelled' };
  }

  if (!request.userId?.trim() || !sameId(license.user_id, request.userId)) {
    return { ok: false, reason: 'user_mismatch' };
  }

  if (!user || !normalizeEmail(request.email) || normalizeEmail(user.email) !== normalizeEmail(request.email)) {
    return { ok: false, reason: 'email_mismatch' };
  }

  // The legitimate buyer activates only after this claim; a license that already has
  // an activation was either claimed already or set up by hand — refuse a second key
  // hand-out either way.
  if (typeof license.activated === 'number' && license.activated > 0) {
    return { ok: false, reason: 'already_activated' };
  }

  if (!license.secret_key) {
    return { ok: false, reason: 'no_key' };
  }

  return { ok: true };
}

export type FreemiusLicenseClaimResult =
  | {
      expiration: string | null;
      licenseKey: string;
      ok: true;
      planId: string | null;
    }
  | {
      error: string;
      ok: false;
      /** Detailed cause, for logs only; the route never sends it to the caller. */
      reason: FreemiusLicenseClaimRejection | 'not_configured' | 'upstream_error';
      status: number;
    };

/**
 * Look the license up with the vendor credentials for `productId` and return its key
 * when `evaluateFreemiusLicenseClaim` accepts the claim.
 */
export async function claimFreemiusLicenseKey(
  request: FreemiusLicenseClaimRequest,
  options?: { maxAgeMinutes?: number; now?: Date }
): Promise<FreemiusLicenseClaimResult> {
  await hydrateFreemiusEnvFromDb();

  const credentials = resolveFreemiusCheckoutCredentials(request.productId);

  if (!credentials.apiKey || !credentials.secretKey || !credentials.publicKey) {
    return {
      error: 'The license service is not configured for this product.',
      ok: false,
      reason: 'not_configured',
      status: 503,
    };
  }

  const freemius = new Freemius({
    apiKey: credentials.apiKey,
    productId: Number(request.productId),
    publicKey: credentials.publicKey,
    secretKey: credentials.secretKey,
  });

  let license: FreemiusLicenseRecordLike | null = null;
  let user: FreemiusUserRecordLike | null = null;

  try {
    license = (await freemius.api.license.retrieve(request.licenseId)) as FreemiusLicenseRecordLike | null;

    if (license?.user_id !== null && license?.user_id !== undefined) {
      user = (await freemius.api.user.retrieve(String(license.user_id))) as FreemiusUserRecordLike | null;
    }
  } catch (error) {
    console.error('[Freemius License Claim] Freemius lookup failed:', error);

    return {
      error: 'Freemius could not be reached to verify the license.',
      ok: false,
      reason: 'upstream_error',
      status: 502,
    };
  }

  const decision = evaluateFreemiusLicenseClaim({
    license,
    maxAgeMinutes: options?.maxAgeMinutes,
    now: options?.now,
    request,
    user,
  });

  if (!decision.ok) {
    return {
      error: FREEMIUS_LICENSE_CLAIM_REFUSED_MESSAGE,
      ok: false,
      reason: decision.reason,
      status: 403,
    };
  }

  return {
    expiration: license?.expiration ?? null,
    licenseKey: String(license?.secret_key),
    ok: true,
    planId: license?.plan_id !== null && license?.plan_id !== undefined ? String(license.plan_id) : null,
  };
}
