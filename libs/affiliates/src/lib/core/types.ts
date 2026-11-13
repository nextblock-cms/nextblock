/**
 * Row and domain types of the Affiliates package. Hand-written because the generated
 * `@nextblock-cms/db` `Database` type only learns the new tables after `npm run db:types`
 * runs against a project that has migrations 02029–02031. Keep in lockstep with
 * `libs/db/src/supabase/migrations/02030_affiliates_schema.sql`.
 */
import type {
  AFFILIATE_ALERT_TYPES,
  AFFILIATE_BADGE_COLORS,
  AFFILIATE_SOCIAL_NETWORKS,
} from './constants';

export type AffiliateOnboardingStep =
  | 'SIGNED_UP'
  | 'PROFILE_COMPLETED'
  | 'PAYOUT_CONFIGURED'
  | 'PAGE_SUBMITTED'
  | 'ACTIVE_PUBLISHED';

export type AffiliateStatus = 'ACTIVE' | 'SUSPENDED';

export type AffiliatePageStatus = 'DRAFT' | 'PENDING_REVIEW' | 'PUBLISHED' | 'CHANGES_REQUESTED';

export type AffiliateGateway = 'STRIPE' | 'FREEMIUS';

export type AffiliateCommissionStatus = 'PENDING_CLEARANCE' | 'CLEARED' | 'PAID' | 'VOIDED_REFUND';

export type AffiliatePayoutStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED';

export type AffiliatePayoutTrigger = 'cron' | 'admin' | 'auto';

/**
 * How a payout was made (`affiliate_payouts.method`, migrations 02036 and 02037): a Stripe Connect
 * transfer from the platform balance, a PayPal Payouts item the daily run sends from the operator's
 * PayPal balance (02037), or money the operator sent outside Stripe and recorded in the CMS. It is
 * also how the program pays the commissions of each gateway (`AffiliatesPayoutMethods`).
 */
export type AffiliatePayoutMethod = 'stripe_connect' | 'paypal' | 'manual';

/**
 * What a partner's payout email is (`affiliate_profiles.payout_email_kind`, 02037): the email of a
 * PayPal account (PayPal payouts and the PayPal payouts file can use it) or an Interac e-Transfer
 * address (paid by hand only: PayPal cannot send an Interac e-Transfer).
 */
export type AffiliatePayoutEmailKind = 'paypal' | 'interac';

/** Where a manual payout was sent from (`affiliate_payouts.manual_channel`, 02036). */
export type AffiliateManualPayoutChannel = 'paypal' | 'interac' | 'wise' | 'bank_transfer' | 'other';

/**
 * How the commissions of each sale gateway are paid (`affiliates_settings.payoutMethods`). Freemius
 * pays the operator (monthly, by PayPal), never the partners, and its money never reaches the Stripe
 * balance: `paypal` takes those commissions out of the Stripe transfers and the daily run pays them
 * from the operator's PayPal balance with the PayPal Payouts API (02037); `manual` takes them out
 * too, and the operator records what they sent from PayPal, Interac e-Transfer, Wise or a bank.
 */
export interface AffiliatesPayoutMethods {
  /** Commissions earned on Stripe (physical product) sales. */
  stripeSales: AffiliatePayoutMethod;
  /** Commissions earned on Freemius (digital product) sales. */
  freemiusSales: AffiliatePayoutMethod;
}

export type AffiliateBadgeColor = (typeof AFFILIATE_BADGE_COLORS)[number];

export type AffiliateSocialNetwork = (typeof AFFILIATE_SOCIAL_NETWORKS)[number];

export type AffiliateSocialLinks = Partial<Record<AffiliateSocialNetwork, string>>;

export type AffiliateAlertType = (typeof AFFILIATE_ALERT_TYPES)[keyof typeof AFFILIATE_ALERT_TYPES];

export type AffiliateLocale = 'en' | 'fr';

