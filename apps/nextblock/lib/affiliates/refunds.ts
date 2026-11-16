import 'server-only';

import {
  applyAffiliateRefund,
  setAffiliateCommissionDispute,
  type AffiliateCommissionDisputeOutcome,
  type AffiliateRefundOutcome,
  type AffiliateRepositoryClient,
} from '@nextblock-cms/affiliates/server';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import {
  syncFreemiusOrderDisputeFromWebhookEvent,
  syncFreemiusOrderRefundFromWebhookEvent,
  type FreemiusWebhookEvent,
} from '@nextblock-cms/ecommerce/freemius-order-sync';
import {
  syncStripeOrderDisputeFromEvent,
  syncStripeOrderRefundFromEvent,
} from '@nextblock-cms/ecommerce/stripe/order-sync';
import type { StripeWebhookEvent } from '@nextblock-cms/ecommerce/stripe/webhooks';

import {
  scheduleAffiliateNotification,
  sweepAffiliateCommissionNotifications,
  sweepAffiliateRefundAlertEmails,
} from './notify';
import { isAffiliatesProgramActive } from './package-state';

/**
 * The payment hooks of NextBlock Affiliates: refunds, disputes and lost disputes from the
 * webhooks (ADDENDUM B5, B6) and the commission sweep after a payment (B8).
 *
 * The ecommerce helpers apply the store side of a refund (a full refund moves a paid order to
 * 'refunded'; the database's order trigger then voids its commission); this adds the ledger side
 * through `apply_affiliate_refund` (partial refunds, the tombstone that stops a late commission,
 * alerts after a payout). A dispute never changes an order's status: an open one holds the
 * commission (`set_affiliate_commission_dispute`; an attributed order with no commission yet keeps
 * the dispute in `affiliate_disputed_at`, so the commission recorded later starts held, 02035), one
 * the store wins releases it, and a lost one is a full refund.
 *
 * The ledger side runs whatever the package state, like the order trigger does: a refund or a
 * dispute skipped while the license check failed (or the license lapsed) would be lost for good,
 * since nothing re-derives it later, and the unreduced commission would be paid on reactivation.
 * The RPCs answer 'none' for an order without a partner, and the lib answers 'none' on a database
 * without the affiliates schema. Every step is idempotent, so the webhook routes let every error
 * through: they answer 5xx and the provider redelivers the event.
 */

export interface AffiliateRefundWebhookResult {
  /** The event refunded something and its order was found. */
  handled: boolean;
  orderId: string | null;
  full: boolean;
  /** This event moved the order to 'refunded'. */
  orderStatusUpdated: boolean;
  /** What the affiliate ledger did; 'skipped' when no order matched or the refund concerns no commission (a renewal). */
  affiliate: AffiliateRefundOutcome | 'skipped';
}

export interface AffiliateDisputeWebhookResult {
  /** The event opened a dispute or closed one without loss, and its order was found. */
  handled: boolean;
  orderId: string | null;
  /** True: the dispute opened (hold); false: it closed without loss (release). */
  open: boolean;
  /** What the affiliate ledger did; 'skipped' when no order matched or the dispute concerns no commission. */
  affiliate: AffiliateCommissionDisputeOutcome | 'skipped';
}

async function isAffiliatesPackageActive(): Promise<boolean> {
  try {
    return await isAffiliatesProgramActive();
  } catch {
    return false;
  }
}

function ledgerClient(): AffiliateRepositoryClient {
  return getServiceRoleSupabaseClient() as unknown as AffiliateRepositoryClient;
}

async function applyLedgerRefund(input: {
  gateway: 'STRIPE' | 'FREEMIUS';
  orderId: string;
  refundedMinor: number;
  orderTotalMinor: number;
  full: boolean;
}): Promise<AffiliateRefundOutcome> {
  return applyAffiliateRefund({ supabase: ledgerClient(), ...input, throwOnError: true });
}

/**
 * `charge.refunded` (full or partial, with the charge's CUMULATIVE refunded amount, so replays
 * and out-of-order deliveries are harmless) and `charge.dispute.closed` lost (a full refund).
 * Throws on any database or Stripe failure.
 */
export async function handleStripeRefundWebhookEvent(event: StripeWebhookEvent): Promise<AffiliateRefundWebhookResult> {
  const refund = await syncStripeOrderRefundFromEvent(event);

  if (!refund.isRefund || !refund.orderId) {
    return { handled: false, orderId: null, full: refund.full, orderStatusUpdated: false, affiliate: 'skipped' };
  }

  const affiliate = await applyLedgerRefund({
    gateway: 'STRIPE',
    orderId: refund.orderId,
    refundedMinor: refund.refundedMinor,
    orderTotalMinor: refund.totalMinor,
    full: refund.full,
  });

  return {
    handled: true,
    orderId: refund.orderId,
    full: refund.full,
    orderStatusUpdated: refund.statusUpdated,
    affiliate,
  };
}

