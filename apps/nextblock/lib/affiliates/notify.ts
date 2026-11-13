import 'server-only';

import { after } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import {
  AFFILIATE_ALERT_TYPES,
  AFFILIATE_CMS_APPROVALS_PATH,
  AFFILIATE_CMS_PATH,
  AFFILIATE_CMS_PAYOUTS_PATH,
  AFFILIATE_PARTNERS_PATH,
  AFFILIATE_PORTAL_PATH,
  AFFILIATE_PORTAL_PAYOUTS_PATH,
  AFFILIATE_PORTAL_STOREFRONT_PATH,
  affiliatePayoutMethodForGateway,
  formatAffiliateMoney,
  type AffiliateAdminLifecycleEvent,
  type AffiliateAlertType,
  type AffiliateCommissionRow,
  type AffiliateEmailData,
  type AffiliateEmailMessage,
  type AffiliateGateway,
  type AffiliateLifecycleEvent,
  type AffiliateLifecyclePayload,
  type AffiliateLocale,
  type AffiliatePayoutMethod,
  type AffiliateProfileRow,
  type AffiliateRetailerLifecycleEvent,
  type AffiliateSystemAlertInsert,
} from '@nextblock-cms/affiliates';
import { buildAffiliateEmail, buildAffiliateSystemAlert } from '@nextblock-cms/affiliates/server';
import { sendEmail } from '../../app/actions/email';
import { isSafeInternalPath } from '../auth-redirects';
import { getSiteSettings } from '../../app/lib/site-settings';
import { DEFAULT_SITE_TITLE } from '../../app/lib/seo';
import { resolveSellerContactEmail } from '../commerce/seller-contact';
import { isEmailConfigured } from '../config/email-settings';
import { usableEmail } from '../email/placeholder-address';
import { hasExplicitSiteUrl, isPubliclyRoutableSiteUrl, resolveSiteUrl } from '../site-url';
import { toAffiliatesLocale } from './request-locale';
import { getAffiliatesSettings, normalizeAffiliateNotificationEmail } from './settings';

/**
 * Partner lifecycle notifications (SPEC §7, milestone 6).
 *
 * Admin events (signed up, profile completed, payouts configured, page submitted, payout failed,
 * refund after payout) become a `system_alerts` row — the CMS banner and /cms/affiliates read
 * those — plus an English email to the affiliate notification addresses (`affiliates_settings`),
 * or the store contact ladder when none are set. Partner events (page published, changes
 * requested, commission earned, payout sent, account suspended or reactivated by an admin, tier
 * changed by an admin who asked to email the partner, and since 02037 a PayPal payout waiting to be
 * claimed or one PayPal would not pay) email the partner's own auth address in their preferred
 * language.
 *
 * Everything here is best-effort and NEVER throws: a notification must not fail the approval,
 * webhook or payout that triggered it. Callers defer it past the response with
 * `scheduleAffiliateNotification(() => notifyAffiliateLifecycle(...))` (an `after()` wrapper),
 * because an SMTP round trip has no place on a click path and a floating promise may be frozen
 * with the serverless instance.
 *
 * Deduplication: an admin event with a natural key (the payout for PAYOUT_FAILED, the
 * commission or order for REFUND_AFTER_PAYOUT, the affiliate for the one-time onboarding steps)
 * reuses an unresolved alert with the same key instead of inserting another, and mails at most
 * once per alert (`metadata.emailed_at`). REFUND_AFTER_PAYOUT alerts are inserted by the
 * database itself (02030), on paths that never call this module, so their email comes from
 * {@link sweepAffiliateRefundAlertEmails}. PAGE_SUBMITTED resolves the page's older unresolved
 * submission alerts first, so the queue shows one per page.
 */

type AnyClient = SupabaseClient<any>;

type NotifyProfile = Pick<
  AffiliateProfileRow,
  'id' | 'user_id' | 'handle' | 'display_name' | 'preferred_locale' | 'status'
>;

interface NotifyContext {
  db: AnyClient;
  siteUrl: string;
  siteName: string;
  /** False when links in an email would point at an address nobody chose (see canMailLinks). */
  canSendEmail: boolean;
}

interface AlertKey {
  /** PostgREST JSON path filter, e.g. `metadata->>payout_id`. */
  column: string;
  value: string;
}

const PROFILE_COLUMNS = 'id, user_id, handle, display_name, preferred_locale, status';
const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_NOTE_LENGTH = 2000;
const MAX_REASON_LENGTH = 500;
const MAX_SUBJECT_LENGTH = 200;
const MAX_SWEEP_LIMIT = 200;
/** Commissions claimed by a sweep but older than this are marked notified without an email. */
const STALE_COMMISSION_MS = 14 * 24 * 60 * 60 * 1000;

const ADMIN_EVENTS: ReadonlySet<string> = new Set<AffiliateAdminLifecycleEvent>([
  'SIGNED_UP',
  'PROFILE_COMPLETED',
  'PAYOUT_CONFIGURED',
  'PAGE_SUBMITTED',
  'PAYOUT_FAILED',
  'REFUND_AFTER_PAYOUT',
]);

const RETAILER_EVENTS: ReadonlySet<string> = new Set<AffiliateRetailerLifecycleEvent>([
  'PAGE_PUBLISHED',
  'CHANGES_REQUESTED',
  'COMMISSION_EARNED',
  'PAYOUT_SENT',
  'PARTNER_SUSPENDED',
  'PARTNER_REACTIVATED',
  'TIER_CHANGED',
  // 02037: a PayPal payout waits to be claimed, or PayPal will not pay it (paypal/events.ts).
  'PAYPAL_UNCLAIMED',
  'PAYPAL_PAYOUT_FAILED',
]);

