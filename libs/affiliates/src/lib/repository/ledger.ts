/**
 * Commission and payout reads, and the balance cards the portal and the CMS show. Amounts are
 * base-currency minor units, net of partial refunds.
 */
import { affiliateCommissionNetMinor } from '../core/money';
import { isAffiliateCommissionStatus, isAffiliatePayoutStatus } from '../core/statuses';
import type {
  AffiliateBalances,
  AffiliateCommissionRow,
  AffiliateCommissionStatus,
  AffiliateCurrencyBalance,
  AffiliatePayoutRow,
  AffiliatePayoutStatus,
} from '../core/types';
import {
  AffiliateRepositoryError,
  affiliateTable,
  clampAffiliatePageOffset,
  clampAffiliatePageSize,
  normalizeAffiliateUuid,
  type AffiliateRepositoryClient,
  type AffiliateRepositoryPage,
} from './client';
import { normalizeAffiliateCommissionRow, normalizeAffiliatePayoutRow, normalizeAffiliateRows } from './rows';

export interface ListAffiliateLedgerOptions<TStatus extends string> {
  /** Omit for every affiliate (CMS ledger). */
  affiliateId?: string | null;
  status?: TStatus | readonly TStatus[] | null;
  limit?: number;
  offset?: number;
}

type FilterResult<TStatus> = { ok: true; affiliateId: string | null; statuses: TStatus[] | null } | { ok: false };

/** Validated filters, or `{ ok: false }` when a filter can match nothing (bad id or status). */
function ledgerFilters<TStatus extends string>(
  options: ListAffiliateLedgerOptions<TStatus>,
  isStatus: (value: unknown) => value is TStatus
): FilterResult<TStatus> {
  let affiliateId: string | null = null;

  if (options.affiliateId !== undefined && options.affiliateId !== null) {
    affiliateId = normalizeAffiliateUuid(options.affiliateId);
    if (!affiliateId) return { ok: false };
  }

  if (options.status === undefined || options.status === null) {
    return { ok: true, affiliateId, statuses: null };
  }

  const requested: readonly unknown[] = Array.isArray(options.status) ? options.status : [options.status];
  const statuses = [...new Set(requested.filter(isStatus))];

  return statuses.length > 0 ? { ok: true, affiliateId, statuses } : { ok: false };
}

async function listLedger<TRow, TStatus extends string>(
  supabase: AffiliateRepositoryClient,
  operation: string,
  table: 'affiliate_commissions' | 'affiliate_payouts',
  options: ListAffiliateLedgerOptions<TStatus>,
  isStatus: (value: unknown) => value is TStatus,
  normalize: (raw: unknown) => TRow | null
): Promise<AffiliateRepositoryPage<TRow>> {
  const filters = ledgerFilters(options, isStatus);
  if (!filters.ok) return { rows: [], count: 0 };

  const limit = clampAffiliatePageSize(options.limit);
  const offset = clampAffiliatePageOffset(options.offset);
  let query = affiliateTable(supabase, table).select('*', { count: 'exact' });

  if (filters.affiliateId) query = query.eq('affiliate_id', filters.affiliateId);
  if (filters.statuses) {
    query = filters.statuses.length === 1 ? query.eq('status', filters.statuses[0]) : query.in('status', filters.statuses);
  }

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new AffiliateRepositoryError(operation, error);

  const rows = normalizeAffiliateRows(data, normalize);
  return { rows, count: typeof count === 'number' ? count : rows.length };
}

/** Newest first, `{ rows, count }`. */
export function listAffiliateCommissions(
  supabase: AffiliateRepositoryClient,
  options: ListAffiliateLedgerOptions<AffiliateCommissionStatus> = {}
): Promise<AffiliateRepositoryPage<AffiliateCommissionRow>> {
  return listLedger(
    supabase,
    'listAffiliateCommissions',
    'affiliate_commissions',
    options,
    isAffiliateCommissionStatus,
    normalizeAffiliateCommissionRow
  );
}

/** Newest first, `{ rows, count }`. */
export function listAffiliatePayouts(
  supabase: AffiliateRepositoryClient,
  options: ListAffiliateLedgerOptions<AffiliatePayoutStatus> = {}
): Promise<AffiliateRepositoryPage<AffiliatePayoutRow>> {
  return listLedger(supabase, 'listAffiliatePayouts', 'affiliate_payouts', options, isAffiliatePayoutStatus, normalizeAffiliatePayoutRow);
}

/** The commission fields the balance math reads. */
export type AffiliateBalanceInputRow = Pick<
  AffiliateCommissionRow,
  'status' | 'currency' | 'commission_amount_cents' | 'refunded_amount_cents' | 'payout_id' | 'clears_at'
>;

