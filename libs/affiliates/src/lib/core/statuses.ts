/**
 * Every value of the affiliates enum types (migration 02030), as runtime lists for zod enums,
 * filters and row normalization. Client-safe. Keep in lockstep with `core/types.ts`.
 */
import type {
  AffiliateCommissionStatus,
  AffiliateGateway,
  AffiliateManualPayoutChannel,
  AffiliateOnboardingStep,
  AffiliatePageStatus,
  AffiliatePayoutEmailKind,
  AffiliatePayoutMethod,
  AffiliatePayoutStatus,
  AffiliatePayoutTrigger,
  AffiliateStatus,
} from './types';

/** `public.affiliate_onboarding_step`, in lifecycle order. */
export const AFFILIATE_ONBOARDING_STEPS = [
  'SIGNED_UP',
  'PROFILE_COMPLETED',
  'PAYOUT_CONFIGURED',
  'PAGE_SUBMITTED',
  'ACTIVE_PUBLISHED',
] as const satisfies readonly AffiliateOnboardingStep[];

/** `public.affiliate_status`. */
export const AFFILIATE_STATUSES = ['ACTIVE', 'SUSPENDED'] as const satisfies readonly AffiliateStatus[];

/** `public.affiliate_page_status`. */
export const AFFILIATE_PAGE_STATUSES = [
  'DRAFT',
  'PENDING_REVIEW',
  'PUBLISHED',
  'CHANGES_REQUESTED',
] as const satisfies readonly AffiliatePageStatus[];

/** `public.affiliate_gateway`. */
export const AFFILIATE_GATEWAYS = ['STRIPE', 'FREEMIUS'] as const satisfies readonly AffiliateGateway[];

/** `public.affiliate_commission_status`, in lifecycle order. */
export const AFFILIATE_COMMISSION_STATUSES = [
  'PENDING_CLEARANCE',
  'CLEARED',
  'PAID',
  'VOIDED_REFUND',
] as const satisfies readonly AffiliateCommissionStatus[];

/** `public.affiliate_payout_status`. */
export const AFFILIATE_PAYOUT_STATUSES = ['PROCESSING', 'COMPLETED', 'FAILED'] as const satisfies readonly AffiliatePayoutStatus[];

/** `affiliate_payouts.trigger` CHECK values. */
export const AFFILIATE_PAYOUT_TRIGGERS = ['cron', 'admin', 'auto'] as const satisfies readonly AffiliatePayoutTrigger[];

/**
 * `affiliate_payouts.method` CHECK values (02036; `paypal` since 02037), and the choices of
 * `affiliates_settings.payoutMethods`, in the order the CMS lists them.
 */
export const AFFILIATE_PAYOUT_METHODS = ['stripe_connect', 'paypal', 'manual'] as const satisfies readonly AffiliatePayoutMethod[];

/** `affiliate_profiles.payout_email_kind` CHECK values (02037; the column defaults to `paypal`). */
export const AFFILIATE_PAYOUT_EMAIL_KINDS = ['paypal', 'interac'] as const satisfies readonly AffiliatePayoutEmailKind[];

/** `affiliate_payouts.manual_channel` CHECK values (02036), in the order the CMS lists them. */
export const AFFILIATE_MANUAL_PAYOUT_CHANNELS = [
  'paypal',
  'interac',
  'wise',
  'bank_transfer',
  'other',
] as const satisfies readonly AffiliateManualPayoutChannel[];

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

export function isAffiliatePayoutMethod(value: unknown): value is AffiliatePayoutMethod {
  return isOneOf(AFFILIATE_PAYOUT_METHODS, value);
}

export function isAffiliatePayoutEmailKind(value: unknown): value is AffiliatePayoutEmailKind {
  return isOneOf(AFFILIATE_PAYOUT_EMAIL_KINDS, value);
}

export function isAffiliateManualPayoutChannel(value: unknown): value is AffiliateManualPayoutChannel {
  return isOneOf(AFFILIATE_MANUAL_PAYOUT_CHANNELS, value);
}

export function isAffiliatePageStatus(value: unknown): value is AffiliatePageStatus {
  return isOneOf(AFFILIATE_PAGE_STATUSES, value);
}

export function isAffiliateCommissionStatus(value: unknown): value is AffiliateCommissionStatus {
  return isOneOf(AFFILIATE_COMMISSION_STATUSES, value);
}

export function isAffiliatePayoutStatus(value: unknown): value is AffiliatePayoutStatus {
  return isOneOf(AFFILIATE_PAYOUT_STATUSES, value);
}

export function isAffiliateStatus(value: unknown): value is AffiliateStatus {
  return isOneOf(AFFILIATE_STATUSES, value);
}