/** Fallback alert copy when the template builder is unavailable (the alert matters more than its wording). */
const FALLBACK_ALERT_COPY: Record<AffiliateAdminLifecycleEvent, { title: string; message: string; label: string }> = {
  SIGNED_UP: { title: 'New partner signed up', message: 'A new partner joined the affiliate program.', label: 'View partners' },
  PROFILE_COMPLETED: { title: 'Partner profile completed', message: 'A partner completed their profile.', label: 'View partners' },
  PAYOUT_CONFIGURED: { title: 'Partner payouts connected', message: 'A partner connected Stripe payouts.', label: 'View partners' },
  PAGE_SUBMITTED: { title: 'Storefront waiting for review', message: 'A partner submitted their storefront for approval.', label: 'Review storefronts' },
  PAYOUT_FAILED: { title: 'Affiliate payout failed', message: 'An automated affiliate payout failed.', label: 'Review payouts' },
  REFUND_AFTER_PAYOUT: {
    title: 'Refund after an affiliate payout',
    message: 'An order was refunded after its commission was paid or queued. Reverse the transfer in Stripe if needed.',
    label: 'Review payouts',
  },
};

function isAdminEvent(event: AffiliateLifecycleEvent): event is AffiliateAdminLifecycleEvent {
  return ADMIN_EVENTS.has(event);
}

function isRetailerEvent(event: AffiliateLifecycleEvent): event is AffiliateRetailerLifecycleEvent {
  return RETAILER_EVENTS.has(event);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? clip(trimmed, max) : null;
}

function cleanId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/* ------------------------------------------------------------------ context --- */

/**
 * Whether a link to `siteUrl` may go out by email: an address the operator chose (explicit
 * `NEXT_PUBLIC_URL` or the Vercel production URL), a publicly routable one, or local development
 * — never the invented `http://localhost:3000` default in a deployed build (lib/site-url.ts).
 */
function canMailLinks(siteUrl: string): boolean {
  if (hasExplicitSiteUrl()) return true;
  if (isPubliclyRoutableSiteUrl(siteUrl)) return true;
  return process.env.NODE_ENV === 'development';
}

async function resolveSiteName(): Promise<string> {
  try {
    const settings = await getSiteSettings();
    return settings?.siteTitle?.trim() || DEFAULT_SITE_TITLE;
  } catch {
    return DEFAULT_SITE_TITLE;
  }
}

async function createNotifyContext(db?: AnyClient): Promise<NotifyContext> {
  const client = db ?? (getServiceRoleSupabaseClient() as unknown as AnyClient);
  // The sandbox records every alert but mails nobody: its admin login is public, so its
  // notification addresses (up to 10) are whatever a visitor typed.
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    return { db: client, siteUrl: resolveSiteUrl(), siteName: await resolveSiteName(), canSendEmail: false };
  }
  const siteUrl = resolveSiteUrl();
  const linksAllowed = canMailLinks(siteUrl);
  if (!linksAllowed) {
    console.warn(
      `[affiliates] Not emailing lifecycle notices: the site address is the unconfigured default ${siteUrl}. Set NEXT_PUBLIC_URL.`,
    );
  }
  const [siteName, smtpReady] = await Promise.all([
    resolveSiteName(),
    linksAllowed ? isEmailConfigured().catch(() => false) : Promise.resolve(false),
  ]);
  return { db: client, siteUrl, siteName, canSendEmail: linksAllowed && smtpReady };
}

/* -------------------------------------------------------------------- reads --- */

async function loadProfile(db: AnyClient, affiliateId: string): Promise<NotifyProfile | null> {
  const id = cleanId(affiliateId);
  if (!id) return null;
  try {
    const { data, error } = await db.from('affiliate_profiles').select(PROFILE_COLUMNS).eq('id', id).maybeSingle();
    if (error || !data) return null;
    return data as NotifyProfile;
  } catch {
    return null;
  }
}

async function loadProfiles(db: AnyClient, affiliateIds: string[]): Promise<Map<string, NotifyProfile>> {
  const ids = [...new Set(affiliateIds.map(cleanId).filter((id): id is string => Boolean(id)))];
  const profiles = new Map<string, NotifyProfile>();
  if (ids.length === 0) return profiles;
  try {
    const { data, error } = await db.from('affiliate_profiles').select(PROFILE_COLUMNS).in('id', ids);
    if (error || !Array.isArray(data)) return profiles;
    for (const row of data as NotifyProfile[]) profiles.set(row.id, row);
  } catch {
    // Treated as "no profile": the affected notifications are skipped.
  }
  return profiles;
}

async function resolvePageId(db: AnyClient, payload: AffiliateLifecyclePayload): Promise<string | null> {
  const explicit = cleanId(payload.pageId);
  if (explicit) return explicit;
  const affiliateId = cleanId(payload.affiliateId);
  if (!affiliateId) return null;
  try {
    const { data } = await db.from('affiliate_pages').select('id').eq('affiliate_id', affiliateId).maybeSingle();
    return cleanId((data as { id?: unknown } | null)?.id);
  } catch {
    return null;
  }
}

/** The partner's sign-in address, when it can actually receive mail. */
async function resolvePartnerEmail(db: AnyClient, userId: string): Promise<string | null> {
  const id = cleanId(userId);
  if (!id) return null;
  try {
    const { data, error } = await db.auth.admin.getUserById(id);
    if (error) return null;
    return usableEmail(normalizeAffiliateNotificationEmail(data?.user?.email));
  } catch {
    return null;
  }
}

