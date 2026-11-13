/**
 * What the platform owes its partners, per currency, in one Stripe key mode: the "Balance vs what
 * you owe" card of /cms/affiliates/stripe. Reads only. Pass the service-role client after the
 * caller authorized an ADMIN (the affiliate tables are service-role reads); every read is paged
 * past PostgREST's 1000-row cap.
 *
 * - **owed now**: CLEARED commissions no payout holds and no dispute holds, net of refunds, of
 *   every partner, read through the daily cycle's own query
 *   ({@link readAffiliateClaimableCommissionPage}) and split by the gateway of the sale (Freemius
 *   sales never add money to the Stripe balance). The next run pays only part of it: partners who
 *   are ACTIVE, approved and onboarded to Stripe, at or above the minimum payout, while the
 *   balance covers them (`claim_affiliate_payout` refuses the rest).
 * - **in flight**: PROCESSING payouts. Their transfer reached Stripe or is being sent, so their
 *   money has normally left the balance already.
 * - **waiting to retry**: FAILED payouts the daily cycle retries by itself
 *   (`isAffiliatePayoutAutoRetryable`: a transient reason, attempts left, payouts running, the
 *   partner payable).
 * - **needs an admin**: the other FAILED payouts that still hold their commissions (not released,
 *   emptied or handed back below the minimum): a Retry, or a Release and the next claim, will need
 *   the money too.
 * - **clearing soon**: PENDING_CLEARANCE commissions, not disputed, whose hold ends within the
 *   window (30 days by default).
 * - **last 30 days**: commissions recorded over the last 30 days and not voided, net of refunds:
 *   the "month of commissions" a Stripe minimum balance should cover.
 * - **owed manually** (02036): what "owed now" would count for the gateways the program pays
 *   outside Stripe (`payoutMethods`: by hand, or with PayPal since 02037), live mode only, as
 *   `claim_manual_affiliate_payout` and `claim_paypal_affiliate_payout` take it, plus the manual
 *   payouts prepared and not recorded yet and the PayPal payouts in flight (PROCESSING, method
 *   manual or paypal: their money is about to leave by PayPal, Interac e-Transfer or a bank, not
 *   from Stripe). It never needs the
 *   Stripe balance, so it is left out of "owed now", "in flight", "clearing soon", "last 30 days"
 *   and "Needed"; the Stripe payouts screen shows it as "Paid manually". Stripe payouts already
 *   claimed (in flight, waiting to retry, needs an admin) are transfers whatever their commissions'
 *   gateway, and stay counted.
 */
import { AFFILIATE_GATEWAYS } from '../core/statuses';
import type { AffiliateGateway } from '../core/types';
import { affiliateTable, type AffiliateRepositoryClient } from '../repository/client';
import { isAffiliatePayoutAutoRetryable } from './payout-config';

/** `failure_reason` of a FAILED payout whose commissions went back to the cleared balance: nothing left to send. */
export const AFFILIATE_PAYOUT_CLOSED_FAILURE_REASONS = ['released', 'nothing_to_pay', 'below_minimum'] as const;

const CLOSED_FAILURES: ReadonlySet<string> = new Set(AFFILIATE_PAYOUT_CLOSED_FAILURE_REASONS);

/** Days ahead the "clearing soon" figure looks, and the span of "last 30 days". */
export const AFFILIATE_PAYOUT_OBLIGATION_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const ID_CHUNK = 100;

/** One currency of {@link AffiliatePayoutObligations} (minor units of `currency`). */
export interface AffiliatePayoutObligationTotals {
  /** Uppercase ISO code: the store base currency the commissions were recorded in. */
  currency: string;
  /** CLEARED, unattached, undisputed commissions of every partner, net of refunds (the next run claims the payable partners' share). */
  owedNowCents: number;
  /** The part of `owedNowCents` earned on Stripe (physical product) sales. */
  owedNowStripeCents: number;
  /** The part of `owedNowCents` earned on Freemius (digital product) sales. */
  owedNowFreemiusCents: number;
  /** PROCESSING payouts. */
  inFlightCents: number;
  /** FAILED payouts the daily cycle retries by itself. */
  retryingCents: number;
  /** The other FAILED payouts that still hold their commissions (Retry or Release). */
  needsAdminCents: number;
  /** PENDING_CLEARANCE commissions clearing within the window. */
  clearingSoonCents: number;
  /** Commissions recorded over the last window (not voided), net of refunds. */
  lastWindowCents: number;
  /**
   * CLEARED, unattached, undisputed, live-mode commissions of the gateways paid outside Stripe
   * (02036), net of refunds, plus the manual payouts prepared and not recorded yet: what the
   * operator owes by PayPal, Interac e-Transfer or bank transfer. Never part of the figures above or
   * of "Needed". 0 while every gateway is paid through Stripe and no manual payout is prepared.
   */
  owedManuallyCents: number;
}

