/**
 * Shared constants of the Affiliates & Creator Storefronts package (package id `affiliates`).
 * Pure and client-safe: importable from the proxy-free app code, client islands and server modules.
 */

/** `package_activations.package_id` and `verifyPackageOnline()` id. */
export const AFFILIATES_PACKAGE_ID = 'affiliates' as const;

/** `public.user_role` value held by affiliate / retailer accounts (added by migration 02029). */
export const AFFILIATE_RETAILER_ROLE = 'RTL' as const;

/** First-party, httpOnly referral cookie set by `apps/nextblock/proxy.ts`. Holds a handle only. */
export const AFFILIATE_REF_COOKIE = 'nb_affiliate_ref';

/** Fallback referral window when the tier lookup is unavailable. */
export const AFFILIATE_DEFAULT_COOKIE_DAYS = 30;

/** Fallback clearance hold (refund protection) when a tier carries none. */
export const AFFILIATE_DEFAULT_CLEARANCE_DAYS = 30;

/** Default minimum automated payout, in base-currency minor units. */
export const AFFILIATE_MIN_PAYOUT_CENTS_DEFAULT = 100;

/** Longest `affiliate_profiles.payout_email` (the 02036 CHECK; RFC 5321's path limit). */
export const AFFILIATE_PAYOUT_EMAIL_MAX_LENGTH = 254;

/**
 * Longest PayPal payout recipient (`affiliate_payouts.paypal_receiver`, the 02037 CHECK): PayPal's
 * Payouts API takes a `receiver` of at most 127 characters. A longer payout email is paid by hand.
 */
export const AFFILIATE_PAYPAL_RECEIVER_MAX_LENGTH = 127;

/**
 * `site_settings` key of the CMS-saved PayPal Payouts credentials (02037): the active environment,
 * a client id and an encrypted secret per environment. Read and written only with the service role
 * (a RESTRICTIVE policy keeps every API role away from it, an aal2 ADMIN included); never on the
 * public sandbox. The `PAYPAL_*` environment variables are the fallback.
 */
export const AFFILIATE_PAYPAL_SETTINGS_KEY = 'affiliates_paypal_secret';

/**
 * The CMS may release a PayPal payout whose batch PayPal never acknowledged (claimed and never sent,
 * or sent with an unknown outcome) this many hours after its last send. Enforced under the payout lock
 * by 02037's `release_paypal_affiliate_payout` (`interval '1 hour'`); every resend stamps the send first.
 */
export const AFFILIATE_PAYPAL_UNCONFIRMED_RELEASE_HOURS = 1;

/**
 * The CMS may release a PayPal payout PayPal acknowledged but never settled (the run cannot read its
 * batch, its item is missing, its status is unknown) this many days after its last send, while PayPal
 * lists no status it holds money in (SUCCESS, PENDING, ONHOLD, UNCLAIMED). Enforced by 02037's
 * `release_paypal_affiliate_payout` (`interval '7 days'`).
 */
export const AFFILIATE_PAYPAL_ACKNOWLEDGED_RELEASE_DAYS = 7;

/**
 * A PayPal batch sent with an unknown outcome is sent again with the same sender_batch_id only while
 * its payouts were claimed fewer than this many days ago: PayPal refuses a reused sender_batch_id, and
 * replays a PayPal-Request-Id, for 30 days only, after which the same id could be paid as a new batch.
 */
export const AFFILIATE_PAYPAL_RESEND_MAX_AGE_DAYS = 25;

/** Longest manual payout reference (`affiliate_payouts.external_reference`, the 02036 CHECK). */
export const AFFILIATE_MANUAL_PAYOUT_REFERENCE_MAX_LENGTH = 120;

/** Longest manual payout note for the partner (`affiliate_payouts.note`, the 02036 CHECK). */
export const AFFILIATE_MANUAL_PAYOUT_NOTE_MAX_LENGTH = 500;

/** `unstable_cache` tag of the public storefront reads (`/partners/[handle]`, sitemap, OG image). */
export const AFFILIATE_STOREFRONT_CACHE_TAG = 'public-affiliate-storefronts';

/** `unstable_cache` tag of the public tier reads (`/partners`). */
export const AFFILIATE_TIERS_CACHE_TAG = 'public-affiliate-tiers';

/**
 * `unstable_cache` tag of the public projection of the program settings (the partner terms page and
 * the signup form's terms link): the terms overrides, the minimum payout and the payout switch, never
 * the notification addresses.
 */
export const AFFILIATE_PROGRAM_SETTINGS_CACHE_TAG = 'public-affiliate-program-settings';

/**
 * The version of the built-in partner terms (`affiliates.terms.*` copy), shown as "Last updated" on
 * `/partners/terms`. Change it whenever the meaning of those terms changes.
 */