async function resolveAdminRecipients(): Promise<string[]> {
  try {
    const settings = await getAffiliatesSettings();
    const configured = settings.notificationEmails
      .map((email) => usableEmail(email))
      .filter((email): email is string => Boolean(email));
    if (configured.length > 0) return configured;
  } catch {
    // Fall through to the store contact ladder.
  }
  try {
    const { email } = await resolveSellerContactEmail();
    const usable = usableEmail(normalizeAffiliateNotificationEmail(email));
    return usable ? [usable] : [];
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------- email data --- */

function cmsUrlFor(event: AffiliateLifecycleEvent, siteUrl: string): string {
  if (event === 'PAGE_SUBMITTED') return `${siteUrl}${AFFILIATE_CMS_APPROVALS_PATH}`;
  if (event === 'PAYOUT_FAILED' || event === 'REFUND_AFTER_PAYOUT') return `${siteUrl}${AFFILIATE_CMS_PAYOUTS_PATH}`;
  return `${siteUrl}${AFFILIATE_CMS_PATH}`;
}

function cmsPathFor(event: AffiliateAdminLifecycleEvent): string {
  return cmsUrlFor(event, '');
}

/** The payout events: their amount is the payout's, and the partner's button opens the payouts page. */
const PAYOUT_EVENTS: ReadonlySet<AffiliateLifecycleEvent> = new Set<AffiliateLifecycleEvent>([
  'PAYOUT_SENT',
  'PAYOUT_FAILED',
  'PAYPAL_UNCLAIMED',
  'PAYPAL_PAYOUT_FAILED',
]);

function portalUrlFor(event: AffiliateLifecycleEvent, siteUrl: string): string {
  if (event === 'CHANGES_REQUESTED') return `${siteUrl}${AFFILIATE_PORTAL_STOREFRONT_PATH}`;
  if (event === 'COMMISSION_EARNED' || PAYOUT_EVENTS.has(event)) {
    return `${siteUrl}${AFFILIATE_PORTAL_PAYOUTS_PATH}`;
  }
  return `${siteUrl}${AFFILIATE_PORTAL_PATH}`;
}

function formatAmount(amountCents: unknown, currency: unknown, locale: AffiliateLocale): string | null {
  const amount = Number(amountCents);
  if (!Number.isFinite(amount) || typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency.trim())) return null;
  try {
    return formatAffiliateMoney(Math.round(amount), currency.trim().toUpperCase(), locale);
  } catch {
    return null;
  }
}

function formatDate(value: unknown, locale: AffiliateLocale): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-US', {
      dateStyle: 'long',
      timeZone: 'UTC',
    }).format(date);
  } catch {
    return null;
  }
}

/**
 * A commission's clearance date while it is still ahead, '' otherwise. The hold counts from the
 * payment (02035), so a commission recorded late (reconcile after a pause, or a payment trigger
 * that failed) can arrive with its clears_at already past: it clears at the next promote, so its
 * "you just earned" email must not say "it clears on" a date that is gone (the template then uses
 * the line without a date).
 */
function upcomingClearance(value: unknown, now: number): string {
  if (typeof value !== 'string') return '';
  const time = Date.parse(value);
  return Number.isFinite(time) && time > now ? value : '';
}

function amountFor(event: AffiliateLifecycleEvent, payload: AffiliateLifecyclePayload, locale: AffiliateLocale) {
  const commission = payload.commission ?? null;
  const payout = payload.payout ?? null;
  if (event === 'COMMISSION_EARNED') return commission ? formatAmount(commission.amountCents, commission.currency, locale) : null;
  if (PAYOUT_EVENTS.has(event)) {
    return payout ? formatAmount(payout.amountCents, payout.currency, locale) : null;
  }
  if (event === 'REFUND_AFTER_PAYOUT') {
    if (commission) return formatAmount(commission.amountCents, commission.currency, locale);
    if (payout) return formatAmount(payout.amountCents, payout.currency, locale);
  }
  return null;
}

function buildEmailData(
  event: AffiliateLifecycleEvent,
  ctx: NotifyContext,
  profile: NotifyProfile | null,
  payload: AffiliateLifecyclePayload,
  locale: AffiliateLocale,
): AffiliateEmailData {
  const handle = profile?.handle ?? null;
  const spots = payload.spotsRemaining;
  const rate = Number(payload.commission?.ratePercent);
  // TIER_CHANGED: the new tier's rate (a number only: Number(null) would read as 0 %).
  const tierRate = typeof payload.tierRatePercent === 'number' ? payload.tierRatePercent : Number.NaN;
  return {
    locale,
    siteName: ctx.siteName,
    siteUrl: ctx.siteUrl,
    recipientName: isRetailerEvent(event) ? profile?.display_name ?? null : null,
    handle,
    displayName: profile?.display_name ?? null,
    storefrontUrl: handle ? `${ctx.siteUrl}${AFFILIATE_PARTNERS_PATH}/${encodeURIComponent(handle)}` : null,
    portalUrl: portalUrlFor(event, ctx.siteUrl),
    cmsUrl: cmsUrlFor(event, ctx.siteUrl),
    tierName: cleanText(payload.tierName, 120),
    spotsRemaining: typeof spots === 'number' && Number.isFinite(spots) ? Math.max(0, Math.floor(spots)) : null,
    feedbackNote: cleanText(payload.feedbackNote, MAX_NOTE_LENGTH),
    amountLabel: amountFor(event, payload, locale),
    ratePercent:
      payload.commission && Number.isFinite(rate)
        ? rate
        : event === 'TIER_CHANGED' && Number.isFinite(tierRate)
          ? tierRate
          : null,
    // COMMISSION_EARNED's "it clears on {date}" (no other template reads it): a future date only.
    clearsAtLabel: formatDate(upcomingClearance(payload.commission?.clearsAt, Date.now()), locale),
    transferId: cleanText(payload.payout?.transferId, 255),
    // PARTNER_SUSPENDED carries the admin's reason; PAYOUT_FAILED the payout's failure code;
    // PAYPAL_PAYOUT_FAILED the PayPal run's reason code, which the template words (never prints).
    reason: cleanText(event === 'PARTNER_SUSPENDED' ? payload.suspendedReason : payload.payout?.reason, MAX_REASON_LENGTH),
    orderId: cleanText(payload.orderId, 128),
    storefrontLive: typeof payload.storefrontLive === 'boolean' ? payload.storefrontLive : null,
    // PAYPAL_UNCLAIMED (02037): the address PayPal sent its claim email to (the payout's receiver).
    payoutEmail: event === 'PAYPAL_UNCLAIMED' ? cleanText(payload.payout?.receiver, 254) : null,
    ...payoutMethodFields(event, payload),
  };
}

