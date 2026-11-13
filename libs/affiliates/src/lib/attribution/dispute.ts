/**
 * Chargebacks, as the affiliate ledger sees them: one call of the service-role RPC
 * `set_affiliate_commission_dispute` (migration 02030, redefined by 02035). An open dispute HOLDS
 * the order's commission (`disputed_at`): it is not promoted to CLEARED, not claimed, and a FAILED
 * payout detaches it on its next retry, so a disputed sale is never paid out while the dispute is
 * open. An attributed order with no commission yet (its partner was paused at payment, or the paid
 * trigger failed) keeps the dispute itself (`orders.affiliate_disputed_at`, since 02035), and the
 * commission recorded later starts held: its hold counts from the payment, so without that it
 * could clear and be paid in the run that records it. A dispute closed without loss lifts the
 * hold, the order's included; a lost one is a full refund (`apply_affiliate_refund`), which voids
 * the commission (or leaves the tombstone that stops one from being recorded).
 */
import { normalizeAffiliateUuid } from '../repository/client';
import type { AffiliateGateway } from '../core/types';
import type { AffiliateCommissionDisputeInput, AffiliateCommissionDisputeOutcome } from './types';

const AFFILIATE_DISPUTE_OUTCOMES: ReadonlySet<string> = new Set<AffiliateCommissionDisputeOutcome>(['held', 'released', 'none']);

const AFFILIATE_DISPUTE_GATEWAYS: ReadonlySet<string> = new Set<AffiliateGateway>(['STRIPE', 'FREEMIUS']);

/** PostgREST / Postgres codes for "no such function": the affiliates schema is not installed. */
const AFFILIATE_DISPUTE_MISSING_RPC_CODES: ReadonlySet<string> = new Set(['PGRST202', '42883']);

let affiliateDisputeMissingRpcLogged = false;

/** A dispute the ledger could not record; thrown only when the caller passed `throwOnError`. */
export class AffiliateCommissionDisputeError extends Error {
  /** PostgREST / Postgres error code, when there is one. */
  readonly code: string | null;

  constructor(cause: unknown) {
    super('Affiliates: set_affiliate_commission_dispute failed', { cause });
    this.name = 'AffiliateCommissionDisputeError';
    const code = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
    this.code = typeof code === 'string' && code ? code : null;
  }
}

function affiliateDisputeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : '';
}

/**
 * Holds (`open: true`) or releases (`open: false`) the order's commission and returns what the
 * RPC did: 'held', 'released' or 'none'. Every answer is a success for a webhook. Invalid input
 * answers 'none' without a call. Errors are logged and answer 'none', unless `throwOnError`
 * (webhooks) asks for an `AffiliateCommissionDisputeError`; a database without the RPC always
 * answers 'none'.
 */
export async function setAffiliateCommissionDispute(
  input: AffiliateCommissionDisputeInput
): Promise<AffiliateCommissionDisputeOutcome> {
  const gateway = typeof input.gateway === 'string' ? input.gateway.trim().toUpperCase() : '';
  const orderId = normalizeAffiliateUuid(input.orderId);

  if (!AFFILIATE_DISPUTE_GATEWAYS.has(gateway) || !orderId || typeof input.open !== 'boolean') {
    return 'none';
  }

  try {
    const { data, error } = await input.supabase.rpc('set_affiliate_commission_dispute', {
      p_gateway: gateway,
      p_order_id: orderId,
      p_open: input.open,
    });

    if (error) throw error;

    return typeof data === 'string' && AFFILIATE_DISPUTE_OUTCOMES.has(data) ? (data as AffiliateCommissionDisputeOutcome) : 'none';
  } catch (error) {
    const code = affiliateDisputeErrorCode(error);

    if (AFFILIATE_DISPUTE_MISSING_RPC_CODES.has(code)) {
      if (!affiliateDisputeMissingRpcLogged) {
        affiliateDisputeMissingRpcLogged = true;
        console.warn(
          '[affiliates] set_affiliate_commission_dispute is missing (migration 02030 not applied); disputes do not hold commissions.'
        );
      }
      return 'none';
    }

    console.error(`[affiliates] Dispute on order ${orderId} not applied to its commission:`, code || 'unknown error');

    if (input.throwOnError) throw new AffiliateCommissionDisputeError(error);

    return 'none';
  }
}
