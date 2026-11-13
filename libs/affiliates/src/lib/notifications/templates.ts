/**
 * Lifecycle email templates of the affiliate program (SPEC §9). `buildAffiliateEmail(event, data)`
 * returns `{ subject, text, html }` for `sendEmail()`:
 *
 * - partner events (PAGE_PUBLISHED, CHANGES_REQUESTED, COMMISSION_EARNED, PAYOUT_SENT,
 *   PARTNER_SUSPENDED, PARTNER_REACTIVATED, TIER_CHANGED, and the PayPal Payouts notices of 02037,
 *   PAYPAL_UNCLAIMED and PAYPAL_PAYOUT_FAILED) in the partner's language (English or Québec French);
 *   admin events in English (CMS audience);
 * - every value is escaped (`escapeAffiliateHtml`), and only absolute http(s) URLs become links;
 * - admin emails never link, or print the URL of, a public storefront (`/partners/<handle>` is
 *   shown as a path): an admin's click would set that partner's referral cookie;
 * - the subject is one line (no CR/LF reaches a mail header) of at most 150 characters;
 * - the HTML is a table layout with inline styles only (email clients drop `<style>` and classes),
 *   the `{{brand_header}}` token at the top of the card (replaced by `sendEmail()`), one CTA
 *   button and the same URL printed as text below it.
 */
import {
  AFFILIATE_CMS_APPROVALS_PATH,
  AFFILIATE_CMS_PATH,
  AFFILIATE_CMS_PAYOUTS_PATH,
  AFFILIATE_PARTNERS_PATH,
  AFFILIATE_PORTAL_PATH,
  AFFILIATE_PORTAL_PAYOUTS_PATH,
  AFFILIATE_PORTAL_STOREFRONT_PATH,
} from '../core/constants';
import { isAffiliatePayPalReceiverFailureReason } from '../core/payout-methods';
import { isAffiliateManualPayoutChannel } from '../core/statuses';
import { applyAffiliatesFrenchTypography, interpolateAffiliatesCopy, resolveAffiliatesLocale } from '../i18n/copy-runtime';
import type { AffiliatesCopyValues } from '../i18n/types';
import type {
  AffiliateAdminLifecycleEvent,
  AffiliateEmailData,
  AffiliateEmailMessage,
  AffiliateLifecycleEvent,
  AffiliateLocale,
  AffiliateManualPayoutChannel,
  AffiliateRetailerLifecycleEvent,
} from '../core/types';
import {
  AFFILIATE_ADMIN_EMAIL_COPY,
  AFFILIATE_PARTNER_EMAIL_COPY,
  type AffiliateAdminEmailCopyKey,
  type AffiliatePartnerEmailCopyKey,
} from './copy';
import { affiliateEmailHref, cleanAffiliateEmailText, escapeAffiliateHtml, toAffiliateEmailSubject } from './escape';

/** The token `applyEmailBranding()` (app) replaces with the tenant logo or name. */
export const AFFILIATE_EMAIL_BRAND_HEADER_TOKEN = '{{brand_header}}';

export type AffiliateEmailShareNetwork = 'x' | 'facebook' | 'linkedin' | 'pinterest' | 'email';

export interface AffiliateEmailShareLink {
  network: AffiliateEmailShareNetwork;
  label: string;
  url: string;
}

interface EmailDetail {
  label: string;
  value: string;
  href?: string | null;
}

interface EmailContent {
  locale: AffiliateLocale;
  subject: string;
  preheader: string;
  heading: string;
  greeting: string | null;
  paragraphs: string[];
  details: EmailDetail[];
  note: { label: string; text: string } | null;
  /** Paragraphs between the note/details and the button. */
  beforeCta: string[];
  cta: { label: string; url: string } | null;
  fallbackLabel: string;
  afterCta: string[];
  share: { heading: string; links: AffiliateEmailShareLink[] } | null;
  signature: string | null;
  footer: string;
}

const NBSP = String.fromCharCode(0xa0);
const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MAX_NAME = 80;
const MAX_SITE_NAME = 120;
const MAX_NOTE = 2000;
const MAX_REASON = 500;
const MAX_LABEL = 120;

const PARTNER_EVENTS: ReadonlySet<string> = new Set<AffiliateRetailerLifecycleEvent>([
  'PAGE_PUBLISHED',
  'CHANGES_REQUESTED',
  'COMMISSION_EARNED',
  'PAYOUT_SENT',
  'PARTNER_SUSPENDED',
  'PARTNER_REACTIVATED',
  'TIER_CHANGED',
  'PAYPAL_UNCLAIMED',
  'PAYPAL_PAYOUT_FAILED',
]);

const ADMIN_EVENTS: ReadonlySet<string> = new Set<AffiliateAdminLifecycleEvent>([
  'SIGNED_UP',
  'PROFILE_COMPLETED',
  'PAYOUT_CONFIGURED',
  'PAGE_SUBMITTED',
  'PAYOUT_FAILED',
  'REFUND_AFTER_PAYOUT',
]);