/**
 * How the email words the payout. 02036: a payout recorded by hand (PAYOUT_SENT, REFUND_AFTER_PAYOUT)
 * or a commission paid by hand (COMMISSION_EARNED) is worded without Stripe. 02037: a PayPal payout's
 * PAYOUT_SENT gets the PayPal variant ("We sent you {amount} by PayPal.", PayPal's transaction id as
 * the reference); a commission the program pays with PayPal the manual wording; the admin mails
 * (PAYOUT_FAILED, REFUND_AFTER_PAYOUT) get `paypal`, with `payoutPrepared` while PayPal still holds the
 * payout.
 */
function payoutMethodFields(
  event: AffiliateLifecycleEvent,
  payload: AffiliateLifecyclePayload
): Pick<AffiliateEmailData, 'payoutMethod' | 'payoutPrepared' | 'payoutChannel' | 'payoutReference' | 'payoutNote'> {
  const payout = payload.payout ?? null;
  const commissionMethod = payload.commission?.payoutMethod;
  if (payout?.method === 'paypal') {
    if (event === 'PAYOUT_SENT') {
      return {
        payoutMethod: 'paypal',
        payoutPrepared: null,
        payoutChannel: null,
        payoutReference: cleanText(payout.transferId, 120),
        payoutNote: null,
      };
    }
    return {
      payoutMethod: 'paypal',
      // REFUND_AFTER_PAYOUT of a PayPal payout PayPal has not settled yet (it may still fail or come back).
      payoutPrepared: payout.status === 'PROCESSING' ? true : null,
      payoutChannel: null,
      payoutReference: null,
      payoutNote: null,
    };
  }
  const manual = payout?.method === 'manual';
  return {
    payoutMethod: manual || commissionMethod === 'manual' || commissionMethod === 'paypal' ? 'manual' : null,
    // REFUND_AFTER_PAYOUT of a manual payout still prepared (not recorded): it may not have been sent.
    payoutPrepared: manual && payout?.status === 'PROCESSING' ? true : null,
    payoutChannel: manual ? payout?.channel ?? null : null,
    payoutReference: manual ? cleanText(payout?.reference, 120) : null,
    payoutNote: manual ? cleanText(payout?.note, 500) : null,
  };
}

/* ------------------------------------------------------------------- alerts --- */

function alertIdsFor(
  event: AffiliateAdminLifecycleEvent,
  payload: AffiliateLifecyclePayload,
  pageId: string | null,
): Record<string, string> {
  const ids: Record<string, string> = {};
  const affiliateId = cleanId(payload.affiliateId);
  if (affiliateId) ids['affiliate_id'] = affiliateId;
  if (pageId) ids['page_id'] = pageId;
  const payoutId = cleanId(payload.payout?.payoutId);
  if (payoutId) ids['payout_id'] = payoutId;
  const commissionId = cleanId(payload.commission?.commissionId);
  if (commissionId) ids['commission_id'] = commissionId;
  const orderId = cleanId(payload.orderId);
  if (orderId) ids['order_id'] = orderId;
  if (event === 'PAYOUT_FAILED') {
    const reason = cleanText(payload.payout?.reason, MAX_REASON_LENGTH);
    if (reason) ids['reason'] = reason;
  }
  return ids;
}

/** The natural key an unresolved alert of this event is deduplicated on, or null (always insert). */
function alertKeyFor(event: AffiliateAdminLifecycleEvent, ids: Record<string, string>): AlertKey | null {
  switch (event) {
    case 'PAYOUT_FAILED':
      return ids['payout_id'] ? { column: 'metadata->>payout_id', value: ids['payout_id'] } : null;
    case 'REFUND_AFTER_PAYOUT':
      if (ids['commission_id']) return { column: 'metadata->>commission_id', value: ids['commission_id'] };
      return ids['order_id'] ? { column: 'metadata->>order_id', value: ids['order_id'] } : null;
    case 'SIGNED_UP':
    case 'PROFILE_COMPLETED':
    case 'PAYOUT_CONFIGURED':
      return ids['affiliate_id'] ? { column: 'metadata->>affiliate_id', value: ids['affiliate_id'] } : null;
    case 'PAGE_SUBMITTED':
    default:
      return null;
  }
}

async function findUnresolvedAlert(
  db: AnyClient,
  alertType: AffiliateAlertType,
  key: AlertKey,
): Promise<{ id: string; metadata: Record<string, unknown> } | null> {
  const { data, error } = await db
    .from('system_alerts')
    .select('id, metadata')
    .eq('alert_type', alertType)
    .eq('is_resolved', false)
    .eq(key.column, key.value)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`alert lookup failed: ${error.message}`);
  const row = Array.isArray(data) ? (data[0] as { id?: unknown; metadata?: unknown } | undefined) : undefined;
  return row && typeof row.id === 'string' ? { id: row.id, metadata: asRecord(row.metadata) } : null;
}

