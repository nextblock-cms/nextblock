/**
 * Admin actions on one payout (the "Retry failed transfer" / "Release" buttons of
 * /cms/affiliates/payouts). Both reconcile against Stripe first (ADDENDUM B1): when a transfer of
 * the payout's group exists, the payout is completed with it and neither a new transfer nor a
 * release happens. The caller authorizes (`requireCmsAdmin()`) and passes the service-role and
 * Stripe clients.
 */
import { normalizeAffiliateUuid, type AffiliateRepositoryClient } from '../repository/client';
import type { AffiliatePayoutRow } from '../core/types';
import { AffiliatePayoutEngine, type AffiliatePayoutHooks, type AffiliatePayoutRetrySkipReason } from './engine';
import { releaseAffiliatePayoutViaRpc } from './rpc';
import type { AffiliatesStripeLike } from './stripe-like';

export type AffiliatePayoutActionError =
  | 'invalid_id'
  | 'not_found'
  | 'not_failed'
  | 'in_flight'
  | 'transfer_exists'
  | 'reconcile_failed'
  | 'stripe_error'
  | 'not_eligible'
  | 'account_not_ready'
  | 'balance_insufficient'
  | 'nothing_to_pay'
  | 'below_minimum'
  /** The payout was claimed with the other Stripe key mode (test ↔ live). */
  | 'other_mode'
  /** A manual payout (02036): recorded or cancelled under Pay manually, never retried or released through Stripe. */
  | 'manual_payout'
  /** A PayPal payout (02037): checked and settled with PayPal on the PayPal payouts screen, never through Stripe. */
  | 'paypal_payout'
  | 'transfer_failed'
  | 'sandbox'
  | 'stripe_not_configured'
  /** The app runner's refusal while the Affiliates package is inactive. */
  | 'package_inactive'
  | 'forbidden'
  | 'unknown';

export type AffiliatePayoutActionResult =
  | {
      ok: true;
      /**
       * `sent`: a new transfer was created; `completed`: Stripe already had the transfer, the
       * payout is now COMPLETED; `pending`: the outcome is unknown, the payout stays PROCESSING
       * and is reconciled by the next cycle; `released`: the commissions are claimable again.
       */
      outcome: 'sent' | 'completed' | 'pending' | 'released';
      payoutId: string;
      transferId: string | null;
    }
  | {
      ok: false;
      error: AffiliatePayoutActionError;
      payoutId: string | null;
      /** Stripe's refusal code for `transfer_failed`. */
      reason: string | null;
    };

export interface AffiliatePayoutAdminDeps {
  /** Service-role client. */
  supabase: AffiliateRepositoryClient;
  stripe: AffiliatesStripeLike;
  now?: () => Date;
  hooks?: Pick<AffiliatePayoutHooks, 'onPayoutSent' | 'onPayoutFailed' | 'onTransferMismatch' | 'onConnectFirstReady' | 'onError'>;
}

const SKIP_ERRORS: Readonly<Record<AffiliatePayoutRetrySkipReason, AffiliatePayoutActionError>> = {
  transfer_unusable: 'transfer_exists',
  reconcile_failed: 'reconcile_failed',
  not_eligible: 'not_eligible',
  account_not_ready: 'account_not_ready',
  balance_insufficient: 'balance_insufficient',
  nothing_to_pay: 'nothing_to_pay',
  below_minimum: 'below_minimum',
  other_mode: 'other_mode',
  unknown: 'unknown',
};

function refuse(error: AffiliatePayoutActionError, payoutId: string | null, reason: string | null = null): AffiliatePayoutActionResult {
  return { ok: false, error, payoutId, reason };
}

function done(
  outcome: 'sent' | 'completed' | 'pending' | 'released',
  payoutId: string,
  transferId: string | null = null
): AffiliatePayoutActionResult {
  return { ok: true, outcome, payoutId, transferId };
}

type Prepared =
  | { kind: 'failed_payout'; engine: AffiliatePayoutEngine; payout: AffiliatePayoutRow; reconciled: boolean }
  | { kind: 'result'; result: AffiliatePayoutActionResult };

/**
 * Loads the payout and brings it to a FAILED row with no transfer at Stripe: a COMPLETED payout
 * is refused, a PROCESSING one is refused while in flight (< 15 minutes) and otherwise reconciled
 * (completed when Stripe has the transfer, else failed as `stale`). The platform balance (and
 * with it the key mode) is read before anything asks Stripe about the payout: a payout claimed
 * with the other key mode is refused (`other_mode`), since this key can neither see its
 * transfers nor pay it.
 */
