import { Freemius } from '@freemius/sdk';

import {
  FreemiusApiError,
  canUseFreemiusDeveloperScope,
  freemiusDeveloperRequest,
  isFreemiusApiError,
  toFreemiusId,
} from './freemius-developer-api';
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
 * assign it to an email (`PUT .../licenses.json`; at developer scope both live under
 * `/developers/{dev}/plugins/{product}/`, with the product's bearer under `/products/{product}/`), which creates the
 * Freemius user if needed and sends the welcome email with the key. Functionally that is
 * the same 30-day, no-card trial the overlay produces: the buyer's CMS activates the key
 * normally, `package_activations.meta.nextblock.trial_ends_at` expires it locally, and
 * the daily revalidation sees Freemius report it expired. What it is not is a Freemius
 * subscription, so it never auto-converts — which a no-card trial cannot do anyway.
 *
 * Abuse controls: one trial per email per product (any existing license, even expired,
 * refuses a new one), plus the route's limits (Cortex AI only; per client network, per email and
 * per instance). The request is the buyer's own email, so the refusal names the reason.
 *
 * The one-trial rule fails closed (review 2026-11-13). Eligibility is read only from a conclusive
 * Freemius answer: a lookup that fails (non-2xx, network error, timeout) or answers with something
 * other than the list it asked for is a 502, never "this email holds no license" (the SDK reads any
 * failure as no user and no licenses, so the bearer path asks with the typed client instead). And a
 * license minted whose assignment failed belongs to no Freemius user, so the email's own lookup
 * cannot show it: this instance remembers it (`unassignedTrials`) and refuses the email while that
 * license stands at Freemius.
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

/** Freemius refused the developer key pair (401/403) before any license existed: the bearer may still work. */
const REFUSED_BEFORE_LICENSE = Symbol('refused-before-license');

/**
 * The Freemius calls a trial needs: at developer scope, or with the product's bearer token. The
 * lookups throw whenever Freemius gives no conclusive answer (see `firstUserId`, `licenseList`).
 */
type FreemiusTrialApi = {
  /** The Freemius user with this email, null when Freemius answered that there is none. */
  findUserIdByEmail(email: string): Promise<string | null>;
  /** That user's licenses for the product. */
  listUserLicenses(userId: string): Promise<FreemiusOwnedLicenseLike[]>;
  /** Whether a license minted earlier still stands: `gone` once Freemius has no such license or cancelled it. */
  readLicense(licenseId: string): Promise<'live' | 'gone'>;
  listPlanPricing(): Promise<FreemiusPricingLike[]>;
  createLicense(
    pricingId: string,
    body: { expires_at: string; is_block_features: boolean; send_email: boolean }
  ): Promise<{ id?: string | number | null; secret_key?: string | null } | null>;
  /** Throws when Freemius refuses the assignment. */
  assignLicense(body: { email: string; license_key: string; name: string }): Promise<void>;
};

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

/** An answer that settles nothing (no list, a user without an id): read like Freemius not answering. */
function inconclusive(message: string): FreemiusApiError {
  return new FreemiusApiError('unavailable', message);
}

/**
 * The user a `users.json?email=` answer names: null only for an empty list. A body without a
 * `users` list, a user without an id, or a user listed under another email is no answer: it throws,
 * so the caller refuses (502) instead of reading "no user" and minting a second trial.
 */
function firstUserId(users: unknown, email: string): string | null {
  if (!Array.isArray(users)) {
    throw inconclusive('Freemius answered the user lookup without a user list.');
  }

  if (users.length === 0) {
    return null;
  }

  const user = asRecord(users[0]);
  const id = toFreemiusId(user?.['id']);
  const listedEmail = typeof user?.['email'] === 'string' ? user['email'].trim().toLowerCase() : null;

  if (!id || (listedEmail !== null && listedEmail !== email)) {
    throw inconclusive('Freemius answered the user lookup with a user that is not the one asked for.');
  }

  return id;
}

/** A `licenses` list; anything else throws (an unreadable answer never means "no license"). */
function licenseList(licenses: unknown): FreemiusOwnedLicenseLike[] {
  if (!Array.isArray(licenses)) {
    throw inconclusive('Freemius answered the license lookup without a license list.');
  }

  return licenses as FreemiusOwnedLicenseLike[];
}

/**
 * `gone` for a cancelled license, `live` otherwise; a body that is not that license (none, unreadable,
 * another id) throws. A 404 is the caller's to read as `gone`: an empty 2xx is no answer.
 */
