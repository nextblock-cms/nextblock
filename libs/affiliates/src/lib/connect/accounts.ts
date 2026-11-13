/**
 * Stripe Connect Express accounts for partners (ADDENDUM B3): one account per partner, created
 * idempotently and stored with a conditional UPDATE so two concurrent "Connect" clicks end with
 * one account; hosted onboarding and Express dashboard links; and the platform account facts
 * the payout screens need. The caller passes the service-role client and the Stripe client
 * after it has authorized the partner (`requireRetailer()`); nothing here authorizes.
 */
import { affiliateTable, type AffiliateRepositoryClient } from '../repository/client';
import { getAffiliateProfileById } from '../repository/profiles';
import { isAffiliateStripeMissingResourceError } from '../payouts/stripe-errors';
import type { AffiliateStripeAccountCreateParams, AffiliateStripeAccountLike, AffiliatesStripeLike } from '../payouts/stripe-like';

export type AffiliateConnectErrorCode = 'affiliate_not_found' | 'invalid_account' | 'invalid_link' | 'persist_failed';

/** A Connect step that failed for a reason other than a Stripe API error. */
export class AffiliateConnectError extends Error {
  readonly code: AffiliateConnectErrorCode;

  constructor(code: AffiliateConnectErrorCode, cause?: unknown) {
    super(`Affiliate Connect: ${code}`, cause === undefined ? undefined : { cause });
    this.name = 'AffiliateConnectError';
    this.code = code;
  }
}

export interface AffiliatePlatformAccountInfo {
  /** ISO country of the platform's Stripe account (uppercase), when Stripe reports it. */
  country: string | null;
  /** Settlement currency of the platform account (uppercase). */
  defaultCurrency: string | null;
  /** Mode of the configured key (from the balance object). */
  livemode: boolean;
}

const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]+$/;

function upperCode(value: unknown, length: number): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return new RegExp(`^[A-Z]{${length}}$`).test(code) ? code : null;
}

/** The platform's country, settlement currency and key mode: `accounts.retrieve(null)` + `balance.retrieve()`. */
export async function getAffiliatePlatformAccountInfo(stripe: AffiliatesStripeLike): Promise<AffiliatePlatformAccountInfo> {
  const [account, balance] = await Promise.all([stripe.accounts.retrieve(null), stripe.balance.retrieve()]);
  return {
    country: upperCode(account?.country, 2),
    defaultCurrency: upperCode(account?.default_currency, 3),
    livemode: balance?.livemode === true,
  };
}

export interface EnsureAffiliateExpressAccountInput {
  affiliateId: string;
  /** The partner's sign-in address (prefills Stripe's form); omitted when not an address. */
  email: string | null;
  /** Validated ISO country of the new account (see `normalizeAffiliateConnectCountry`). */
  country: string;
  platform: Pick<AffiliatePlatformAccountInfo, 'country' | 'livemode'>;
  /** Public https storefront URL for the business profile; omitted when null or not https. */
  storefrontUrl: string | null;
  /** Internal description Stripe uses for risk review. */
  productDescription: string;
  now?: Date;
}

export interface AffiliateExpressAccountResult {
  accountId: string;
  /** A new Stripe account was created by this call. */
  created: boolean;
  /** The account this one replaced (other key mode, or deleted at Stripe), when any. */
  replacedAccountId: string | null;
  /** The account object when Stripe was asked for it. */
  account: AffiliateStripeAccountLike | null;
}

function publicHttpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function usableEmail(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  return email.length >= 3 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** The Express account parameters of ADDENDUM B3. */
export function buildAffiliateExpressAccountParams(input: EnsureAffiliateExpressAccountInput): AffiliateStripeAccountCreateParams {
  const country = input.country.trim().toUpperCase();
  const email = usableEmail(input.email);
  const url = publicHttpsUrl(input.storefrontUrl);
  const description = input.productDescription.trim().slice(0, 300);
  const params: AffiliateStripeAccountCreateParams = {
    type: 'express',
    country,
    capabilities: { transfers: { requested: true } },
    metadata: { affiliate_id: input.affiliateId },
  };
  if (email) params.email = email;
  if (url || description) {
    params.business_profile = {
      ...(url ? { url } : {}),
      ...(description ? { product_description: description } : {}),
    };
  }
  if (input.platform.country && country !== input.platform.country.toUpperCase()) {
    params.tos_acceptance = { service_agreement: 'recipient' };
  }
  return params;
}

/** First account: `affiliate-connect-<id>`; a replacement is keyed on the account it replaces. */
export function affiliateConnectIdempotencyKey(affiliateId: string, replacedAccountId: string | null): string {
  return replacedAccountId
    ? `affiliate-connect-${affiliateId}-replace-${replacedAccountId}`
    : `affiliate-connect-${affiliateId}`;
}

/**
 * The partner's usable Express account, creating it when needed (B3):
 *
 * - a stored account of the current key mode that Stripe still knows is returned as is (its
 *   unknown mode is adopted once Stripe answers);
 * - otherwise a new account is created (`accounts.create`, idempotency key
 *   `affiliate-connect-<affiliateId>`) and stored with
 *   `UPDATE … WHERE stripe_connect_account_id IS NULL` (or `= <replaced id>`); when another
 *   request stored one first, the stored account wins and is returned.
 *
 * Stripe errors other than "no such account" propagate (classify them with
 * `classifyAffiliateStripeError`).
 */
export async function ensureAffiliateExpressAccount(
  supabase: AffiliateRepositoryClient,
  stripe: AffiliatesStripeLike,
  input: EnsureAffiliateExpressAccountInput
): Promise<AffiliateExpressAccountResult> {
  const profile = await getAffiliateProfileById(supabase, input.affiliateId);
  if (!profile) throw new AffiliateConnectError('affiliate_not_found');
  const now = (input.now ?? new Date()).toISOString();

  const stored = profile.stripe_connect_account_id;
  let replacedAccountId: string | null = null;
  if (stored) {
    const sameMode = profile.stripe_connect_livemode === null || profile.stripe_connect_livemode === input.platform.livemode;
    if (sameMode) {
      let existing: AffiliateStripeAccountLike | null = null;
      try {
        existing = await stripe.accounts.retrieve(stored);
      } catch (error) {
        // "No such account": deleted at Stripe, or created with the other key mode. Replace it.
        if (!isAffiliateStripeMissingResourceError(error)) throw error;
      }
      if (existing) {
        if (profile.stripe_connect_livemode === null) {
          // Stripe answered with the current key, so the account belongs to this mode.
          const { error } = await affiliateTable(supabase, 'affiliate_profiles')
            .update({ stripe_connect_livemode: input.platform.livemode })
            .eq('id', profile.id)
            .eq('stripe_connect_account_id', stored);
          if (error) throw new AffiliateConnectError('persist_failed', error);
        }
        return { accountId: stored, created: false, replacedAccountId: null, account: existing };
      }
    }
    replacedAccountId = stored;
  }

  const account = await stripe.accounts.create(buildAffiliateExpressAccountParams(input), {
    idempotencyKey: affiliateConnectIdempotencyKey(profile.id, replacedAccountId),
  });
  if (!account || typeof account.id !== 'string' || !ACCOUNT_ID_PATTERN.test(account.id)) {
    throw new AffiliateConnectError('invalid_account');
  }

  const values = {
    stripe_connect_account_id: account.id,
    stripe_connect_livemode: input.platform.livemode,
    stripe_connect_onboarding_complete: false,
    stripe_connect_details_submitted: account.details_submitted === true,
    stripe_connect_payouts_enabled: account.payouts_enabled === true,
    stripe_connect_checked_at: now,
  };
  const update = affiliateTable(supabase, 'affiliate_profiles').update(values).eq('id', profile.id);
  const guarded = replacedAccountId
    ? update.eq('stripe_connect_account_id', replacedAccountId)
    : update.is('stripe_connect_account_id', null);
  const { data, error } = await guarded.select('stripe_connect_account_id');
  if (error) throw new AffiliateConnectError('persist_failed', error);

  if (Array.isArray(data) && data.length > 0) {
    return { accountId: account.id, created: true, replacedAccountId, account };
  }

  // Another request stored an account first (normally this same account: both used the same
  // idempotency key). The stored one is the partner's account.
  const current = await getAffiliateProfileById(supabase, profile.id);
  const winner = current?.stripe_connect_account_id ?? null;
  if (!winner) throw new AffiliateConnectError('persist_failed');
  return { accountId: winner, created: false, replacedAccountId: null, account: winner === account.id ? account : null };
}

function stripeHostedUrl(value: unknown): string {
  if (typeof value !== 'string') throw new AffiliateConnectError('invalid_link');
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol === 'https:' && (host === 'stripe.com' || host.endsWith('.stripe.com'))) return url.toString();
  } catch {
    // fall through
  }
  throw new AffiliateConnectError('invalid_link');
}

/** Stripe-hosted onboarding (`accountLinks.create`, type `account_onboarding`). Returns the https URL. */
export async function createAffiliateOnboardingLink(
  stripe: AffiliatesStripeLike,
  input: { accountId: string; refreshUrl: string; returnUrl: string }
): Promise<string> {
  if (!ACCOUNT_ID_PATTERN.test(input.accountId)) throw new AffiliateConnectError('invalid_account');
  const link = await stripe.accountLinks.create({
    account: input.accountId,
    refresh_url: input.refreshUrl,
    return_url: input.returnUrl,
    type: 'account_onboarding',
  });
  return stripeHostedUrl(link?.url);
}

/** A single-use Express dashboard login link (`accounts.createLoginLink`). Returns the https URL. */
export async function createAffiliateExpressDashboardLink(stripe: AffiliatesStripeLike, accountId: string): Promise<string> {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new AffiliateConnectError('invalid_account');
  const link = await stripe.accounts.createLoginLink(accountId);
  return stripeHostedUrl(link?.url);
}