/** The phrase that names a manual payout's channel in a sentence ("by PayPal", "par virement Interac"). */
const MANUAL_CHANNEL_KEYS: Readonly<Record<AffiliateManualPayoutChannel, AffiliatePartnerEmailCopyKey>> = {
  paypal: 'payout_sent.channel_paypal',
  interac: 'payout_sent.channel_interac',
  wise: 'payout_sent.channel_wise',
  bank_transfer: 'payout_sent.channel_bank_transfer',
  other: 'payout_sent.channel_other',
};

/** A known channel, else `other` (the copy then says "another payment method"). */
function manualChannelOf(value: unknown): AffiliateManualPayoutChannel {
  return isAffiliateManualPayoutChannel(value) ? value : 'other';
}

/**
 * Why a PayPal payout failed, as the partner reads it (02037), from the PayPal run's reason code
 * (`paypal_returned`, `paypal_failed:receiver_unregistered`, `paypal_cancelled`, …). PayPal's own code
 * never reaches the email: an unknown one reads "PayPal could not complete it".
 */
export function affiliatePayPalFailureReasonKey(reason: unknown): AffiliatePartnerEmailCopyKey {
  const code = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
  if (/^paypal_cancel+ed\b/.test(code)) return 'paypal_payout_failed.reason_cancelled';
  if (code.includes(':receiver_unregistered')) return 'paypal_payout_failed.reason_unregistered';
  if (/^paypal_returned\b/.test(code)) return 'paypal_payout_failed.reason_unclaimed';
  if (code.includes(':receiver_')) return 'paypal_payout_failed.reason_receiver';
  if (/^paypal_blocked\b/.test(code)) return 'paypal_payout_failed.reason_blocked';
  return 'paypal_payout_failed.reason_generic';
}

function partnerText(locale: AffiliateLocale, key: AffiliatePartnerEmailCopyKey, values?: AffiliatesCopyValues): string {
  const entry = AFFILIATE_PARTNER_EMAIL_COPY[key];
  return interpolateAffiliatesCopy(locale === 'fr' ? applyAffiliatesFrenchTypography(entry.fr) : entry.en, values);
}

function adminText(key: AffiliateAdminEmailCopyKey, values?: AffiliatesCopyValues): string {
  return interpolateAffiliatesCopy(AFFILIATE_ADMIN_EMAIL_COPY[key], values);
}

function line(value: unknown, max: number): string {
  return cleanAffiliateEmailText(value, { max });
}

function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function siteNameOf(data: AffiliateEmailData, fallback: string): string {
  return line(data.siteName, MAX_SITE_NAME) || hostOf(affiliateEmailHref(data.siteUrl)) || fallback;
}

/** `{label}: {value}` in English, `{label} : {value}` (no-break space) in French. */
function labelled(locale: AffiliateLocale, label: string, value: string): string {
  return locale === 'fr' ? `${label}${NBSP}: ${value}` : `${label}: ${value}`;
}

/**
 * A commission rate for the copy: `50%` / `12.5%` in English, `50 %` / `12,5 %` (no-break space)
 * in French; null for a missing or out-of-range rate.
 */
export function formatAffiliateEmailRate(rate: unknown, locale: AffiliateLocale): string | null {
  if (rate === null || rate === undefined || rate === '') return null;
  const value = typeof rate === 'number' ? rate : Number(rate);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  const number = new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-US', { maximumFractionDigits: 2 }).format(value);
  return locale === 'fr' ? `${number}${NBSP}%` : `${number}%`;
}

/**
 * Share links for a published storefront (X, Facebook, LinkedIn, Pinterest, email), every
 * parameter built with `encodeURIComponent`. Empty when `url` is not an absolute http(s) URL.
 */
export function buildAffiliateShareLinks(input: { url: string | null; text: string; locale: AffiliateLocale }): AffiliateEmailShareLink[] {
  const href = affiliateEmailHref(input.url);
  if (!href) return [];
  const locale = resolveAffiliatesLocale(input.locale);
  const text = line(input.text, 200);
  const url = encodeURIComponent(href);
  const message = encodeURIComponent(text);
  return [
    { network: 'x', label: partnerText(locale, 'page_published.share_x'), url: `https://x.com/intent/post?text=${message}&url=${url}` },
    { network: 'facebook', label: partnerText(locale, 'page_published.share_facebook'), url: `https://www.facebook.com/sharer/sharer.php?u=${url}` },
    { network: 'linkedin', label: partnerText(locale, 'page_published.share_linkedin'), url: `https://www.linkedin.com/sharing/share-offsite/?url=${url}` },
    {
      network: 'pinterest',
      label: partnerText(locale, 'page_published.share_pinterest'),
      url: `https://www.pinterest.com/pin/create/button/?url=${url}&description=${message}`,
    },
    {
      network: 'email',
      label: partnerText(locale, 'page_published.share_email'),
      url: `mailto:?subject=${message}&body=${encodeURIComponent(`${text} ${href}`)}`,
    },
  ];
}