/** Close the page's older submission alerts: a resubmission replaces them in the approvals queue. */
async function resolveOlderSubmissionAlerts(db: AnyClient, ids: Record<string, string>): Promise<void> {
  const key = ids['page_id']
    ? { column: 'metadata->>page_id', value: ids['page_id'] }
    : ids['affiliate_id']
      ? { column: 'metadata->>affiliate_id', value: ids['affiliate_id'] }
      : null;
  if (!key) return;
  const { error } = await db
    .from('system_alerts')
    .update({ is_resolved: true, resolved_at: new Date().toISOString() })
    .eq('alert_type', AFFILIATE_ALERT_TYPES.PAGE_SUBMITTED)
    .eq('is_resolved', false)
    .eq(key.column, key.value);
  if (error) console.warn('[affiliates] Could not resolve older submission alerts:', error.message);
}

function buildAlertRow(
  event: AffiliateAdminLifecycleEvent,
  data: AffiliateEmailData,
  ids: Record<string, string>,
): { alert_type: AffiliateAlertType; title: string; message: string; metadata: Record<string, unknown> } {
  const alertType = AFFILIATE_ALERT_TYPES[event];
  const fallback = FALLBACK_ALERT_COPY[event];
  let built: Partial<AffiliateSystemAlertInsert> = {};
  try {
    built = asRecord(buildAffiliateSystemAlert(event, data)) as Partial<AffiliateSystemAlertInsert>;
  } catch (error) {
    console.warn(`[affiliates] Alert template failed for ${event}:`, describeError(error));
  }

  const metadata = asRecord(built.metadata);
  const actionUrl = typeof metadata['action_url'] === 'string' ? metadata['action_url'] : '';
  const actionLabel = typeof metadata['action_label'] === 'string' ? metadata['action_label'].trim() : '';
  return {
    // Always the type the database allows for this event, whatever the template said.
    alert_type: alertType,
    title: clip(cleanText(built.title, MAX_TITLE_LENGTH) ?? fallback.title, MAX_TITLE_LENGTH),
    message: clip(cleanText(built.message, MAX_MESSAGE_LENGTH) ?? fallback.message, MAX_MESSAGE_LENGTH),
    metadata: {
      ...metadata,
      ...ids,
      // The CMS renders this as a link: only ever a path inside the affiliates screens.
      action_url: isAffiliatesCmsPath(actionUrl) ? actionUrl : cmsPathFor(event),
      action_label: actionLabel ? clip(actionLabel, 60) : fallback.label,
    },
  };
}

function isAffiliatesCmsPath(value: string): boolean {
  if (!isSafeInternalPath(value)) return false;
  return (
    value === AFFILIATE_CMS_PATH ||
    value.startsWith(`${AFFILIATE_CMS_PATH}/`) ||
    value.startsWith(`${AFFILIATE_CMS_PATH}?`)
  );
}