export interface AffiliateTierRow {
  id: string;
  name: string;
  /** `{ "fr": "Ambassadeur fondateur" }`; English lives in `name`. */
  name_translations: Record<string, string>;
  slug: string;
  commission_percentage: number;
  cookie_duration_days: number;
  clearance_hold_days: number;
  is_default_signup_tier: boolean;
  is_limited_time_promo: boolean;
  /** NULL = unlimited spots. */
  max_ambassadors_cap: number | null;
  /** Maintained by a trigger on `affiliate_profiles`. */
  member_count: number;
  sort_order: number;
  badge_color: AffiliateBadgeColor;
  is_active: boolean;
  /**
   * What a partner aims for to reach this tier ("Make 8 confirmed sales…"), shown on `/partners`.
   * Display only: nothing promotes a partner automatically (an admin moves partners by hand).
   * English; NULL or absent = no goal line. Added by migration 02033, so absent on older rows.
   */
  goal?: string | null;
  /** `{ "fr": "…" }`; English lives in `goal`. Absent before 02033. */
  goal_translations?: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface AffiliateProfileRow {
  id: string;
  user_id: string;
  tier_id: string;
  /**
   * When `tier_id` last changed (stamped by the 02035 profile guard for every writer); null while the
   * partner is still in their sign-up tier (they have been in it since `created_at`). Added by
   * migration 02035, so absent on rows read before it ran (the normalizer reads that as null).
   */
  tier_changed_at?: string | null;
  handle: string;
  display_name: string;
  bio: string | null;
  /** Storage key set by the upload route only (never a user-supplied URL). */
  avatar_object_key: string | null;
  social_links: AffiliateSocialLinks;
  preferred_locale: string;
  onboarding_step: AffiliateOnboardingStep;
  status: AffiliateStatus;
  suspended_reason: string | null;
  stripe_connect_account_id: string | null;
  stripe_connect_onboarding_complete: boolean;
  stripe_connect_details_submitted: boolean;
  stripe_connect_payouts_enabled: boolean;
  /** Stripe key mode the account was created in; a mismatch with the current key means re-onboarding. */
  stripe_connect_livemode: boolean | null;
  stripe_connect_checked_at: string | null;
  total_clicks: number;
  last_click_at: string | null;
  /** Base-currency minor units. */
  total_earned_cents: number;
  /** Base-currency minor units. */
  total_paid_cents: number;
  profile_completed_at: string | null;
  payout_configured_at: string | null;
  page_submitted_at: string | null;
  first_published_at: string | null;
  signup_ip_masked: string | null;
  /**
   * Where the partner wants manual payouts sent (a PayPal or Interac e-Transfer address), or null.
   * Written only by the server for the partner (the portal, after `requireRetailer()`) or by an
   * admin: no Data API grant, and the profile guard refuses it from a partner session (02036).
   * Absent on rows read before 02036 ran (the normalizer reads that as null).
   */
  payout_email?: string | null;
  /**
   * What `payout_email` is (02037, default `paypal`): a PayPal account's email (automatic PayPal
   * payouts, the PayPal payouts file) or an Interac e-Transfer address (paid by hand). Written like
   * `payout_email` (the server after `requireRetailer()`, or an admin). Absent before 02037 ran (the
   * normalizer reads that as `paypal`, the column default).
   */
  payout_email_kind?: AffiliatePayoutEmailKind;
  /**
   * When the partner last saved the payout email (02037; the portal stamps every save, the same address
   * included), or null. A PayPal payout returned from an address keeps the run off it until a save
   * after that return. Written like `payout_email`. Absent before 02037 ran (read as null).
   */
  payout_email_saved_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** The public profile snapshot copied onto the page when an admin approves it. */
export interface AffiliatePublishedProfile {
  display_name: string;
  bio: string | null;
  avatar_object_key: string | null;
  social_links: AffiliateSocialLinks;
  /**
   * The language the partner writes in (their `preferred_locale` at approval): the storefront marks
   * the bio and the page body with it, and declares it in JSON-LD and `og:locale`. Absent from a
   * snapshot taken before it existed (the page then follows the visitor's language).
   */
  locale?: AffiliateLocale;
}

export interface AffiliatePageRow {
  id: string;
  affiliate_id: string;
  user_id: string;
  title: string;
  meta_description: string;
  /** UNTRUSTED Tiptap JSON (an RTL may PATCH it over the Data API): always sanitize before use. */
  draft_content: unknown;
  featured_product_ids: string[];
  /** Admin-approved, sanitized at approval time; still rendered through the allowlist renderer. */
  published_content: unknown | null;
  published_title: string | null;
  published_meta_description: string | null;
  published_profile: AffiliatePublishedProfile | null;
  published_featured_product_ids: string[];
  approval_status: AffiliatePageStatus;
  admin_feedback_note: string | null;
  draft_version: number;
  draft_updated_at: string;
  submitted_at: string | null;
  submitted_version: number | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AffiliateCommissionRow {
  id: string;
  affiliate_id: string;
  order_id: string | null;
  gateway: AffiliateGateway;
  order_currency: string;
  order_net_amount_minor: number;
  exchange_rate_snapshot: number;
  /** Net order amount in the store base currency (minor units). */
  net_order_amount_cents: number;
  commission_rate_snapshot: number;
  /** Base-currency minor units, before refunds. */
  commission_amount_cents: number;
  /** Portion reversed by partial refunds (base-currency minor units). */
  refunded_amount_cents: number;
  /** Refund recorded while the commission was attached to an in-flight or completed payout (applied if that payout fails). */
  refund_pending_cents: number;
  /** Full refund recorded while attached to an in-flight or completed payout. */
  void_requested_at: string | null;
  /**
   * Set while the order's payment is disputed (`set_affiliate_commission_dispute`): the commission
   * is neither promoted nor claimed until the dispute closes (won: released; lost: voided).
   */
  disputed_at: string | null;
  /**
   * The Stripe key mode (or Freemius sandbox) the sale was paid in: false for a test-mode sale.
   * Only a payout to a Connect account of the same mode ever claims it.
   */
  livemode: boolean;
  /** Store base currency at the time the commission was recorded. */
  currency: string;
  status: AffiliateCommissionStatus;
  clears_at: string;
  cleared_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  payout_id: string | null;
  stripe_transfer_id: string | null;
  notified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AffiliatePayoutRow {
  id: string;
  affiliate_id: string;
  amount_cents: number;
  currency: string;
  /** The Connect account of a Stripe payout; `''` for a manual payout (the column is NULL there, 02036). */
  stripe_destination_account: string;
  stripe_transfer_id: string | null;
  /**
   * `stripe_connect` (a transfer; PROCESSING → COMPLETED or FAILED), `paypal` (a PayPal Payouts item
   * sent from the operator's PayPal balance, 02037: PROCESSING while PayPal has it, COMPLETED on
   * SUCCESS, FAILED with its commissions handed back otherwise) or `manual` (money sent outside
   * Stripe and recorded by an admin: prepared PROCESSING, then COMPLETED). Added by 02036: absent on
   * rows read before it ran, which the normalizer reads as `stripe_connect`.
   */
  method?: AffiliatePayoutMethod;
  /** A manual payout's channel (PayPal, Interac e-Transfer, Wise, bank transfer, other); null for Stripe. */
  manual_channel?: AffiliateManualPayoutChannel | null;
  /** A manual payout's reference (the PayPal transaction ID, e-Transfer or bank reference), at most 120 characters. */
  external_reference?: string | null;
  /** A note the admin wrote for the partner (the partner reads it), at most 500 characters. */
  note?: string | null;
  /** The admin who recorded a manual payout (`auth.users.id`; null for Stripe payouts or a deleted account). */
  recorded_by?: string | null;
  /** A PayPal payout's recipient: the partner's PayPal email when it was claimed (02037). Null otherwise. */
  paypal_receiver?: string | null;
  /**
   * The `sender_batch_id` of the PayPal batch carrying this payout, saved BEFORE the create call (it
   * is also the PayPal-Request-Id), so a create that timed out is retried with the same id.
   */
  paypal_sender_batch_id?: string | null;
  /** PayPal's `payout_batch_id`, once the create call answered. */
  paypal_batch_id?: string | null;
  /** PayPal's `payout_item_id` of this payout's item, once seen. */
  paypal_item_id?: string | null;
  /** PayPal's transaction id, set when the item reached SUCCESS (the payout is COMPLETED). */
  paypal_transaction_id?: string | null;
  /** The item's last `transaction_status` (SUCCESS, PENDING, UNCLAIMED, RETURNED, …) or null before the first check. */
  paypal_item_status?: string | null;
  /** PayPal's fee for the item, in minor units of the payout currency (null when unknown or in another currency). */
  paypal_fee_cents?: number | null;
  /** When PayPal was last asked about this payout. */
  paypal_checked_at?: string | null;
  /**
   * Mode of the destination account when the payout was claimed (false: a test-mode payout). It
   * is retried and reconciled only with a Stripe key of the same mode.
   */
  livemode: boolean;
  status: AffiliatePayoutStatus;
  attempt_count: number;
  last_attempt_at: string;
  failure_reason: string | null;
  trigger: AffiliatePayoutTrigger;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Balance cards for the portal and the CMS (minor units, net of refunds), grouped by currency. */
export interface AffiliateBalances {
  /** The store base currency's balance (zeros when the affiliate has no rows in it). */
  primary: AffiliateCurrencyBalance;
  /** Every currency the affiliate has ledger rows in (normally just the base currency). */
  byCurrency: AffiliateCurrencyBalance[];
}

export interface AffiliateCurrencyBalance {
  currency: string;
  /** PENDING_CLEARANCE (inside the refund window). */
  pendingCents: number;
  /** CLEARED and not yet attached to a payout. */
  clearedCents: number;
  /** Attached to a PROCESSING or FAILED payout. */
  processingCents: number;
  /** PAID. */
  paidCents: number;
  /** VOIDED_REFUND plus partial refund reversals. */
  voidedCents: number;
  /** Earliest `clears_at` among PENDING_CLEARANCE rows. */
  nextClearsAt: string | null;
}

export interface CreateAffiliateAccountInput {
  userId: string;
  handle: string;
  displayName: string;
  locale: string;
  title: string;
  metaDescription: string;
  starterDoc: unknown;
  signupIpMasked: string | null;
}

export interface CreateAffiliateAccountResult {
  affiliateId: string;
  pageId: string;
  tierId: string;
  tierName: string;
  tierSlug: string;
  commissionPercentage: number;
  isLimitedTimePromo: boolean;
  /** Spots left in the assigned tier after this signup; NULL when the tier is unlimited. */
  spotsRemaining: number | null;
}

export type AffiliateAccountErrorCode =
  | 'handle_taken'
  | 'handle_invalid'
  | 'role_conflict'
  | 'affiliate_exists'
  | 'program_full'
  | 'unknown';

export type AffiliateOnboardingStepKey = 'account' | 'profile' | 'payouts' | 'storefront';

export interface AffiliateOnboardingProgress {
  steps: Array<{ key: AffiliateOnboardingStepKey; complete: boolean; completedAt: string | null }>;
  completedCount: number;
  totalCount: 4;
  /** First incomplete step, or null when all four are done. */
  nextStep: AffiliateOnboardingStepKey | null;
}

/** `affiliates_settings` site setting (normalized). */
export interface AffiliatesSettings {
  /** Admin recipients for lifecycle mail; empty = the store contact address ladder. */
  notificationEmails: string[];
  /** Minimum automated payout in base-currency minor units. */
  minPayoutCents: number;
  /** Daily automated payouts (cron route + after() fallback). */
  autoPayoutsEnabled: boolean;
  /**
   * The operator's own partner terms page in English: a site path (`/legal/partners`) or an https
   * URL. `''` = the built-in terms at `/partners/terms`. Always `''` on the public sandbox.
   */
  termsUrlEn: string;
  /** The same in French (`''` = the English page when one is set, else the built-in terms). */
  termsUrlFr: string;
  /**
   * How the commissions of each gateway are paid (default: both `stripe_connect`, the behaviour
   * before 02036; `paypal` since 02037). An unknown stored value reads as the default.
   */
  payoutMethods: AffiliatesPayoutMethods;
}

export type AffiliateLifecycleEvent =
  | 'SIGNED_UP'
  | 'PROFILE_COMPLETED'
  | 'PAYOUT_CONFIGURED'
  | 'PAGE_SUBMITTED'
  | 'PAGE_PUBLISHED'
  | 'CHANGES_REQUESTED'
  | 'COMMISSION_EARNED'
  | 'PAYOUT_SENT'
  | 'PAYOUT_FAILED'
  | 'REFUND_AFTER_PAYOUT'
  | 'PARTNER_SUSPENDED'
  | 'PARTNER_REACTIVATED'
  | 'TIER_CHANGED'
  /** 02037: a PayPal payout waits for the partner to claim it (first seen UNCLAIMED). Partner email. */
  | 'PAYPAL_UNCLAIMED'
  /**
   * 02037: the partner's side of a PayPal PAYOUT_FAILED (PayPal will not pay the item, or an admin
   * cancelled it; its commissions went back to the balance). Partner email; the admins get PAYOUT_FAILED.
   */
  | 'PAYPAL_PAYOUT_FAILED';

export type AffiliateAdminLifecycleEvent = Extract<
  AffiliateLifecycleEvent,
  'SIGNED_UP' | 'PROFILE_COMPLETED' | 'PAYOUT_CONFIGURED' | 'PAGE_SUBMITTED' | 'PAYOUT_FAILED' | 'REFUND_AFTER_PAYOUT'
>;

export type AffiliateRetailerLifecycleEvent = Extract<
  AffiliateLifecycleEvent,
  | 'PAGE_PUBLISHED'
  | 'CHANGES_REQUESTED'
  | 'COMMISSION_EARNED'
  | 'PAYOUT_SENT'
  | 'PARTNER_SUSPENDED'
  | 'PARTNER_REACTIVATED'
  | 'TIER_CHANGED'
  | 'PAYPAL_UNCLAIMED'
  | 'PAYPAL_PAYOUT_FAILED'
>;

/** What callers pass to `notifyAffiliateLifecycle()`; the notifier loads anything else it needs. */
export interface AffiliateLifecyclePayload {
  affiliateId: string;
  pageId?: string | null;
  feedbackNote?: string | null;
  /** SIGNED_UP: the sign-up tier (English, for the admins); TIER_CHANGED: the new tier, in the partner's language. */
  tierName?: string | null;
  /** TIER_CHANGED: the new tier's commission rate in percent (`12.5`), the rate of orders paid from now on. */
  tierRatePercent?: number | null;
  spotsRemaining?: number | null;
  commission?: {
    commissionId: string;
    amountCents: number;
    currency: string;
    ratePercent: number;
    clearsAt: string;
    /** COMMISSION_EARNED: how the program pays this commission (`manual`: outside Stripe); absent = Stripe Connect. */
    payoutMethod?: AffiliatePayoutMethod | null;
  } | null;
  payout?: {
    payoutId: string;
    amountCents: number;
    currency: string;
    transferId?: string | null;
    /**
     * PAYOUT_FAILED: the failure, as the admins read it. PAYPAL_PAYOUT_FAILED (02037): the PayPal run's
     * reason code (`paypal_returned`, `paypal_failed:receiver_unregistered`, …), which the partner
     * template words per locale.
     */
    reason?: string | null;
    /** PAYOUT_SENT / REFUND_AFTER_PAYOUT: how the payout was made (absent = a Stripe transfer). */
    method?: AffiliatePayoutMethod | null;
    /** PAYPAL_UNCLAIMED (02037): the address PayPal sent its claim email to (the payout's `paypal_receiver`). */
    receiver?: string | null;
    /**
     * REFUND_AFTER_PAYOUT: the payout's status when the refund came (02036: a manual payout still
     * PROCESSING is prepared, not recorded, and may not have been sent yet).
     */
    status?: AffiliatePayoutStatus | null;
    /** PAYOUT_SENT of a manual payout: the channel and the reference the admin recorded. */
    channel?: AffiliateManualPayoutChannel | null;
    reference?: string | null;
    /** PAYOUT_SENT of a manual payout: the note the admin wrote for the partner. */
    note?: string | null;
  } | null;
  orderId?: string | null;
  /** PARTNER_SUSPENDED: the reason the admin gave (`affiliate_profiles.suspended_reason`), if any. */
  suspendedReason?: string | null;
  /**
   * PARTNER_SUSPENDED / PARTNER_REACTIVATED: the partner has an approved storefront
   * (`first_published_at` is set), so the notice talks about it going offline or back online.
   */
  storefrontLive?: boolean | null;
}

/** Pre-formatted values for `buildAffiliateEmail()` (the app formats money and dates per locale). */
export interface AffiliateEmailData {
  locale: AffiliateLocale;
  siteName: string;
  siteUrl: string;
  recipientName: string | null;
  handle: string | null;
  displayName: string | null;
  storefrontUrl: string | null;
  portalUrl: string;
  cmsUrl: string;
  /** SIGNED_UP: the sign-up tier; TIER_CHANGED: the partner's new tier (already in their language). */
  tierName?: string | null;
  spotsRemaining?: number | null;
  feedbackNote?: string | null;
  amountLabel?: string | null;
  /** COMMISSION_EARNED: the commission's rate; TIER_CHANGED: the new tier's rate. */
  ratePercent?: number | null;
  clearsAtLabel?: string | null;
  transferId?: string | null;
  /**
   * PAYOUT_FAILED: the failure code; PARTNER_SUSPENDED: the reason the admin gave;
   * PAYPAL_PAYOUT_FAILED (02037): the PayPal run's reason code, which the template words per locale
   * (it never prints the code itself).
   */
  reason?: string | null;
  orderId?: string | null;
  /** PARTNER_SUSPENDED / PARTNER_REACTIVATED: the partner has an approved storefront. */
  storefrontLive?: boolean | null;
  /**
   * PAYOUT_SENT / REFUND_AFTER_PAYOUT: `manual` for a payout sent outside Stripe and recorded in the
   * CMS (02036); COMMISSION_EARNED: `manual` when the program pays that commission outside Stripe.
   * PAYOUT_SENT: `paypal` for a payout PayPal paid into the partner's PayPal account (02037; PayPal's
   * transaction id in `payoutReference`). REFUND_AFTER_PAYOUT / PAYOUT_FAILED (admin mail): `paypal`
   * for a PayPal payout. The app words a COMMISSION_EARNED the program pays with PayPal with the
   * `manual` copy. Anything else is Stripe Connect.
   */
  payoutMethod?: AffiliatePayoutMethod | null;
  /** PAYPAL_UNCLAIMED (02037): the address PayPal sent its claim email to (plain text). */
  payoutEmail?: string | null;
  /**
   * REFUND_AFTER_PAYOUT of a manual payout: true while that payout is prepared but not recorded
   * (PROCESSING): the advice is to cancel and prepare it again if the money has not left yet. Of a
   * PayPal payout (02037): true while PayPal still holds it (PROCESSING).
   */
  payoutPrepared?: boolean | null;
  /** PAYOUT_SENT of a manual payout: where the money was sent from (worded per locale by the template). */
  payoutChannel?: AffiliateManualPayoutChannel | null;
  /**
   * PAYOUT_SENT of a manual payout: the PayPal transaction ID, e-Transfer or bank reference; of a
   * PayPal payout (02037): PayPal's transaction id.
   */
  payoutReference?: string | null;
  /** PAYOUT_SENT of a manual payout: the admin's note for the partner (plain text). */
  payoutNote?: string | null;
}

export interface AffiliateEmailMessage {
  subject: string;
  text: string;
  /** Contains the `{{brand_header}}` token that `sendEmail()` replaces. */
  html: string;
}

export interface AffiliateSystemAlertInsert {
  alert_type: AffiliateAlertType;
  title: string;
  message: string;
  metadata: Record<string, unknown> & { action_url: string; action_label: string };
}
