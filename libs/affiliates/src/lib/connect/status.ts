/**
 * Stripe Connect readiness of a partner (ADDENDUM B3). Readiness is only ever read from
 * `accounts.retrieve()` (never from the `?connected=1` return URL): details submitted, payouts
 * enabled and the `transfers` capability active. The result is written back to the partner's
 * `stripe_connect_*` columns with the service-role client the caller passes.
 */
import type { AffiliateProfileRow } from '../core/types';
import { affiliateTable, type AffiliateRepositoryClient } from '../repository/client';
import { isAffiliateStripeMissingResourceError } from '../payouts/stripe-errors';
import type { AffiliateStripeAccountLike, AffiliatesStripeLike } from '../payouts/stripe-like';

/** The profile columns a readiness check needs. */
export type AffiliateConnectProfileRef = Pick<
  AffiliateProfileRow,
  'id' | 'stripe_connect_account_id' | 'stripe_connect_livemode'
> & { payout_configured_at?: string | null };

export interface AffiliateConnectStatus {
  /** A Connect account id is stored for the partner. */
  hasAccount: boolean;
  /** Stripe does not know the stored account (deleted, or created with the other key mode). */
  accountMissing: boolean;
  /** The account was created with the other key mode (test vs live): the partner must re-onboard. */
  livemodeMismatch: boolean;
  /** Payouts can be sent: details submitted, payouts enabled, transfers capability active. */
  ready: boolean;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  transfersActive: boolean;
  /** Stripe still asks the partner for information (currently or past due). */
  requirementsDue: boolean;
  disabledReason: string | null;
  /** When this status was read from Stripe (ISO), null when Stripe was not asked. */
  checkedAt: string | null;
}

export interface AffiliateConnectSyncResult {
  status: AffiliateConnectStatus;
  /** True exactly once per partner: the first time the account was found ready (`payout_configured_at` set). */
  firstReady: boolean;
}

function noAccountStatus(): AffiliateConnectStatus {
  return {
    hasAccount: false,
    accountMissing: false,
    livemodeMismatch: false,
    ready: false,
    detailsSubmitted: false,
    payoutsEnabled: false,
    transfersActive: false,
    requirementsDue: false,
    disabledReason: null,
    checkedAt: null,
  };
}

function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Readiness of a retrieved connected account (B3). */
export function evaluateAffiliateConnectAccount(
  account: AffiliateStripeAccountLike
): Pick<AffiliateConnectStatus, 'ready' | 'detailsSubmitted' | 'payoutsEnabled' | 'transfersActive' | 'requirementsDue' | 'disabledReason'> {
  const detailsSubmitted = account.details_submitted === true;
  const payoutsEnabled = account.payouts_enabled === true;
  const transfersActive = account.capabilities?.transfers === 'active';
  const requirements = account.requirements ?? null;
  const disabledReason =
    typeof requirements?.disabled_reason === 'string' && requirements.disabled_reason.trim()
      ? requirements.disabled_reason.trim().slice(0, 120)
      : null;
  return {
    ready: detailsSubmitted && payoutsEnabled && transfersActive,
    detailsSubmitted,
    payoutsEnabled,
    transfersActive,
    requirementsDue: listLength(requirements?.currently_due) > 0 || listLength(requirements?.past_due) > 0,
    disabledReason,
  };
}

async function writeConnectColumns(
  supabase: AffiliateRepositoryClient,
  profileId: string,
  accountId: string,
  values: Record<string, unknown>
): Promise<void> {
  // Keyed on the account id too: a concurrent re-onboarding (new account) is never overwritten
  // with the old account's status.
  const { error } = await affiliateTable(supabase, 'affiliate_profiles')
    .update(values)
    .eq('id', profileId)
    .eq('stripe_connect_account_id', accountId);
  if (error) throw new Error('Could not record the Stripe Connect status.', { cause: error });
}

/**
 * Reads the partner's connected account from Stripe and records the result:
 * `stripe_connect_details_submitted`, `stripe_connect_payouts_enabled`,
 * `stripe_connect_onboarding_complete` (= ready) and `stripe_connect_checked_at`, plus
 * `stripe_connect_livemode` when it was unknown, and `payout_configured_at` the first time the
 * account is ready (one conditional UPDATE, so concurrent checks report `firstReady` once).
 *
 * An account of the other key mode, or one Stripe no longer knows, is recorded as not ready
 * without asking Stripe again (the partner re-onboards). Other Stripe or database errors throw.
 */
export async function syncAffiliateConnectStatus(
  supabase: AffiliateRepositoryClient,
  stripe: AffiliatesStripeLike,
  input: { profile: AffiliateConnectProfileRef; livemode: boolean; now?: Date }
): Promise<AffiliateConnectSyncResult> {
  const { profile, livemode } = input;
  const accountId = profile.stripe_connect_account_id;
  if (!accountId) return { status: noAccountStatus(), firstReady: false };

  const checkedAt = (input.now ?? new Date()).toISOString();
  const notReady = {
    stripe_connect_onboarding_complete: false,
    stripe_connect_details_submitted: false,
    stripe_connect_payouts_enabled: false,
    stripe_connect_checked_at: checkedAt,
  };

  if (profile.stripe_connect_livemode !== null && profile.stripe_connect_livemode !== livemode) {
    await writeConnectColumns(supabase, profile.id, accountId, notReady);
    return {
      status: { ...noAccountStatus(), hasAccount: true, livemodeMismatch: true, checkedAt },
      firstReady: false,
    };
  }

  let account: AffiliateStripeAccountLike;
  try {
    account = await stripe.accounts.retrieve(accountId);
  } catch (error) {
    if (!isAffiliateStripeMissingResourceError(error)) throw error;
    await writeConnectColumns(supabase, profile.id, accountId, notReady);
    return {
      status: { ...noAccountStatus(), hasAccount: true, accountMissing: true, checkedAt },
      firstReady: false,
    };
  }

  const evaluation = evaluateAffiliateConnectAccount(account);
  await writeConnectColumns(supabase, profile.id, accountId, {
    stripe_connect_onboarding_complete: evaluation.ready,
    stripe_connect_details_submitted: evaluation.detailsSubmitted,
    stripe_connect_payouts_enabled: evaluation.payoutsEnabled,
    stripe_connect_checked_at: checkedAt,
    // The account answered with the current key, so it belongs to this mode.
    ...(profile.stripe_connect_livemode === null ? { stripe_connect_livemode: livemode } : {}),
  });

  let firstReady = false;
  if (evaluation.ready && profile.payout_configured_at == null) {
    const { data, error } = await affiliateTable(supabase, 'affiliate_profiles')
      .update({ payout_configured_at: checkedAt })
      .eq('id', profile.id)
      .is('payout_configured_at', null)
      .select('id');
    if (error) throw new Error('Could not record the payout configuration.', { cause: error });
    firstReady = Array.isArray(data) && data.length > 0;
  }

  return {
    status: {
      hasAccount: true,
      accountMissing: false,
      livemodeMismatch: false,
      ...evaluation,
      checkedAt,
    },
    firstReady,
  };
}