async function insertAlert(
  db: AnyClient,
  row: ReturnType<typeof buildAlertRow>,
): Promise<{ id: string; metadata: Record<string, unknown> } | null> {
  const { data, error } = await db.from('system_alerts').insert(row).select('id').single();
  if (error) {
    console.warn(`[affiliates] Could not record the ${row.alert_type} alert:`, error.message);
    return null;
  }
  const id = (data as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? { id, metadata: row.metadata } : null;
}

async function markAlertEmailed(db: AnyClient, alert: { id: string; metadata: Record<string, unknown> }): Promise<void> {
  const { error } = await db
    .from('system_alerts')
    .update({ metadata: { ...alert.metadata, emailed_at: new Date().toISOString() } })
    .eq('id', alert.id);
  if (error) console.warn('[affiliates] Could not mark the alert as emailed:', error.message);
}

/* -------------------------------------------------------------------- email --- */

async function renderEmail(event: AffiliateLifecycleEvent, data: AffiliateEmailData): Promise<AffiliateEmailMessage | null> {
  try {
    const message = await Promise.resolve(buildAffiliateEmail(event, data));
    if (!message || typeof message.subject !== 'string' || typeof message.html !== 'string') return null;
    return {
      // Lands in a mail header: never let a CR/LF through, whatever the template produced.
      subject: clip(message.subject.replace(/[\r\n]+/g, ' ').trim(), MAX_SUBJECT_LENGTH),
      text: typeof message.text === 'string' ? message.text : '',
      html: message.html,
    };
  } catch (error) {
    console.warn(`[affiliates] Email template failed for ${event}:`, describeError(error));
    return null;
  }
}

/** Send one message to each recipient separately. True when at least one send succeeded. */
async function deliver(event: AffiliateLifecycleEvent, message: AffiliateEmailMessage, recipients: string[]): Promise<boolean> {
  let delivered = false;
  for (const to of recipients) {
    try {
      await sendEmail({ to, subject: message.subject, text: message.text, html: message.html });
      delivered = true;
    } catch (error) {
      // No recipient address in the log line.
      console.warn(`[affiliates] ${event} email failed:`, describeError(error));
    }
  }
  return delivered;
}

/* ------------------------------------------------------------------ flows --- */

async function notifyAdmins(
  event: AffiliateAdminLifecycleEvent,
  payload: AffiliateLifecyclePayload,
  ctx: NotifyContext,
): Promise<void> {
  const profile = await loadProfile(ctx.db, payload.affiliateId);
  const data = buildEmailData(event, ctx, profile, payload, 'en');
  const pageId = event === 'PAGE_SUBMITTED' ? await resolvePageId(ctx.db, payload) : cleanId(payload.pageId);
  const ids = alertIdsFor(event, payload, pageId);
  const alertType = AFFILIATE_ALERT_TYPES[event];

  if (event === 'PAGE_SUBMITTED') {
    try {
      await resolveOlderSubmissionAlerts(ctx.db, ids);
    } catch (error) {
      console.warn('[affiliates] Could not resolve older submission alerts:', describeError(error));
    }
  }

  const key = alertKeyFor(event, ids);
  let alert: { id: string; metadata: Record<string, unknown> } | null = null;
  let existing: { id: string; metadata: Record<string, unknown> } | null = null;
  if (key) {
    try {
      existing = await findUnresolvedAlert(ctx.db, alertType, key);
    } catch (error) {
      // A failed lookup must not cost the alert itself: a duplicate beats a missing one.
      console.warn(`[affiliates] ${event} alert lookup failed:`, describeError(error));
    }
  }

  if (existing) {
    // Already raised (by an earlier call, or by the database for refunds after payout).
    if (existing.metadata['emailed_at']) return;
    alert = existing;
  } else {
    try {
      alert = await insertAlert(ctx.db, buildAlertRow(event, data, ids));
    } catch (error) {
      console.warn(`[affiliates] ${event} alert skipped:`, describeError(error));
    }
  }

  if (!ctx.canSendEmail) return;
  const recipients = await resolveAdminRecipients();
  if (recipients.length === 0) return;
  const message = await renderEmail(event, data);
  if (!message) return;

  const delivered = await deliver(event, message, recipients);
  if (delivered && alert && key) {
    try {
      await markAlertEmailed(ctx.db, alert);
    } catch (error) {
      console.warn('[affiliates] Could not mark the alert as emailed:', describeError(error));
    }
  }
}

async function notifyPartner(
  event: AffiliateRetailerLifecycleEvent,
  payload: AffiliateLifecyclePayload,
  ctx: NotifyContext,
  preloaded?: NotifyProfile | null,
): Promise<boolean> {
  if (!ctx.canSendEmail) return false;
  const profile = preloaded ?? (await loadProfile(ctx.db, payload.affiliateId));
  if (!profile) return false;

  const to = await resolvePartnerEmail(ctx.db, profile.user_id);
  if (!to) return false;

  const locale = toAffiliatesLocale(profile.preferred_locale);
  const message = await renderEmail(event, buildEmailData(event, ctx, profile, payload, locale));
  if (!message) return false;
  return deliver(event, message, [to]);
}

/**
 * Record and send one lifecycle notification. Resolves when done; never rejects. Prefer calling
 * it through {@link scheduleAffiliateNotification} so the work happens after the response.
 */
export async function notifyAffiliateLifecycle(
  event: AffiliateLifecycleEvent,
  payload: AffiliateLifecyclePayload,
): Promise<void> {
  try {
    if (!payload || typeof payload !== 'object' || !cleanId(payload.affiliateId)) return;
    if (!isAdminEvent(event) && !isRetailerEvent(event)) return;

    const ctx = await createNotifyContext();
    if (isAdminEvent(event)) {
      await notifyAdmins(event, payload, ctx);
    } else {
      await notifyPartner(event, payload, ctx);
    }
  } catch (error) {
    console.warn(`[affiliates] ${String(event)} notification failed:`, describeError(error));
  }
}

interface CommissionGroup {
  affiliateId: string;
  commissionId: string;
  currency: string;
  ratePercent: number;
  amountCents: number;
  clearsAt: string;
  /** How the program pays these commissions (02036): the email explains Stripe or a payment by hand. */
  payoutMethod: AffiliatePayoutMethod;
}

/**
 * One email per partner, currency, rate and payout method: a burst of orders between two sweeps
 * becomes a single "you just earned" message with the total and the earliest clearance date still
 * ahead (a late commission whose clears_at has passed gives no date; '' when none is ahead).
 * `methodOf` says how a gateway's commissions are paid (`affiliates_settings.payoutMethods`).
 */
function groupCommissions(
  rows: AffiliateCommissionRow[],
  now: number,
  methodOf: (gateway: AffiliateGateway) => AffiliatePayoutMethod = () => 'stripe_connect',
): CommissionGroup[] {
  const groups = new Map<string, CommissionGroup>();
  for (const row of rows) {
    if (!row || row.status === 'VOIDED_REFUND') continue;
    const affiliateId = cleanId(row.affiliate_id);
    const commissionId = cleanId(row.id);
    if (!affiliateId || !commissionId) continue;

    const net = Math.max(0, Math.round(Number(row.commission_amount_cents) - Number(row.refunded_amount_cents ?? 0)));
    if (!Number.isFinite(net) || net <= 0) continue; // tombstones and fully refunded rows

    const createdAt = Date.parse(row.created_at);
    if (Number.isFinite(createdAt) && now - createdAt > STALE_COMMISSION_MS) continue;

    const currency = typeof row.currency === 'string' ? row.currency.trim().toUpperCase() : '';
    const rate = Number(row.commission_rate_snapshot);
    if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(rate)) continue;

    const payoutMethod = methodOf(row.gateway === 'FREEMIUS' ? 'FREEMIUS' : 'STRIPE');
    const key = `${affiliateId}|${currency}|${rate}|${payoutMethod}`;
    const clearsAt = upcomingClearance(row.clears_at, now);
    const existing = groups.get(key);
    if (existing) {
      existing.amountCents += net;
      if (clearsAt && (!existing.clearsAt || Date.parse(clearsAt) < Date.parse(existing.clearsAt))) existing.clearsAt = clearsAt;
    } else {
      groups.set(key, { affiliateId, commissionId, currency, ratePercent: rate, amountCents: net, clearsAt, payoutMethod });
    }
  }
  return [...groups.values()];
}