async function prepareFailedPayout(deps: AffiliatePayoutAdminDeps, payoutId: string): Promise<Prepared> {
  const id = normalizeAffiliateUuid(payoutId);
  if (!id) return { kind: 'result', result: refuse('invalid_id', null) };

  const engine = new AffiliatePayoutEngine({
    supabase: deps.supabase,
    stripe: deps.stripe,
    trigger: 'admin',
    now: deps.now,
    hooks: deps.hooks,
  });

  let payout: AffiliatePayoutRow | null;
  try {
    payout = await engine.loadPayout(id);
  } catch (error) {
    engine.recordError('load', error, { payoutId: id });
    return { kind: 'result', result: refuse('unknown', id) };
  }
  if (!payout) return { kind: 'result', result: refuse('not_found', id) };
  // A prepared manual payout (02036) is PROCESSING with no transfer at Stripe: reconciling it would
  // fail it as stale and a retry would send it through Stripe. It is recorded or cancelled instead.
  if (payout.method === 'manual') return { kind: 'result', result: refuse('manual_payout', id) };
  // A PayPal payout (02037) is settled by PayPal's answer (the PayPal sync), never by a transfer.
  if (payout.method === 'paypal') return { kind: 'result', result: refuse('paypal_payout', id) };
  if (payout.status === 'COMPLETED') return { kind: 'result', result: refuse('not_failed', id) };
  if (payout.status === 'PROCESSING' && !engine.isStale(payout)) return { kind: 'result', result: refuse('in_flight', id) };

  if (!(await engine.loadBalance())) return { kind: 'result', result: refuse('stripe_error', id) };
  if (engine.isOtherMode(payout)) return { kind: 'result', result: refuse('other_mode', id) };

  if (payout.status === 'PROCESSING') {
    const reconciled = await engine.reconcile(payout, { failStale: true });
    if (reconciled.kind === 'completed') {
      return { kind: 'result', result: done('completed', id, reconciled.transferId) };
    }
    if (reconciled.kind === 'other_mode') return { kind: 'result', result: refuse('other_mode', id) };
    if (reconciled.kind === 'error') return { kind: 'result', result: refuse('reconcile_failed', id) };
    if (reconciled.kind === 'transfer_unusable') return { kind: 'result', result: refuse('transfer_exists', id) };
    try {
      payout = await engine.loadPayout(id);
    } catch (error) {
      engine.recordError('load', error, { payoutId: id });
      return { kind: 'result', result: refuse('unknown', id) };
    }
    if (!payout || payout.status !== 'FAILED') return { kind: 'result', result: refuse('not_failed', id) };
    return { kind: 'failed_payout', engine, payout, reconciled: true };
  }

  return { kind: 'failed_payout', engine, payout, reconciled: false };
}

/**
 * Retries a FAILED (or stale PROCESSING) payout now, regardless of the automatic attempt limit:
 * reconcile, then the partner's eligibility and Connect readiness, the platform balance,
 * `prepare_affiliate_payout_retry` and a transfer with the new attempt's idempotency key. An
 * admin retry applies no minimum: it sends whatever refunds left (Stripe may still refuse a
 * tiny amount as `amount_too_small`).
 */
export async function retryAffiliatePayout(deps: AffiliatePayoutAdminDeps, payoutId: string): Promise<AffiliatePayoutActionResult> {
  const prepared = await prepareFailedPayout(deps, payoutId);
  if (prepared.kind === 'result') return prepared.result;
  const { engine, payout } = prepared;

  // prepareFailedPayout already read the balance and the key mode.
  const outcome = await engine.retry(payout, { skipReconcile: prepared.reconciled });
  if (outcome.kind === 'completed') return done('completed', payout.id, outcome.transferId);
  if (outcome.kind === 'sent') return done('sent', payout.id, outcome.transferId);
  if (outcome.kind === 'pending') return done('pending', payout.id, outcome.transferId);
  if (outcome.kind === 'failed') return refuse('transfer_failed', payout.id, outcome.reason);
  return refuse(SKIP_ERRORS[outcome.reason], payout.id);
}

/**
 * Gives a FAILED (or stale PROCESSING) payout up: its commissions are detached and claimable by
 * the next payout (`release_affiliate_payout`). Refused while Stripe holds a transfer of the
 * payout's group; that payout is completed instead.
 */
export async function releaseAffiliatePayout(deps: AffiliatePayoutAdminDeps, payoutId: string): Promise<AffiliatePayoutActionResult> {
  const prepared = await prepareFailedPayout(deps, payoutId);
  if (prepared.kind === 'result') {
    // A payout reconciliation just completed was paid after all: releasing it is refused.
    return prepared.result.ok && prepared.result.outcome === 'completed'
      ? refuse('transfer_exists', prepared.result.payoutId)
      : prepared.result;
  }
  const { engine, payout } = prepared;

  if (!prepared.reconciled) {
    const reconciled = await engine.reconcile(payout, { failStale: false });
    if (reconciled.kind === 'completed' || reconciled.kind === 'transfer_unusable') return refuse('transfer_exists', payout.id);
    if (reconciled.kind === 'other_mode') return refuse('other_mode', payout.id);
    if (reconciled.kind === 'error') return refuse('reconcile_failed', payout.id);
  }

  try {
    const released = await releaseAffiliatePayoutViaRpc(engine.supabase, payout.id);
    return released ? done('released', payout.id) : refuse('not_failed', payout.id);
  } catch (error) {
    engine.recordError('fail', error, { payoutId: payout.id });
    return refuse('unknown', payout.id);
  }
}