export interface AffiliatePayoutObligations {
  /** The key mode the figures belong to. */
  livemode: boolean;
  windowDays: number;
  /** Sorted by currency. */
  currencies: AffiliatePayoutObligationTotals[];
  /** A read stopped at its page cap, so a figure may be low. */
  truncated: boolean;
}

export interface LoadAffiliatePayoutObligationsOptions {
  /** The Stripe key mode: only commissions and payouts of this mode count. */
  livemode: boolean;
  /** Automated payouts are on, Stripe is configured and this is not the public sandbox. */
  automatedPayoutsRunning: boolean;
  now?: Date;
  /** Days ahead for "clearing soon" (and back for "last window"); default 30, at most 365. */
  windowDays?: number;
  /**
   * The gateways whose commissions Stripe Connect pays (`affiliateGatewaysPaidByStripe`); the
   * others count as "owed manually". Omitted or null: every gateway (the behaviour before 02036).
   */
  gateways?: readonly AffiliateGateway[] | null;
}

/**
 * One page of the commissions `claim_affiliate_payout` takes with a key of this mode: CLEARED,
 * attached to no payout, under no dispute, ordered by id. The daily cycle's candidate sums (for its
 * payable partners), the CMS "owed now" figure (every partner) and, with `livemode: true` and the
 * manual gateways, the CMS "Pay manually" list all read through it, so they count a commission by
 * the same rules. `gateways` limits the page to those gateways (02036; an empty list reads nothing,
 * omitted or null reads every gateway).
 *
 * Paging: by default an OFFSET window (`from`..`to`). With `afterId` set (null for the first page)
 * the page is instead the next `to - from + 1` rows whose id comes after it (keyset paging): a row
 * that enters or leaves the set between two page reads (a promote, a claim, a released payout) then
 * shifts no later row, so none is read twice or skipped. The "Pay manually" list pages that way.
 */
export async function readAffiliateClaimableCommissionPage(
  supabase: AffiliateRepositoryClient,
  input: {
    livemode: boolean;
    columns: string;
    affiliateIds?: readonly string[] | null;
    gateways?: readonly AffiliateGateway[] | null;
    from: number;
    to: number;
    afterId?: string | null;
  }
): Promise<{ rows: Array<Record<string, unknown>>; error: unknown }> {
  if (Array.isArray(input.gateways) && input.gateways.length === 0) return { rows: [], error: null };
  let query = affiliateTable(supabase, 'affiliate_commissions')
    .select(input.columns)
    .eq('status', 'CLEARED')
    .eq('livemode', input.livemode)
    .is('payout_id', null)
    .is('disputed_at', null);
  if (input.affiliateIds) query = query.in('affiliate_id', [...input.affiliateIds]);
  if (Array.isArray(input.gateways)) query = query.in('gateway', [...input.gateways]);
  if (input.afterId !== undefined) {
    if (typeof input.afterId === 'string' && input.afterId) query = query.gt('id', input.afterId);
    const size = Math.max(1, Math.trunc(input.to - input.from + 1));
    const { data, error } = await query.order('id', { ascending: true }).limit(size);
    return { rows: Array.isArray(data) ? (data as unknown as Array<Record<string, unknown>>) : [], error: error ?? null };
  }
  const { data, error } = await query.order('id', { ascending: true }).range(input.from, input.to);
  return { rows: Array.isArray(data) ? (data as unknown as Array<Record<string, unknown>>) : [], error: error ?? null };
}

/** What still has to be funded from the balance: owed now, waiting to retry, needs an admin and clearing soon. */
export function affiliatePayoutObligationNeededCents(
  totals: Pick<AffiliatePayoutObligationTotals, 'owedNowCents' | 'retryingCents' | 'needsAdminCents' | 'clearingSoonCents'>
): number {
  return totals.owedNowCents + totals.retryingCents + totals.needsAdminCents + totals.clearingSoonCents;
}

function emptyTotals(currency: string): AffiliatePayoutObligationTotals {
  return {
    currency,
    owedNowCents: 0,
    owedNowStripeCents: 0,
    owedNowFreemiusCents: 0,
    inFlightCents: 0,
    retryingCents: 0,
    needsAdminCents: 0,
    clearingSoonCents: 0,
    lastWindowCents: 0,
    owedManuallyCents: 0,
  };
}

/**
 * The obligations' gateway split: `stripe` is the filter for the Stripe-side figures (undefined =
 * every gateway, so the reads stay exactly as before 02036), `manual` the gateways paid by hand.
 */