/**
 * Claim commissions nobody was told about yet (`claim_affiliate_commission_notifications`, which
 * stamps `notified_at` atomically, so concurrent sweeps never double-send) and email each partner
 * a COMMISSION_EARNED notice. Commissions older than two weeks are claimed without an email (a
 * backlog from before SMTP was configured is not news). Returns how many commissions were claimed;
 * never throws. Runs from the webhook routes (after a paid order) and every payout cycle.
 */
export async function sweepAffiliateCommissionNotifications(limit = 50): Promise<number> {
  try {
    const db = getServiceRoleSupabaseClient() as unknown as AnyClient;
    const requested = Number.isFinite(limit) ? Math.floor(limit) : 50;
    const pLimit = Math.min(MAX_SWEEP_LIMIT, Math.max(1, requested));

    const { data, error } = await db.rpc('claim_affiliate_commission_notifications', { p_limit: pLimit });
    if (error) {
      console.warn('[affiliates] Commission notification claim failed:', error.message);
      return 0;
    }
    const rows = Array.isArray(data) ? (data as AffiliateCommissionRow[]) : [];
    if (rows.length === 0) return 0;

    // How each gateway's commissions are paid (02036); getAffiliatesSettings never throws.
    const settings = await getAffiliatesSettings();
    const groups = groupCommissions(rows, Date.now(), (gateway) => affiliatePayoutMethodForGateway(settings, gateway));
    if (groups.length > 0) {
      const ctx = await createNotifyContext(db);
      if (ctx.canSendEmail) {
        const profiles = await loadProfiles(
          db,
          groups.map((group) => group.affiliateId),
        );
        for (const group of groups) {
          const profile = profiles.get(group.affiliateId);
          if (!profile) continue;
          try {
            await notifyPartner(
              'COMMISSION_EARNED',
              {
                affiliateId: group.affiliateId,
                commission: {
                  commissionId: group.commissionId,
                  amountCents: group.amountCents,
                  currency: group.currency,
                  ratePercent: group.ratePercent,
                  clearsAt: group.clearsAt,
                  ...(group.payoutMethod === 'manual' || group.payoutMethod === 'paypal' ? { payoutMethod: group.payoutMethod } : {}),
                },
              },
              ctx,
              profile,
            );
          } catch (error) {
            console.warn('[affiliates] Commission notice failed:', describeError(error));
          }
        }
      }
    }
    return rows.length;
  } catch (error) {
    console.warn('[affiliates] Commission notification sweep failed:', describeError(error));
    return 0;
  }
}

/* -------------------------------------------------------- refund alert emails --- */

/** Refund alerts older than this are left to the CMS banner: a backlog from before SMTP was set up is not news. */
const REFUND_ALERT_EMAIL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** A sweep's claim on an alert lapses after this, so a crash or a failed send between claim and stamp is retried. */
const REFUND_ALERT_CLAIM_TTL_MS = 15 * 60 * 1000;
const MAX_REFUND_ALERT_SWEEP = 50;

interface StoredAlert {
  id: string;
  metadata: Record<string, unknown>;
}

/**
 * Compare-and-set claim on one alert's email (`metadata.email_claimed_at`). The update matches
 * only while the alert is unresolved, unmailed and still carries the claim value this sweep read,
 * so of two overlapping sweeps (a webhook's `after()` and the payout cron) exactly one sends.
 */
async function claimAlertEmail(db: AnyClient, alert: StoredAlert, claimedAt: string): Promise<StoredAlert | null> {
  const previous = alert.metadata['email_claimed_at'];
  const metadata = { ...alert.metadata, email_claimed_at: claimedAt };
  const base = db
    .from('system_alerts')
    .update({ metadata })
    .eq('id', alert.id)
    .eq('is_resolved', false)
    .is('metadata->>emailed_at', null);
  const guarded =
    typeof previous === 'string'
      ? base.eq('metadata->>email_claimed_at', previous)
      : base.is('metadata->>email_claimed_at', null);
  const { data, error } = await guarded.select('id');
  if (error) {
    console.warn('[affiliates] Could not claim the refund alert email:', error.message);
    return null;
  }
  return Array.isArray(data) && data.length > 0 ? { id: alert.id, metadata } : null;
}

/** The commission and payout behind a refund alert, for the email's amount and transfer lines. */
async function refundAlertPayload(
  db: AnyClient,
  metadata: Record<string, unknown>,
  affiliateId: string,
): Promise<AffiliateLifecyclePayload> {
  const payload: AffiliateLifecyclePayload = { affiliateId, orderId: cleanId(metadata['order_id']) };

  const commissionId = cleanId(metadata['commission_id']);
  if (commissionId) {
    const { data } = await db
      .from('affiliate_commissions')
      .select('id, commission_amount_cents, currency, commission_rate_snapshot, clears_at')
      .eq('id', commissionId)
      .maybeSingle();
    const row = asRecord(data);
    const amountCents = Number(row['commission_amount_cents']);
    const currency = typeof row['currency'] === 'string' ? row['currency'] : '';
    if (Number.isFinite(amountCents) && currency) {
      payload.commission = {
        commissionId,
        amountCents,
        currency,
        ratePercent: Number(row['commission_rate_snapshot']),
        clearsAt: typeof row['clears_at'] === 'string' ? row['clears_at'] : '',
      };
    }
  }

  const payoutId = cleanId(metadata['payout_id']);
  if (payoutId) {
    const { data } = await db
      .from('affiliate_payouts')
      .select('id, amount_cents, currency, stripe_transfer_id, method, status')
      .eq('id', payoutId)
      .maybeSingle();
    const row = asRecord(data);
    const amountCents = Number(row['amount_cents']);
    const currency = typeof row['currency'] === 'string' ? row['currency'] : '';
    if (Number.isFinite(amountCents) && currency) {
      // The status the database saw when it raised the alert (02036), else the payout's own now.
      const status = metadata['payout_status'] ?? row['status'];
      payload.payout = {
        payoutId,
        amountCents,
        currency,
        transferId: typeof row['stripe_transfer_id'] === 'string' ? row['stripe_transfer_id'] : null,
        // A payout recorded by hand (02036): the email asks to recover the amount, not to reverse a
        // transfer; one only prepared (PROCESSING) asks to cancel it if the money has not left yet.
        // A PayPal payout (02037): in flight, the refund waits for PayPal's answer; paid, recover it.
        method:
          row['method'] === 'paypal' || metadata['payout_method'] === 'paypal'
            ? 'paypal'
            : row['method'] === 'manual' || metadata['payout_method'] === 'manual'
              ? 'manual'
              : 'stripe_connect',
        status: status === 'PROCESSING' || status === 'COMPLETED' || status === 'FAILED' ? status : null,
      };
    }
  }
  return payload;
}