export interface AffiliateBalancesOptions {
  /**
   * The store base currency (`currencies.is_default`). It becomes `primary` (zeros when the
   * affiliate has no rows in it); without it, `primary` is the currency with the most rows.
   */
  baseCurrency?: string | null;
}

function emptyBalance(currency: string): AffiliateCurrencyBalance {
  return { currency, pendingCents: 0, clearedCents: 0, processingCents: 0, paidCents: 0, voidedCents: 0, nextClearsAt: null };
}

function normalizedCurrency(value: unknown): string | null {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function earlier(current: string | null, candidate: string | null | undefined): string | null {
  if (!candidate) return current;
  const candidateTime = Date.parse(candidate);
  if (!Number.isFinite(candidateTime)) return current;
  if (!current) return candidate;
  return candidateTime < Date.parse(current) ? candidate : current;
}

/**
 * Pure balance math over commission rows:
 * - pending: PENDING_CLEARANCE (net of refunds); `nextClearsAt` is the earliest `clears_at` among them;
 * - cleared: CLEARED with no payout attached;
 * - processing: CLEARED and attached to a payout (an in-flight or failed transfer);
 * - paid: PAID (net of refunds);
 * - voided: the whole amount of VOIDED_REFUND rows plus the refunded part of every other row.
 */
export function computeAffiliateBalances(
  rows: readonly AffiliateBalanceInputRow[],
  options: AffiliateBalancesOptions = {}
): AffiliateBalances {
  const balances = new Map<string, AffiliateCurrencyBalance>();
  const rowCounts = new Map<string, number>();

  for (const row of rows) {
    const currency = normalizedCurrency(row.currency) ?? 'USD';
    const balance = balances.get(currency) ?? emptyBalance(currency);
    const commission = Math.max(0, Math.round(Number(row.commission_amount_cents) || 0));
    const refunded = Math.min(commission, Math.max(0, Math.round(Number(row.refunded_amount_cents) || 0)));
    const net = affiliateCommissionNetMinor({ commission_amount_cents: commission, refunded_amount_cents: refunded });

    switch (row.status) {
      case 'PENDING_CLEARANCE':
        balance.pendingCents += net;
        balance.voidedCents += refunded;
        balance.nextClearsAt = earlier(balance.nextClearsAt, row.clears_at);
        break;
      case 'CLEARED':
        if (row.payout_id) balance.processingCents += net;
        else balance.clearedCents += net;
        balance.voidedCents += refunded;
        break;
      case 'PAID':
        balance.paidCents += net;
        balance.voidedCents += refunded;
        break;
      case 'VOIDED_REFUND':
        balance.voidedCents += commission;
        break;
      default:
        continue;
    }

    balances.set(currency, balance);
    rowCounts.set(currency, (rowCounts.get(currency) ?? 0) + 1);
  }

  const byFrequency = [...rowCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const primaryCurrency = normalizedCurrency(options.baseCurrency) ?? byFrequency[0]?.[0] ?? 'USD';
  const primary = balances.get(primaryCurrency) ?? emptyBalance(primaryCurrency);
  const byCurrency = [...balances.values()].sort((a, b) =>
    a.currency === primaryCurrency ? -1 : b.currency === primaryCurrency ? 1 : a.currency.localeCompare(b.currency)
  );

  return { primary, byCurrency };
}

/** Rows per balance page; PostgREST caps a response at `max_rows` (1000 on Supabase). */
const BALANCE_PAGE_SIZE = 1000;
/** Hard stop for the paging loop (100k commission rows). */
const BALANCE_MAX_PAGES = 100;

/** {@link computeAffiliateBalances} over every commission of one affiliate. */
export async function getAffiliateBalances(
  supabase: AffiliateRepositoryClient,
  affiliateId: string,
  options: AffiliateBalancesOptions = {}
): Promise<AffiliateBalances> {
  const id = normalizeAffiliateUuid(affiliateId);
  if (!id) return computeAffiliateBalances([], options);

  const rows: AffiliateBalanceInputRow[] = [];

  for (let page = 0; page < BALANCE_MAX_PAGES; page += 1) {
    const from = page * BALANCE_PAGE_SIZE;
    const { data, error } = await affiliateTable(supabase, 'affiliate_commissions')
      .select('id, status, currency, commission_amount_cents, refunded_amount_cents, payout_id, clears_at')
      .eq('affiliate_id', id)
      .order('id', { ascending: true })
      .range(from, from + BALANCE_PAGE_SIZE - 1);

    if (error) throw new AffiliateRepositoryError('getAffiliateBalances', error);

    const batch = normalizeAffiliateRows(data, normalizeAffiliateCommissionRow);
    rows.push(...batch);

    if (!Array.isArray(data) || data.length < BALANCE_PAGE_SIZE) break;
  }

  return computeAffiliateBalances(rows, options);
}
