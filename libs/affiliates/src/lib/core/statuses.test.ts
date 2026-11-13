import { describe, expect, it } from 'vitest';

import {
  AFFILIATE_COMMISSION_STATUSES,
  AFFILIATE_GATEWAYS,
  AFFILIATE_ONBOARDING_STEPS,
  AFFILIATE_PAGE_STATUSES,
  AFFILIATE_PAYOUT_STATUSES,
  AFFILIATE_PAYOUT_TRIGGERS,
  AFFILIATE_STATUSES,
  isAffiliateCommissionStatus,
  isAffiliatePageStatus,
  isAffiliatePayoutStatus,
  isAffiliateStatus,
} from './statuses';

describe('affiliate enum lists', () => {
  it('hold the values of the 02030 enum types, in order', () => {
    expect(AFFILIATE_ONBOARDING_STEPS).toEqual(['SIGNED_UP', 'PROFILE_COMPLETED', 'PAYOUT_CONFIGURED', 'PAGE_SUBMITTED', 'ACTIVE_PUBLISHED']);
    expect(AFFILIATE_STATUSES).toEqual(['ACTIVE', 'SUSPENDED']);
    expect(AFFILIATE_PAGE_STATUSES).toEqual(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'CHANGES_REQUESTED']);
    expect(AFFILIATE_GATEWAYS).toEqual(['STRIPE', 'FREEMIUS']);
    expect(AFFILIATE_COMMISSION_STATUSES).toEqual(['PENDING_CLEARANCE', 'CLEARED', 'PAID', 'VOIDED_REFUND']);
    expect(AFFILIATE_PAYOUT_STATUSES).toEqual(['PROCESSING', 'COMPLETED', 'FAILED']);
    expect(AFFILIATE_PAYOUT_TRIGGERS).toEqual(['cron', 'admin', 'auto']);
  });

  it('guards are exact and case-sensitive', () => {
    expect(isAffiliatePageStatus('PENDING_REVIEW')).toBe(true);
    expect(isAffiliatePageStatus('pending_review')).toBe(false);
    expect(isAffiliateCommissionStatus('PAID')).toBe(true);
    expect(isAffiliateCommissionStatus('REFUNDED')).toBe(false);
    expect(isAffiliatePayoutStatus('FAILED')).toBe(true);
    expect(isAffiliatePayoutStatus(null)).toBe(false);
    expect(isAffiliateStatus('SUSPENDED')).toBe(true);
    expect(isAffiliateStatus({})).toBe(false);
  });
});