/**
 * Email the affiliate notification addresses about every unresolved `affiliate_refund_after_payout`
 * alert nobody was mailed about yet. The database raises those alerts itself (02030: a refund, a
 * lost dispute, a cancellation or a deleted order after the commission was paid or queued), on
 * paths that never pass through this module (the payment webhooks, the CMS order status actions,
 * an order delete), so the email is a sweep rather than a call at each site. It runs after the
 * payment webhooks and the checkout success page (`scheduleAffiliateCommissionSweep`) and in every
 * payout cycle. Each alert is claimed before the send ({@link claimAlertEmail}) and stamped
 * `metadata.emailed_at` after it, so it is mailed once; a failed send keeps the claim, which lapses
 * after 15 minutes so a later sweep retries. Alerts older than two weeks are left to the CMS banner.
 * Until 2026-10-27 no email was ever sent for them. Returns how many alerts were mailed; never throws.
 */
export async function sweepAffiliateRefundAlertEmails(limit = 20): Promise<number> {
  try {
    const db = getServiceRoleSupabaseClient() as unknown as AnyClient;
    const ctx = await createNotifyContext(db);
    if (!ctx.canSendEmail) return 0;

    const requested = Number.isFinite(limit) ? Math.floor(limit) : 20;
    const max = Math.min(MAX_REFUND_ALERT_SWEEP, Math.max(1, requested));
    const now = Date.now();
    const { data, error } = await db
      .from('system_alerts')
      .select('id, metadata')
      .eq('alert_type', AFFILIATE_ALERT_TYPES.REFUND_AFTER_PAYOUT)
      .eq('is_resolved', false)
      .is('metadata->>emailed_at', null)
      .gte('created_at', new Date(now - REFUND_ALERT_EMAIL_WINDOW_MS).toISOString())
      .order('created_at', { ascending: true })
      .limit(max);
    if (error) {
      console.warn('[affiliates] Refund alert lookup failed:', error.message);
      return 0;
    }

    const pending = (Array.isArray(data) ? (data as Array<{ id?: unknown; metadata?: unknown }>) : [])
      .map((row) => ({ id: typeof row?.id === 'string' ? row.id : '', metadata: asRecord(row?.metadata) }))
      .filter((alert) => {
        if (!alert.id || !cleanId(alert.metadata['affiliate_id'])) return false;
        // Another sweep holds a fresh claim on this one.
        const claimedAt = Date.parse(String(alert.metadata['email_claimed_at'] ?? ''));
        return !(Number.isFinite(claimedAt) && now - claimedAt < REFUND_ALERT_CLAIM_TTL_MS);
      });
    if (pending.length === 0) return 0;

    const recipients = await resolveAdminRecipients();
    if (recipients.length === 0) return 0;

    let mailed = 0;
    for (const candidate of pending) {
      try {
        const alert = await claimAlertEmail(db, candidate, new Date().toISOString());
        if (!alert) continue;
        const affiliateId = cleanId(alert.metadata['affiliate_id']) ?? '';
        const payload = await refundAlertPayload(db, alert.metadata, affiliateId);
        const profile = await loadProfile(db, affiliateId);
        const message = await renderEmail(
          'REFUND_AFTER_PAYOUT',
          buildEmailData('REFUND_AFTER_PAYOUT', ctx, profile, payload, 'en'),
        );
        if (!message) continue;
        if (await deliver('REFUND_AFTER_PAYOUT', message, recipients)) {
          await markAlertEmailed(db, alert);
          mailed += 1;
        }
      } catch (error) {
        console.warn('[affiliates] Refund alert email failed:', describeError(error));
      }
    }
    return mailed;
  } catch (error) {
    console.warn('[affiliates] Refund alert email sweep failed:', describeError(error));
    return 0;
  }
}

/**
 * Run `task` after the response (`after()` from next/server), swallowing its errors. Usable from
 * server actions, route handlers and server components. Outside a request scope (a script, a
 * test) the task starts immediately instead, still without throwing.
 */
export function scheduleAffiliateNotification(task: () => unknown): void {
  const run = async () => {
    try {
      await task();
    } catch (error) {
      console.warn('[affiliates] Deferred notification failed:', describeError(error));
    }
  };
  try {
    after(run);
  } catch {
    void run();
  }
}

/** `scheduleAffiliateNotification(() => notifyAffiliateLifecycle(event, payload))`. */
export function scheduleAffiliateLifecycleNotification(
  event: AffiliateLifecycleEvent,
  payload: AffiliateLifecyclePayload,
): void {
  scheduleAffiliateNotification(() => notifyAffiliateLifecycle(event, payload));
}
