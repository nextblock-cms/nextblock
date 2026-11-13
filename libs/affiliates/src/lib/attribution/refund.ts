/**
 * Refunds and lost disputes, as the affiliate ledger sees them (ADDENDUM A7, B5, B6): one call
 * of the service-role RPC `apply_affiliate_refund`, which voids, reduces (pro rata, monotonic)
 * or flags the order's commission under the ledger's row locks.
 */
import { normalizeAffiliateUuid } from '../repository/client';
import type { AffiliateGateway } from '../core/types';
import type { AffiliateRefundInput, AffiliateRefundOutcome } from './types';

const AFFILIATE_REFUND_OUTCOMES: ReadonlySet<string> = new Set<AffiliateRefundOutcome>(['voided', 'adjusted', 'alerted', 'none']);

const AFFILIATE_REFUND_GATEWAYS: ReadonlySet<string> = new Set<AffiliateGateway>(['STRIPE', 'FREEMIUS']);

/** PostgREST / Postgres codes for "no such function": the affiliates schema is not installed. */
const AFFILIATE_REFUND_MISSING_RPC_CODES: ReadonlySet<string> = new Set(['PGRST202', '42883']);

let affiliateRefundMissingRpcLogged = false;

/** A refund the ledger could not apply; thrown only when the caller passed `throwOnError`. */
export class AffiliateRefundError extends Error {
  /** PostgREST / Postgres error code, when there is one. */
  readonly code: string | null;

  constructor(cause: unknown) {
    super('Affiliates: apply_affiliate_refund failed', { cause });
    this.name = 'AffiliateRefundError';
    const code = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
    this.code = typeof code === 'string' && code ? code : null;
  }
}

function toAffiliateRefundMinor(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function affiliateRefundErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : '';
}

/**
 * Applies a refund to the order's commission and returns what the RPC did:
 * 'voided' (full refund; or a tombstone on an attributed order that has no commission yet, so
 * a later paid event can never record one), 'adjusted' (partial, pro rata), 'alerted' (the
 * commission was already paid or in a payout: amounts kept, an admin alert raised) or 'none'.
 *
 * Pass the CUMULATIVE refunded amount and the payment total. A partial refund needs both
 * (positive total); a full one needs neither. Invalid input answers 'none' without a call.
 * Errors are logged and answer 'none', unless `throwOnError` (webhooks) asks for an
 * `AffiliateRefundError`; a database without the RPC always answers 'none'.
 */
export async function applyAffiliateRefund(input: AffiliateRefundInput): Promise<AffiliateRefundOutcome> {
  const gateway = typeof input.gateway === 'string' ? input.gateway.trim().toUpperCase() : '';
  const orderId = normalizeAffiliateUuid(input.orderId);

  if (!AFFILIATE_REFUND_GATEWAYS.has(gateway) || !orderId) {
    return 'none';
  }

  const full = input.full === true;
  const refundedMinor = toAffiliateRefundMinor(input.refundedMinor);
  const totalMinor = toAffiliateRefundMinor(input.orderTotalMinor);

  // The RPC treats a non-positive total as a full refund: a partial one without a real total
  // must never void a commission.
  if (!full && (refundedMinor === null || totalMinor === null || totalMinor <= 0 || refundedMinor <= 0)) {
    return 'none';
  }

  try {
    const { data, error } = await input.supabase.rpc('apply_affiliate_refund', {
      p_gateway: gateway,
      p_order_id: orderId,
      p_refunded_minor: refundedMinor ?? 0,
      p_order_total_minor: totalMinor ?? 0,
      p_full: full,
    });

    if (error) throw error;

    return typeof data === 'string' && AFFILIATE_REFUND_OUTCOMES.has(data) ? (data as AffiliateRefundOutcome) : 'none';
  } catch (error) {
    const code = affiliateRefundErrorCode(error);

    if (AFFILIATE_REFUND_MISSING_RPC_CODES.has(code)) {
      if (!affiliateRefundMissingRpcLogged) {
        affiliateRefundMissingRpcLogged = true;
        console.warn('[affiliates] apply_affiliate_refund is missing (migration 02030 not applied); refunds do not reach commissions.');
      }
      return 'none';
    }

    console.error(`[affiliates] Refund of order ${orderId} not applied to its commission:`, code || 'unknown error');

    if (input.throwOnError) throw new AffiliateRefundError(error);

    return 'none';
  }
}
