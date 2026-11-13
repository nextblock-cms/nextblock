/**
 * `affiliate_payout_runs.summary`: what the day's payout run did, merged across the calls of the
 * day (the first claim, continuations, cron and admin runs). The latest call's figures drive the
 * continuation (`remaining`, `aborted`); `totals` add up the day; `insufficientBalanceAlertedAt`
 * keeps B2's "one alert per day" across calls.
 */
import { AFFILIATE_PAYOUT_TRIGGERS } from '../core/statuses';
import type { AffiliatePayoutTrigger } from '../core/types';
import type {
  AffiliatePayoutCycleAbortReason,
  AffiliatePayoutCycleError,
  AffiliatePayoutCycleSummary,
  AffiliatePayoutShortfall,
} from './engine';

export interface AffiliatePayoutRunTotals {
  claimed: number;
  sent: number;
  failed: number;
  pending: number;
  retried: number;
  reconciled: number;
}

export interface AffiliatePayoutStoredRunSummary extends AffiliatePayoutCycleSummary {
  /** Cycle calls recorded for the day. */
  calls: number;
  /** When the day's first call started (continuations skip partners checked since then). */
  firstStartedAt: string;
  /** When the day's insufficient-balance alert went out, if it did. */
  insufficientBalanceAlertedAt: string | null;
  totals: AffiliatePayoutRunTotals;
}

const COUNT_KEYS = [
  'recorded',
  'voided',
  'promoted',
  'notified',
  'reconciled',
  'claimed',
  'sent',
  'failed',
  'pending',
  'retried',
  'skippedNotReady',
  'skippedBelowMinimum',
  'skippedInsufficientBalance',
  'remaining',
] as const;

const TOTAL_KEYS = ['claimed', 'sent', 'failed', 'pending', 'retried', 'reconciled'] as const;

const ABORT_REASONS: readonly AffiliatePayoutCycleAbortReason[] = ['stripe_authentication', 'stripe_unavailable'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function shortText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function readShortfalls(value: unknown): AffiliatePayoutShortfall[] {
  if (!Array.isArray(value)) return [];
  const shortfalls: AffiliatePayoutShortfall[] = [];
  for (const entry of value.slice(0, 20)) {
    const record = asRecord(entry);
    const currency = typeof record?.['currency'] === 'string' ? record['currency'].toUpperCase() : '';
    if (!record || !/^[A-Z]{3}$/.test(currency)) continue;
    shortfalls.push({ currency, availableCents: count(record['availableCents']), requiredCents: count(record['requiredCents']) });
  }
  return shortfalls;
}

function readErrors(value: unknown): AffiliatePayoutCycleError[] {
  if (!Array.isArray(value)) return [];
  const errors: AffiliatePayoutCycleError[] = [];
  for (const entry of value.slice(0, 50)) {
    const record = asRecord(entry);
    const step = shortText(record?.['step'], 40);
    const code = shortText(record?.['code'], 64);
    if (!record || !step || !code) continue;
    const error = { step, code } as AffiliatePayoutCycleError;
    const payoutId = shortText(record['payoutId'], 64);
    const affiliateId = shortText(record['affiliateId'], 64);
    if (payoutId) error.payoutId = payoutId;
    if (affiliateId) error.affiliateId = affiliateId;
    errors.push(error);
  }
  return errors;
}

/** A stored run summary read defensively (it is jsonb), or null when there is none yet. */
export function readAffiliatePayoutRunSummary(value: unknown): AffiliatePayoutStoredRunSummary | null {
  const record = asRecord(value);
  if (!record || typeof record['startedAt'] !== 'string') return null;

  const startedAt = isoOrNull(record['startedAt']) ?? new Date(0).toISOString();
  const trigger = (AFFILIATE_PAYOUT_TRIGGERS as readonly string[]).includes(String(record['trigger']))
    ? (record['trigger'] as AffiliatePayoutTrigger)
    : 'auto';
  const totalsRecord = asRecord(record['totals']) ?? {};
  const totals = Object.fromEntries(TOTAL_KEYS.map((key) => [key, count(totalsRecord[key])])) as unknown as AffiliatePayoutRunTotals;
  const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, count(record[key])])) as Record<(typeof COUNT_KEYS)[number], number>;
  const aborted = ABORT_REASONS.includes(record['aborted'] as AffiliatePayoutCycleAbortReason)
    ? (record['aborted'] as AffiliatePayoutCycleAbortReason)
    : null;

  return {
    trigger,
    startedAt,
    finishedAt: isoOrNull(record['finishedAt']) ?? startedAt,
    livemode: typeof record['livemode'] === 'boolean' ? record['livemode'] : null,
    ...counts,
    insufficientBalance: readShortfalls(record['insufficientBalance']),
    insufficientBalanceAlerted: record['insufficientBalanceAlerted'] === true,
    aborted,
    errors: readErrors(record['errors']),
    calls: Math.max(1, count(record['calls'])),
    firstStartedAt: isoOrNull(record['firstStartedAt']) ?? startedAt,
    insufficientBalanceAlertedAt: isoOrNull(record['insufficientBalanceAlertedAt']),
    totals,
  };
}

/**
 * The summary to store after a cycle call: the call's own figures, the day's call count, first
 * start, running totals and the time of the day's insufficient-balance alert.
 */
export function mergeAffiliatePayoutRunSummary(
  previous: unknown,
  current: AffiliatePayoutCycleSummary
): AffiliatePayoutStoredRunSummary {
  const before = readAffiliatePayoutRunSummary(previous);
  const totals = {} as AffiliatePayoutRunTotals;
  for (const key of TOTAL_KEYS) totals[key] = (before?.totals[key] ?? 0) + count(current[key]);

  const alertedNow = current.insufficientBalanceAlerted && current.insufficientBalance.length > 0 && !before?.insufficientBalanceAlertedAt;
  return {
    ...current,
    insufficientBalance: current.insufficientBalance.map((shortfall) => ({ ...shortfall })),
    errors: current.errors.slice(0, 50).map((error) => ({ ...error })),
    insufficientBalanceAlerted: current.insufficientBalanceAlerted || Boolean(before?.insufficientBalanceAlertedAt),
    calls: (before?.calls ?? 0) + 1,
    firstStartedAt: before?.firstStartedAt ?? current.startedAt,
    insufficientBalanceAlertedAt: before?.insufficientBalanceAlertedAt ?? (alertedNow ? current.finishedAt : null),
    totals,
  };
}

/** The UTC day (YYYY-MM-DD) a payout run belongs to. */
export function affiliatePayoutRunDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
