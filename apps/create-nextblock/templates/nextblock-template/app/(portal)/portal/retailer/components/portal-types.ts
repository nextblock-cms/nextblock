import type {
  AffiliatePageStatus,
  AffiliatePayoutEmailKind,
  AffiliateSocialLinks,
  AffiliateSocialNetwork,
  StorefrontEditorProduct,
} from '@nextblock-cms/affiliates';

/**
 * Result shapes of the partner portal's server actions (`../actions.ts`), shared with the client
 * islands. Plain types: a `'use server'` module may only export async functions, and client code
 * imports these with `import type`.
 */

export type RetailerPortalActionError =
  | 'unauthorized'
  | 'forbidden'
  | 'suspended'
  | 'package_inactive'
  | 'invalid_input'
  | 'invalid_social_links'
  | 'not_found'
  | 'pending_review'
  | 'conflict'
  | 'empty_storefront'
  /** The storefront draft is over the database's size limit (a 02030 CHECK refused the save). */
  | 'too_large'
  | 'missing_title'
  | 'nothing_to_submit'
  | 'not_pending'
  /** A withdrawn submission is sent again before the resubmission cooldown ran out. */
  | 'rate_limited'
  | 'sandbox'
  | 'connect_unavailable'
  /** The store has no Stripe account set up yet: bank payouts cannot be connected at all (not a transient failure). */
  | 'payouts_not_configured'
  /**
   * The payout email is not one deliverable-looking address (02036), or, for PayPal, not one PayPal
   * can take as is (02037: at most 127 characters).
   */
  | 'invalid_payout_email'
  | 'unknown';

export type RetailerPortalFailure = {
  ok: false;
  error: RetailerPortalActionError;
  /** For `invalid_social_links`: the networks whose link was refused. */
  fields?: AffiliateSocialNetwork[];
  /** For `conflict`: the draft version the server holds now. */
  currentDraftVersion?: number;
};

export type PortalLocale = 'en' | 'fr';

export interface RetailerProfileInput {
  displayName: string;
  bio: string;
  socialLinks: AffiliateSocialLinks;
  preferredLocale: PortalLocale;
}

export type SaveRetailerProfileResult =
  | {
      ok: true;
      profile: { displayName: string; bio: string; socialLinks: AffiliateSocialLinks; preferredLocale: PortalLocale };
      /** True when this save completed the profile step for the first time. */
      profileCompleted: boolean;
    }
  | RetailerPortalFailure;

export interface StorefrontDraftInput {
  title: string;
  metaDescription: string;
  /** The editor document (validated and sanitized on the server). */
  draft: unknown;
  featuredProductIds: string[];
  expectedDraftVersion: number;
}

export type SaveStorefrontDraftResult =
  | {
      ok: true;
      draftVersion: number;
      approvalStatus: AffiliatePageStatus;
      /** What was stored after validation (inactive or unknown products are dropped). */
      featuredProductIds: string[];
      title: string;
      metaDescription: string;
    }
  | RetailerPortalFailure;

export type SubmitStorefrontResult =
  | { ok: true; approvalStatus: AffiliatePageStatus; submittedAt: string }
  | RetailerPortalFailure;

export type WithdrawStorefrontResult = { ok: true; approvalStatus: AffiliatePageStatus } | RetailerPortalFailure;

export type StorefrontProductsResult = { ok: true; products: StorefrontEditorProduct[] } | RetailerPortalFailure;

export type StripeConnectRedirectResult = { ok: true; url: string } | RetailerPortalFailure;

export type StripeConnectRefreshResult = { ok: true; ready: boolean } | RetailerPortalFailure;

/**
 * `saveRetailerPayoutEmail`: what is stored now (lowercased), or null once cleared, and what it is for
 * (02037: a PayPal account or an Interac e-Transfer address).
 */
export type SaveRetailerPayoutEmailResult =
  | { ok: true; payoutEmail: string | null; payoutEmailKind: AffiliatePayoutEmailKind }
  | RetailerPortalFailure;

/** Upload route responses (`POST /api/affiliates/upload`). */
export type PortalUploadKind = 'avatar' | 'image';

export type PortalUploadError =
  | 'unauthorized'
  | 'forbidden'
  | 'suspended'
  | 'package_inactive'
  | 'pending_review'
  | 'rate_limited'
  | 'image_limit'
  | 'too_large'
  | 'unsupported_type'
  | 'invalid_image'
  | 'invalid_request'
  | 'storage_unavailable'
  | 'upload_failed'
  | 'network';

export type PortalUploadResult =
  | { ok: true; src: string; width: number; height: number; objectKey: string }
  | { ok: false; error: PortalUploadError };
