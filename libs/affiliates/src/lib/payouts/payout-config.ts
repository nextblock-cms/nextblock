/**
 * Payout runner tuning (ADDENDUM B1/B2). Pure constants and id builders, shared by the cycle,
 * the admin retry/release paths and the app runner.
 */

import type { AffiliatePayoutRow } from '../core/types';

/** A PROCESSING payout untouched this long is reconciled against Stripe (B1). */
export const AFFILIATE_PAYOUT_STALE_AFTER_MS = 15 * 60 * 1000;

/** Automatic retries stop after this many attempts; an admin can still retry by hand. */
export const AFFILIATE_PAYOUT_MAX_ATTEMPTS = 5;

/** A FAILED payout is retried automatically in a later daily cycle, not the one that failed it. */
export const AFFILIATE_PAYOUT_AUTO_RETRY_DELAY_MS = 12 * 60 * 60 * 1000;

/** Affiliates whose Stripe work (readiness check, claim, transfer) one cycle call does at most. */
export const AFFILIATE_PAYOUT_DEFAULT_BATCH_SIZE = 25;

/** Stale PROCESSING payouts one cycle call reconciles at most. */
export const AFFILIATE_PAYOUT_MAX_RECONCILES_PER_CYCLE = 50;

/** A cycle call stops starting new Stripe work after this long (the cron route allows 60 s). */
export const AFFILIATE_PAYOUT_DEFAULT_TIME_BUDGET_MS = 40_000;

/** Consecutive transient Stripe failures after which a cycle stops calling Stripe. */
export const AFFILIATE_PAYOUT_STRIPE_FAILURE_LIMIT = 3;

/** Hour (UTC) of the scheduled daily run (`npm run affiliates:schedule-payouts` default). */
export const AFFILIATE_PAYOUT_DEFAULT_RUN_HOUR_UTC = 6;

/**
 * `failure_reason` values automatic retries pick up (B1): the platform balance was short, or a
 * PROCESSING payout had no transfer at Stripe after the stale window. Every other reason is
 * definitive and waits for an admin.
 */
export const AFFILIATE_PAYOUT_TRANSIENT_FAILURE_REASONS = ['balance_insufficient', 'stale'] as const;

export type AffiliatePayoutTransientFailureReason = (typeof AFFILIATE_PAYOUT_TRANSIENT_FAILURE_REASONS)[number];

export function isAffiliatePayoutTransientFailureReason(reason: unknown): reason is AffiliatePayoutTransientFailureReason {
  return (
    typeof reason === 'string' &&
    (AFFILIATE_PAYOUT_TRANSIENT_FAILURE_REASONS as readonly string[]).includes(reason)
  );
}

/** What decides whether the daily cycle retries a failed payout by itself, beside the payout row. */
export interface AffiliatePayoutAutoRetryContext {
  /** Automated payouts are on, Stripe is configured and this is not the public sandbox. */
  automatedPayoutsRunning: boolean;
  /** The partner can be paid: active, approved once, with a Stripe Connect account. */
  partnerPayable: boolean;
}

/**
 * Whether the daily cycle will retry this FAILED payout by itself (`retryFailedPayouts` in
 * cycle.ts): a transient reason with attempts left, while automated payouts run and the partner
 * can be paid. Any other failed payout waits for an admin's Retry or Release, so the partner
 * portal must not promise an automatic retry for it.
 */
export function isAffiliatePayoutAutoRetryable(
  payout: Pick<AffiliatePayoutRow, 'status' | 'failure_reason' | 'attempt_count'>,
  context: AffiliatePayoutAutoRetryContext,
): boolean {
  return (
    payout.status === 'FAILED' &&
    context.automatedPayoutsRunning &&
    context.partnerPayable &&
    isAffiliatePayoutTransientFailureReason(payout.failure_reason) &&
    Number(payout.attempt_count) < AFFILIATE_PAYOUT_MAX_ATTEMPTS
  );
}

/** Every attempt of one payout shares this transfer group, so reconciliation finds any of them. */
export function affiliatePayoutTransferGroup(payoutId: string): string {
  return `affiliate_payout_${payoutId}`;
}

/** One idempotency key per attempt: a replayed attempt returns Stripe's first answer. */
export function affiliatePayoutIdempotencyKey(payoutId: string, attemptCount: number): string {
  return `affiliate-payout-${payoutId}-${attemptCount}`;
}

/**
 * The next scheduled payout run after `now` (default 06:00 UTC daily), for "next automated
 * payout" displays. The after() fallback may run earlier on days without a scheduler.
 */
export function computeAffiliateNextPayoutAt(
  now: Date = new Date(),
  hourUtc: number = AFFILIATE_PAYOUT_DEFAULT_RUN_HOUR_UTC
): Date {
  const hour = Number.isInteger(hourUtc) && hourUtc >= 0 && hourUtc <= 23 ? hourUtc : AFFILIATE_PAYOUT_DEFAULT_RUN_HOUR_UTC;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