function cta(label: string, url: string | null | undefined): EmailContent['cta'] {
  const href = affiliateEmailHref(url);
  return href ? { label, url: href } : null;
}

const HANDLE_SHAPE = /^[a-z0-9-]{1,64}$/;

function originOf(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const href = affiliateEmailHref(candidate);
    if (href) return new URL(href).origin;
  }
  return null;
}

function hasPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** `preferred` when it is an http(s) URL on the site's origin (when known) inside `path`, else null. */
function urlInside(preferred: unknown, path: string, siteOrigin: string | null): string | null {
  const href = affiliateEmailHref(preferred);
  if (!href) return null;
  const url = new URL(href);
  if (siteOrigin !== null && url.origin !== siteOrigin) return null;
  return hasPathPrefix(url.pathname, path) ? href : null;
}

/**
 * The link of an event's button: `preferred` when it is an http(s) URL on the site inside `path`
 * (a deep link such as `…/approvals?page=…` is kept), otherwise `path` on the site's origin. So a
 * PAGE_SUBMITTED mail always opens the approvals queue and a payout mail the payouts screen,
 * whatever the caller sent, and no button leaves the site.
 */
function eventUrl(preferred: unknown, path: string, data: AffiliateEmailData): string | null {
  const site = originOf(data.siteUrl);
  const kept = urlInside(preferred, path, site);
  if (kept) return kept;
  const origin = site ?? originOf(preferred, data.cmsUrl, data.portalUrl);
  return origin ? `${origin}${path}` : null;
}

/** The partner's public storefront URL (`/partners/<handle>` on the site), or null. */
function storefrontUrlOf(data: AffiliateEmailData): string | null {
  const site = originOf(data.siteUrl);
  const kept = urlInside(data.storefrontUrl, AFFILIATE_PARTNERS_PATH, site);
  if (kept) return kept;
  const handle = typeof data.handle === 'string' ? data.handle.trim() : '';
  const origin = site ?? originOf(data.portalUrl, data.cmsUrl);
  return origin && HANDLE_SHAPE.test(handle) ? `${origin}${AFFILIATE_PARTNERS_PATH}/${encodeURIComponent(handle)}` : null;
}

/* ----------------------------------------------------------------------- partner emails --- */

function partnerBase(locale: AffiliateLocale, data: AffiliateEmailData) {
  const siteName = siteNameOf(data, partnerText(locale, 'common.store_fallback'));
  const name = line(data.recipientName, MAX_NAME) || line(data.displayName, MAX_NAME);
  return {
    siteName,
    greeting: name ? partnerText(locale, 'common.greeting_named', { name }) : partnerText(locale, 'common.greeting'),
    signature: partnerText(locale, 'common.signature', { siteName }),
    footer: partnerText(locale, 'common.footer', { siteName }),
    fallbackLabel: partnerText(locale, 'common.button_fallback'),
  };
}

