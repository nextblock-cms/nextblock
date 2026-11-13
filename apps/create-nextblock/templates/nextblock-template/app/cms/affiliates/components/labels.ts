import type {
  AffiliateBadgeColor,
  AffiliateCommissionStatus,
  AffiliateManualPayoutChannel,
  AffiliateOnboardingStep,
  AffiliatePageStatus,
  AffiliatePayoutMethod,
  AffiliatePayoutStatus,
  AffiliatePayoutTrigger,
  AffiliateStatus,
} from '@nextblock-cms/affiliates';

/**
 * English labels and badge classes of the /cms/affiliates screens (the CMS is English-only).
 * Pure literals with type-only imports, so server and client components share them without
 * pulling the affiliates lib into a client bundle. Every class string is written out in full:
 * Tailwind only generates utilities it finds verbatim in source.
 */

/** The CMS calls a suspension a pause ("Pause partner" / "Resume partner"); the enum and portal keep SUSPENDED. */
export const AFFILIATE_PARTNER_STATUS_LABEL: Readonly<Record<AffiliateStatus, string>> = {
  ACTIVE: 'Active',
  SUSPENDED: 'Paused',
};

export const AFFILIATE_PARTNER_STATUS_CLASS: Readonly<Record<AffiliateStatus, string>> = {
  ACTIVE: 'border-transparent bg-green-100 text-green-800 dark:bg-green-700/30 dark:text-green-200',
  SUSPENDED: 'border-transparent bg-red-100 text-red-800 dark:bg-red-700/30 dark:text-red-200',
};

/** What the public sees of a published storefront (`AffiliateStorefrontState` in lib/affiliates/admin-data.ts). */
export type AffiliateStorefrontStateKey = 'live' | 'paused' | 'unpublished';

export const AFFILIATE_STOREFRONT_STATE_LABEL: Readonly<Record<AffiliateStorefrontStateKey, string>> = {
  live: 'Live',
  paused: 'Paused',
  unpublished: 'Not published yet',
};

export const AFFILIATE_STOREFRONT_STATE_CLASS: Readonly<Record<AffiliateStorefrontStateKey, string>> = {
  live: 'border-transparent bg-green-100 text-green-800 dark:bg-green-700/30 dark:text-green-200',
  paused: 'border-transparent bg-red-100 text-red-800 dark:bg-red-700/30 dark:text-red-200',
  unpublished: 'border-transparent bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200',
};

export const AFFILIATE_PAGE_STATUS_LABEL: Readonly<Record<AffiliatePageStatus, string>> = {
  DRAFT: 'Draft',
  PENDING_REVIEW: 'Pending review',
  PUBLISHED: 'Published',
  CHANGES_REQUESTED: 'Changes requested',
};

export const AFFILIATE_PAGE_STATUS_CLASS: Readonly<Record<AffiliatePageStatus, string>> = {
  DRAFT: 'border-transparent bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200',
  PENDING_REVIEW: 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-700/30 dark:text-amber-200',
  PUBLISHED: 'border-transparent bg-green-100 text-green-800 dark:bg-green-700/30 dark:text-green-200',
  CHANGES_REQUESTED: 'border-transparent bg-orange-100 text-orange-800 dark:bg-orange-700/30 dark:text-orange-200',
};

export const AFFILIATE_ONBOARDING_STEP_LABEL: Readonly<Record<AffiliateOnboardingStep, string>> = {
  SIGNED_UP: 'Signed up',
  PROFILE_COMPLETED: 'Profile completed',
  PAYOUT_CONFIGURED: 'Payouts connected',
  PAGE_SUBMITTED: 'Storefront submitted',
  ACTIVE_PUBLISHED: 'Live',
};

export const AFFILIATE_COMMISSION_STATUS_LABEL: Readonly<Record<AffiliateCommissionStatus, string>> = {
  PENDING_CLEARANCE: 'Pending clearance',
  CLEARED: 'Cleared',
  PAID: 'Paid',
  VOIDED_REFUND: 'Voided (refund)',
};

export const AFFILIATE_COMMISSION_STATUS_CLASS: Readonly<Record<AffiliateCommissionStatus, string>> = {
  PENDING_CLEARANCE: 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-700/30 dark:text-amber-200',
  CLEARED: 'border-transparent bg-sky-100 text-sky-800 dark:bg-sky-700/30 dark:text-sky-200',
  PAID: 'border-transparent bg-green-100 text-green-800 dark:bg-green-700/30 dark:text-green-200',
  VOIDED_REFUND: 'border-transparent bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200',
};

