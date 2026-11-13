import 'server-only';

import {
  AFFILIATE_GATEWAYS,
  affiliateGatewaysPaidByPayPal,
  affiliateGatewaysPaidManually,
  isAffiliateManualPayoutChannel,
  isAffiliatePayPalPayoutReceiver,
  normalizeAffiliatePayoutEmailKind,
  type AffiliateGateway,
  type AffiliateManualPayoutChannel,
  type AffiliatePayoutEmailKind,
  type AffiliateStatus,
} from '@nextblock-cms/affiliates';
import {
  cancelManualAffiliatePayoutViaRpc,
  claimManualAffiliatePayoutViaRpc,
  normalizeAffiliateUuid,
  readAffiliateClaimableCommissionPage,
  recordManualAffiliatePayoutViaRpc,
  type AffiliateManualPayoutCancelResult,
  type AffiliateManualPayoutClaimResult,
  type AffiliateManualPayoutRecordResult,
  type AffiliateRepositoryClient,
} from '@nextblock-cms/affiliates/server';
import { getSiteSettings } from '../../app/lib/site-settings';
import { DEFAULT_SITE_TITLE } from '../../app/lib/seo';
import { requireCmsAdmin } from '../auth/cms-actor';
import { scheduleAffiliateLifecycleNotification } from './notify';
import { isAffiliatesProgramActive } from './package-state';
import {
  AFFILIATE_PAYPAL_PAYOUTS_MAX_ROWS,
  buildAffiliatePayPalPayoutsCsv,
  isAffiliatePayPalRecipientSafe,
  type AffiliatePayPalPayoutRow,
} from './paypal-payouts-csv';
import { isAffiliatePayPalPayoutCurrency } from './paypal/client';
import { loadAffiliatePayPalBlockedReceivers } from './paypal/engine';
import { readAffiliatesSettingsStrict } from './settings';

/**
 * Commissions paid outside Stripe (02036): the "Pay manually" section of /cms/affiliates/payouts.
 *
 * Since 02037 a gateway can also be paid with automatic PayPal Payouts (`lib/affiliates/paypal/`).
 * The partners PayPal cannot pay automatically (a payout email for Interac e-Transfer, none, one
 * PayPal cannot take, or one PayPal already returned a payout from) are paid by hand here for those
 * gateways too: their commissions join the queue, and a payout prepared for them reserves them.
 *
 * Freemius pays the operator, never the partners, and its money never reaches the Stripe balance,
 * so the program can route a gateway's commissions to "manual" (`affiliates_settings.payoutMethods`).
 * The operator then sends that money from PayPal, Interac e-Transfer, Wise or a bank; nothing in
 * this module moves money. A manual payout follows the Stripe path's order, so what is sent is
 * exactly what gets recorded: it is PREPARED first (`claim_manual_affiliate_payout` reserves the
 * commissions owed), the money is sent (the PayPal file lists the prepared payouts), then the payout
 * is RECORDED with its reference (`record_manual_affiliate_payout`) or CANCELLED if it was never sent
 * (`cancel_manual_affiliate_payout`). A refund or dispute that arrives in between is flagged on the
 * prepared payout and alerted; a commission that clears in between waits for the next payout.
 *
 * - {@link loadAffiliateManualPayoutQueue}: what is owed by hand and not prepared yet, per partner
 *   and currency, read with the claim's own rules (CLEARED, unattached, undisputed, live mode, the
 *   manual gateways), keyset-paged past PostgREST's 1000-row cap.
 * - {@link loadAffiliatePreparedManualPayouts}: the prepared payouts waiting to be recorded or
 *   cancelled, with their commissions and what changed since they were prepared.
 * - {@link prepareManualAffiliatePayoutNow} / {@link prepareManualAffiliatePayPalPayoutsNow}: the
 *   CMS "Prepare payout" (one partner) and "Prepare PayPal payouts" (every payable partner of a
 *   currency with a payout email who reaches the minimum).
 * - {@link recordManualAffiliatePayoutNow}: "Record payout", with the verified admin as
 *   `recorded_by` (never a value from the request); mails the partner (PAYOUT_SENT, manual wording).
 * - {@link cancelManualAffiliatePayoutNow}: "Cancel" a prepared payout that was never sent.
 * - {@link buildAffiliatePayPalPayoutsFileNow}: the PayPal Payouts upload file of the prepared
 *   payouts (ADMIN only; it only reads).
 *
 * Every write verifies the ADMIN itself (`requireCmsAdmin()`), refuses on the public sandbox (its demo
 * partner is shared), and refuses while the package is inactive.
 */

/** Commissions listed per row in the "Record payout" dialog (the rest are counted). */
export const AFFILIATE_MANUAL_PAYOUT_SAMPLE_LIMIT = 25;

/** Partners one "Prepare PayPal payouts" click prepares at most; a second click takes the rest. */
export const AFFILIATE_MANUAL_PAYOUT_PREPARE_BATCH = 250;

const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const ID_CHUNK = 100;

/** One commission of a row, as the dialogs list it. */
export interface AffiliateManualPayoutCommission {
  id: string;
  orderId: string | null;
  gateway: AffiliateGateway;
  /** Net of partial refunds, minor units of the row's currency. */
  amountCents: number;
  createdAt: string;
  /**
   * A prepared payout's commission that changed since it was prepared: `refunded` (a refund, a lost
   * dispute, a cancelled or deleted order: flagged, its alert raised) or `disputed` (an open dispute
   * holds it). Null otherwise, and always for what is owed and not prepared yet.
   */
  flag: 'refunded' | 'disputed' | null;
}