function partnerContent(event: AffiliateRetailerLifecycleEvent, data: AffiliateEmailData): EmailContent {
  const locale = resolveAffiliatesLocale(data.locale);
  const base = partnerBase(locale, data);
  const content: EmailContent = {
    locale,
    subject: '',
    preheader: '',
    heading: '',
    greeting: base.greeting,
    paragraphs: [],
    details: [],
    note: null,
    beforeCta: [],
    cta: null,
    fallbackLabel: base.fallbackLabel,
    afterCta: [],
    share: null,
    signature: base.signature,
    footer: base.footer,
  };
  const amount = line(data.amountLabel, MAX_LABEL);

  switch (event) {
    case 'PAGE_PUBLISHED': {
      const storefrontUrl = storefrontUrlOf(data);
      content.subject = partnerText(locale, 'page_published.subject', { siteName: base.siteName });
      content.preheader = partnerText(locale, 'page_published.preheader');
      content.heading = partnerText(locale, 'page_published.heading');
      content.paragraphs = [partnerText(locale, 'page_published.body')];
      content.cta = cta(partnerText(locale, 'page_published.cta'), storefrontUrl ?? eventUrl(data.portalUrl, AFFILIATE_PORTAL_PATH, data));
      content.afterCta = [partnerText(locale, 'page_published.portal_hint')];
      const links = buildAffiliateShareLinks({
        url: storefrontUrl,
        text: partnerText(locale, 'page_published.share_text', { siteName: base.siteName }),
        locale,
      });
      content.share = links.length > 0 ? { heading: partnerText(locale, 'page_published.share_heading'), links } : null;
      break;
    }
    case 'CHANGES_REQUESTED': {
      const note = cleanAffiliateEmailText(data.feedbackNote, { multiline: true, max: MAX_NOTE });
      content.subject = partnerText(locale, 'changes_requested.subject');
      content.preheader = partnerText(locale, 'changes_requested.preheader');
      content.heading = partnerText(locale, 'changes_requested.heading');
      content.paragraphs = [partnerText(locale, 'changes_requested.body')];
      if (note) content.note = { label: partnerText(locale, 'changes_requested.note_label'), text: note };
      else content.paragraphs.push(partnerText(locale, 'changes_requested.no_note'));
      content.beforeCta = [partnerText(locale, 'changes_requested.next_step')];
      content.cta = cta(partnerText(locale, 'changes_requested.cta'), eventUrl(data.portalUrl, AFFILIATE_PORTAL_STOREFRONT_PATH, data));
      break;
    }
    case 'COMMISSION_EARNED': {
      const rate = formatAffiliateEmailRate(data.ratePercent, locale);
      const date = line(data.clearsAtLabel, MAX_LABEL);
      let summary: string;
      if (!amount) summary = partnerText(locale, 'commission_earned.line_generic');
      else if (rate && date) summary = partnerText(locale, 'commission_earned.line_full', { rate, amount, date });
      else if (rate) summary = partnerText(locale, 'commission_earned.line_rate', { rate, amount });
      else if (date) summary = partnerText(locale, 'commission_earned.line_date', { amount, date });
      else summary = partnerText(locale, 'commission_earned.line_amount', { amount });
      content.subject = amount
        ? partnerText(locale, 'commission_earned.subject_amount', { amount })
        : partnerText(locale, 'commission_earned.subject');
      content.preheader = summary;
      content.heading = partnerText(locale, 'commission_earned.heading');
      content.paragraphs = [
        summary,
        partnerText(locale, data.payoutMethod === 'manual' ? 'commission_earned.explain_manual' : 'commission_earned.explain'),
      ];
      content.cta = cta(partnerText(locale, 'commission_earned.cta'), eventUrl(data.portalUrl, AFFILIATE_PORTAL_PAYOUTS_PATH, data));
      break;
    }
    case 'PAYOUT_SENT': {
      if (data.payoutMethod === 'paypal') {
        // PayPal paid the item into the partner's PayPal account (02037): PayPal's transaction id, no
        // Stripe transfer, no "a few business days".
        const transaction = line(data.payoutReference, 120);
        const summary = amount
          ? partnerText(locale, 'payout_sent.paypal_line', { amount })
          : partnerText(locale, 'payout_sent.paypal_line_generic');
        content.subject = amount
          ? partnerText(locale, 'payout_sent.paypal_subject', { amount })
          : partnerText(locale, 'payout_sent.paypal_subject_generic');
        content.preheader = summary;
        content.heading = partnerText(locale, 'payout_sent.paypal_heading');
        content.paragraphs = [summary, partnerText(locale, 'payout_sent.paypal_timing')];
        if (amount) content.details.push({ label: partnerText(locale, 'payout_sent.amount_label'), value: amount });
        if (transaction) content.details.push({ label: partnerText(locale, 'payout_sent.paypal_transaction_label'), value: transaction });
        content.cta = cta(partnerText(locale, 'payout_sent.cta'), eventUrl(data.portalUrl, AFFILIATE_PORTAL_PAYOUTS_PATH, data));
        break;
      }
      if (data.payoutMethod === 'manual') {
        // Money the operator sent outside Stripe and recorded in the CMS (02036): no transfer id.
        const channel = partnerText(locale, MANUAL_CHANNEL_KEYS[manualChannelOf(data.payoutChannel)]);
        const reference = line(data.payoutReference, 120);
        const note = cleanAffiliateEmailText(data.payoutNote, { multiline: true, max: 500 });
        const summary = !amount
          ? partnerText(locale, 'payout_sent.manual_line_generic', { channel })
          : reference
            ? partnerText(locale, 'payout_sent.manual_line', { amount, channel, reference })
            : partnerText(locale, 'payout_sent.manual_line_no_reference', { amount, channel });
        content.subject = amount
          ? partnerText(locale, 'payout_sent.manual_subject', { amount })
          : partnerText(locale, 'payout_sent.manual_subject_generic');
        content.preheader = summary;
        content.heading = partnerText(locale, 'payout_sent.manual_heading');
        content.paragraphs = [summary, partnerText(locale, 'payout_sent.manual_timing')];
        if (amount) content.details.push({ label: partnerText(locale, 'payout_sent.amount_label'), value: amount });
        if (reference) content.details.push({ label: partnerText(locale, 'payout_sent.reference_label'), value: reference });
        if (note) content.note = { label: partnerText(locale, 'payout_sent.note_label'), text: note };
        content.cta = cta(partnerText(locale, 'payout_sent.cta'), eventUrl(data.portalUrl, AFFILIATE_PORTAL_PAYOUTS_PATH, data));
        break;
      }
      const transferId = line(data.transferId, 255);
      const summary = amount
        ? partnerText(locale, 'payout_sent.line_amount', { amount })
        : partnerText(locale, 'payout_sent.line');
      content.subject = amount
        ? partnerText(locale, 'payout_sent.subject_amount', { amount })
        : partnerText(locale, 'payout_sent.subject');
      content.preheader = summary;
      content.heading = partnerText(locale, 'payout_sent.heading');
      content.paragraphs = [summary, partnerText(locale, 'payout_sent.timing')];
      if (amount) content.details.push({ label: partnerText(locale, 'payout_sent.amount_label'), value: amount });
      if (transferId) content.details.push({ label: partnerText(locale, 'payout_sent.transfer_label'), value: transferId });
      content.cta = cta(partnerText(locale, 'payout_sent.cta'), eventUrl(data.portalUrl, AFFILIATE_PORTAL_PAYOUTS_PATH, data));
      break;
    }
    case 'PAYPAL_UNCLAIMED': {
      // A PayPal payout waiting to be claimed (02037): PayPal emailed its claim link to the payout's
      // address; a new payout email in the portal changes the next payout.
      const email = line(data.payoutEmail, 254);
      const summary = !amount
        ? partnerText(locale, 'paypal_unclaimed.line_generic')
        : email
          ? partnerText(locale, 'paypal_unclaimed.line', { amount, email })
          : partnerText(locale, 'paypal_unclaimed.line_no_email', { amount });
      content.subject = amount
        ? partnerText(locale, 'paypal_unclaimed.subject', { amount })
        : partnerText(locale, 'paypal_unclaimed.subject_generic');
      content.preheader = summary;
      content.heading = partnerText(locale, 'paypal_unclaimed.heading');
      content.paragraphs = [summary, partnerText(locale, 'paypal_unclaimed.explain')];
      content.cta = cta(partnerText(locale, 'paypal_unclaimed.cta'), eventUrl(data.portalUrl, AFFILIATE_PORTAL_PAYOUTS_PATH, data));
      break;
    }
    case 'PAYPAL_PAYOUT_FAILED': {
      // PayPal will not pay the item (02037); its commissions are already back in the balance. The
      // reason is worded per locale from the run's code, never printed raw. A failure caused by the
      // address stops PayPal there until the partner saves their payout email again (the store pays by
      // hand meanwhile), so only the other failures promise a retry.
      const reason = partnerText(locale, affiliatePayPalFailureReasonKey(data.reason));
      const receiverFailure = isAffiliatePayPalReceiverFailureReason(data.reason);
      const summary = receiverFailure
        ? amount
          ? partnerText(locale, 'paypal_payout_failed.line_receiver', { amount, reason })
          : partnerText(locale, 'paypal_payout_failed.line_receiver_generic', { reason })
        : amount
          ? partnerText(locale, 'paypal_payout_failed.line', { amount, reason })
          : partnerText(locale, 'paypal_payout_failed.line_generic', { reason });
      content.subject = amount
        ? partnerText(locale, 'paypal_payout_failed.subject', { amount })
        : partnerText(locale, 'paypal_payout_failed.subject_generic');
      content.preheader = summary;
      content.heading = partnerText(locale, 'paypal_payout_failed.heading');
      content.paragraphs = [summary, partnerText(locale, 'paypal_payout_failed.balance')];
      content.cta = cta(partnerText(locale, 'paypal_payout_failed.cta'), eventUrl(data.portalUrl, AFFILIATE_PORTAL_PAYOUTS_PATH, data));
      break;
    }
    case 'PARTNER_SUSPENDED': {
      // The admin's reason, as the portal shows it ("Reason given: …"); plain text, escaped on render.
      const reason = cleanAffiliateEmailText(data.reason, { multiline: true, max: MAX_REASON });
      const live = data.storefrontLive === true;
      const summary = partnerText(locale, live ? 'partner_suspended.body' : 'partner_suspended.body_unpublished', {
        siteName: base.siteName,
      });
      content.subject = partnerText(locale, 'partner_suspended.subject', { siteName: base.siteName });
      content.preheader = summary;
      content.heading = partnerText(locale, 'partner_suspended.heading');
      content.paragraphs = live ? [summary, partnerText(locale, 'partner_suspended.balance')] : [summary];
      if (reason) content.note = { label: partnerText(locale, 'partner_suspended.reason_label'), text: reason };
      content.beforeCta = [partnerText(locale, 'partner_suspended.contact')];
      content.cta = cta(partnerText(locale, 'partner_suspended.cta'), eventUrl(data.portalUrl, AFFILIATE_PORTAL_PATH, data));
      break;
    }
    case 'PARTNER_REACTIVATED': {
      const live = data.storefrontLive === true;
      const summary = partnerText(locale, live ? 'partner_reactivated.body' : 'partner_reactivated.body_unpublished', {
        siteName: base.siteName,
      });
      content.subject = partnerText(locale, 'partner_reactivated.subject', { siteName: base.siteName });
      content.preheader = summary;
      content.heading = partnerText(locale, 'partner_reactivated.heading');
      content.paragraphs = live ? [summary, partnerText(locale, 'partner_reactivated.balance')] : [summary];
      content.cta = cta(partnerText(locale, 'partner_reactivated.cta'), eventUrl(data.portalUrl, AFFILIATE_PORTAL_PATH, data));
      break;
    }
    case 'TIER_CHANGED': {
      // The new tier (named in the partner's language by the caller) and its rate, then when that
      // rate applies: orders paid from the move on; recorded commissions keep theirs (02035).
      const tier = line(data.tierName, MAX_LABEL);
      const rate = formatAffiliateEmailRate(data.ratePercent, locale);
      const summary = tier
        ? partnerText(locale, 'tier_changed.body', { siteName: base.siteName, tier })
        : partnerText(locale, 'tier_changed.body_generic', { siteName: base.siteName });
      content.subject = partnerText(locale, 'tier_changed.subject', { siteName: base.siteName });
      content.preheader = summary;
      content.heading = partnerText(locale, 'tier_changed.heading');
      content.paragraphs = [summary];
      if (rate) content.paragraphs.push(partnerText(locale, 'tier_changed.rate', { rate }));
      content.paragraphs.push(partnerText(locale, 'tier_changed.applies'));
      content.cta = cta(partnerText(locale, 'tier_changed.cta'), eventUrl(data.portalUrl, AFFILIATE_PORTAL_PATH, data));
      break;
    }
  }
  return content;
}

