/**
 * Raw PostgREST rows → the contract types in `core/types.ts`. Every field is read explicitly
 * (unknown columns are dropped, numerics coerced, jsonb defaulted), so what leaves the
 * repository is exactly the documented shape even before `db:types` knows the tables.
 */
import { AFFILIATE_BADGE_COLORS } from '../core/constants';
import {
  AFFILIATE_COMMISSION_STATUSES,
  AFFILIATE_GATEWAYS,
  AFFILIATE_MANUAL_PAYOUT_CHANNELS,
  AFFILIATE_ONBOARDING_STEPS,
  AFFILIATE_PAGE_STATUSES,
  AFFILIATE_PAYOUT_EMAIL_KINDS,
  AFFILIATE_PAYOUT_METHODS,
  AFFILIATE_PAYOUT_STATUSES,
  AFFILIATE_PAYOUT_TRIGGERS,
  AFFILIATE_STATUSES,
} from '../core/statuses';
import type {
  AffiliateBadgeColor,
  AffiliateCommissionRow,
  AffiliateCommissionStatus,
  AffiliateGateway,
  AffiliateManualPayoutChannel,
  AffiliateOnboardingStep,
  AffiliatePageRow,
  AffiliatePageStatus,
  AffiliatePayoutEmailKind,
  AffiliatePayoutMethod,
  AffiliatePayoutRow,
  AffiliatePayoutStatus,
  AffiliatePayoutTrigger,
  AffiliateProfileRow,
  AffiliatePublishedProfile,
  AffiliateSocialLinks,
  AffiliateStatus,
  AffiliateTierRow,
} from '../core/types';

type RawRow = Record<string, unknown>;

