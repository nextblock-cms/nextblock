/**
 * Typed maps from domain values to their `affiliates.common.*` copy keys, so screens never
 * build keys from strings (`t(AFFILIATE_PAGE_STATUS_COPY_KEYS[status])`).
 */
import type {
  AffiliateAccountErrorCode,
  AffiliateCommissionStatus,
  AffiliateOnboardingStepKey,
  AffiliatePageStatus,
  AffiliatePayoutStatus,
  AffiliateStatus,
} from '../core/types';
import type { AFFILIATES_COMMON_COPY } from './copy/common';

export type AffiliatesCommonCopyKey = keyof typeof AFFILIATES_COMMON_COPY;

export const AFFILIATE_PAGE_STATUS_COPY_KEYS = {
  DRAFT: 'affiliates.common.page_status_draft',
  PENDING_REVIEW: 'affiliates.common.page_status_pending_review',
  PUBLISHED: 'affiliates.common.page_status_published',
  CHANGES_REQUESTED: 'affiliates.common.page_status_changes_requested',
} as const satisfies Record<AffiliatePageStatus, AffiliatesCommonCopyKey>;

export const AFFILIATE_COMMISSION_STATUS_COPY_KEYS = {
  PENDING_CLEARANCE: 'affiliates.common.commission_status_pending_clearance',
  CLEARED: 'affiliates.common.commission_status_cleared',
  PAID: 'affiliates.common.commission_status_paid',
  VOIDED_REFUND: 'affiliates.common.commission_status_voided_refund',
} as const satisfies Record<AffiliateCommissionStatus, AffiliatesCommonCopyKey>;

export const AFFILIATE_PAYOUT_STATUS_COPY_KEYS = {
  PROCESSING: 'affiliates.common.payout_status_processing',
  COMPLETED: 'affiliates.common.payout_status_completed',
  FAILED: 'affiliates.common.payout_status_failed',
} as const satisfies Record<AffiliatePayoutStatus, AffiliatesCommonCopyKey>;

export const AFFILIATE_ACCOUNT_STATUS_COPY_KEYS = {
  ACTIVE: 'affiliates.common.account_status_active',
  SUSPENDED: 'affiliates.common.account_status_suspended',
} as const satisfies Record<AffiliateStatus, AffiliatesCommonCopyKey>;

export const AFFILIATE_ONBOARDING_STEP_COPY_KEYS = {
  account: 'affiliates.common.step_account',
  profile: 'affiliates.common.step_profile',
  payouts: 'affiliates.common.step_payouts',
  storefront: 'affiliates.common.step_storefront',
} as const satisfies Record<AffiliateOnboardingStepKey, AffiliatesCommonCopyKey>;

/** `createAffiliateAccountViaRpc` / signup error codes → message keys (`unknown` → the generic error). */
export const AFFILIATE_ACCOUNT_ERROR_COPY_KEYS = {
  handle_taken: 'affiliates.common.error_handle_taken',
  handle_invalid: 'affiliates.common.error_handle_invalid',
  role_conflict: 'affiliates.common.error_role_conflict',
  affiliate_exists: 'affiliates.common.error_affiliate_exists',
  program_full: 'affiliates.common.error_program_full',
  unknown: 'affiliates.common.error_generic',
} as const satisfies Record<AffiliateAccountErrorCode, AffiliatesCommonCopyKey>;