/* ------------------------------------------------------------------------- admin emails --- */

function adminContent(event: AffiliateAdminLifecycleEvent, data: AffiliateEmailData): EmailContent {
  const siteName = siteNameOf(data, adminText('common.store_fallback'));
  const displayName = line(data.displayName, MAX_NAME);
  const handle = line(data.handle, 64);
  const name = displayName || (handle ? `@${handle}` : adminText('common.partner_fallback'));
  const amount = line(data.amountLabel, MAX_LABEL);
  const details: EmailDetail[] = [];
  if (displayName) details.push({ label: adminText('label.partner'), value: displayName });
  if (handle) details.push({ label: adminText('label.handle'), value: `@${handle}` });
  if (HANDLE_SHAPE.test(handle) && (event === 'PAGE_SUBMITTED' || event === 'SIGNED_UP')) {
    // The public address as a bare path, never a link and never a full URL (mail clients link
    // those): an admin's click would set the partner's referral cookie, and the admin's own
    // orders from that browser would then earn the partner a commission. The CMS review page
    // prints it the same way.
    details.push({ label: adminText('label.storefront'), value: `${AFFILIATE_PARTNERS_PATH}/${handle}` });
  }

  const content: EmailContent = {
    locale: 'en',
    subject: '',
    preheader: '',
    heading: '',
    greeting: null,
    paragraphs: [],
    details,
    note: null,
    beforeCta: [],
    cta: null,
    fallbackLabel: adminText('common.button_fallback'),
    afterCta: [],
    share: null,
    signature: null,
    footer: adminText('common.footer', { siteName }),
  };

  switch (event) {
    case 'SIGNED_UP': {
      const tier = line(data.tierName, MAX_LABEL);
      const spots = typeof data.spotsRemaining === 'number' && Number.isFinite(data.spotsRemaining)
        ? Math.max(0, Math.floor(data.spotsRemaining))
        : null;
      content.subject = adminText('signed_up.subject', { name });
      content.heading = adminText('signed_up.heading');
      content.paragraphs = [adminText('signed_up.body', { name })];
      if (tier) details.push({ label: adminText('label.tier'), value: tier });
      if (spots !== null) details.push({ label: adminText('label.spots'), value: String(spots) });
      if (spots === 0) content.paragraphs.push(adminText('signed_up.tier_full'));
      content.cta = cta(adminText('signed_up.cta'), eventUrl(data.cmsUrl, AFFILIATE_CMS_PATH, data));
      break;
    }
    case 'PROFILE_COMPLETED':
      content.subject = adminText('profile_completed.subject', { name });
      content.heading = adminText('profile_completed.heading');
      content.paragraphs = [adminText('profile_completed.body', { name })];
      content.cta = cta(adminText('profile_completed.cta'), eventUrl(data.cmsUrl, AFFILIATE_CMS_PATH, data));
      break;
    case 'PAYOUT_CONFIGURED':
      content.subject = adminText('payout_configured.subject', { name });
      content.heading = adminText('payout_configured.heading');
      content.paragraphs = [adminText('payout_configured.body', { name })];
      content.cta = cta(adminText('payout_configured.cta'), eventUrl(data.cmsUrl, AFFILIATE_CMS_PATH, data));
      break;
    case 'PAGE_SUBMITTED':
      content.subject = adminText('page_submitted.subject', { name });
      content.heading = adminText('page_submitted.heading');
      content.paragraphs = [adminText('page_submitted.body', { name })];
      content.cta = cta(adminText('page_submitted.cta'), eventUrl(data.cmsUrl, AFFILIATE_CMS_APPROVALS_PATH, data));
      break;
    case 'PAYOUT_FAILED': {
      const reason = line(data.reason, MAX_REASON);
      content.subject = adminText('payout_failed.subject', { name });
      content.heading = adminText('payout_failed.heading');
      content.paragraphs = [
        amount ? adminText('payout_failed.body_amount', { amount, name }) : adminText('payout_failed.body', { name }),
        // A PayPal payout (02037) has no Stripe balance or Connect account to check.
        adminText(data.payoutMethod === 'paypal' ? 'payout_failed.advice_paypal' : 'payout_failed.advice'),
      ];
      if (amount) details.push({ label: adminText('label.amount'), value: amount });
      if (reason) details.push({ label: adminText('label.reason'), value: reason });
      content.cta = cta(adminText('payout_failed.cta'), eventUrl(data.cmsUrl, AFFILIATE_CMS_PAYOUTS_PATH, data));
      break;
    }
    case 'REFUND_AFTER_PAYOUT': {
      const order = line(data.orderId, 128);
      const transferId = line(data.transferId, 255);
      // A payout recorded by hand (02036) has no Stripe transfer to reverse; one only prepared may not
      // have been sent yet (cancel and prepare it again). A PayPal payout (02037) still in flight is
      // settled by PayPal's answer; a completed one is recovered from the partner, like a manual one.
      const paypal = data.payoutMethod === 'paypal';
      const paypalInFlight = paypal && data.payoutPrepared === true;
      const manual = data.payoutMethod === 'manual' || (paypal && !paypalInFlight);
      const prepared = data.payoutMethod === 'manual' && data.payoutPrepared === true;
      content.subject = adminText('refund_after_payout.subject', { name });
      content.heading = adminText('refund_after_payout.heading');
      content.paragraphs = [
        order
          ? adminText(
              paypalInFlight
                ? 'refund_after_payout.body_order_paypal_in_flight'
                : prepared
                  ? 'refund_after_payout.body_order_manual_prepared'
                  : manual
                    ? 'refund_after_payout.body_order_manual'
                    : 'refund_after_payout.body_order',
              { order }
            )
          : adminText(
              paypalInFlight
                ? 'refund_after_payout.body_paypal_in_flight'
                : prepared
                  ? 'refund_after_payout.body_manual_prepared'
                  : manual
                    ? 'refund_after_payout.body_manual'
                    : 'refund_after_payout.body'
            ),
      ];
      if (order) details.push({ label: adminText('label.order'), value: order });
      if (amount) details.push({ label: adminText('label.amount'), value: amount });
      if (transferId) details.push({ label: adminText('label.transfer'), value: transferId });
      content.cta = cta(adminText('refund_after_payout.cta'), eventUrl(data.cmsUrl, AFFILIATE_CMS_PAYOUTS_PATH, data));
      break;
    }
  }
  content.preheader = content.paragraphs[0] ?? content.heading;
  return content;
}

