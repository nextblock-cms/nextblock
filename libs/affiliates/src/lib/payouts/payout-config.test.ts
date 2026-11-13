import { describe, expect, it } from 'vitest';

import {
  AFFILIATE_PAYOUT_MAX_ATTEMPTS,
  AFFILIATE_PAYOUT_TRANSIENT_FAILURE_REASONS,
  isAffiliatePayoutAutoRetryable,
  type AffiliatePayoutAutoRetryContext,
} from './payout-config';

/**
 * Whether the partner portal may promise an automatic retry: the same conditions as the daily
 * cycle's `retryFailedPayouts` (FAILED, a transient reason, attempts left), plus payouts running
 * and a partner who can be paid, which the cycle checks before it calls Stripe.
 */

const RUNNING: AffiliatePayoutAutoRetryContext = { automatedPayoutsRunning: true, partnerPayable: true };

function failed(failureReason: string | null, attemptCount = 1) {
  return { status: 'FAILED' as const, failure_reason: failureReason, attempt_count: attemptCount };
}

describe('isAffiliatePayoutAutoRetryable', () => {
  it('retries a transient failure with attempts left', () => {
    for (const reason of AFFILIATE_PAYOUT_TRANSIENT_FAILURE_REASONS) {
      expect(isAffiliatePayoutAutoRetryable(failed(reason), RUNNING)).toBe(true);
      expect(isAffiliatePayoutAutoRetryable(failed(reason, AFFILIATE_PAYOUT_MAX_ATTEMPTS - 1), RUNNING)).toBe(true);
    }
  });

  it('leaves a definitive failure, or one out of attempts, to an admin', () => {
    expect(isAffiliatePayoutAutoRetryable(failed('account_closed'), RUNNING)).toBe(false);
    expect(isAffiliatePayoutAutoRetryable(failed('transfers_not_allowed'), RUNNING)).toBe(false);
    expect(isAffiliatePayoutAutoRetryable(failed(null), RUNNING)).toBe(false);
    expect(isAffiliatePayoutAutoRetryable(failed('balance_insufficient', AFFILIATE_PAYOUT_MAX_ATTEMPTS), RUNNING)).toBe(false);
    expect(isAffiliatePayoutAutoRetryable(failed('balance_insufficient', Number.NaN), RUNNING)).toBe(false);
  });

  it('promises nothing while payouts do not run or the partner cannot be paid', () => {
    const payout = failed('balance_insufficient');
    expect(isAffiliatePayoutAutoRetryable(payout, { automatedPayoutsRunning: false, partnerPayable: true })).toBe(false);
    expect(isAffiliatePayoutAutoRetryable(payout, { automatedPayoutsRunning: true, partnerPayable: false })).toBe(false);
  });

  it('is only ever true for a failed payout', () => {
    expect(isAffiliatePayoutAutoRetryable({ status: 'PROCESSING', failure_reason: 'stale', attempt_count: 1 }, RUNNING)).toBe(false);
    expect(isAffiliatePayoutAutoRetryable({ status: 'COMPLETED', failure_reason: 'stale', attempt_count: 1 }, RUNNING)).toBe(false);
  });
});
