import { Freemius } from '@freemius/sdk';

import { hydrateFreemiusEnvFromDb } from './payment-config';
import { resolveFreemiusCheckoutCredentials } from './providers/freemius';

/**
 * Vendor-side headless trial provisioning.
 *
 * The in-dashboard trial goes through the Freemius checkout overlay, which collects the
 * buyer's name and email itself and creates a real Freemius *trial* (a subscription in a
 * trialing state). Freemius exposes no API to start such a trial from a name and an
 * email alone — the trial endpoint is install-scoped, and an install only exists once
 * the buyer's site has activated something.
 *
 * What the API does allow the vendor to do is mint a time-boxed license on the plan
 * (`POST .../plans/{plan}/pricing/{pricing}/licenses.json` with `expires_at`) and then
 * assign it to an email (`PUT /products/{product}/licenses.json`), which creates the
 * Freemius user if needed and sends the welcome email with the key. Functionally that is
 * the same 30-day, no-card trial the overlay produces: the buyer's CMS activates the key
 * normally, `package_activations.meta.nextblock.trial_ends_at` expires it locally, and
 * the daily revalidation sees Freemius report it expired. What it is not is a Freemius
 * subscription, so it never auto-converts — which a no-card trial cannot do anyway.
 *
 * Abuse controls: one trial per email per product (any existing license, even expired,
 * refuses a new one), plus the route's per-address and per-email rate limits. The
 * request is the buyer's own email, so the refusal names the reason.
 */

export type FreemiusTrialProvisionRequest = {
  email: string;
  name: string;
  /** Freemius plan the trial license is minted on (`fm_plan_id` in the package registry). */
  planId: string;
  /** Freemius product id (`fm_product_id` in the package registry). */
  productId: string;
  trialDays: number;
};

export type FreemiusTrialProvisionRejection = 'already_licensed' | 'no_key' | 'no_pricing';

export type FreemiusTrialProvisionResult =
  | {
      /** False when the license was minted but could not be tied to the email; the key still works. */
      assigned: boolean;
      expiresAt: string;
      licenseId: string | null;
      licenseKey: string;
      ok: true;
      planId: string;
      pricingId: string;
    }
  | {
      error: string;
      ok: false;
      reason: FreemiusTrialProvisionRejection | 'not_configured' | 'upstream_error';
      status: number;
    };

export const FREEMIUS_TRIAL_ALREADY_USED_MESSAGE =
  'A NextBlock license or trial already exists for this email. Activate that key from CMS Settings → Packages, or purchase a license at nextblock.dev.';

export const FREEMIUS_TRIAL_PROVISION_FAILED_MESSAGE =
  'The trial could not be provisioned automatically. Start it from CMS Settings → Packages instead.';

export type FreemiusPricingLike = {
  id?: string | number | null;
  is_hidden?: boolean | null;
  /** Site quota; null means unlimited. */
  licenses?: number | null;
};

export type FreemiusOwnedLicenseLike = {
  id?: string | number | null;
  plugin_id?: string | number | null;
};