/* ---------------------------------------------------------------------------- rendering --- */

function paragraphHtml(text: string, style = 'margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;'): string {
  // Outlook's Word engine does not inherit the cell's font: every paragraph names it.
  return `<p style="font-family:${FONT_STACK};${style}">${escapeAffiliateHtml(text)}</p>`;
}

function multilineHtml(text: string): string {
  return text
    .split('\n')
    .map((part) => escapeAffiliateHtml(part))
    .join('<br>');
}

function linkHtml(href: string, text: string, style: string): string {
  return `<a href="${escapeAffiliateHtml(href)}" target="_blank" rel="noopener noreferrer" style="${style}">${escapeAffiliateHtml(text)}</a>`;
}

function detailsHtml(details: readonly EmailDetail[]): string {
  if (details.length === 0) return '';
  const rows = details
    .map((detail) => {
      const href = detail.href ? affiliateEmailHref(detail.href) : null;
      const value = href
        ? linkHtml(href, detail.value, 'color:#4f46e5;text-decoration:underline;word-break:break-all;')
        : escapeAffiliateHtml(detail.value);
      return (
        '<tr>' +
        `<td style="padding:8px 12px 8px 0;border-top:1px solid #e2e8f0;font-family:${FONT_STACK};font-size:13px;line-height:1.5;color:#64748b;vertical-align:top;width:40%;">${escapeAffiliateHtml(detail.label)}</td>` +
        `<td style="padding:8px 0;border-top:1px solid #e2e8f0;font-family:${FONT_STACK};font-size:14px;line-height:1.5;color:#0f172a;vertical-align:top;word-break:break-word;">${value}</td>` +
        '</tr>'
      );
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 20px;">${rows}</table>`;
}

function noteHtml(note: EmailContent['note']): string {
  if (!note) return '';
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 20px;">' +
    `<tr><td style="padding:16px;background-color:#f8fafc;border-left:4px solid #6366f1;font-family:${FONT_STACK};">` +
    `<p style="margin:0 0 8px;font-size:12px;line-height:1.4;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#64748b;">${escapeAffiliateHtml(note.label)}</p>` +
    `<p style="margin:0;font-size:15px;line-height:1.6;color:#0f172a;">${multilineHtml(note.text)}</p>` +
    '</td></tr></table>'
  );
}

function ctaHtml(content: EmailContent): string {
  if (!content.cta) return '';
  const { label, url } = content.cta;
  const href = escapeAffiliateHtml(url);
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:8px 0 16px;">' +
    '<tr><td align="center" bgcolor="#4f46e5" style="border-radius:8px;background-color:#4f46e5;">' +
    `<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-family:${FONT_STACK};font-size:15px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeAffiliateHtml(label)}</a>` +
    '</td></tr></table>' +
    `<p style="margin:0 0 20px;font-family:${FONT_STACK};font-size:12px;line-height:1.5;color:#64748b;">${escapeAffiliateHtml(content.fallbackLabel)}<br>` +
    `${linkHtml(url, url, 'color:#4f46e5;text-decoration:underline;word-break:break-all;')}</p>`
  );
}