function licenseState(license: unknown, licenseId: string): 'live' | 'gone' {
  const record = asRecord(license);

  if (!record || toFreemiusId(record['id']) !== licenseId) {
    throw inconclusive('Freemius answered the license read without that license.');
  }

  return record['is_cancelled'] === true ? 'gone' : 'live';
}

/** A product-scope (bearer) request Freemius answered with an error status, as the developer module's error kinds. */
function bearerFailure(status: number, what: string): FreemiusApiError {
  const kind = status === 401 || status === 403 ? 'auth' : status === 404 ? 'not_found' : status === 429 || status >= 500 ? 'unavailable' : 'rejected';

  return new FreemiusApiError(kind, `Freemius answered the ${what} with ${status}.`, { status });
}

/** The trial calls with the developer key pair (every id digits: `toFreemiusId`). */
function developerTrialApi(productId: string, planId: string): FreemiusTrialApi {
  return {
    async findUserIdByEmail(email) {
      const body = asRecord(
        await freemiusDeveloperRequest({ path: `/plugins/${productId}/users.json`, query: { email, count: 1 } })
      );

      return firstUserId(body?.['users'], email);
    },
    async listUserLicenses(userId) {
      const id = toFreemiusId(userId);

      if (!id) {
        throw inconclusive('The user id Freemius returned is not a Freemius id.');
      }

      const body = asRecord(
        await freemiusDeveloperRequest({ path: `/plugins/${productId}/users/${id}/licenses.json`, query: { count: 50 } })
      );

      return licenseList(body?.['licenses']);
    },
    async readLicense(licenseId) {
      const id = toFreemiusId(licenseId);

      if (!id) {
        throw inconclusive('The remembered license id is not a Freemius id.');
      }

      let license: unknown;

      try {
        license = await freemiusDeveloperRequest({ path: `/plugins/${productId}/licenses/${id}.json` });
      } catch (error) {
        if (isFreemiusApiError(error) && error.kind === 'not_found') return 'gone';
        throw error;
      }

      return licenseState(license, id);
    },
    async listPlanPricing() {
      const body = asRecord(await freemiusDeveloperRequest({ path: `/plugins/${productId}/plans/${planId}/pricing.json` }));

      return Array.isArray(body?.['pricing']) ? (body?.['pricing'] as FreemiusPricingLike[]) : [];
    },
    async createLicense(pricingId, payload) {
      const id = toFreemiusId(pricingId);

      if (!id) return null;

      const body = asRecord(
        await freemiusDeveloperRequest({
          method: 'POST',
          path: `/plugins/${productId}/plans/${planId}/pricing/${id}/licenses.json`,
          body: payload,
        })
      );

      return asRecord(body?.['license']) ?? body;
    },
    async assignLicense(payload) {
      await freemiusDeveloperRequest({ method: 'PUT', path: `/plugins/${productId}/licenses.json`, body: payload });
    },
  };
}

/**
 * The trial calls with the product's bearer token (`@freemius/sdk`'s typed client), as before the
 * developer key pair. The lookups use the client, not `api.user.retrieveByEmail` /
 * `retrieveLicenses`: those return null and [] for ANY failure (401, 429, 500), which read as "this
 * email holds no license" and minted a trial whenever Freemius failed to answer.
 */
function bearerTrialApi(freemius: Freemius, productId: string, planId: string): FreemiusTrialApi {
  const client = freemius.api.__unstable_ApiClient;
  const productPath = { product_id: productId };

  return {
    async findUserIdByEmail(email) {
      const { data, response } = await client.GET('/products/{product_id}/users.json', {
        params: { path: productPath, query: { email, count: 1 } },
      });

      if (!response.ok) {
        throw bearerFailure(response.status, 'user lookup');
      }

      return firstUserId(asRecord(data)?.['users'], email);
    },
    async listUserLicenses(userId) {
      const id = toFreemiusId(userId);

      if (!id) {
        throw inconclusive('The user id Freemius returned is not a Freemius id.');
      }

      const { data, response } = await client.GET('/products/{product_id}/users/{user_id}/licenses.json', {
        params: { path: { ...productPath, user_id: id }, query: { count: 50 } },
      });

      if (!response.ok) {
        throw bearerFailure(response.status, 'license lookup');
      }

      return licenseList(asRecord(data)?.['licenses']);
    },
    async readLicense(licenseId) {
      const id = toFreemiusId(licenseId);

      if (!id) {
        throw inconclusive('The remembered license id is not a Freemius id.');
      }

      const { data, response } = await client.GET('/products/{product_id}/licenses/{license_id}.json', {
        params: { path: { ...productPath, license_id: id } },
      });

      if (response.status === 404) {
        return 'gone';
      }

      if (!response.ok) {
        throw bearerFailure(response.status, 'license read');
      }

      return licenseState(data, id);
    },
    async listPlanPricing() {
      const { data, error } = await client.GET('/products/{product_id}/plans/{plan_id}/pricing.json', {
        params: { path: { ...productPath, plan_id: planId } },
      });

      if (error) {
        throw new Error(JSON.stringify(error));
      }

      return (data?.pricing ?? []) as FreemiusPricingLike[];
    },
    async createLicense(pricingId, body) {
      const { data, error } = await client.POST(
        '/products/{product_id}/plans/{plan_id}/pricing/{pricing_id}/licenses.json',
        { body, params: { path: { ...productPath, plan_id: planId, pricing_id: pricingId } } }
      );

      if (error) {
        throw new Error(JSON.stringify(error));
      }

      return (data?.license ?? null) as { id?: string | number | null; secret_key?: string | null } | null;
    },
    async assignLicense(body) {
      const { error } = await client.PUT('/products/{product_id}/licenses.json', {
        body,
        params: { path: productPath },
      });

      if (error) {
        throw new Error(JSON.stringify(error));
      }
    },
  };
}

