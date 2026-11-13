import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import {
  AFFILIATE_ALERT_TYPES,
  AFFILIATE_CMS_STRIPE_PATH,
  AFFILIATE_PARTNERS_PATH,
  AFFILIATE_PORTAL_PAYOUTS_PATH,
  type AffiliateProfileRow,
} from '@nextblock-cms/affiliates';
import {
  affiliateStripeErrorCode,
  classifyAffiliateStripeError,
  createAffiliateExpressDashboardLink as createExpressDashboardLoginLink,
  createAffiliateOnboardingLink,
  ensureAffiliateExpressAccount,
  filterAffiliateConnectCountriesForPlatform,
  getAffiliateProfileById,
  isAffiliateConnectCountryAllowedForPlatform,
  isAffiliateStripeMissingResourceError,
  isAffiliateStripePermissionError,
  listAffiliateConnectCountryOptions,
  normalizeAffiliateConnectCountry,
  syncAffiliateConnectStatus,
  type AffiliateConnectCountryCode,
  type AffiliateConnectCountryOption,
  type AffiliateConnectStatus,
  type AffiliatePlatformAccountInfo,
  type AffiliatesStripeLike,
} from '@nextblock-cms/affiliates/server';
import { isPubliclyRoutableSiteUrl, resolveSiteUrl } from '../site-url';
import { notifyAffiliateLifecycle, scheduleAffiliateNotification } from './notify';
import { getCachedAffiliatePlatformInfo, isAffiliatePayoutSandbox, resolveAffiliateStripeClient } from './payout-runner';
import type { RetailerActor } from './retailer-actor';

/**
 * Stripe Connect Express for the partner portal (ADDENDUM B3), on top of the lib's Connect
 * helpers. Every function takes the `RetailerActor` that `requireRetailer()` returned (the portal
 * actions and the refresh route call that first) and re-reads the partner's row by id AND user
 * id with the service-role client, so a stale or forged actor can only ever reach its own
 * account. Readiness comes from `accounts.retrieve()` only, never from `?connected=1`. Disabled
 * in the sandbox. Results are codes; the portal maps them to its copy.
 */

type AnyClient = SupabaseClient<any>;

export type AffiliateConnectServiceError =
  | 'sandbox'
  | 'stripe_not_configured'
  | 'connect_unavailable'
  | 'suspended'
  | 'no_account'
  | 'not_ready'
  | 'unknown';

export type AffiliateConnectLinkResult = { ok: true; url: string } | { ok: false; error: AffiliateConnectServiceError };

export type AffiliateConnectStatusResult =
  | { ok: true; status: AffiliateConnectStatus }
  | { ok: false; error: AffiliateConnectServiceError };

export interface AffiliateConnectCountryOptions {
  /** The platform account's country when it is a supported one (the portal's default choice). */
  platformCountry: AffiliateConnectCountryCode | null;
  countries: AffiliateConnectCountryOption[];
}