function shareHtml(share: EmailContent['share']): string {
  if (!share || share.links.length === 0) return '';
  const links = share.links
    .map((link) => linkHtml(link.url, link.label, 'color:#4f46e5;text-decoration:underline;'))
    .join(' &#183; ');
  return (
    `<p style="margin:24px 0 8px;font-family:${FONT_STACK};font-size:14px;line-height:1.5;font-weight:600;color:#0f172a;">${escapeAffiliateHtml(share.heading)}</p>` +
    `<p style="margin:0 0 20px;font-family:${FONT_STACK};font-size:14px;line-height:1.8;color:#334155;">${links}</p>`
  );
}

function renderHtml(content: EmailContent): string {
  const body = [
    `<h1 style="margin:0 0 16px;font-family:${FONT_STACK};font-size:22px;line-height:1.3;font-weight:700;color:#0f172a;">${escapeAffiliateHtml(content.heading)}</h1>`,
    content.greeting ? paragraphHtml(content.greeting) : '',
    ...content.paragraphs.map((paragraph) => paragraphHtml(paragraph)),
    noteHtml(content.note),
    detailsHtml(content.details),
    ...content.beforeCta.map((paragraph) => paragraphHtml(paragraph)),
    ctaHtml(content),
    ...content.afterCta.map((paragraph) => paragraphHtml(paragraph, 'margin:0 0 16px;font-size:14px;line-height:1.6;color:#475569;')),
    shareHtml(content.share),
    content.signature ? paragraphHtml(content.signature, 'margin:24px 0 0;font-size:15px;line-height:1.6;color:#334155;') : '',
  ].join('');

  return (
    `<div lang="${content.locale}" dir="ltr" style="margin:0;padding:0;background-color:#f1f5f9;">` +
    `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#f1f5f9;">${escapeAffiliateHtml(content.preheader)}</div>` +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background-color:#f1f5f9;">' +
    '<tr><td align="center" style="padding:24px 12px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;max-width:560px;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:12px;">' +
    `<tr><td style="padding:32px 32px 0;">${AFFILIATE_EMAIL_BRAND_HEADER_TOKEN}</td></tr>` +
    `<tr><td style="padding:0 32px;font-family:${FONT_STACK};color:#0f172a;">${body}</td></tr>` +
    `<tr><td style="padding:24px 32px 32px;font-family:${FONT_STACK};font-size:12px;line-height:1.5;color:#64748b;">${escapeAffiliateHtml(content.footer)}</td></tr>` +
    '</table>' +
    '</td></tr></table>' +
    '</div>'
  );
}