export const AFFILIATE_TERMS_VERSION = '2026-11-11';

export const AFFILIATE_PARTNERS_PATH = '/partners';
/**
 * The French URL of the partner program's landing page. `/partners` follows the visitor's language;
 * `/partenaires` always renders in French (the proxy pins the request locale), so each language has
 * an address search engines can index. Storefronts keep the one `/partners/<handle>` address.
 */
export const AFFILIATE_PARTNERS_PATH_FR = '/partenaires';
/**
 * The built-in partner terms, at one address per language like the landing page: `/partners/terms`
 * follows the visitor's language, `/partenaires/conditions` always renders in French. The handles
 * `terms` and `conditions` are reserved so no storefront can claim the English address.
 */
export const AFFILIATE_PARTNERS_TERMS_PATH = '/partners/terms';
export const AFFILIATE_PARTNERS_TERMS_PATH_FR = '/partenaires/conditions';
export const AFFILIATE_PORTAL_PATH = '/portal/retailer';
export const AFFILIATE_PORTAL_STOREFRONT_PATH = '/portal/retailer/storefront';
export const AFFILIATE_PORTAL_PAYOUTS_PATH = '/portal/retailer/payouts';
export const AFFILIATE_CMS_PATH = '/cms/affiliates';
export const AFFILIATE_CMS_APPROVALS_PATH = '/cms/affiliates/approvals';
export const AFFILIATE_CMS_PAYOUTS_PATH = '/cms/affiliates/payouts';
export const AFFILIATE_CMS_TIERS_PATH = '/cms/affiliates/tiers';
/** Stripe payouts: who pays partners, the Stripe key, a read-only connection test, balance vs what is owed. */
export const AFFILIATE_CMS_STRIPE_PATH = '/cms/affiliates/stripe';
/** PayPal payouts (02037): the PayPal credentials, a read-only connection test, the setup checklist, in-flight PayPal payouts. */
export const AFFILIATE_CMS_PAYPAL_PATH = '/cms/affiliates/paypal';

/** `site_settings` key holding `AffiliatesSettings` (ADMIN tier; written with the service role). */
export const AFFILIATE_SETTINGS_KEY = 'affiliates_settings';

/** Tier badge colours. Rendered through literal Tailwind class maps (never interpolated). */
export const AFFILIATE_BADGE_COLORS = [
  'violet',
  'indigo',
  'blue',
  'sky',
  'emerald',
  'amber',
  'orange',
  'rose',
  'slate',
] as const;

/**
 * Longest tier goal, in characters: `affiliate_tiers.goal` (the 02033 CHECK, after `btrim`) and each
 * `goal_translations` value the CMS writes.
 */
export const AFFILIATE_TIER_GOAL_MAX_LENGTH = 160;

/** Social profile keys accepted in `affiliate_profiles.social_links`. */
export const AFFILIATE_SOCIAL_NETWORKS = [
  'website',
  'instagram',
  'tiktok',
  'youtube',
  'x',
  'facebook',
  'pinterest',
  'linkedin',
] as const;

/** `system_alerts.alert_type` values owned by this package (allowed by migration 02030). */
export const AFFILIATE_ALERT_TYPES = {
  SIGNED_UP: 'affiliate_signed_up',
  PROFILE_COMPLETED: 'affiliate_profile_completed',
  PAYOUT_CONFIGURED: 'affiliate_payout_configured',
  PAGE_SUBMITTED: 'affiliate_page_submitted',
  PAYOUT_FAILED: 'affiliate_payout_failed',
  REFUND_AFTER_PAYOUT: 'affiliate_refund_after_payout',
} as const;

/** Alert types the global CMS banner shows (actionable); the rest appear on /cms/affiliates only. */
export const AFFILIATE_BANNER_ALERT_TYPES = [
  AFFILIATE_ALERT_TYPES.PAGE_SUBMITTED,
  AFFILIATE_ALERT_TYPES.PAYOUT_FAILED,
  AFFILIATE_ALERT_TYPES.REFUND_AFTER_PAYOUT,
] as const;

/** Copilot tool names. The `/api/affiliates/cortex` route registers exactly these three. */
export const RETAILER_COPILOT_TOOL_NAMES = [
  'generate_retailer_bio',
  'generate_storefront_section',
  'rewrite_storefront_copy',
] as const;

/** Stock photo hosts a storefront image may point at (Unsplash images stay hotlinked and credited). */
export const AFFILIATE_STOCK_IMAGE_ORIGINS = [
  'https://images.pexels.com',
  'https://images.unsplash.com',
  'https://plus.unsplash.com',
] as const;