function splitGateways(gateways: readonly AffiliateGateway[] | null | undefined): {
  stripe: readonly AffiliateGateway[] | undefined;
  manual: AffiliateGateway[];
} {
  if (!Array.isArray(gateways)) return { stripe: undefined, manual: [] };
  const manual = AFFILIATE_GATEWAYS.filter((gateway) => !gateways.includes(gateway));
  return { stripe: manual.length === 0 ? undefined : AFFILIATE_GATEWAYS.filter((gateway) => gateways.includes(gateway)), manual };
}

function currencyOf(value: unknown): string | null {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** Commission amount net of partial refunds, or 0. */
function netCommission(row: Record<string, unknown>): number {
  const net = Math.trunc(Number(row['commission_amount_cents']) - Number(row['refunded_amount_cents'] ?? 0));
  return Number.isFinite(net) && net > 0 ? net : 0;
}

function positiveAmount(value: unknown): number {
  const amount = Math.trunc(Number(value));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/**
 * The figures of {@link AffiliatePayoutObligations} (see the file comment). Throws an `Error` with
 * the PostgREST error as `cause` when a read fails; nothing is written.
 */
export async function loadAffiliatePayoutObligations(
  supabase: AffiliateRepositoryClient,
  options: LoadAffiliatePayoutObligationsOptions
): Promise<AffiliatePayoutObligations> {
  const livemode = options.livemode === true;
  const now = options.now ?? new Date();
  const days = Math.min(365, Math.max(1, Math.trunc(Number(options.windowDays) || AFFILIATE_PAYOUT_OBLIGATION_WINDOW_DAYS)));
  const windowEnd = new Date(now.getTime() + days * DAY_MS).toISOString();
  const windowStart = new Date(now.getTime() - days * DAY_MS).toISOString();

  const totals = new Map<string, AffiliatePayoutObligationTotals>();
  const totalsFor = (currency: string) => {
    let entry = totals.get(currency);
    if (!entry) {
      entry = emptyTotals(currency);
      totals.set(currency, entry);
    }
    return entry;
  };
  let truncated = false;
  const split = splitGateways(options.gateways);
  // Every gateway paid by hand: no Stripe-side commission figure at all.
  const stripeCommissions = split.stripe === undefined || split.stripe.length > 0;

  // Owed now: the cycle's own claimable query, for the gateways Stripe pays.
  for (let page = 0; stripeCommissions; page += 1) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    const from = page * PAGE_SIZE;
    const { rows, error } = await readAffiliateClaimableCommissionPage(supabase, {
      livemode,
      columns: 'id, currency, gateway, commission_amount_cents, refunded_amount_cents',
      gateways: split.stripe,
      from,
      to: from + PAGE_SIZE - 1,
    });
    if (error) throw new Error('Could not read cleared commissions.', { cause: error });
    for (const row of rows) {
      const currency = currencyOf(row['currency']);
      const net = netCommission(row);
      if (!currency || net <= 0) continue;
      const entry = totalsFor(currency);
      entry.owedNowCents += net;
      if ((row['gateway'] as AffiliateGateway | undefined) === 'FREEMIUS') entry.owedNowFreemiusCents += net;
      else entry.owedNowStripeCents += net;
    }
    if (rows.length < PAGE_SIZE) break;
  }

  // Owed manually (02036): the same rules for the gateways paid by hand, live mode only (what
  // claim_manual_affiliate_payout takes), whatever the key's mode.
  for (let page = 0; split.manual.length > 0; page += 1) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    const from = page * PAGE_SIZE;
    const { rows, error } = await readAffiliateClaimableCommissionPage(supabase, {
      livemode: true,
      columns: 'id, currency, gateway, commission_amount_cents, refunded_amount_cents',
      gateways: split.manual,
      from,
      to: from + PAGE_SIZE - 1,
    });
    if (error) throw new Error('Could not read the commissions paid by hand.', { cause: error });
    for (const row of rows) {
      const currency = currencyOf(row['currency']);
      const net = netCommission(row);
      if (currency && net > 0) totalsFor(currency).owedManuallyCents += net;
    }
    if (rows.length < PAGE_SIZE) break;
  }

  // Stripe payouts still holding commissions: PROCESSING (in flight) and FAILED (retry or admin).
  const failed: Array<{ affiliateId: string; currency: string; amount: number; reason: string | null; attempts: number }> = [];
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    const from = page * PAGE_SIZE;
    const { data, error } = await affiliateTable(supabase, 'affiliate_payouts')
      .select('id, affiliate_id, amount_cents, currency, status, failure_reason, attempt_count')
      .eq('method', 'stripe_connect')
      .eq('livemode', livemode)
      .in('status', ['PROCESSING', 'FAILED'])
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error('Could not read payouts.', { cause: error });
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    for (const row of rows) {
      const currency = currencyOf(row['currency']);
      const amount = positiveAmount(row['amount_cents']);
      if (!currency || amount <= 0) continue;
      if (row['status'] === 'PROCESSING') {
        totalsFor(currency).inFlightCents += amount;
        continue;
      }
      const reason = typeof row['failure_reason'] === 'string' ? row['failure_reason'] : null;
      if (reason && CLOSED_FAILURES.has(reason)) continue;
      const affiliateId = typeof row['affiliate_id'] === 'string' ? row['affiliate_id'] : '';
      failed.push({ affiliateId, currency, amount, reason, attempts: Number(row['attempt_count']) });
    }
    if (rows.length < PAGE_SIZE) break;
  }

  if (failed.length > 0) {
    const payable = new Set<string>();
    const ids = [...new Set(failed.map((entry) => entry.affiliateId).filter(Boolean))];
    for (let index = 0; index < ids.length; index += ID_CHUNK) {
      const { data, error } = await affiliateTable(supabase, 'affiliate_profiles')
        .select('id, status, first_published_at, stripe_connect_account_id')
        .in('id', ids.slice(index, index + ID_CHUNK));
      if (error) throw new Error('Could not read partner profiles.', { cause: error });
      for (const row of Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []) {
        if (row['status'] === 'ACTIVE' && row['first_published_at'] && row['stripe_connect_account_id'] && typeof row['id'] === 'string') {
          payable.add(row['id']);
        }
      }
    }
    for (const entry of failed) {
      const retrying = isAffiliatePayoutAutoRetryable(
        { status: 'FAILED', failure_reason: entry.reason, attempt_count: entry.attempts },
        { automatedPayoutsRunning: options.automatedPayoutsRunning === true, partnerPayable: payable.has(entry.affiliateId) }
      );
      const totalsEntry = totalsFor(entry.currency);
      if (retrying) totalsEntry.retryingCents += entry.amount;
      else totalsEntry.needsAdminCents += entry.amount;
    }
  }

  // Prepared manual payouts (02036) and PayPal payouts in flight (02037): their money leaves by PayPal,
  // Interac e-Transfer or a bank, never from Stripe, so they are owed outside Stripe (live mode only,
  // whatever the key's mode: a PayPal sandbox payout moves no real money).
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    const from = page * PAGE_SIZE;
    const { data, error } = await affiliateTable(supabase, 'affiliate_payouts')
      .select('id, amount_cents, currency')
      .in('method', ['manual', 'paypal'])
      .eq('status', 'PROCESSING')
      .eq('livemode', true)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error('Could not read the prepared manual payouts.', { cause: error });
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    for (const row of rows) {
      const currency = currencyOf(row['currency']);
      const amount = positiveAmount(row['amount_cents']);
      if (currency && amount > 0) totalsFor(currency).owedManuallyCents += amount;
    }
    if (rows.length < PAGE_SIZE) break;
  }

  // Clearing soon: the hold ends within the window (a dispute holds a commission past it), for the
  // gateways Stripe pays.
  for (let page = 0; stripeCommissions; page += 1) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    const from = page * PAGE_SIZE;
    let clearing = affiliateTable(supabase, 'affiliate_commissions')
      .select('id, currency, commission_amount_cents, refunded_amount_cents')
      .eq('status', 'PENDING_CLEARANCE')
      .eq('livemode', livemode)
      .is('disputed_at', null)
      .lte('clears_at', windowEnd);
    if (split.stripe) clearing = clearing.in('gateway', [...split.stripe]);
    const { data, error } = await clearing.order('id', { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error('Could not read pending commissions.', { cause: error });
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    for (const row of rows) {
      const currency = currencyOf(row['currency']);
      const net = netCommission(row);
      if (currency && net > 0) totalsFor(currency).clearingSoonCents += net;
    }
    if (rows.length < PAGE_SIZE) break;
  }

  // The last window's commissions, whatever their status now (voided ones excepted), for the
  // gateways Stripe pays.
  for (let page = 0; stripeCommissions; page += 1) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    const from = page * PAGE_SIZE;
    let recent = affiliateTable(supabase, 'affiliate_commissions')
      .select('id, currency, commission_amount_cents, refunded_amount_cents')
      .eq('livemode', livemode)
      .in('status', ['PENDING_CLEARANCE', 'CLEARED', 'PAID'])
      .gte('created_at', windowStart);
    if (split.stripe) recent = recent.in('gateway', [...split.stripe]);
    const { data, error } = await recent.order('id', { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error('Could not read recent commissions.', { cause: error });
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    for (const row of rows) {
      const currency = currencyOf(row['currency']);
      const net = netCommission(row);
      if (currency && net > 0) totalsFor(currency).lastWindowCents += net;
    }
    if (rows.length < PAGE_SIZE) break;
  }

  return {
    livemode,
    windowDays: days,
    currencies: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    truncated,
  };
}