function isRefusedPair(error: unknown): boolean {
  return isFreemiusApiError(error) && (error.kind === 'auth' || error.kind === 'not_configured' || error.kind === 'sandbox');
}

function describeTrialError(error: unknown): string {
  if (isFreemiusApiError(error)) {
    return `${error.kind} ${error.status ?? ''} ${error.message}`.replace(/\s+/g, ' ').trim();
  }

  return error instanceof Error ? error.message : 'unexpected error';
}

type UnassignedTrial = { licenseId: string | null; until: number };

/**
 * Trials this instance minted whose assignment Freemius refused or never answered, by
 * `<product id>:<email>`. Such a license belongs to no Freemius user, so the email's lookup cannot
 * show it, and without this record the same email minted again on every request. Kept for the
 * trial's length (the license expires then), bounded (the oldest goes first), memory only: a cold
 * start forgets it, and each serverless instance has its own.
 */
const unassignedTrials = new Map<string, UnassignedTrial>();
const UNASSIGNED_TRIALS_MAX = 1_000;

function rememberUnassignedTrial(key: string, licenseId: string | null, trialDays: number): void {
  const now = Date.now();

  for (const [entryKey, entry] of unassignedTrials) {
    if (entry.until <= now) unassignedTrials.delete(entryKey);
  }

  unassignedTrials.delete(key);

  for (const oldest of unassignedTrials.keys()) {
    if (unassignedTrials.size < UNASSIGNED_TRIALS_MAX) break;
    unassignedTrials.delete(oldest);
  }

  unassignedTrials.set(key, { licenseId, until: computeTrialExpiry(new Date(now), trialDays).getTime() });
}

const ALREADY_USED: FreemiusTrialProvisionResult = {
  error: FREEMIUS_TRIAL_ALREADY_USED_MESSAGE,
  ok: false,
  reason: 'already_licensed',
  status: 409,
};

const ELIGIBILITY_UNKNOWN: FreemiusTrialProvisionResult = {
  error: 'Freemius could not be reached to verify eligibility.',
  ok: false,
  reason: 'upstream_error',
  status: 502,
};

