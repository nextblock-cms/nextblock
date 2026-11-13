/**
 * The slice of the Stripe Node SDK that payouts and Stripe Connect use, typed structurally so the
 * lib never imports `stripe`: the app passes `await getStripeClient()` from
 * `@nextblock-cms/ecommerce/server`, and tests pass a fake. Methods use shorthand syntax on
 * purpose, which keeps their parameters bivariant, so the SDK's wider signatures (extra optional
 * params, request options, `ApiListPromise`) fit without a cast.
 */

/** Per-request options; only the idempotency key is used. */
export interface AffiliateStripeRequestOptions {
  idempotencyKey?: string;
}

/** One currency of `balance.available` / `balance.pending` (minor units, lowercase currency). */
export interface AffiliateStripeBalanceAmount {
  amount: number;
  currency: string;
  /** Breakdown by source; a transfer draws from `card` unless told otherwise. */
  source_types?: { card?: number; bank_account?: number; fpx?: number } | null;
}

/** `GET /v1/balance` of the platform. `livemode` tells which key mode is in use. */
export interface AffiliateStripeBalanceLike {
  livemode: boolean;
  available: AffiliateStripeBalanceAmount[];
  pending?: AffiliateStripeBalanceAmount[];
}

/** A Stripe account: the platform's own (`accounts.retrieve(null)`) or a connected Express account. */
export interface AffiliateStripeAccountLike {
  id: string;
  country?: string | null;
  default_currency?: string | null;
  email?: string | null;
  details_submitted?: boolean | null;
  payouts_enabled?: boolean | null;
  capabilities?: { transfers?: string | null } | null;
  requirements?: {
    currently_due?: string[] | null;
    past_due?: string[] | null;
    disabled_reason?: string | null;
  } | null;
  metadata?: Record<string, string> | null;
}

/** A transfer from the platform balance to a connected account. */
export interface AffiliateStripeTransferLike {
  id: string;
  amount: number;
  currency: string;
  destination: string | { id: string } | null;
  transfer_group: string | null;
  reversed?: boolean;
  amount_reversed?: number;
  livemode?: boolean;
  created?: number;
  metadata?: Record<string, string> | null;
}

export interface AffiliateStripeTransferCreateParams {
  amount: number;
  /** Lowercase ISO code. */
  currency: string;
  destination: string;
  transfer_group: string;
  metadata?: Record<string, string>;
}

export interface AffiliateStripeTransferListParams {
  destination?: string;
  transfer_group?: string;
  limit?: number;
}

export interface AffiliateStripeAccountCreateParams {
  type: 'express';
  country: string;
  email?: string;
  capabilities: { transfers: { requested: boolean } };
  business_profile?: { url?: string; product_description?: string };
  metadata?: Record<string, string>;
  /** Cross-border accounts (country differs from the platform's) take the recipient agreement. */
  tos_acceptance?: { service_agreement: 'recipient' };
}

export interface AffiliateStripeAccountLinkCreateParams {
  account: string;
  refresh_url: string;
  return_url: string;
  type: 'account_onboarding';
}

/** What `getStripeClient()` must offer for payouts and Connect. The real SDK client satisfies it. */
export interface AffiliatesStripeLike {
  balance: {
    retrieve(): Promise<AffiliateStripeBalanceLike>;
  };
  accounts: {
    /** `null` retrieves the platform account itself (`GET /v1/account`). */
    retrieve(id: string | null): Promise<AffiliateStripeAccountLike>;
    create(
      params: AffiliateStripeAccountCreateParams,
      options?: AffiliateStripeRequestOptions
    ): Promise<AffiliateStripeAccountLike>;
    createLoginLink(id: string): Promise<{ url: string }>;
  };
  accountLinks: {
    create(params: AffiliateStripeAccountLinkCreateParams): Promise<{ url: string; expires_at?: number }>;
  };
  transfers: {
    create(
      params: AffiliateStripeTransferCreateParams,
      options?: AffiliateStripeRequestOptions
    ): Promise<AffiliateStripeTransferLike>;
    list(params: AffiliateStripeTransferListParams): Promise<{ data: AffiliateStripeTransferLike[]; has_more?: boolean }>;
  };
}