/** Where Stripe sends the partner back: the payouts screen, which then refreshes the status. */
export const AFFILIATE_CONNECT_RETURN_PATH = `${AFFILIATE_PORTAL_PAYOUTS_PATH}?connected=1`;
/** Where Stripe sends a partner whose onboarding link expired: a GET route that mints a new one. */
export const AFFILIATE_CONNECT_REFRESH_PATH = `${AFFILIATE_PORTAL_PAYOUTS_PATH}/connect/refresh`;

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 299)}…` : message;
}

function serviceClient(): AnyClient {
  return getServiceRoleSupabaseClient() as unknown as AnyClient;
}

/** Absolute return / refresh URLs from the canonical site address. */
export function affiliateConnectReturnUrls(): { returnUrl: string; refreshUrl: string } {
  const site = resolveSiteUrl();
  return { returnUrl: `${site}${AFFILIATE_CONNECT_RETURN_PATH}`, refreshUrl: `${site}${AFFILIATE_CONNECT_REFRESH_PATH}` };
}

/** The Connect steps a Stripe refusal can stop (`metadata.step` of the setup alert). */
export type AffiliateConnectSetupStep =
  | 'platform_lookup'
  | 'account_creation'
  | 'onboarding_link'
  | 'status_check'
  | 'refresh_link'
  | 'dashboard_link';

const CONNECT_STEP_LABELS: Readonly<Record<AffiliateConnectSetupStep, string>> = {
  platform_lookup: 'platform account lookup',
  account_creation: 'Express account creation',
  onboarding_link: 'onboarding link',
  status_check: 'account status check',
  refresh_link: 'onboarding refresh link',
  dashboard_link: 'Express dashboard link',
};

/** `metadata.kind` of the Connect setup alert (an `affiliate_payout_failed` alert, like `insufficient_balance`). */
export const AFFILIATE_CONNECT_SETUP_ALERT_KIND = 'connect_setup';

/**
 * What the Connect setup alert advises. A 403 (`StripePermissionError`) is a restricted key short
 * of a permission, which no Dashboard setting fixes; any other refusal points at the platform's
 * Connect setup, or at a partner country Express onboarding does not allow.
 */
function connectSetupAdvice(permission: boolean): string {
  return permission
    ? 'This restricted key lacks a permission Connect needs: allow Balance (read), Accounts and Account links (write) and Login links (write) for it in the Stripe Dashboard (Developers > API keys), or use a standard secret key.'
    : 'In the Stripe Dashboard, check that Connect is enabled, the platform profile is complete, Connect branding (business name, colour and icon) is set, Accounts v1 support is turned on, and the partner’s country is among the countries allowed for Express onboarding.';
}

/**
 * A definitive Stripe refusal of a partner's Connect step usually means the platform is not set up
 * for Connect (Connect off, the platform profile unfinished, no Connect branding, Accounts v1
 * support off, a partner country not allowed) or a restricted key lacks a permission. One
 * `affiliate_payout_failed` alert per UTC day says so (`metadata.kind = 'connect_setup'`, the step
 * and Stripe's error code, never its message): an unresolved alert of the same day counts, like
 * the insufficient-balance alert. The alert is about the platform, so the partner who hit the
 * refusal is kept as `first_affiliate_id`, never `affiliate_id`: lookups keyed on a partner (a
 * removal closing that partner's alerts) must not reach it. It sends no email; the CMS banner and
 * the Stripe payouts screen show it. Never throws.
 */
async function recordConnectSetupAlert(
  step: AffiliateConnectSetupStep,
  stripeCode: string,
  affiliateId: string | null,
  permission: boolean
): Promise<void> {
  try {
    const db = serviceClient();
    const alertDate = new Date().toISOString().slice(0, 10);
    const { data: existing, error: lookupError } = await db
      .from('system_alerts')
      .select('id')
      .eq('alert_type', AFFILIATE_ALERT_TYPES.PAYOUT_FAILED)
      .eq('is_resolved', false)
      .eq('metadata->>kind', AFFILIATE_CONNECT_SETUP_ALERT_KIND)
      .eq('metadata->>alert_date', alertDate)
      .limit(1);
    if (!lookupError && Array.isArray(existing) && existing.length > 0) return;

    const { error } = await db.from('system_alerts').insert({
      alert_type: AFFILIATE_ALERT_TYPES.PAYOUT_FAILED,
      title: 'Stripe Connect refused a partner’s payout setup',
      message: `Stripe refused the ${CONNECT_STEP_LABELS[step]} (${stripeCode}), so a partner could not set up payouts. ${connectSetupAdvice(permission)}`,
      metadata: {
        kind: AFFILIATE_CONNECT_SETUP_ALERT_KIND,
        alert_date: alertDate,
        step,
        stripe_code: stripeCode,
        first_affiliate_id: affiliateId,
        action_url: AFFILIATE_CMS_STRIPE_PATH,
        action_label: 'Open Stripe payouts',
      },
    });
    if (error) console.warn('[affiliates] Could not record the Stripe Connect setup alert:', error.message);
  } catch (error) {
    console.warn('[affiliates] Could not record the Stripe Connect setup alert:', describeError(error));
  }
}

/**
 * A Stripe refusal means Connect is not available to this platform (or account), and raises the
 * day's setup alert for the admins; anything else is unknown (possibly transient).
 */
async function stripeFailure(
  step: AffiliateConnectSetupStep,
  error: unknown,
  affiliateId: string | null = null
): Promise<AffiliateConnectServiceError> {
  const code = affiliateStripeErrorCode(error);
  console.warn(`[affiliates] Stripe Connect ${CONNECT_STEP_LABELS[step]} failed (${code}):`, describeError(error));
  if (classifyAffiliateStripeError(error) !== 'definitive') return 'unknown';
  await recordConnectSetupAlert(step, code, affiliateId, isAffiliateStripePermissionError(error));
  return 'connect_unavailable';
}

type PartnerContext =
  | { ok: true; db: AnyClient; stripe: AffiliatesStripeLike; platform: AffiliatePlatformAccountInfo; profile: AffiliateProfileRow }
  | { ok: false; error: AffiliateConnectServiceError };

/** The actor's own, ACTIVE partner row (fresh), the Stripe client and the platform facts. */
async function partnerContext(actor: RetailerActor): Promise<PartnerContext> {
  if (isAffiliatePayoutSandbox()) return { ok: false, error: 'sandbox' };
  const affiliateId = actor?.affiliate?.id;
  if (!affiliateId || !actor.userId) return { ok: false, error: 'unknown' };

  const db = serviceClient();
  const profile = await getAffiliateProfileById(db, affiliateId);
  if (!profile || profile.user_id !== actor.userId) return { ok: false, error: 'unknown' };
  if (profile.status !== 'ACTIVE') return { ok: false, error: 'suspended' };

  const resolved = await resolveAffiliateStripeClient();
  if (!resolved.ok) return { ok: false, error: resolved.error === 'unknown' ? 'unknown' : resolved.error };

  let platform: AffiliatePlatformAccountInfo;
  try {
    platform = await getCachedAffiliatePlatformInfo(resolved.stripe);
  } catch (error) {
    return { ok: false, error: await stripeFailure('platform_lookup', error, profile.id) };
  }
  return { ok: true, db, stripe: resolved.stripe, platform, profile };
}

/**
 * Can partners connect a bank account on this store at all? False only when no Stripe secret key
 * is configured (CMS → Payments or `STRIPE_SECRET_KEY`): the payouts page then says payouts are
 * not available yet instead of offering a "Connect bank account" button that cannot work. The
 * sandbox (it has its own notice) and a Stripe client that failed for another reason (possibly
 * transient: the button stays, and a click reports `connect_unavailable`) count as configured.
 * Never throws.
 */
export async function isAffiliateConnectConfigured(): Promise<boolean> {
  if (isAffiliatePayoutSandbox()) return true;
  try {
    const resolved = await resolveAffiliateStripeClient();
    return resolved.ok || resolved.error !== 'stripe_not_configured';
  } catch {
    return true;
  }
}

/** The stored account is usable with the current key (same mode, or a mode not recorded yet). */
function usableAccountId(profile: AffiliateProfileRow, platform: AffiliatePlatformAccountInfo): string | null {
  const accountId = profile.stripe_connect_account_id;
  if (!accountId) return null;
  if (profile.stripe_connect_livemode !== null && profile.stripe_connect_livemode !== platform.livemode) return null;
  return accountId;
}

function siteHost(site: string): string | null {
  try {
    return new URL(site).host || null;
  } catch {
    return null;
  }
}

/**
 * "Connect bank account": creates (or reuses) the partner's Express account in `country`
 * (default: the platform's country; another country gets the recipient agreement) and returns
 * a Stripe-hosted onboarding URL for the client to open (`window.location.href`; the CSP's
 * `form-action 'self'` forbids a form post to Stripe).
 */
export async function startAffiliateConnectOnboarding(
  actor: RetailerActor,
  input: { country?: string | null } = {}
): Promise<AffiliateConnectLinkResult> {
  try {
    const context = await partnerContext(actor);
    if (!context.ok) return context;
    const { db, stripe, platform, profile } = context;

    const requested = typeof input?.country === 'string' && input.country.trim() ? normalizeAffiliateConnectCountry(input.country) : null;
    if (typeof input?.country === 'string' && input.country.trim() && !requested) return { ok: false, error: 'unknown' };
    // Only a country the portal offers for this platform (Stripe would refuse the transfers).
    if (requested && !isAffiliateConnectCountryAllowedForPlatform(requested, platform.country)) return { ok: false, error: 'unknown' };
    const country = requested ?? normalizeAffiliateConnectCountry(platform.country);
    if (!country) return { ok: false, error: 'connect_unavailable' };

    const site = resolveSiteUrl();
    const host = siteHost(site);
    let accountId: string;
    try {
      const account = await ensureAffiliateExpressAccount(db, stripe, {
        affiliateId: profile.id,
        email: actor.email,
        country,
        platform,
        storefrontUrl: isPubliclyRoutableSiteUrl(site) ? `${site}${AFFILIATE_PARTNERS_PATH}/${encodeURIComponent(profile.handle)}` : null,
        productDescription: host
          ? `Affiliate partner earning referral commissions from ${host}`
          : 'Affiliate partner earning referral commissions',
      });
      accountId = account.accountId;
    } catch (error) {
      return { ok: false, error: await stripeFailure('account_creation', error, profile.id) };
    }

    const { returnUrl, refreshUrl } = affiliateConnectReturnUrls();
    try {
      return { ok: true, url: await createAffiliateOnboardingLink(stripe, { accountId, refreshUrl, returnUrl }) };
    } catch (error) {
      return { ok: false, error: await stripeFailure('onboarding_link', error, profile.id) };
    }
  } catch (error) {
    console.warn('[affiliates] Could not start Stripe Connect onboarding:', describeError(error));
    return { ok: false, error: 'unknown' };
  }
}

/**
 * Reads the partner's account from Stripe and records it (`stripe_connect_*`,
 * `payout_configured_at` the first time it is ready, which also notifies the admins with
 * PAYOUT_CONFIGURED). Call it when the partner returns from Stripe (`?connected=1`) or asks to
 * refresh.
 */
export async function refreshAffiliateConnectStatus(actor: RetailerActor): Promise<AffiliateConnectStatusResult> {
  try {
    const context = await partnerContext(actor);
    if (!context.ok) return context;
    const { db, stripe, platform, profile } = context;

    let result: Awaited<ReturnType<typeof syncAffiliateConnectStatus>>;
    try {
      result = await syncAffiliateConnectStatus(db, stripe, { profile, livemode: platform.livemode });
    } catch (error) {
      return { ok: false, error: await stripeFailure('status_check', error, profile.id) };
    }
    if (result.firstReady) {
      scheduleAffiliateNotification(() => notifyAffiliateLifecycle('PAYOUT_CONFIGURED', { affiliateId: profile.id }));
    }
    return { ok: true, status: result.status };
  } catch (error) {
    console.warn('[affiliates] Could not refresh the Stripe Connect status:', describeError(error));
    return { ok: false, error: 'unknown' };
  }
}

/**
 * A fresh onboarding link for the refresh route (`/portal/retailer/payouts/connect/refresh`,
 * which Stripe opens when a link expired). `no_account` when the partner has no usable account
 * (none yet, or one of the other key mode): the route sends them back to the payouts screen.
 */
export async function createAffiliateConnectRefreshLink(actor: RetailerActor): Promise<AffiliateConnectLinkResult> {
  try {
    const context = await partnerContext(actor);
    if (!context.ok) return context;
    const accountId = usableAccountId(context.profile, context.platform);
    if (!accountId) return { ok: false, error: 'no_account' };

    const { returnUrl, refreshUrl } = affiliateConnectReturnUrls();
    try {
      return { ok: true, url: await createAffiliateOnboardingLink(context.stripe, { accountId, refreshUrl, returnUrl }) };
    } catch (error) {
      if (isAffiliateStripeMissingResourceError(error)) return { ok: false, error: 'no_account' };
      return { ok: false, error: await stripeFailure('refresh_link', error, context.profile.id) };
    }
  } catch (error) {
    console.warn('[affiliates] Could not create a Stripe Connect refresh link:', describeError(error));
    return { ok: false, error: 'unknown' };
  }
}

/**
 * A single-use login link to the partner's Stripe Express dashboard (bank details, payouts).
 * `not_ready` until the partner has submitted their details to Stripe.
 */
export async function createAffiliateExpressDashboardLink(actor: RetailerActor): Promise<AffiliateConnectLinkResult> {
  try {
    const context = await partnerContext(actor);
    if (!context.ok) return context;
    const accountId = usableAccountId(context.profile, context.platform);
    if (!accountId) return { ok: false, error: 'no_account' };
    if (!context.profile.stripe_connect_details_submitted) return { ok: false, error: 'not_ready' };

    try {
      return { ok: true, url: await createExpressDashboardLoginLink(context.stripe, accountId) };
    } catch (error) {
      if (isAffiliateStripeMissingResourceError(error)) return { ok: false, error: 'no_account' };
      if (classifyAffiliateStripeError(error) === 'definitive') {
        console.warn(`[affiliates] Express dashboard link refused (${affiliateStripeErrorCode(error)}).`);
        return { ok: false, error: 'not_ready' };
      }
      return { ok: false, error: await stripeFailure('dashboard_link', error, context.profile.id) };
    }
  } catch (error) {
    console.warn('[affiliates] Could not create an Express dashboard link:', describeError(error));
    return { ok: false, error: 'unknown' };
  }
}

/**
 * The countries a partner may open their Stripe account in (names localized for `locale`) and
 * the platform's country as the default. Stripe transfers money across borders only between the
 * US, Canada, the UK, the EEA and Switzerland: a platform in that region offers the region's
 * countries, a platform elsewhere only its own (when partners can open accounts there), and an
 * unknown platform country keeps the whole list (`filterAffiliateConnectCountriesForPlatform`).
 * The portal's Connect action accepts only a country of this list. Never throws: without Stripe
 * (or in the sandbox) the default is null and the list is unfiltered.
 */
export async function getAffiliateConnectCountryOptions(locale = 'en'): Promise<AffiliateConnectCountryOptions> {
  const countries = listAffiliateConnectCountryOptions(locale);
  if (isAffiliatePayoutSandbox()) return { platformCountry: null, countries };
  try {
    const resolved = await resolveAffiliateStripeClient();
    if (!resolved.ok) return { platformCountry: null, countries };
    const platform = await getCachedAffiliatePlatformInfo(resolved.stripe);
    return {
      platformCountry: normalizeAffiliateConnectCountry(platform.country),
      countries: filterAffiliateConnectCountriesForPlatform(countries, platform.country),
    };
  } catch (error) {
    console.warn('[affiliates] Could not read the Stripe platform country:', describeError(error));
    return { platformCountry: null, countries };
  }
}