/** The four steps of a trial with one set of Freemius calls. */
async function runTrialProvision(
  api: FreemiusTrialApi,
  request: { email: string; name: string; now: Date; planId: string; productId: string; trialDays: number }
): Promise<FreemiusTrialProvisionResult | typeof REFUSED_BEFORE_LICENSE> {
  // 0. A trial this instance minted for the email but could not assign: Freemius ties it to no
  //    user, so step 1 cannot see it. Refused while that license stands; asked again once Freemius
  //    reports it deleted or cancelled (the operator cleaned it up).
  const unassignedKey = `${request.productId}:${request.email}`;
  const unassigned = unassignedTrials.get(unassignedKey);

  if (unassigned && unassigned.until <= Date.now()) {
    unassignedTrials.delete(unassignedKey);
  } else if (unassigned) {
    if (!unassigned.licenseId) {
      return ALREADY_USED;
    }

    try {
      if ((await api.readLicense(unassigned.licenseId)) === 'live') {
        return ALREADY_USED;
      }

      unassignedTrials.delete(unassignedKey);
    } catch (error) {
      if (isRefusedPair(error)) return REFUSED_BEFORE_LICENSE;

      console.error('[Freemius trial] unassigned trial check failed:', describeTrialError(error));

      return ELIGIBILITY_UNKNOWN;
    }
  }

  // 1. One trial per email: an existing Freemius user with any license for this product
  //    is refused, whatever the license's state. Only a conclusive answer counts: a failed or
  //    unreadable lookup throws (502), never "no license".
  let existingLicenses: FreemiusOwnedLicenseLike[] = [];

  try {
    const userId = await api.findUserIdByEmail(request.email);

    if (userId) {
      existingLicenses = await api.listUserLicenses(userId);
    }
  } catch (error) {
    if (isRefusedPair(error)) return REFUSED_BEFORE_LICENSE;

    console.error('[Freemius trial] user lookup failed:', describeTrialError(error));

    return ELIGIBILITY_UNKNOWN;
  }

  const eligibility = evaluateTrialEligibility({ existingLicenses, productId: request.productId });

  if (!eligibility.ok) {
    return ALREADY_USED;
  }

  // 2. The pricing tier to mint on (a license belongs to a plan AND a pricing).
  let pricingId: string | null = null;

  try {
    const picked = pickTrialPricing(await api.listPlanPricing());
    pricingId = picked?.id !== null && picked?.id !== undefined ? String(picked.id) : null;
  } catch (error) {
    if (isRefusedPair(error)) return REFUSED_BEFORE_LICENSE;

    console.error('[Freemius trial] pricing lookup failed:', describeTrialError(error));

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
  const expiresAt = formatFreemiusTimestamp(computeTrialExpiry(request.now, request.trialDays));
  let licenseKey: string | null = null;
  let licenseId: string | null = null;

  try {
    const license = await api.createLicense(pricingId, { expires_at: expiresAt, is_block_features: true, send_email: false });
    licenseKey = typeof license?.secret_key === 'string' ? license.secret_key.trim() || null : null;
    licenseId = license?.id !== null && license?.id !== undefined ? String(license.id) : null;
  } catch (error) {
    // A 401/403 refused the request itself: no license exists, so other keys may try.
    if (isRefusedPair(error)) return REFUSED_BEFORE_LICENSE;

    console.error('[Freemius trial] license creation failed:', describeTrialError(error));

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
  //    Best-effort, and never retried with other keys (the license exists now): the buyer's
  //    own activation (with user_email) registers the user too. Until then nothing at Freemius
  //    links the email to this license, so step 0 remembers it.
  let assigned = false;

  try {
    await api.assignLicense({ email: request.email, license_key: licenseKey, name: request.name.trim() });
    assigned = true;
  } catch (error) {
    console.warn('[Freemius trial] license assignment failed:', describeTrialError(error));
    rememberUnassignedTrial(unassignedKey, toFreemiusId(licenseId), request.trialDays);
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

const NOT_CONFIGURED: FreemiusTrialProvisionResult = {
  error: 'The license service is not configured for this product.',
  ok: false,
  reason: 'not_configured',
  status: 503,
};

/**
 * Mint and assign a trial license: with the developer key pair when it works and the account owns
 * the product (no per-product key needed), else with the product-scope bearer credentials from the
 * same resolver as the license claim route. The bearer is also tried when Freemius refuses the
 * developer pair (401/403) before any license exists; never after, so one request mints at most
 * one license.
 */
export async function provisionFreemiusTrialLicense(
  request: FreemiusTrialProvisionRequest,
  options?: { now?: Date }
): Promise<FreemiusTrialProvisionResult> {
  await hydrateFreemiusEnvFromDb();

  const productId = toFreemiusId(request.productId);
  const planId = toFreemiusId(request.planId);

  if (!productId || !planId) {
    return NOT_CONFIGURED;
  }

  const trial = {
    email: normalizeEmail(request.email),
    name: request.name,
    now: options?.now ?? new Date(),
    planId,
    productId,
    trialDays: request.trialDays,
  };

  if (await canUseFreemiusDeveloperScope(productId)) {
    const outcome = await runTrialProvision(developerTrialApi(productId, planId), trial);

    if (outcome !== REFUSED_BEFORE_LICENSE) {
      return outcome;
    }
  }

  const credentials = resolveFreemiusCheckoutCredentials(productId);

  if (!credentials.apiKey || !credentials.secretKey || !credentials.publicKey) {
    return NOT_CONFIGURED;
  }

  const freemius = new Freemius({
    apiKey: credentials.apiKey,
    productId: Number(productId),
    publicKey: credentials.publicKey,
    secretKey: credentials.secretKey,
  });
  const outcome = await runTrialProvision(bearerTrialApi(freemius, productId, planId), trial);

  return outcome === REFUSED_BEFORE_LICENSE ? NOT_CONFIGURED : outcome;
}
