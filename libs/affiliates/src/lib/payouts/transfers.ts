/**
 * The two Stripe calls a payout makes (ADDENDUM B1): the transfer itself, created with one
 * idempotency key per attempt, and the reconciliation lookup that finds a transfer of ANY
 * attempt through the payout's transfer group.
 */
import type { AffiliatePayoutRow } from '../core/types';
import { affiliatePayoutIdempotencyKey, affiliatePayoutTransferGroup } from './payout-config';
import type { AffiliateStripeTransferLike, AffiliatesStripeLike } from './stripe-like';

export type AffiliatePayoutTransferInput = Pick<
  AffiliatePayoutRow,
  'id' | 'affiliate_id' | 'amount_cents' | 'currency' | 'stripe_destination_account' | 'attempt_count'
>;

export interface AffiliatePayoutTransferLookup {
  /** The transfer the payout corresponds to, or null when Stripe has none in the group. */
  transfer: AffiliateStripeTransferLike | null;
  /** Transfers in the group that are not fully reversed (more than one means a double payment). */
  activeCount: number;
}

function hasTransferId(transfer: AffiliateStripeTransferLike | null | undefined): transfer is AffiliateStripeTransferLike {
  return Boolean(transfer && typeof transfer.id === 'string' && transfer.id.trim() && transfer.id.length <= 255);
}

/**
 * Sends the payout: `amount_cents` in the payout currency (lowercased) to the destination
 * snapshot, in the transfer group `affiliate_payout_<id>`, with idempotency key
 * `affiliate-payout-<id>-<attempt_count>`. Throws whatever the SDK throws; classify it with
 * `classifyAffiliateStripeError`.
 */
export async function createAffiliatePayoutTransfer(
  stripe: AffiliatesStripeLike,
  payout: AffiliatePayoutTransferInput
): Promise<AffiliateStripeTransferLike> {
  const transfer = await stripe.transfers.create(
    {
      amount: payout.amount_cents,
      currency: payout.currency.toLowerCase(),
      destination: payout.stripe_destination_account,
      transfer_group: affiliatePayoutTransferGroup(payout.id),
      metadata: {
        payout_id: payout.id,
        affiliate_id: payout.affiliate_id,
        attempt: String(payout.attempt_count),
      },
    },
    { idempotencyKey: affiliatePayoutIdempotencyKey(payout.id, payout.attempt_count) }
  );
  if (!hasTransferId(transfer)) {
    // A success without an id cannot be recorded; treat it like an unknown outcome.
    throw new Error('Stripe returned a transfer without an id.');
  }
  return transfer;
}

/**
 * Looks the payout up at Stripe: `transfers.list({ destination, transfer_group, limit: 10 })`.
 * Prefers a live transfer of the payout's amount, then any live one, then a reversed one (the
 * money left even if an admin reversed it later). Throws when Stripe cannot be asked.
 */
export async function findAffiliatePayoutTransfer(
  stripe: AffiliatesStripeLike,
  payout: Pick<AffiliatePayoutRow, 'id' | 'stripe_destination_account' | 'amount_cents'>
): Promise<AffiliatePayoutTransferLookup> {
  const group = affiliatePayoutTransferGroup(payout.id);
  const list = await stripe.transfers.list({
    destination: payout.stripe_destination_account,
    transfer_group: group,
    limit: 10,
  });
  const transfers = (Array.isArray(list?.data) ? list.data : []).filter(
    (transfer) => hasTransferId(transfer) && transfer.transfer_group === group
  );
  const active = transfers.filter((transfer) => transfer.reversed !== true);
  const transfer =
    active.find((candidate) => candidate.amount === payout.amount_cents) ?? active[0] ?? transfers[0] ?? null;
  return { transfer, activeCount: active.length };
}

/** The transfer's destination account id, whatever shape the SDK returned. */
export function affiliateTransferDestinationId(transfer: Pick<AffiliateStripeTransferLike, 'destination'>): string | null {
  const destination = transfer.destination;
  if (typeof destination === 'string') return destination;
  if (destination && typeof destination === 'object' && typeof destination.id === 'string') return destination.id;
  return null;
}