/**
 * `charge.dispute.created` holds the order's commission (not promoted, not claimed) until the
 * dispute closes; `charge.dispute.closed` with any status but lost releases it (a lost one is a
 * refund, `handleStripeRefundWebhookEvent`). The order itself never changes. Throws on any
 * database or Stripe failure, so Stripe redelivers.
 */
export async function handleStripeDisputeWebhookEvent(event: StripeWebhookEvent): Promise<AffiliateDisputeWebhookResult> {
  const dispute = await syncStripeOrderDisputeFromEvent(event);

  if (!dispute.isDispute || !dispute.orderId) {
    return { handled: false, orderId: null, open: dispute.open, affiliate: 'skipped' };
  }

  const affiliate = await setAffiliateCommissionDispute({
    supabase: ledgerClient(),
    gateway: 'STRIPE',
    orderId: dispute.orderId,
    open: dispute.open,
    throwOnError: true,
  });

  return { handled: true, orderId: dispute.orderId, open: dispute.open, affiliate };
}

/** What the Freemius webhook route verified about an event. */
export interface FreemiusWebhookHandlerOptions {
  /**
   * The product whose secret verified the event (`getFreemiusWebhookVerification`): only an order
   * of that product is touched. Passed on to the order sync explicitly, so the binding holds even
   * when a caller hands over an event whose `plugin_id` was not overwritten with it. Without it,
   * the sync keeps to the event's own `plugin_id`.
   */
  productId?: string;
}

/**
 * `payment.refund` / `payment.refunded` / `payment.dispute.lost` / `payment.dispute.closed`,
 * always a full refund, for an order of the verified product only (`options.productId`). The
 * refund of a renewal payment changes nothing (renewals never earned; the order records the first
 * purchase). Throws on any database failure.
 */
export async function handleFreemiusRefundWebhookEvent(
  event: FreemiusWebhookEvent,
  options: FreemiusWebhookHandlerOptions = {}
): Promise<AffiliateRefundWebhookResult> {
  const refund = await syncFreemiusOrderRefundFromWebhookEvent({ event, productId: options.productId });

  if (!refund.isRefund || !refund.orderId || refund.isRenewal) {
    return { handled: false, orderId: refund.orderId, full: true, orderStatusUpdated: false, affiliate: 'skipped' };
  }

  const affiliate = await applyLedgerRefund({
    gateway: 'FREEMIUS',
    orderId: refund.orderId,
    refundedMinor: 0,
    orderTotalMinor: 0,
    full: true,
  });

  return {
    handled: true,
    orderId: refund.orderId,
    full: true,
    orderStatusUpdated: refund.statusUpdated,
    affiliate,
  };
}

/**
 * `payment.dispute.created` holds the order's commission until the dispute closes;
 * `payment.dispute.won` releases it (a lost or refunded dispute is a refund,
 * `handleFreemiusRefundWebhookEvent`), for an order of the verified product only
 * (`options.productId`). A dispute on a renewal payment concerns no commission. The order's status
 * never changes (an order that stored no product gets the one its items prove). Throws on any
 * database failure, so Freemius redelivers.
 */
export async function handleFreemiusDisputeWebhookEvent(
  event: FreemiusWebhookEvent,
  options: FreemiusWebhookHandlerOptions = {}
): Promise<AffiliateDisputeWebhookResult> {
  const dispute = await syncFreemiusOrderDisputeFromWebhookEvent({ event, productId: options.productId });

  if (!dispute.isDispute || !dispute.orderId || dispute.isRenewal) {
    return { handled: false, orderId: dispute.orderId, open: dispute.open, affiliate: 'skipped' };
  }

  const affiliate = await setAffiliateCommissionDispute({
    supabase: ledgerClient(),
    gateway: 'FREEMIUS',
    orderId: dispute.orderId,
    open: dispute.open,
    throwOnError: true,
  });

  return { handled: true, orderId: dispute.orderId, open: dispute.open, affiliate };
}

/**
 * Schedule the COMMISSION_EARNED sweep (`claim_affiliate_commission_notifications`) and the
 * refund-after-payout email sweep after the response, when the Affiliates package is active.
 * Called once a webhook or the checkout success page marked an order paid (the database trigger
 * records the commission) or applied a refund (which may raise an affiliate_refund_after_payout
 * alert). Both sweeps claim before they send, so overlapping runs never double-send. Never throws.
 */
export function scheduleAffiliateCommissionSweep(): void {
  scheduleAffiliateNotification(async () => {
    if (!(await isAffiliatesPackageActive())) {
      return;
    }

    await sweepAffiliateCommissionNotifications();
    await sweepAffiliateRefundAlertEmails();
  });
}
