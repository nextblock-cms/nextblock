import type { AffiliateGateway } from '../core/types';
import type { AffiliateRepositoryClient } from '../repository/client';

/**
 * How a sale reached its partner: the partner's storefront (a signed token the cart carried
 * from `/partners/<handle>`) or a referral link (the `nb_affiliate_ref` cookie the proxy set).
 * Stored as `orders.affiliate_source`.
 */
export type AffiliateAttributionSource = 'storefront' | 'referral_link';

/**
 * A storefront token whose signature, format and maximum age the app already verified
 * (`verifyAffiliateStorefrontToken`): the handle it was minted for and when.
 */
export interface AffiliateAttributionToken {
  handle: string;
  /** Unix seconds. */
  issuedAt: number;
}

export interface AffiliateCheckoutAttributionInput {
  /** The SERVICE-ROLE client: it reads partner rows and the partner's auth email. */
  supabase: AffiliateRepositoryClient;
  /** The verified storefront token from the cart, or null. */
  token: AffiliateAttributionToken | null;
  /** The referral cookie's value (a handle), or null. Validated here. */
  cookieHandle: string | null;
  /** The signed-in buyer, or null for a guest. */
  buyerUserId: string | null;
  /** The buyer's email (account email, else the checkout form's), or null. */
  buyerEmail: string | null;
  /** Clock override in epoch milliseconds (tests). */
  now?: number;
}

/** The partner a checkout is attributed to. The providers copy it onto the pending order. */
export interface AffiliateCheckoutAttribution {
  affiliateId: string;
  handle: string;
  source: AffiliateAttributionSource;
  /** Store default currency code at checkout (`orders.affiliate_base_currency`), or null. */
  baseCurrency: string | null;
}

/** `apply_affiliate_refund`'s answer (migration 02030). */
export type AffiliateRefundOutcome = 'voided' | 'adjusted' | 'alerted' | 'none';

export interface AffiliateRefundInput {
  /** The SERVICE-ROLE client (the RPC is granted to service_role only). */
  supabase: AffiliateRepositoryClient;
  gateway: AffiliateGateway;
  orderId: string;
  /**
   * CUMULATIVE refunded amount of the payment (Stripe `charge.amount_refunded`), in the order
   * currency's minor units. Never the delta of the latest refund: the RPC is monotonic, so
   * replays and out-of-order events can only ever raise the refunded share.
   */
  refundedMinor: number;
  /** The payment's total (Stripe `charge.amount`), same units. */
  orderTotalMinor: number;
  /** A full refund or a lost dispute: the commission is voided. */
  full: boolean;
  /**
   * Webhooks pass true: a failed call then throws `AffiliateRefundError`, the route answers 5xx
   * and the provider redelivers the event. Otherwise a failure is logged and reads as 'none'.
   * A database without the affiliates schema always reads as 'none' (a redelivery cannot help).
   */
  throwOnError?: boolean;
}

/**
 * `set_affiliate_commission_dispute`'s answer (migration 02030, 02035): 'held' (the commission is
 * on hold while the dispute is open: not promoted, not claimed, detached from a FAILED payout on
 * its next retry; or, for an attributed order with no commission yet, the order keeps the dispute
 * and the commission recorded later starts held), 'released' (the dispute closed without loss: the
 * hold is lifted, the order's included) or 'none' (unattributed order, a paid or voided
 * commission, nothing to lift).
 */
export type AffiliateCommissionDisputeOutcome = 'held' | 'released' | 'none';

export interface AffiliateCommissionDisputeInput {
  /** The SERVICE-ROLE client (the RPC is granted to service_role only). */
  supabase: AffiliateRepositoryClient;
  gateway: AffiliateGateway;
  orderId: string;
  /** True: a dispute opened (hold the commission). False: it closed without loss (release it). */
  open: boolean;
  /**
   * Webhooks pass true: a failed call then throws `AffiliateCommissionDisputeError`, the route
   * answers 5xx and the provider redelivers. A database without the RPC always reads as 'none'.
   */
  throwOnError?: boolean;
}
