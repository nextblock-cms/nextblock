/**
 * The four-step partner onboarding (account → profile → payouts → storefront). Pure and
 * client-safe. The lifecycle timestamps on `affiliate_profiles` are the record; the live
 * profile/payout state also counts so a step never shows incomplete while its timestamp is
 * still being written.
 *
 * The payouts step is done once Stripe Connect is (`payout_configured_at`, or the live
 * `stripe_connect_onboarding_complete`), or, while the program pays some gateway's commissions by
 * hand (`affiliates_settings.payoutMethods`, 02036) or with PayPal Payouts (02037), once the partner
 * saved a payout email: the address the operator (or PayPal) sends those payouts to.
 */
import { affiliateGatewaysPaidOutsideStripe } from './payout-methods';
import type {
  AffiliateOnboardingProgress,
  AffiliateOnboardingStepKey,
  AffiliatePageRow,
  AffiliateProfileRow,
  AffiliatesPayoutMethods,
} from './types';

/** Minimum bio length (after trimming) for the profile step. */
export const AFFILIATE_PROFILE_MIN_BIO_LENGTH = 40;

/** Step keys in display order. */
export const AFFILIATE_ONBOARDING_STEP_KEYS = ['account', 'profile', 'payouts', 'storefront'] as const satisfies readonly AffiliateOnboardingStepKey[];

/** Display name non-blank and a bio of at least {@link AFFILIATE_PROFILE_MIN_BIO_LENGTH} characters. */
export function isAffiliateProfileComplete(profile: {
  display_name: string | null | undefined;
  bio: string | null | undefined;
}): boolean {
  const displayName = typeof profile.display_name === 'string' ? profile.display_name.trim() : '';
  const bio = typeof profile.bio === 'string' ? profile.bio.trim() : '';

  return displayName.length > 0 && bio.length >= AFFILIATE_PROFILE_MIN_BIO_LENGTH;
}

export interface AffiliateOnboardingProgressInput {
  profile: Pick<
    AffiliateProfileRow,
    | 'created_at'
    | 'display_name'
    | 'bio'
    | 'profile_completed_at'
    | 'payout_configured_at'
    | 'stripe_connect_onboarding_complete'
    | 'first_published_at'
    | 'payout_email'
  >;
  page?: Pick<AffiliatePageRow, 'published_at'> | null;
  /**
   * How the program pays each gateway's commissions (`affiliates_settings.payoutMethods`). While a
   * gateway is paid by hand, a saved payout email also completes the payouts step. Omitted or
   * null: every gateway through Stripe Connect (the behaviour before 02036).
   */
  payoutMethods?: AffiliatesPayoutMethods | null;
}

function timestamp(value: string | null | undefined): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** A gateway is paid outside Stripe (by hand, or with PayPal) and the partner told us where to send that money. */
function isManualPayoutReady(input: AffiliateOnboardingProgressInput): boolean {
  if (affiliateGatewaysPaidOutsideStripe({ payoutMethods: input.payoutMethods }).length === 0) return false;
  const email = input.profile.payout_email;
  return typeof email === 'string' && email.trim().length > 0;
}

export function computeAffiliateOnboardingProgress(input: AffiliateOnboardingProgressInput): AffiliateOnboardingProgress {
  const { profile, page } = input;
  const publishedAt = timestamp(profile.first_published_at) ?? timestamp(page?.published_at);
  const status: Record<AffiliateOnboardingStepKey, { complete: boolean; completedAt: string | null }> = {
    account: { complete: true, completedAt: timestamp(profile.created_at) },
    profile: {
      complete: timestamp(profile.profile_completed_at) !== null || isAffiliateProfileComplete(profile),
      completedAt: timestamp(profile.profile_completed_at),
    },
    payouts: {
      complete:
        timestamp(profile.payout_configured_at) !== null ||
        profile.stripe_connect_onboarding_complete === true ||
        isManualPayoutReady(input),
      completedAt: timestamp(profile.payout_configured_at),
    },
    storefront: { complete: publishedAt !== null, completedAt: publishedAt },
  };

  const steps = AFFILIATE_ONBOARDING_STEP_KEYS.map((key) => ({ key, ...status[key] }));

  return {
    steps,
    completedCount: steps.filter((step) => step.complete).length,
    totalCount: 4,
    nextStep: steps.find((step) => !step.complete)?.key ?? null,
  };
}
