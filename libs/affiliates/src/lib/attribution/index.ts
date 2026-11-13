// Checkout attribution and refund handling (W2-COMMERCE). Server-side: every function takes the
// service-role client from the app, which decides when to call (package active, after the
// webhook signature or the checkout request was verified).
export { isAffiliateAttributionTokenFresh, resolveCheckoutAttribution } from './resolve';
export { AffiliateRefundError, applyAffiliateRefund } from './refund';
export { AffiliateCommissionDisputeError, setAffiliateCommissionDispute } from './dispute';
export type {
  AffiliateAttributionSource,
  AffiliateAttributionToken,
  AffiliateCheckoutAttribution,
  AffiliateCheckoutAttributionInput,
  AffiliateCommissionDisputeInput,
  AffiliateCommissionDisputeOutcome,
  AffiliateRefundInput,
  AffiliateRefundOutcome,
} from './types';