/** Freemius timestamps are "YYYY-MM-DD HH:mm:ss" in UTC, without a zone marker. */
export function formatFreemiusTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function computeTrialExpiry(now: Date, trialDays: number): Date {
  const days = Number.isFinite(trialDays) && trialDays > 0 ? Math.floor(trialDays) : 30;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The plan's cheapest tier is the one to trial: a visible pricing with the smallest site
 * quota (a single-site license), falling back to whatever is listed first.
 */
export function pickTrialPricing(pricing: readonly FreemiusPricingLike[]): FreemiusPricingLike | null {
  const candidates = pricing.filter((entry) => entry.id !== null && entry.id !== undefined);

  if (candidates.length === 0) {
    return null;
  }

  const visible = candidates.filter((entry) => !entry.is_hidden);
  const pool = visible.length > 0 ? visible : candidates;

  return [...pool].sort((a, b) => {
    const quotaA = a.licenses === null || a.licenses === undefined ? Number.POSITIVE_INFINITY : a.licenses;
    const quotaB = b.licenses === null || b.licenses === undefined ? Number.POSITIVE_INFINITY : b.licenses;
    return quotaA - quotaB;
  })[0];
}

/** Pure decision: does this email already hold any license for the product? */
export function evaluateTrialEligibility(input: {
  existingLicenses: readonly FreemiusOwnedLicenseLike[];
  productId: string;
}): { ok: true } | { ok: false; reason: 'already_licensed' } {
  const owned = input.existingLicenses.some(
    (license) =>
      license.plugin_id === null ||
      license.plugin_id === undefined ||
      String(license.plugin_id).trim() === String(input.productId).trim()
  );

  return owned ? { ok: false, reason: 'already_licensed' } : { ok: true };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Mint and assign a trial license. The Freemius product-scope bearer credentials come
 * from the same resolver as the license claim route, so a vendor that already answers
 * claims needs no extra configuration.
 */
export async function provisionFreemiusTrialLicense(
  request: FreemiusTrialProvisionRequest,
  options?: { now?: Date }
): Promise<FreemiusTrialProvisionResult> {
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

  const email = normalizeEmail(request.email);
  const client = freemius.api.__unstable_ApiClient;
  const productPath = { product_id: request.productId };

  // 1. One trial per email: an existing Freemius user with any license for this product
  //    is refused, whatever the license's state.
  let existingLicenses: FreemiusOwnedLicenseLike[] = [];

  try {
    const user = await freemius.api.user.retrieveByEmail(email);

    if (user?.id !== null && user?.id !== undefined) {
      existingLicenses = (await freemius.api.user.retrieveLicenses(user.id)) as FreemiusOwnedLicenseLike[];
    }
  } catch (error) {
    console.error('[Freemius trial] user lookup failed:', error);

    return {
      error: 'Freemius could not be reached to verify eligibility.',
      ok: false,
      reason: 'upstream_error',
      status: 502,
    };
  }

  const eligibility = evaluateTrialEligibility({ existingLicenses, productId: request.productId });

  if (!eligibility.ok) {
    return { error: FREEMIUS_TRIAL_ALREADY_USED_MESSAGE, ok: false, reason: 'already_licensed', status: 409 };
  }

  // 2. The pricing tier to mint on (a license belongs to a plan AND a pricing).
  let pricingId: string | null = null;

  try {
    const { data, error } = await client.GET('/products/{product_id}/plans/{plan_id}/pricing.json', {
      params: { path: { ...productPath, plan_id: request.planId } },
    });

    if (error) {
      throw new Error(JSON.stringify(error));
    }

    const picked = pickTrialPricing((data?.pricing ?? []) as FreemiusPricingLike[]);
    pricingId = picked?.id !== null && picked?.id !== undefined ? String(picked.id) : null;
  } catch (error) {
    console.error('[Freemius trial] pricing lookup failed:', error);

    return {
      error: 'Freemius could not be reached to resolve the plan pricing.',
      ok: false,
      reason: 'upstream_error',
      status: 502,
    };
  }

  if (!pricingId) {
    return {
      error: FREEMIUS_TRIAL_PROVISION_FAILED_MESSAGE,
      ok: false,
      reason: 'no_pricing',
      status: 502,
    };
  }

  // 3. Mint the time-boxed license. No `email` here on purpose: Freemius only accepts it
  //    for users who already activated something; the assignment below handles new ones.
  const now = options?.now ?? new Date();
  const expiresAt = formatFreemiusTimestamp(computeTrialExpiry(now, request.trialDays));
  let licenseKey: string | null = null;
  let licenseId: string | null = null;

  try {
    const { data, error } = await client.POST(
      '/products/{product_id}/plans/{plan_id}/pricing/{pricing_id}/licenses.json',
      {
        body: { expires_at: expiresAt, is_block_features: true, send_email: false },
        params: { path: { ...productPath, plan_id: request.planId, pricing_id: pricingId } },
      }
    );

    if (error) {
      throw new Error(JSON.stringify(error));
    }

    const license = data?.license as { id?: string | number | null; secret_key?: string | null } | undefined;
    licenseKey = license?.secret_key?.trim() || null;
    licenseId = license?.id !== null && license?.id !== undefined ? String(license.id) : null;
  } catch (error) {
    console.error('[Freemius trial] license creation failed:', error);

    return {
      error: 'Freemius could not create the trial license.',
      ok: false,
      reason: 'upstream_error',
      status: 502,
    };
  }

  if (!licenseKey) {
    return { error: FREEMIUS_TRIAL_PROVISION_FAILED_MESSAGE, ok: false, reason: 'no_key', status: 502 };
  }

  // 4. Tie the license to the buyer. This creates the Freemius user when needed and
  //    sends the welcome email carrying the key, so the buyer can always recover it.
  //    Best-effort: the buyer's own activation (with user_email) registers the user too.
  let assigned = false;

  try {
    const { error } = await client.PUT('/products/{product_id}/licenses.json', {
      body: { email, license_key: licenseKey, name: request.name.trim() },
      params: { path: productPath },
    });

    assigned = !error;

    if (error) {
      console.warn('[Freemius trial] license assignment refused:', JSON.stringify(error));
    }
  } catch (error) {
    console.warn('[Freemius trial] license assignment failed:', error);
  }

  return {
    assigned,
    expiresAt,
    licenseId,
    licenseKey,
    ok: true,
    planId: request.planId,
    pricingId,
  };
}