function renderText(content: EmailContent): string {
  const blocks: string[] = [content.heading];
  if (content.greeting) blocks.push(content.greeting);
  blocks.push(...content.paragraphs);
  if (content.note) blocks.push(`${labelled(content.locale, content.note.label, '').trimEnd()}\n${content.note.text}`);
  if (content.details.length > 0) {
    blocks.push(content.details.map((detail) => labelled(content.locale, detail.label, detail.value)).join('\n'));
  }
  blocks.push(...content.beforeCta);
  if (content.cta) blocks.push(labelled(content.locale, content.cta.label, content.cta.url));
  blocks.push(...content.afterCta);
  if (content.share && content.share.links.length > 0) {
    const links = content.share.links.map((link) => `- ${labelled(content.locale, link.label, link.url)}`).join('\n');
    blocks.push(`${labelled(content.locale, content.share.heading, '').trimEnd()}\n${links}`);
  }
  if (content.signature) blocks.push(content.signature);
  blocks.push(`--\n${content.footer}`);
  return `${blocks.filter((block) => block.trim() !== '').join('\n\n')}\n`;
}

function contentFor(event: AffiliateLifecycleEvent, data: AffiliateEmailData): EmailContent {
  if (PARTNER_EVENTS.has(event)) return partnerContent(event as AffiliateRetailerLifecycleEvent, data);
  if (ADMIN_EVENTS.has(event)) return adminContent(event as AffiliateAdminLifecycleEvent, data);
  throw new TypeError(`Unknown affiliate lifecycle event: ${String(event).slice(0, 40)}`);
}

/**
 * The email for one lifecycle event. Partner events use `data.locale` (`fr*` → Québec French);
 * admin events are always English. Throws only for an unknown event.
 */
export function buildAffiliateEmail(event: AffiliateLifecycleEvent, data: AffiliateEmailData): AffiliateEmailMessage {
  const content = contentFor(event, data ?? ({} as AffiliateEmailData));
  return {
    subject: toAffiliateEmailSubject(content.subject),
    text: renderText(content),
    html: renderHtml(content),
  };
}