function asRecord(value: unknown): RawRow | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RawRow) : null;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value);
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function int(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function decimal(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

function nullableBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const result: Record<string, string> = {};
  if (!record) return result;
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function uuidList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function socialLinks(value: unknown): AffiliateSocialLinks {
  return stringRecord(value) as AffiliateSocialLinks;
}

export function normalizeAffiliateTierRow(raw: unknown): AffiliateTierRow | null {
  const row = asRecord(raw);
  if (!row || typeof row['id'] !== 'string') return null;

  return {
    id: row['id'],
    name: text(row['name']),
    name_translations: stringRecord(row['name_translations']),
    slug: text(row['slug']),
    commission_percentage: decimal(row['commission_percentage']),
    cookie_duration_days: int(row['cookie_duration_days'], 30),
    clearance_hold_days: int(row['clearance_hold_days'], 30),
    is_default_signup_tier: bool(row['is_default_signup_tier']),
    is_limited_time_promo: bool(row['is_limited_time_promo']),
    max_ambassadors_cap: nullableInt(row['max_ambassadors_cap']),
    member_count: int(row['member_count']),
    sort_order: int(row['sort_order']),
    badge_color: oneOf<AffiliateBadgeColor>(row['badge_color'], AFFILIATE_BADGE_COLORS, 'violet'),
    is_active: bool(row['is_active']),
    // 02033: absent on a database that has not run it yet, which reads as "no goal".
    goal: nullableText(row['goal']),
    goal_translations: stringRecord(row['goal_translations']),
    created_at: text(row['created_at']),
    updated_at: text(row['updated_at']),
  };
}

export function normalizeAffiliateProfileRow(raw: unknown): AffiliateProfileRow | null {
  const row = asRecord(raw);
  if (!row || typeof row['id'] !== 'string') return null;

  return {
    id: row['id'],
    user_id: text(row['user_id']),
    tier_id: text(row['tier_id']),
    // 02035: absent on a database that has not run it yet, which reads as "since created_at".
    tier_changed_at: nullableText(row['tier_changed_at']),
    handle: text(row['handle']),
    display_name: text(row['display_name']),
    bio: nullableText(row['bio']),
    avatar_object_key: nullableText(row['avatar_object_key']),
    social_links: socialLinks(row['social_links']),
    preferred_locale: text(row['preferred_locale'], 'en') || 'en',
    onboarding_step: oneOf<AffiliateOnboardingStep>(row['onboarding_step'], AFFILIATE_ONBOARDING_STEPS, 'SIGNED_UP'),
    status: oneOf<AffiliateStatus>(row['status'], AFFILIATE_STATUSES, 'SUSPENDED'),
    suspended_reason: nullableText(row['suspended_reason']),
    stripe_connect_account_id: nullableText(row['stripe_connect_account_id']),
    stripe_connect_onboarding_complete: bool(row['stripe_connect_onboarding_complete']),
    stripe_connect_details_submitted: bool(row['stripe_connect_details_submitted']),
    stripe_connect_payouts_enabled: bool(row['stripe_connect_payouts_enabled']),
    stripe_connect_livemode: nullableBool(row['stripe_connect_livemode']),
    stripe_connect_checked_at: nullableText(row['stripe_connect_checked_at']),
    total_clicks: int(row['total_clicks']),
    last_click_at: nullableText(row['last_click_at']),
    total_earned_cents: int(row['total_earned_cents']),
    total_paid_cents: int(row['total_paid_cents']),
    profile_completed_at: nullableText(row['profile_completed_at']),
    payout_configured_at: nullableText(row['payout_configured_at']),
    page_submitted_at: nullableText(row['page_submitted_at']),
    first_published_at: nullableText(row['first_published_at']),
    signup_ip_masked: nullableText(row['signup_ip_masked']),
    // 02036: absent on a database that has not run it yet, which reads as "no payout email".
    payout_email: nullableText(row['payout_email']),
    // 02037: absent before it ran; the column default (a PayPal account's email) otherwise.
    payout_email_kind: oneOf<AffiliatePayoutEmailKind>(row['payout_email_kind'], AFFILIATE_PAYOUT_EMAIL_KINDS, 'paypal'),
    payout_email_saved_at: nullableText(row['payout_email_saved_at']),
    created_at: text(row['created_at']),
    updated_at: text(row['updated_at']),
  };
}

function publishedProfile(value: unknown): AffiliatePublishedProfile | null {
  const record = asRecord(value);
  if (!record) return null;

  return {
    display_name: text(record['display_name']),
    bio: nullableText(record['bio']),
    avatar_object_key: nullableText(record['avatar_object_key']),
    social_links: socialLinks(record['social_links']),
    // The partner's language at approval (finding T); absent from snapshots approved before it existed.
    ...(record['locale'] === 'en' || record['locale'] === 'fr' ? { locale: record['locale'] } : {}),
  };
}

export function normalizeAffiliatePageRow(raw: unknown): AffiliatePageRow | null {
  const row = asRecord(raw);
  if (!row || typeof row['id'] !== 'string') return null;

  return {
    id: row['id'],
    affiliate_id: text(row['affiliate_id']),
    user_id: text(row['user_id']),
    title: text(row['title']),
    meta_description: text(row['meta_description']),
    // UNTRUSTED Tiptap JSON: passed through as-is; every reader sanitizes it.
    draft_content: row['draft_content'] ?? null,
    featured_product_ids: uuidList(row['featured_product_ids']),
    published_content: row['published_content'] ?? null,
    published_title: nullableText(row['published_title']),
    published_meta_description: nullableText(row['published_meta_description']),
    published_profile: publishedProfile(row['published_profile']),
    published_featured_product_ids: uuidList(row['published_featured_product_ids']),
    approval_status: oneOf<AffiliatePageStatus>(row['approval_status'], AFFILIATE_PAGE_STATUSES, 'DRAFT'),
    admin_feedback_note: nullableText(row['admin_feedback_note']),
    draft_version: int(row['draft_version'], 1),
    draft_updated_at: text(row['draft_updated_at']),
    submitted_at: nullableText(row['submitted_at']),
    submitted_version: nullableInt(row['submitted_version']),
    reviewed_at: nullableText(row['reviewed_at']),
    reviewed_by: nullableText(row['reviewed_by']),
    published_at: nullableText(row['published_at']),
    created_at: text(row['created_at']),
    updated_at: text(row['updated_at']),
  };
}

export function normalizeAffiliateCommissionRow(raw: unknown): AffiliateCommissionRow | null {
  const row = asRecord(raw);
  if (!row || typeof row['id'] !== 'string') return null;

  return {
    id: row['id'],
    affiliate_id: text(row['affiliate_id']),
    order_id: nullableText(row['order_id']),
    gateway: oneOf<AffiliateGateway>(row['gateway'], AFFILIATE_GATEWAYS, 'STRIPE'),
    order_currency: text(row['order_currency']),
    order_net_amount_minor: int(row['order_net_amount_minor']),
    exchange_rate_snapshot: decimal(row['exchange_rate_snapshot'], 1),
    net_order_amount_cents: int(row['net_order_amount_cents']),
    commission_rate_snapshot: decimal(row['commission_rate_snapshot']),
    commission_amount_cents: int(row['commission_amount_cents']),
    refunded_amount_cents: int(row['refunded_amount_cents']),
    refund_pending_cents: int(row['refund_pending_cents']),
    void_requested_at: nullableText(row['void_requested_at']),
    disputed_at: nullableText(row['disputed_at']),
    // The column defaults to true (live): only an explicit false is a test-mode sale.
    livemode: row['livemode'] !== false,
    currency: text(row['currency'], 'USD') || 'USD',
    status: oneOf<AffiliateCommissionStatus>(row['status'], AFFILIATE_COMMISSION_STATUSES, 'PENDING_CLEARANCE'),
    clears_at: text(row['clears_at']),
    cleared_at: nullableText(row['cleared_at']),
    paid_at: nullableText(row['paid_at']),
    voided_at: nullableText(row['voided_at']),
    void_reason: nullableText(row['void_reason']),
    payout_id: nullableText(row['payout_id']),
    stripe_transfer_id: nullableText(row['stripe_transfer_id']),
    notified_at: nullableText(row['notified_at']),
    created_at: text(row['created_at']),
    updated_at: text(row['updated_at']),
  };
}

export function normalizeAffiliatePayoutRow(raw: unknown): AffiliatePayoutRow | null {
  const row = asRecord(raw);
  if (!row || typeof row['id'] !== 'string') return null;

  return {
    id: row['id'],
    affiliate_id: text(row['affiliate_id']),
    amount_cents: int(row['amount_cents']),
    currency: text(row['currency'], 'USD') || 'USD',
    // NULL for a manual payout (02036): '' keeps the documented string type.
    stripe_destination_account: text(row['stripe_destination_account']),
    stripe_transfer_id: nullableText(row['stripe_transfer_id']),
    // 02036: absent before it ran, when every payout was a Stripe transfer.
    method: oneOf<AffiliatePayoutMethod>(row['method'], AFFILIATE_PAYOUT_METHODS, 'stripe_connect'),
    manual_channel:
      typeof row['manual_channel'] === 'string' && (AFFILIATE_MANUAL_PAYOUT_CHANNELS as readonly string[]).includes(row['manual_channel'])
        ? (row['manual_channel'] as AffiliateManualPayoutChannel)
        : null,
    external_reference: nullableText(row['external_reference']),
    note: nullableText(row['note']),
    recorded_by: nullableText(row['recorded_by']),
    // 02037: the PayPal columns, absent before it ran and NULL on every other method.
    paypal_receiver: nullableText(row['paypal_receiver']),
    paypal_sender_batch_id: nullableText(row['paypal_sender_batch_id']),
    paypal_batch_id: nullableText(row['paypal_batch_id']),
    paypal_item_id: nullableText(row['paypal_item_id']),
    paypal_transaction_id: nullableText(row['paypal_transaction_id']),
    paypal_item_status: nullableText(row['paypal_item_status']),
    paypal_fee_cents: nullableInt(row['paypal_fee_cents']),
    paypal_checked_at: nullableText(row['paypal_checked_at']),
    livemode: row['livemode'] !== false,
    status: oneOf<AffiliatePayoutStatus>(row['status'], AFFILIATE_PAYOUT_STATUSES, 'PROCESSING'),
    attempt_count: int(row['attempt_count'], 1),
    last_attempt_at: text(row['last_attempt_at']),
    failure_reason: nullableText(row['failure_reason']),
    trigger: oneOf<AffiliatePayoutTrigger>(row['trigger'], AFFILIATE_PAYOUT_TRIGGERS, 'cron'),
    paid_at: nullableText(row['paid_at']),
    created_at: text(row['created_at']),
    updated_at: text(row['updated_at']),
  };
}

/** Normalize a list, dropping rows that are not rows. */
export function normalizeAffiliateRows<T>(rows: unknown, normalize: (raw: unknown) => T | null): T[] {
  if (!Array.isArray(rows)) return [];
  const result: T[] = [];
  for (const raw of rows) {
    const row = normalize(raw);
    if (row) result.push(row);
  }
  return result;
}