export const AFFILIATE_PAYOUT_STATUS_LABEL: Readonly<Record<AffiliatePayoutStatus, string>> = {
  PROCESSING: 'Processing',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

export const AFFILIATE_PAYOUT_STATUS_CLASS: Readonly<Record<AffiliatePayoutStatus, string>> = {
  PROCESSING: 'border-transparent bg-sky-100 text-sky-800 dark:bg-sky-700/30 dark:text-sky-200',
  COMPLETED: 'border-transparent bg-green-100 text-green-800 dark:bg-green-700/30 dark:text-green-200',
  FAILED: 'border-transparent bg-red-100 text-red-800 dark:bg-red-700/30 dark:text-red-200',
};

export const AFFILIATE_PAYOUT_TRIGGER_LABEL: Readonly<Record<AffiliatePayoutTrigger, string>> = {
  cron: 'Scheduled run',
  admin: 'Run by an admin',
  auto: 'Automatic',
};

/** How the program pays a gateway's commissions (Program settings → How partners are paid, 02036; PayPal 02037). */
export const AFFILIATE_PAYOUT_METHOD_LABEL: Readonly<Record<AffiliatePayoutMethod, string>> = {
  stripe_connect: 'Stripe Connect (automatic transfers)',
  paypal: 'PayPal (automatic, from your PayPal balance)',
  manual: 'Manually (PayPal, Interac e-Transfer, bank transfer)',
};

/** Where a manual payout was sent from (`affiliate_payouts.manual_channel`, 02036), in CMS order. */
export const AFFILIATE_MANUAL_PAYOUT_CHANNEL_LABEL: Readonly<Record<AffiliateManualPayoutChannel, string>> = {
  paypal: 'PayPal',
  interac: 'Interac e-Transfer',
  wise: 'Wise',
  bank_transfer: 'Bank transfer',
  other: 'Other',
};

/** `affiliate_payouts.failure_reason` machine codes, as sentences (unknown codes are shown as-is). */
export const AFFILIATE_PAYOUT_FAILURE_LABEL: Readonly<Record<string, string>> = {
  failed: 'The transfer failed.',
  stale: 'No transfer was found at Stripe for this in-flight payout.',
  released: 'Released: its commissions went back to the cleared balance.',
  nothing_to_pay: 'Nothing left to pay (the commissions were refunded).',
  below_minimum: 'Below the minimum payout after refunds: its commissions went back to the cleared balance.',
  balance_insufficient: 'The Stripe balance was too low.',
  account_invalid: 'The partner’s Stripe account is invalid.',
  account_closed: 'The partner’s Stripe account is closed.',
  transfers_not_allowed: 'Transfers are not allowed to this account.',
  capability_not_active: 'The account cannot receive transfers yet.',
  insufficient_capabilities_for_transfer: 'The account cannot receive transfers yet.',
  amount_too_small: 'The amount is below Stripe’s minimum transfer.',
  amount_too_large: 'The amount is above Stripe’s maximum transfer.',
  resource_missing: 'Stripe does not know the partner’s account.',
};

export const AFFILIATE_ALERT_TYPE_LABEL: Readonly<Record<string, string>> = {
  affiliate_signed_up: 'New partner',
  affiliate_profile_completed: 'Profile completed',
  affiliate_payout_configured: 'Payouts connected',
  affiliate_page_submitted: 'Storefront submitted',
  affiliate_payout_failed: 'Payout failed',
  affiliate_refund_after_payout: 'Refund after payout',
};

/**
 * Platform-wide Stripe alerts, by `metadata.kind`: `affiliate_payout_failed` rows about no payout
 * of their own (the Connect setup alert and the daily insufficient-balance alert). The activity
 * feed labels them by kind and links the Stripe payouts screen, which explains the fix.
 */
export const AFFILIATE_STRIPE_ALERT_KIND_LABEL: Readonly<Record<string, string>> = {
  connect_setup: 'Stripe Connect setup',
  insufficient_balance: 'Stripe balance',
};

/** Tier badge colours (`affiliate_tiers.badge_color`). */
export const AFFILIATE_TIER_BADGE_CLASS: Readonly<Record<AffiliateBadgeColor, string>> = {
  violet: 'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-200',
  indigo: 'border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-500/40 dark:bg-indigo-500/15 dark:text-indigo-200',
  blue: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-200',
  sky: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/40 dark:bg-sky-500/15 dark:text-sky-200',
  emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200',
  amber: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200',
  orange: 'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-500/40 dark:bg-orange-500/15 dark:text-orange-200',
  rose: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-200',
  slate: 'border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-500/40 dark:bg-slate-500/15 dark:text-slate-200',
};

export const AFFILIATE_TIER_SWATCH_CLASS: Readonly<Record<AffiliateBadgeColor, string>> = {
  violet: 'bg-violet-500',
  indigo: 'bg-indigo-500',
  blue: 'bg-blue-500',
  sky: 'bg-sky-500',
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  orange: 'bg-orange-500',
  rose: 'bg-rose-500',
  slate: 'bg-slate-500',
};

export const AFFILIATE_BADGE_COLOR_LABEL: Readonly<Record<AffiliateBadgeColor, string>> = {
  violet: 'Violet',
  indigo: 'Indigo',
  blue: 'Blue',
  sky: 'Sky',
  emerald: 'Emerald',
  amber: 'Amber',
  orange: 'Orange',
  rose: 'Rose',
  slate: 'Slate',
};