/** What one partner is owed by hand in one currency, not prepared yet. */
export interface AffiliateManualPayoutQueueRow {
  affiliateId: string;
  handle: string;
  displayName: string;
  /** Where the partner wants manual payouts sent, or null ("No payout email yet"). */
  payoutEmail: string | null;
  partnerStatus: AffiliateStatus;
  /** ACTIVE and approved: `claim_manual_affiliate_payout` prepares a payout (it refuses paused partners). */
  payable: boolean;
  preferredLocale: string;
  currency: string;
  /** What `claim_manual_affiliate_payout` would reserve now (minor units). */
  amountCents: number;
  commissionCount: number;
  /** The program's minimum payout is reached (a guide: an admin may prepare less). */
  reachesMinimum: boolean;
  /**
   * "Prepare PayPal payouts" would take it: payable, at the minimum, a PayPal payout email PayPal can
   * take as is (not one for Interac e-Transfer, not one PayPal returned a payout from).
   */
  paypalReady: boolean;
  /**
   * The gateways a payout prepared for this row reserves: the gateways paid by hand, plus (02037) the
   * gateways paid with PayPal when PayPal cannot pay this partner automatically.
   */
  claimGateways: AffiliateGateway[];
  /**
   * Why commissions the program pays with PayPal are listed here (02037): PayPal Payouts does not send
   * the row's currency, or the payout email is for Interac e-Transfer, missing, one PayPal cannot take,
   * or one PayPal returned a payout from (and the partner has not saved it since). Null when the row
   * holds only commissions paid by hand.
   */
  payPalFallback: 'currency' | 'interac' | 'no_email' | 'invalid_email' | 'returned' | null;
  /** The newest commissions (at most {@link AFFILIATE_MANUAL_PAYOUT_SAMPLE_LIMIT}). */
  commissions: AffiliateManualPayoutCommission[];
}

export interface AffiliateManualPayoutQueue {
  /** The gateways paid by hand (and, 02037, paid with PayPal for the partners it cannot pay); empty means nothing is read. */
  gateways: AffiliateGateway[];
  rows: AffiliateManualPayoutQueueRow[];
  /** Rows across every page. */
  total: number;
  /**
   * Per currency: what is owed by hand and to how many partners, and the part "Prepare PayPal
   * payouts" would prepare (payable partners with a payout email who reach the minimum).
   */
  totals: Array<{ currency: string; amountCents: number; partners: number; paypalAmountCents: number; paypalPartners: number }>;
  /** A read stopped at its page cap, so a figure may be low. */
  truncated: boolean;
}

/** A manual payout prepared (PROCESSING) and waiting to be recorded or cancelled. */
export interface AffiliatePreparedManualPayout {
  payoutId: string;
  affiliateId: string;
  handle: string;
  displayName: string;
  /** Where the partner wants manual payouts sent (read now), or null. */
  payoutEmail: string | null;
  partnerStatus: AffiliateStatus;
  /** The PayPal payouts file lists it: the partner is ACTIVE and their payout email can go in the file as is. */
  paypalReady: boolean;
  preferredLocale: string;
  currency: string;
  /** Fixed when it was prepared: exactly what to send and what "Record payout" records. */
  amountCents: number;
  commissionCount: number;
  preparedAt: string;
  /** Commissions a refund reached since it was prepared (the alert says what to do). */
  refundedCount: number;
  /** Commissions an open dispute holds since it was prepared. */
  disputedCount: number;
  /** Its commissions, flagged ones first, then the newest (at most {@link AFFILIATE_MANUAL_PAYOUT_SAMPLE_LIMIT}). */
  commissions: AffiliateManualPayoutCommission[];
}

export interface AffiliatePreparedManualPayouts {
  rows: AffiliatePreparedManualPayout[];
  /** Prepared payouts across every page. */
  total: number;
  /** Per currency: what the prepared payouts add up to, and the part the PayPal payouts file lists. */
  totals: Array<{ currency: string; amountCents: number; payouts: number; paypalAmountCents: number; paypalPayouts: number }>;
  truncated: boolean;
}

interface QueueOptions {
  gateways: readonly AffiliateGateway[];
  /**
   * The gateways paid with PayPal (02037): their commissions are listed for the partners PayPal
   * cannot pay automatically. Omitted or empty: none.
   */
  paypalGateways?: readonly AffiliateGateway[];
  minPayoutCents: number;
  /** 1-based page of rows; omit both to get every row. */
  page?: number;
  pageSize?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function currencyOf(value: unknown): string | null {
  const code = text(value).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function gatewayOf(value: unknown): AffiliateGateway {
  return value === 'FREEMIUS' ? 'FREEMIUS' : 'STRIPE';
}

/** A payout email PayPal's file can carry as typed (none that a spreadsheet would read as a formula). */
function payPalEmailOf(email: string | null): string | null {
  return email && isAffiliatePayPalRecipientSafe(email) ? email : null;
}

/**
 * Why automatic PayPal Payouts (02037) cannot pay a partner in a currency, or null when they can:
 * PayPal Payouts does not send the currency (the run skips it), or the payout email is for Interac
 * e-Transfer, missing, not one PayPal can take, or one PayPal returned a payout from.
 */
function payPalFallbackOf(
  profile: { payoutEmail: string | null; payoutEmailKind: AffiliatePayoutEmailKind },
  returned: boolean,
  currency: string
): AffiliateManualPayoutQueueRow['payPalFallback'] {
  if (!isAffiliatePayPalPayoutCurrency(currency)) return 'currency';
  if (!profile.payoutEmail) return 'no_email';
  if (profile.payoutEmailKind === 'interac') return 'interac';
  if (!isAffiliatePayPalPayoutReceiver(profile.payoutEmail, profile.payoutEmailKind)) return 'invalid_email';
  return returned ? 'returned' : null;
}

interface PartnerProfile {
  handle: string;
  displayName: string;
  payoutEmail: string | null;
  /** What the payout email is for (02037): a PayPal account, or Interac e-Transfer. */
  payoutEmailKind: AffiliatePayoutEmailKind;
  /** When the partner last saved the payout email (02037), or null: a save after a PayPal return lifts it. */
  payoutEmailSavedAt: string | null;
  status: AffiliateStatus;
  payable: boolean;
  preferredLocale: string;
}

/** The partners' names, payout emails and status, by id (100 ids per read). */
async function readPartnerProfiles(db: AffiliateRepositoryClient, affiliateIds: readonly string[]): Promise<Map<string, PartnerProfile>> {
  const ids = [...new Set(affiliateIds)];
  const profiles = new Map<string, PartnerProfile>();
  for (let index = 0; index < ids.length; index += ID_CHUNK) {
    const { data, error } = await db
      .from('affiliate_profiles')
      .select('id, handle, display_name, payout_email, payout_email_kind, payout_email_saved_at, status, first_published_at, preferred_locale')
      .in('id', ids.slice(index, index + ID_CHUNK));
    if (error) throw new Error('Could not read partner profiles.', { cause: error });
    for (const row of Array.isArray(data) ? data : []) {
      const record = asRecord(row);
      const id = normalizeAffiliateUuid(text(record['id']));
      if (!id) continue;
      const status: AffiliateStatus = record['status'] === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED';
      const email = text(record['payout_email']).trim();
      profiles.set(id, {
        handle: text(record['handle']),
        displayName: text(record['display_name']),
        payoutEmail: email || null,
        payoutEmailKind: normalizeAffiliatePayoutEmailKind(record['payout_email_kind']),
        payoutEmailSavedAt: text(record['payout_email_saved_at']) || null,
        status,
        payable: status === 'ACTIVE' && Boolean(record['first_published_at']),
        preferredLocale: record['preferred_locale'] === 'fr' ? 'fr' : 'en',
      });
    }
  }
  return profiles;
}

function sliceRows<T>(rows: T[], page: number | undefined, pageSize: number | undefined): T[] {
  if (page === undefined || pageSize === undefined) return rows;
  const size = Math.max(1, Math.trunc(pageSize));
  const start = (Math.max(1, Math.trunc(page)) - 1) * size;
  return rows.slice(start, start + size);
}

/**
 * Every partner owed commissions the program pays by hand and not prepared yet, per currency,
 * sorted payable first, then those reaching the minimum, then by amount (largest first) and handle;
 * `page` / `pageSize` slice the rows. The commissions are read with the claim's own rules, keyset by
 * id (a commission cleared, claimed or released between two page reads shifts no other one, and a
 * commission seen twice is counted once). Pass the service-role client after `requireCmsAdmin()`.
 * Throws an `Error` with the PostgREST error as `cause` when a read fails; nothing is written.
 */
export async function loadAffiliateManualPayoutQueue(
  db: AffiliateRepositoryClient,
  options: QueueOptions
): Promise<AffiliateManualPayoutQueue> {
  const manualGateways = AFFILIATE_GATEWAYS.filter((gateway) => options.gateways.includes(gateway));
  // 02037: the PayPal gateways' commissions, kept below only for the partners PayPal cannot pay.
  const paypalGateways = AFFILIATE_GATEWAYS.filter(
    (gateway) => (options.paypalGateways ?? []).includes(gateway) && !manualGateways.includes(gateway)
  );
  const gateways = AFFILIATE_GATEWAYS.filter((gateway) => manualGateways.includes(gateway) || paypalGateways.includes(gateway));
  const empty: AffiliateManualPayoutQueue = { gateways, rows: [], total: 0, totals: [], truncated: false };
  if (gateways.length === 0) return empty;

  type Group = { affiliateId: string; currency: string; amountCents: number; commissions: AffiliateManualPayoutCommission[] };
  const groups = new Map<string, Group>();
  const seen = new Set<string>();
  let truncated = false;
  let afterId: string | null = null;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    // The claim's own query (obligations.ts), live mode only and the manual gateways: exactly what
    // claim_manual_affiliate_payout reserves.
    const { rows, error } = await readAffiliateClaimableCommissionPage(db, {
      livemode: true,
      columns: 'id, affiliate_id, order_id, gateway, currency, commission_amount_cents, refunded_amount_cents, created_at',
      gateways,
      from: 0,
      to: PAGE_SIZE - 1,
      afterId,
    });
    if (error) throw new Error('Could not read the commissions paid by hand.', { cause: error });
    for (const row of rows) {
      const id = text(row['id']);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const affiliateId = normalizeAffiliateUuid(text(row['affiliate_id']));
      const currency = currencyOf(row['currency']);
      const net = Math.trunc(Number(row['commission_amount_cents']) - Number(row['refunded_amount_cents'] ?? 0));
      if (!affiliateId || !currency || !Number.isFinite(net) || net <= 0) continue;
      const key = `${affiliateId}|${currency}`;
      const group = groups.get(key) ?? { affiliateId, currency, amountCents: 0, commissions: [] };
      group.amountCents += net;
      group.commissions.push({
        id,
        orderId: normalizeAffiliateUuid(text(row['order_id'])),
        gateway: gatewayOf(row['gateway']),
        amountCents: net,
        createdAt: text(row['created_at']),
        flag: null,
      });
      groups.set(key, group);
    }
    const last = rows.length > 0 ? text(rows[rows.length - 1]?.['id']) : '';
    if (rows.length < PAGE_SIZE || !last) break;
    afterId = last;
  }
  if (groups.size === 0) return { ...empty, truncated };

  const profiles = await readPartnerProfiles(db, [...groups.values()].map((group) => group.affiliateId));
  // 02037: partners whose last PayPal payout came back from the payout email they still have (and
  // have not saved again since).
  const returned =
    paypalGateways.length > 0
      ? await loadAffiliatePayPalBlockedReceivers(
          db,
          [...profiles.entries()].map(([affiliateId, profile]) => ({
            affiliateId,
            email: profile.payoutEmail,
            emailSavedAt: profile.payoutEmailSavedAt,
          }))
        )
      : new Set<string>();
  const minimum = Math.max(0, Math.trunc(Number(options.minPayoutCents) || 0));
  const all: AffiliateManualPayoutQueueRow[] = [];
  for (const group of groups.values()) {
    const profile = profiles.get(group.affiliateId);
    if (!profile) continue;
    const fallback = payPalFallbackOf(profile, returned.has(group.affiliateId), group.currency);
    // Commissions of a PayPal gateway stay only for a partner PayPal cannot pay automatically.
    const commissions =
      paypalGateways.length > 0 && fallback === null
        ? group.commissions.filter((commission) => !paypalGateways.includes(commission.gateway))
        : group.commissions;
    if (commissions.length === 0) continue;
    const amountCents = commissions.reduce((sum, commission) => sum + commission.amountCents, 0);
    const newest = [...commissions].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const reachesMinimum = amountCents >= minimum;
    const holdsPayPalCommissions = commissions.some((commission) => paypalGateways.includes(commission.gateway));
    all.push({
      affiliateId: group.affiliateId,
      handle: profile.handle,
      displayName: profile.displayName,
      payoutEmail: profile.payoutEmail,
      partnerStatus: profile.status,
      payable: profile.payable,
      preferredLocale: profile.preferredLocale,
      currency: group.currency,
      amountCents,
      commissionCount: commissions.length,
      reachesMinimum,
      paypalReady:
        profile.payable &&
        reachesMinimum &&
        profile.payoutEmailKind === 'paypal' &&
        !returned.has(group.affiliateId) &&
        payPalEmailOf(profile.payoutEmail) !== null,
      claimGateways: fallback === null ? manualGateways : gateways,
      payPalFallback: holdsPayPalCommissions ? fallback : null,
      commissions: newest.slice(0, AFFILIATE_MANUAL_PAYOUT_SAMPLE_LIMIT),
    });
  }
  all.sort(
    (a, b) =>
      Number(b.payable) - Number(a.payable) ||
      Number(b.reachesMinimum) - Number(a.reachesMinimum) ||
      b.amountCents - a.amountCents ||
      a.handle.localeCompare(b.handle) ||
      a.currency.localeCompare(b.currency)
  );

  const totalsByCurrency = new Map<string, AffiliateManualPayoutQueue['totals'][number]>();
  for (const row of all) {
    const entry = totalsByCurrency.get(row.currency) ?? {
      currency: row.currency,
      amountCents: 0,
      partners: 0,
      paypalAmountCents: 0,
      paypalPartners: 0,
    };
    entry.amountCents += row.amountCents;
    entry.partners += 1;
    if (row.paypalReady) {
      entry.paypalAmountCents += row.amountCents;
      entry.paypalPartners += 1;
    }
    totalsByCurrency.set(row.currency, entry);
  }

  return {
    gateways,
    rows: sliceRows(all, options.page, options.pageSize),
    total: all.length,
    totals: [...totalsByCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    truncated,
  };
}

/** A commission's flag on a prepared payout (see {@link AffiliateManualPayoutCommission.flag}). */
function preparedFlagOf(row: Record<string, unknown>): AffiliateManualPayoutCommission['flag'] {
  const refundPending = Number(row['refund_pending_cents']) || 0;
  const refunded = Number(row['refunded_amount_cents']) || 0;
  if (row['void_requested_at'] || refundPending > refunded || row['status'] === 'VOIDED_REFUND') return 'refunded';
  if (row['disputed_at']) return 'disputed';
  return null;
}

/**
 * Every manual payout prepared and not recorded yet (PROCESSING, method manual), with its partner,
 * its commissions and what a refund or a dispute changed since it was prepared; sorted by currency,
 * then partners with a flag first, then handle. `page` / `pageSize` slice the rows; the totals cover
 * every page. Payouts and commissions are read keyset by id past PostgREST's 1000-row cap (a payout
 * is never listed twice: the PayPal file pays what this returns). Pass the service-role client after
 * `requireCmsAdmin()`. Throws an `Error` with the PostgREST error as `cause` when a read fails.
 */
export async function loadAffiliatePreparedManualPayouts(
  db: AffiliateRepositoryClient,
  options: { page?: number; pageSize?: number } = {}
): Promise<AffiliatePreparedManualPayouts> {
  type Prepared = { payoutId: string; affiliateId: string; currency: string; amountCents: number; preparedAt: string };
  const payouts = new Map<string, Prepared>();
  let truncated = false;
  let afterId: string | null = null;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    let query = db
      .from('affiliate_payouts')
      .select('id, affiliate_id, amount_cents, currency, created_at')
      .eq('method', 'manual')
      .eq('status', 'PROCESSING');
    if (afterId) query = query.gt('id', afterId);
    const { data, error } = await query.order('id', { ascending: true }).limit(PAGE_SIZE);
    if (error) throw new Error('Could not read the prepared manual payouts.', { cause: error });
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    for (const row of rows) {
      const payoutId = normalizeAffiliateUuid(text(row['id']));
      const affiliateId = normalizeAffiliateUuid(text(row['affiliate_id']));
      const currency = currencyOf(row['currency']);
      const amountCents = Math.trunc(Number(row['amount_cents']));
      if (!payoutId || !affiliateId || !currency || !Number.isFinite(amountCents) || amountCents <= 0) continue;
      payouts.set(payoutId, { payoutId, affiliateId, currency, amountCents, preparedAt: text(row['created_at']) });
    }
    const last = rows.length > 0 ? text(rows[rows.length - 1]?.['id']) : '';
    if (rows.length < PAGE_SIZE || !last) break;
    afterId = last;
  }
  if (payouts.size === 0) return { rows: [], total: 0, totals: [], truncated };

  // Their commissions, 100 payouts per read, keyset by id within each read.
  const commissions = new Map<string, AffiliateManualPayoutCommission[]>();
  const seen = new Set<string>();
  const payoutIds = [...payouts.keys()];
  for (let index = 0; index < payoutIds.length; index += ID_CHUNK) {
    const chunk = payoutIds.slice(index, index + ID_CHUNK);
    let after: string | null = null;
    for (let page = 0; ; page += 1) {
      if (page >= MAX_PAGES) {
        truncated = true;
        break;
      }
      let query = db
        .from('affiliate_commissions')
        .select(
          'id, payout_id, order_id, gateway, status, commission_amount_cents, refunded_amount_cents, refund_pending_cents, void_requested_at, disputed_at, created_at'
        )
        .in('payout_id', chunk);
      if (after) query = query.gt('id', after);
      const { data, error } = await query.order('id', { ascending: true }).limit(PAGE_SIZE);
      if (error) throw new Error('Could not read the commissions of the prepared payouts.', { cause: error });
      const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
      for (const row of rows) {
        const id = text(row['id']);
        const payoutId = normalizeAffiliateUuid(text(row['payout_id']));
        if (!id || !payoutId || seen.has(id)) continue;
        seen.add(id);
        const net = Math.max(0, Math.trunc(Number(row['commission_amount_cents']) - Number(row['refunded_amount_cents'] ?? 0)) || 0);
        const list = commissions.get(payoutId) ?? [];
        list.push({
          id,
          orderId: normalizeAffiliateUuid(text(row['order_id'])),
          gateway: gatewayOf(row['gateway']),
          amountCents: net,
          createdAt: text(row['created_at']),
          flag: preparedFlagOf(row),
        });
        commissions.set(payoutId, list);
      }
      const last = rows.length > 0 ? text(rows[rows.length - 1]?.['id']) : '';
      if (rows.length < PAGE_SIZE || !last) break;
      after = last;
    }
  }

  const profiles = await readPartnerProfiles(db, [...payouts.values()].map((payout) => payout.affiliateId));
  const all: AffiliatePreparedManualPayout[] = [];
  for (const payout of payouts.values()) {
    const profile = profiles.get(payout.affiliateId);
    if (!profile) continue;
    const list = commissions.get(payout.payoutId) ?? [];
    const flagged = (entry: AffiliateManualPayoutCommission) => (entry.flag ? 0 : 1);
    const ordered = [...list].sort((a, b) => flagged(a) - flagged(b) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    all.push({
      payoutId: payout.payoutId,
      affiliateId: payout.affiliateId,
      handle: profile.handle,
      displayName: profile.displayName,
      payoutEmail: profile.payoutEmail,
      partnerStatus: profile.status,
      paypalReady: profile.status === 'ACTIVE' && profile.payoutEmailKind === 'paypal' && payPalEmailOf(profile.payoutEmail) !== null,
      preferredLocale: profile.preferredLocale,
      currency: payout.currency,
      amountCents: payout.amountCents,
      commissionCount: list.length,
      preparedAt: payout.preparedAt,
      refundedCount: list.filter((entry) => entry.flag === 'refunded').length,
      disputedCount: list.filter((entry) => entry.flag === 'disputed').length,
      commissions: ordered.slice(0, AFFILIATE_MANUAL_PAYOUT_SAMPLE_LIMIT),
    });
  }
  all.sort(
    (a, b) =>
      a.currency.localeCompare(b.currency) ||
      Number(b.refundedCount + b.disputedCount > 0) - Number(a.refundedCount + a.disputedCount > 0) ||
      a.handle.localeCompare(b.handle)
  );

  const totalsByCurrency = new Map<string, AffiliatePreparedManualPayouts['totals'][number]>();
  for (const row of all) {
    const entry = totalsByCurrency.get(row.currency) ?? { currency: row.currency, amountCents: 0, payouts: 0, paypalAmountCents: 0, paypalPayouts: 0 };
    entry.amountCents += row.amountCents;
    entry.payouts += 1;
    if (row.paypalReady) {
      entry.paypalAmountCents += row.amountCents;
      entry.paypalPayouts += 1;
    }
    totalsByCurrency.set(row.currency, entry);
  }

  return {
    rows: sliceRows(all, options.page, options.pageSize),
    total: all.length,
    totals: [...totalsByCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    truncated,
  };
}

/* ---------------------------------------------------------- prepare, record, cancel --- */

function isAffiliatesSandbox(): boolean {
  return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
}

/** Why a manual payout write never reached the database. */
export type ManualAffiliatePayoutRefusal = 'forbidden' | 'sandbox' | 'package_inactive' | 'settings_unavailable' | 'not_manual' | 'unknown';

type ManualPayoutWriter = { ok: true; db: AffiliateRepositoryClient; userId: string } | { ok: false; status: ManualAffiliatePayoutRefusal };

/**
 * What every manual payout write checks first: the ADMIN (`requireCmsAdmin()`: session, second
 * factor, role, whatever the caller did), then the public sandbox (its demo partner is shared by
 * every visitor: nothing is prepared, recorded or cancelled there), then the package.
 */
async function authorizeManualPayoutWrite(): Promise<ManualPayoutWriter> {
  let db: AffiliateRepositoryClient;
  let userId: string;
  try {
    const actor = await requireCmsAdmin();
    db = actor.supabase as unknown as AffiliateRepositoryClient;
    userId = actor.userId;
  } catch {
    return { ok: false, status: 'forbidden' };
  }
  if (isAffiliatesSandbox()) return { ok: false, status: 'sandbox' };
  try {
    if (!(await isAffiliatesProgramActive())) return { ok: false, status: 'package_inactive' };
  } catch {
    return { ok: false, status: 'package_inactive' };
  }
  return { ok: true, db, userId };
}

/**
 * The gateways paid by hand, the gateways paid with PayPal (02037: paid by hand for the partners
 * PayPal cannot pay) and the minimum, read strictly from the settings (never from the request).
 * `not_manual` when neither list has a gateway.
 */
async function readManualRouting(): Promise<
  | { ok: true; gateways: AffiliateGateway[]; paypalGateways: AffiliateGateway[]; minPayoutCents: number }
  | { ok: false; status: 'settings_unavailable' | 'not_manual' }
> {
  const settings = await readAffiliatesSettingsStrict();
  if (!settings) return { ok: false, status: 'settings_unavailable' };
  const gateways = affiliateGatewaysPaidManually(settings);
  const paypalGateways = affiliateGatewaysPaidByPayPal(settings);
  if (gateways.length === 0 && paypalGateways.length === 0) return { ok: false, status: 'not_manual' };
  return { ok: true, gateways, paypalGateways, minPayoutCents: settings.minPayoutCents };
}

/**
 * The gateways a manual payout for one partner and currency reserves: the gateways paid by hand, plus
 * the PayPal gateways when PayPal cannot pay that partner automatically in that currency (02037).
 * Throws when a read fails.
 */
async function manualClaimGatewaysFor(
  db: AffiliateRepositoryClient,
  affiliateId: string,
  currency: string,
  routing: { gateways: AffiliateGateway[]; paypalGateways: AffiliateGateway[] }
): Promise<AffiliateGateway[]> {
  if (routing.paypalGateways.length === 0) return routing.gateways;
  const profile = (await readPartnerProfiles(db, [affiliateId])).get(affiliateId);
  if (!profile) return routing.gateways;
  const returned = await loadAffiliatePayPalBlockedReceivers(db, [
    { affiliateId, email: profile.payoutEmail, emailSavedAt: profile.payoutEmailSavedAt },
  ]);
  if (payPalFallbackOf(profile, returned.has(affiliateId), currency) === null) return routing.gateways;
  return AFFILIATE_GATEWAYS.filter((gateway) => routing.gateways.includes(gateway) || routing.paypalGateways.includes(gateway));
}

function logRpcFailure(what: string, error: unknown): void {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code ?? null : null;
  console.error(`[affiliates] ${what} failed`, { code });
}

function currencyInput(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export interface PrepareManualAffiliatePayoutInput {
  affiliateIdToPay: string;
  currency: string;
}

/** The claim's answer (`claim_manual_affiliate_payout`), or why it never reached the database. */
export type PrepareManualAffiliatePayoutOutcome =
  | (AffiliateManualPayoutClaimResult & { currency?: string })
  | { status: ManualAffiliatePayoutRefusal };

/**
 * "Prepare payout" (one partner and currency): `claim_manual_affiliate_payout` with no minimum (the
 * admin picked this partner) and the manual gateways from the settings. It reserves what is owed
 * now; the admin sends exactly that afterwards. Refused on the sandbox, while the package is
 * inactive, while the settings cannot be read and when no gateway is paid by hand (`not_manual`).
 * Never throws.
 */
export async function prepareManualAffiliatePayoutNow(input: PrepareManualAffiliatePayoutInput): Promise<PrepareManualAffiliatePayoutOutcome> {
  const auth = await authorizeManualPayoutWrite();
  if (!auth.ok) return { status: auth.status };
  const routing = await readManualRouting();
  if (!routing.ok) return { status: routing.status };
  const affiliateId = normalizeAffiliateUuid(input.affiliateIdToPay);
  const currency = currencyInput(input.currency);
  if (!affiliateId || !/^[A-Z]{3}$/.test(currency)) return { status: 'invalid_input' };
  try {
    const gateways = await manualClaimGatewaysFor(auth.db, affiliateId, currency, routing);
    if (gateways.length === 0) return { status: 'not_manual' };
    const result = await claimManualAffiliatePayoutViaRpc(auth.db, { affiliateId, currency, minAmountCents: 0, gateways });
    return { ...result, currency };
  } catch (error) {
    logRpcFailure('Preparing a manual payout', error);
    return { status: 'unknown' };
  }
}

export type PrepareManualAffiliatePayPalPayoutsOutcome =
  | {
      status: 'done';
      currency: string;
      /** Payouts prepared by this call, and what they add up to. */
      prepared: number;
      preparedAmountCents: number;
      /** Partners whose claim was refused meanwhile (paused, a refund took them under the minimum, …). */
      skipped: number;
      /** Partners left for another click (at most {@link AFFILIATE_MANUAL_PAYOUT_PREPARE_BATCH} per call). */
      remaining: number;
    }
  | { status: 'invalid_input' | 'nothing_to_prepare' }
  | { status: ManualAffiliatePayoutRefusal };

/**
 * "Prepare PayPal payouts" (one currency): a manual payout for every partner the list marks
 * PayPal-ready (payable, a payout email PayPal takes as is, at the program minimum), each claimed
 * with that minimum so a refund since the list was read never prepares a payout below it; at most
 * {@link AFFILIATE_MANUAL_PAYOUT_PREPARE_BATCH} per call. Same refusals as
 * {@link prepareManualAffiliatePayoutNow}. Never throws.
 */
export async function prepareManualAffiliatePayPalPayoutsNow(input: { currency: string }): Promise<PrepareManualAffiliatePayPalPayoutsOutcome> {
  const auth = await authorizeManualPayoutWrite();
  if (!auth.ok) return { status: auth.status };
  const routing = await readManualRouting();
  if (!routing.ok) return { status: routing.status };
  const currency = currencyInput(input.currency);
  if (!/^[A-Z]{3}$/.test(currency)) return { status: 'invalid_input' };

  let candidates: AffiliateManualPayoutQueueRow[];
  try {
    const queue = await loadAffiliateManualPayoutQueue(auth.db, {
      gateways: routing.gateways,
      paypalGateways: routing.paypalGateways,
      minPayoutCents: routing.minPayoutCents,
    });
    candidates = queue.rows.filter((row) => row.currency === currency && row.paypalReady);
  } catch (error) {
    const cause = error && typeof error === 'object' ? asRecord((error as { cause?: unknown }).cause) : {};
    console.error('[affiliates] The commissions paid by hand could not be read', { code: cause['code'] ?? null });
    return { status: 'unknown' };
  }
  if (candidates.length === 0) return { status: 'nothing_to_prepare' };

  const batch = candidates.slice(0, AFFILIATE_MANUAL_PAYOUT_PREPARE_BATCH);
  let prepared = 0;
  let preparedAmountCents = 0;
  let skipped = 0;
  for (const row of batch) {
    try {
      const result = await claimManualAffiliatePayoutViaRpc(auth.db, {
        affiliateId: row.affiliateId,
        currency,
        minAmountCents: routing.minPayoutCents,
        gateways: row.claimGateways,
      });
      if (result.status === 'prepared') {
        prepared += 1;
        preparedAmountCents += result.amountCents;
      } else {
        skipped += 1;
      }
    } catch (error) {
      logRpcFailure('Preparing a manual payout', error);
      skipped += 1;
    }
  }
  return { status: 'done', currency, prepared, preparedAmountCents, skipped, remaining: candidates.length - batch.length };
}

export interface RecordManualAffiliatePayoutInput {
  /** The prepared payout whose money left. */
  payoutIdToRecord: string;
  channel: AffiliateManualPayoutChannel;
  reference: string;
  note?: string | null;
}

/** The record's answer (`record_manual_affiliate_payout`), or why it never reached the database. */
export type RecordManualAffiliatePayoutOutcome = AffiliateManualPayoutRecordResult | { status: ManualAffiliatePayoutRefusal };

/**
 * "Record payout": the money of a prepared payout left (PayPal, Interac e-Transfer, Wise, a bank).
 * Verifies the ADMIN itself and passes that admin as `p_recorded_by` (the input names only the
 * payout, the channel, the reference and the note). Refused on the sandbox and while the package
 * is inactive. It reads no settings: a payout prepared before its gateway went back to Stripe
 * Connect is still recorded (or cancelled) here. On `recorded`, schedules the partner's
 * PAYOUT_SENT email (manual wording; the sandbox mails nobody anyway). Never throws.
 */
export async function recordManualAffiliatePayoutNow(input: RecordManualAffiliatePayoutInput): Promise<RecordManualAffiliatePayoutOutcome> {
  const auth = await authorizeManualPayoutWrite();
  if (!auth.ok) return { status: auth.status };
  const payoutId = normalizeAffiliateUuid(input.payoutIdToRecord);
  if (!payoutId || !isAffiliateManualPayoutChannel(input.channel)) return { status: 'invalid_input' };
  const reference = typeof input.reference === 'string' ? input.reference.trim() : '';
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;

  let result: AffiliateManualPayoutRecordResult;
  try {
    result = await recordManualAffiliatePayoutViaRpc(auth.db, { payoutId, channel: input.channel, reference, note, recordedBy: auth.userId });
  } catch (error) {
    logRpcFailure('Recording a manual payout', error);
    return { status: 'unknown' };
  }

  if (result.status === 'recorded') {
    scheduleAffiliateLifecycleNotification('PAYOUT_SENT', {
      affiliateId: result.affiliateId,
      payout: {
        payoutId: result.payoutId,
        amountCents: result.amountCents,
        currency: result.currency,
        method: 'manual',
        channel: input.channel,
        reference,
        note,
      },
    });
  }
  return result;
}

/** The cancel's answer (`cancel_manual_affiliate_payout`), or why it never reached the database. */
export type CancelManualAffiliatePayoutOutcome =
  | AffiliateManualPayoutCancelResult
  | { status: 'invalid_input' }
  | { status: ManualAffiliatePayoutRefusal };

/**
 * "Cancel" a prepared payout that was never sent: a refund flagged since it was prepared is applied,
 * its other commissions go back to what is owed and the payout row is deleted. Same refusals as the
 * record. Never throws.
 */
export async function cancelManualAffiliatePayoutNow(input: { payoutIdToCancel: string }): Promise<CancelManualAffiliatePayoutOutcome> {
  const auth = await authorizeManualPayoutWrite();
  if (!auth.ok) return { status: auth.status };
  const payoutId = normalizeAffiliateUuid(input.payoutIdToCancel);
  if (!payoutId) return { status: 'invalid_input' };
  try {
    return await cancelManualAffiliatePayoutViaRpc(auth.db, payoutId);
  } catch (error) {
    logRpcFailure('Cancelling a manual payout', error);
    return { status: 'unknown' };
  }
}

/* ----------------------------------------------------------------- PayPal file --- */

async function resolveSiteName(): Promise<string> {
  try {
    const settings = await getSiteSettings();
    return settings?.siteTitle?.trim() || DEFAULT_SITE_TITLE;
  } catch {
    return DEFAULT_SITE_TITLE;
  }
}

export type AffiliatePayPalPayoutsFile =
  | { ok: true; csv: string; count: number; truncated: boolean; filename: string }
  | { ok: false; status: 400 | 403 | 404 | 409 | 500; error: string };

/**
 * The PayPal Payouts upload file for one currency (paypal-payouts-csv.ts has the format): every
 * PREPARED manual payout in that currency whose partner is ACTIVE and has a payout email PayPal takes
 * as is, at the amount prepared, so what PayPal sends is exactly what "Record payout" records. ADMIN
 * only (verified here, whatever the caller did); refused while the package is inactive. It only
 * reads: the payouts are prepared with "Prepare PayPal payouts" first. Never throws.
 */
export async function buildAffiliatePayPalPayoutsFileNow(currencyValue: string, now: Date = new Date()): Promise<AffiliatePayPalPayoutsFile> {
  let db: AffiliateRepositoryClient;
  try {
    const { supabase } = await requireCmsAdmin();
    db = supabase as unknown as AffiliateRepositoryClient;
  } catch {
    return { ok: false, status: 403, error: 'Only administrators can download the payouts file.' };
  }
  const currency = currencyInput(currencyValue);
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, status: 400, error: 'Choose a currency.' };
  try {
    if (!(await isAffiliatesProgramActive())) return { ok: false, status: 404, error: 'The affiliate program is not active.' };
  } catch {
    return { ok: false, status: 404, error: 'The affiliate program is not active.' };
  }

  try {
    const prepared = await loadAffiliatePreparedManualPayouts(db);
    const rows: AffiliatePayPalPayoutRow[] = prepared.rows
      .filter((row) => row.currency === currency && row.paypalReady && row.payoutEmail)
      .map((row) => ({
        email: row.payoutEmail as string,
        amountCents: row.amountCents,
        commissionCount: row.commissionCount,
        handle: row.handle,
        locale: row.preferredLocale,
      }));
    if (rows.length === 0) {
      return {
        ok: false,
        status: 409,
        error: `No prepared payout in ${currency} goes to a payout email PayPal can take. Prepare the PayPal payouts first.`,
      };
    }
    const file = buildAffiliatePayPalPayoutsCsv(rows, { currency, siteName: await resolveSiteName() });
    if (file.skipped.length > 0) {
      console.warn('[affiliates] Payouts left out of the PayPal file (unsafe recipient)', { count: file.skipped.length });
    }
    return {
      ok: true,
      csv: file.csv,
      count: file.count,
      truncated: file.truncated || rows.length > AFFILIATE_PAYPAL_PAYOUTS_MAX_ROWS,
      filename: `paypal-payouts-${currency.toLowerCase()}-${now.toISOString().slice(0, 10)}.csv`,
    };
  } catch (error) {
    const cause = error && typeof error === 'object' ? asRecord((error as { cause?: unknown }).cause) : {};
    console.error('[affiliates] The PayPal payouts file could not be built', { code: cause['code'] ?? null });
    return { ok: false, status: 500, error: 'The payouts file could not be built. Try again in a moment.' };
  }
}
