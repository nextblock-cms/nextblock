/**
 * The moving parts every payout path shares: reconciling a payout against Stripe, checking a
 * partner's Connect readiness, sending one transfer and retrying a FAILED payout. Used by the
 * daily cycle (`cycle.ts`) and by the admin retry / release actions (`admin.ts`); not exported
 * from the area index.
 *
 * Money rules (ADDENDUM B1): a payout is claimed (PROCESSING) before its transfer is created;
 * only a definitive Stripe refusal fails it; a transient error, or any failure to record a
 * transfer Stripe accepted, leaves it PROCESSING for the next reconciliation; and every
 * retry or release first asks Stripe whether a transfer of the payout's group already exists.
 * Key modes never mix: a payout is claimed only from commissions of its destination account's
 * mode (`claim_affiliate_payout`), and only a key of that mode retries, reconciles or releases it.
 */
import type { AffiliatePayoutRow, AffiliatePayoutTrigger, AffiliateProfileRow } from '../core/types';
import { affiliateTable, type AffiliateRepositoryClient } from '../repository/client';
import { normalizeAffiliatePayoutRow, normalizeAffiliateProfileRow, normalizeAffiliateRows } from '../repository/rows';
import { syncAffiliateConnectStatus } from '../connect/status';
import {
  AFFILIATE_PAYOUT_DEFAULT_BATCH_SIZE,
  AFFILIATE_PAYOUT_DEFAULT_TIME_BUDGET_MS,
  AFFILIATE_PAYOUT_MAX_ATTEMPTS,
  AFFILIATE_PAYOUT_STALE_AFTER_MS,
  AFFILIATE_PAYOUT_STRIPE_FAILURE_LIMIT,
  isAffiliatePayoutTransientFailureReason,
} from './payout-config';
import {
  completeAffiliatePayoutViaRpc,
  failAffiliatePayoutViaRpc,
  prepareAffiliatePayoutRetryViaRpc,
} from './rpc';
import {
  affiliateStripeErrorCode,
  classifyAffiliateStripeError,
  isAffiliateStripeAuthenticationError,
  isAffiliateStripeError,
} from './stripe-errors';
import type { AffiliateStripeBalanceLike, AffiliateStripeTransferLike, AffiliatesStripeLike } from './stripe-like';
import { createAffiliatePayoutTransfer, findAffiliatePayoutTransfer, type AffiliatePayoutTransferLookup } from './transfers';

export type AffiliatePayoutCycleStep =
  | 'reconcile_commissions'
  | 'promote_commissions'
  | 'notify_commissions'
  | 'reconcile_payouts'
  | 'balance'
  | 'retry_payouts'
  | 'list_candidates'
  | 'account'
  | 'claim'
  | 'transfer'
  | 'complete'
  | 'fail'
  | 'load'
  | 'hook'
  | 'cycle';

export interface AffiliatePayoutCycleError {
  step: AffiliatePayoutCycleStep;
  /** A short machine code (Stripe error code, PostgREST/Postgres code, `unknown`), never a message. */
  code: string;
  payoutId?: string;
  affiliateId?: string;
}

/** Payouts that waited because the platform's transferable Stripe balance was short (B2). */
export interface AffiliatePayoutShortfall {
  /** Uppercase ISO currency. */
  currency: string;
  /** Transferable balance in this currency when the shortfall was seen. */
  availableCents: number;
  /** What the waiting payouts in this currency needed in total. */
  requiredCents: number;
}

export type AffiliatePayoutCycleAbortReason = 'stripe_authentication' | 'stripe_unavailable';

/** What one cycle call did. Counts are of payouts unless the name says otherwise. */
export interface AffiliatePayoutCycleSummary {
  trigger: AffiliatePayoutTrigger;
  startedAt: string;
  finishedAt: string;
  /** Mode of the Stripe key (from the balance), null when the balance could not be read. */
  livemode: boolean | null;
  /** Commissions recorded by `reconcile_affiliate_commissions` (the order trigger missed them). */
  recorded: number;
  /** Commissions voided by `reconcile_affiliate_commissions`. */
  voided: number;
  /** Commissions promoted PENDING_CLEARANCE → CLEARED. */
  promoted: number;
  /** Commissions claimed by the "you earned" notification sweep. */
  notified: number;
  /** Stale PROCESSING payouts resolved against Stripe (completed, or failed as `stale`). */
  reconciled: number;
  claimed: number;
  /** Payouts completed: a transfer created now, or found by reconciliation. */
  sent: number;
  failed: number;
  /** Left PROCESSING after an unknown outcome; the next cycle reconciles them. */
  pending: number;
  /** FAILED payouts re-attempted. */
  retried: number;
  /** Partners skipped because their Connect account cannot receive transfers. */
  skippedNotReady: number;
  /** Partner balances below the minimum payout. */
  skippedBelowMinimum: number;
  skippedInsufficientBalance: number;
  insufficientBalance: AffiliatePayoutShortfall[];
  /** The day's insufficient-balance alert went out (this call or an earlier one). */
  insufficientBalanceAlerted: boolean;
  /** Partners with work left because the batch cap or the time budget stopped this call. */
  remaining: number;
  aborted: AffiliatePayoutCycleAbortReason | null;
  errors: AffiliatePayoutCycleError[];
}

export interface AffiliatePayoutSentEvent {
  payout: AffiliatePayoutRow;
  transferId: string;
  /** `transfer`: created now; `reconcile`: an earlier attempt's transfer was found at Stripe. */
  via: 'transfer' | 'reconcile';
}

export interface AffiliatePayoutFailedEvent {
  payout: AffiliatePayoutRow;
  reason: string;
  /** Automatic retries are over (attempt_count reached the maximum). */
  exhausted: boolean;
}

export interface AffiliatePayoutTransferMismatchEvent {
  payout: AffiliatePayoutRow;
  transfer: AffiliateStripeTransferLike;
  /**
   * `amount` / `currency`: the transfer differs from the payout row; `duplicate`: more than one
   * live transfer in the group; `released`: money left for a payout that is FAILED for good
   * (released, emptied, or handed back below the minimum), judged on the row as it is now.
   */
  kind: 'amount' | 'currency' | 'duplicate' | 'released';
  activeTransfers: number;
}

/**
 * Side effects the app wires in (notifications, alerts). The engine awaits each hook and records
 * a throwing hook as a `hook` error; a hook never changes a money outcome.
 */
export interface AffiliatePayoutHooks {
  /** B8: the "you earned" sweep, run after the ledger repair of every cycle. Returns rows claimed. */
  sweepCommissionNotifications?: () => Promise<number>;
  onPayoutSent?: (event: AffiliatePayoutSentEvent) => unknown;
  /** Definitive failures, and transient ones once automatic retries are exhausted. */
  onPayoutFailed?: (event: AffiliatePayoutFailedEvent) => unknown;
  onTransferMismatch?: (event: AffiliatePayoutTransferMismatchEvent) => unknown;
  /** At most once per call, and only while `insufficientBalanceAlerted` is false. Return false when no alert was recorded. */
  onInsufficientBalance?: (shortfalls: AffiliatePayoutShortfall[]) => unknown;
  /** A partner's Connect account was found ready for the first time. */
  onConnectFirstReady?: (affiliateId: string) => unknown;
  /** Every recorded error with its cause, for server logs. */
  onError?: (error: AffiliatePayoutCycleError, cause: unknown) => void;
}

export interface AffiliatePayoutEngineOptions {
  /** Service-role client: the payout RPCs are revoked from every API role. */
  supabase: AffiliateRepositoryClient;
  stripe: AffiliatesStripeLike;
  trigger: AffiliatePayoutTrigger;
  /** Partners (Stripe work) per call. Default 25. */
  batchSize?: number;
  /** No new Stripe work starts after this many ms. Default 40 s. */
  timeBudgetMs?: number;
  /** Automatic retries stop after this many attempts. Default 5. */
  maxAttempts?: number;
  /**
   * Continuation of an earlier call of the same run: partners whose Connect status was checked
   * at or after this ISO time were evaluated already and are skipped.
   */
  skipCheckedSince?: string | null;
  /** Clock for business rules (stale window, retry delay). Defaults to the system clock. */
  now?: () => Date;
  hooks?: AffiliatePayoutHooks;
}

export type AffiliatePayoutReconcileOutcome =
  | { kind: 'completed'; transferId: string }
  | { kind: 'transfer_unusable'; transferId: string }
  | { kind: 'failed_stale' }
  | { kind: 'no_transfer' }
  /**
   * The payout was claimed with the other key mode (test ↔ live), or the key mode is unknown:
   * Stripe was not asked. Handle it like `error`: only a key of the payout's mode can see its
   * transfers.
   */
  | { kind: 'other_mode' }
  | { kind: 'error' };

export type AffiliatePayoutReadiness =
  | { ready: true }
  | { ready: false; reason: 'no_account' | 'livemode_mismatch' | 'account_missing' | 'not_ready' | 'unknown_mode' | 'error' };

export type AffiliatePayoutTransferOutcome =
  | { kind: 'sent'; transferId: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'pending'; reason: string | null; transferId: string | null };

export type AffiliatePayoutRetrySkipReason =
  | 'reconcile_failed'
  | 'transfer_unusable'
  | 'not_eligible'
  | 'account_not_ready'
  | 'balance_insufficient'
  | 'nothing_to_pay'
  /** What is left after refunds is below the minimum: the payout stays FAILED and its commissions go back to the cleared balance. */
  | 'below_minimum'
  /** Claimed with the other key mode (test ↔ live): only a key of its own mode may retry it. */
  | 'other_mode'
  | 'unknown';

export type AffiliatePayoutRetryOutcome =
  | { kind: 'completed'; transferId: string }
  | AffiliatePayoutTransferOutcome
  | { kind: 'skipped'; reason: AffiliatePayoutRetrySkipReason };

const MAX_RECORDED_ERRORS = 50;
const CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function errorCode(error: unknown): string {
  if (isAffiliateStripeError(error)) return affiliateStripeErrorCode(error);
  if (error && typeof error === 'object') {
    const record = error as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && CODE_PATTERN.test(record.code)) return record.code;
    const cause = record.cause;
    if (cause && typeof cause === 'object') {
      const causeCode = (cause as { code?: unknown }).code;
      if (typeof causeCode === 'string' && CODE_PATTERN.test(causeCode)) return causeCode;
    }
  }
  return 'unknown';
}

function positiveInt(value: unknown, fallback: number): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Records one step's failure on a summary (a short code, at most 50 errors kept) and hands it to
 * the `onError` hook, whose own failure is swallowed. The engine's `recordError` and the
 * Stripe-free ledger repair (`runAffiliateLedgerRepair`, cycle.ts) both report through it.
 */
export function appendAffiliatePayoutCycleError(
  summary: AffiliatePayoutCycleSummary,
  hooks: Pick<AffiliatePayoutHooks, 'onError'>,
  step: AffiliatePayoutCycleStep,
  cause: unknown,
  ids: { payoutId?: string; affiliateId?: string } = {}
): void {
  const entry: AffiliatePayoutCycleError = { step, code: errorCode(cause) };
  if (ids.payoutId) entry.payoutId = ids.payoutId;
  if (ids.affiliateId) entry.affiliateId = ids.affiliateId;
  if (summary.errors.length < MAX_RECORDED_ERRORS) summary.errors.push(entry);
  try {
    hooks.onError?.(entry, cause);
  } catch {
    // Logging must never break a money step.
  }
}

/** What a transfer may draw from: the `card` source balance when Stripe reports one, else the total. */
export function readAffiliateTransferableBalance(balance: AffiliateStripeBalanceLike): Map<string, number> {
  const amounts = new Map<string, number>();
  for (const entry of Array.isArray(balance?.available) ? balance.available : []) {
    if (!entry || typeof entry.currency !== 'string') continue;
    const currency = entry.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) continue;
    const card = entry.source_types?.card;
    const amount = typeof card === 'number' && Number.isFinite(card) ? card : Number(entry.amount);
    if (!Number.isFinite(amount)) continue;
    amounts.set(currency, (amounts.get(currency) ?? 0) + Math.max(0, Math.trunc(amount)));
  }
  return amounts;
}

export function createAffiliatePayoutCycleSummary(trigger: AffiliatePayoutTrigger, startedAt: string): AffiliatePayoutCycleSummary {
  return {
    trigger,
    startedAt,
    finishedAt: startedAt,
    livemode: null,
    recorded: 0,
    voided: 0,
    promoted: 0,
    notified: 0,
    reconciled: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    pending: 0,
    retried: 0,
    skippedNotReady: 0,
    skippedBelowMinimum: 0,
    skippedInsufficientBalance: 0,
    insufficientBalance: [],
    insufficientBalanceAlerted: false,
    remaining: 0,
    aborted: null,
    errors: [],
  };
}

export class AffiliatePayoutEngine {
  readonly supabase: AffiliateRepositoryClient;
  readonly stripe: AffiliatesStripeLike;
  readonly trigger: AffiliatePayoutTrigger;
  readonly hooks: AffiliatePayoutHooks;
  readonly summary: AffiliatePayoutCycleSummary;
  readonly batchSize: number;
  readonly maxAttempts: number;

  /** Mode of the configured key, known once the balance was read. */
  livemode: boolean | null = null;

  private readonly clock: () => Date;
  private readonly startedMs: number;
  private readonly timeBudgetMs: number;
  private readonly skipCheckedSinceMs: number | null;
  private balance: Map<string, number> | null = null;
  private readonly shortfalls = new Map<string, AffiliatePayoutShortfall>();
  private readonly slots = new Set<string>();
  private readonly readinessCache = new Map<string, AffiliatePayoutReadiness>();
  private readonly notReadyCounted = new Set<string>();
  private readonly remainingAffiliates = new Set<string>();
  private stripeFailures = 0;

  constructor(options: AffiliatePayoutEngineOptions) {
    this.supabase = options.supabase;
    this.stripe = options.stripe;
    this.trigger = options.trigger;
    this.hooks = options.hooks ?? {};
    this.clock = options.now ?? (() => new Date());
    this.batchSize = positiveInt(options.batchSize, AFFILIATE_PAYOUT_DEFAULT_BATCH_SIZE);
    this.maxAttempts = positiveInt(options.maxAttempts, AFFILIATE_PAYOUT_MAX_ATTEMPTS);
    this.timeBudgetMs = positiveInt(options.timeBudgetMs, AFFILIATE_PAYOUT_DEFAULT_TIME_BUDGET_MS);
    const since = options.skipCheckedSince ? Date.parse(options.skipCheckedSince) : Number.NaN;
    this.skipCheckedSinceMs = Number.isFinite(since) ? since : null;
    this.startedMs = Date.now();
    this.summary = createAffiliatePayoutCycleSummary(this.trigger, this.nowIso());
  }

  now(): Date {
    return this.clock();
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  /* --------------------------------------------------------------- bookkeeping --- */

  recordError(step: AffiliatePayoutCycleStep, cause: unknown, ids: { payoutId?: string; affiliateId?: string } = {}): void {
    appendAffiliatePayoutCycleError(this.summary, this.hooks, step, cause, ids);
  }

  async runHook(task: () => unknown): Promise<unknown> {
    try {
      return await task();
    } catch (error) {
      this.recordError('hook', error);
      return undefined;
    }
  }

  /** Stripe answered (success or a definitive refusal): the service is up. */
  noteStripeAnswer(): void {
    this.stripeFailures = 0;
  }

  /** A Stripe call failed without an answer; enough of them in a row stop this call's Stripe work. */
  noteStripeFailure(error: unknown): void {
    if (isAffiliateStripeAuthenticationError(error)) {
      this.summary.aborted = 'stripe_authentication';
      return;
    }
    if (!isAffiliateStripeError(error) || classifyAffiliateStripeError(error) === 'definitive') return;
    this.stripeFailures += 1;
    if (this.stripeFailures >= AFFILIATE_PAYOUT_STRIPE_FAILURE_LIMIT && !this.summary.aborted) {
      this.summary.aborted = 'stripe_unavailable';
    }
  }

  get stripeBlocked(): boolean {
    return this.summary.aborted !== null;
  }

  outOfTime(): boolean {
    return Date.now() - this.startedMs > this.timeBudgetMs;
  }

  /** One slot per partner per call; a partner already holding one keeps it (other currencies, retries). */
  takeBatchSlot(affiliateId: string): boolean {
    if (this.slots.has(affiliateId)) return true;
    if (this.slots.size >= this.batchSize) return false;
    this.slots.add(affiliateId);
    return true;
  }

  markRemaining(affiliateId: string): void {
    if (!this.slots.has(affiliateId)) this.remainingAffiliates.add(affiliateId);
  }

  countNotReady(affiliateId: string): void {
    if (this.notReadyCounted.has(affiliateId)) return;
    this.notReadyCounted.add(affiliateId);
    this.summary.skippedNotReady += 1;
  }

  /** Evaluated by an earlier call of the same run (its Connect status was checked since the run began). */
  wasCheckedEarlierInRun(profile: Pick<AffiliateProfileRow, 'id' | 'stripe_connect_checked_at'>): boolean {
    if (this.skipCheckedSinceMs === null) return false;
    if (this.slots.has(profile.id) || this.readinessCache.has(profile.id)) return false;
    const checked = profile.stripe_connect_checked_at ? Date.parse(profile.stripe_connect_checked_at) : Number.NaN;
    return Number.isFinite(checked) && checked >= this.skipCheckedSinceMs;
  }

  /** The stored account belongs to the other key mode: not payable until the partner re-onboards. */
  hasLivemodeMismatch(profile: Pick<AffiliateProfileRow, 'stripe_connect_livemode'>): boolean {
    return this.livemode !== null && profile.stripe_connect_livemode !== null && profile.stripe_connect_livemode !== this.livemode;
  }

  /**
   * The payout was claimed in the other key mode (or the key mode is not known yet): it is never
   * retried, reconciled or released with this key. A live key cannot see a test transfer (an
   * empty list would fail it as stale, and a release would hand its paid commissions back), and
   * a test key must never send real money for it, or the other way around.
   */
  isOtherMode(payout: Pick<AffiliatePayoutRow, 'livemode'>): boolean {
    return this.livemode === null || payout.livemode !== this.livemode;
  }

  isStale(payout: Pick<AffiliatePayoutRow, 'last_attempt_at'>): boolean {
    const last = Date.parse(payout.last_attempt_at);
    return !Number.isFinite(last) || this.now().getTime() - last >= AFFILIATE_PAYOUT_STALE_AFTER_MS;
  }

  /** Copies of the shortfalls seen so far. */
  currentShortfalls(): AffiliatePayoutShortfall[] {
    return [...this.shortfalls.values()].map((shortfall) => ({ ...shortfall }));
  }

  finish(): AffiliatePayoutCycleSummary {
    this.summary.remaining = this.remainingAffiliates.size;
    this.summary.insufficientBalance = this.currentShortfalls();
    this.summary.finishedAt = this.nowIso();
    return this.summary;
  }

  /* ------------------------------------------------------------------ balance --- */

  /** Reads the platform balance and key mode (B2). False when Stripe could not be asked. */
  async loadBalance(): Promise<boolean> {
    if (this.stripeBlocked) return false;
    try {
      const balance = await this.stripe.balance.retrieve();
      this.noteStripeAnswer();
      this.livemode = balance?.livemode === true;
      this.summary.livemode = this.livemode;
      this.balance = readAffiliateTransferableBalance(balance);
      return true;
    } catch (error) {
      this.noteStripeFailure(error);
      this.recordError('balance', error);
      return false;
    }
  }

  covers(currency: string, amountCents: number): boolean {
    if (!this.balance) return false;
    return (this.balance.get(currency.toUpperCase()) ?? 0) >= amountCents;
  }

  private debit(currency: string, amountCents: number): void {
    if (!this.balance) return;
    const code = currency.toUpperCase();
    this.balance.set(code, Math.max(0, (this.balance.get(code) ?? 0) - Math.max(0, amountCents)));
  }

  noteShortfall(currency: string, amountCents: number): void {
    const code = currency.toUpperCase();
    const available = this.balance?.get(code) ?? 0;
    const existing = this.shortfalls.get(code);
    if (existing) {
      existing.requiredCents += Math.max(0, amountCents);
      existing.availableCents = Math.min(existing.availableCents, available);
    } else {
      this.shortfalls.set(code, { currency: code, availableCents: available, requiredCents: Math.max(0, amountCents) });
    }
  }

  /* -------------------------------------------------------------------- reads --- */

  async loadPayout(payoutId: string): Promise<AffiliatePayoutRow | null> {
    const { data, error } = await affiliateTable(this.supabase, 'affiliate_payouts').select('*').eq('id', payoutId).maybeSingle();
    if (error) throw new Error('Could not read the payout.', { cause: error });
    return normalizeAffiliatePayoutRow(data);
  }

  async loadProfiles(affiliateIds: readonly string[]): Promise<Map<string, AffiliateProfileRow>> {
    const ids = [...new Set(affiliateIds.filter((id) => typeof id === 'string' && id))];
    const profiles = new Map<string, AffiliateProfileRow>();
    for (let index = 0; index < ids.length; index += 100) {
      const chunk = ids.slice(index, index + 100);
      const { data, error } = await affiliateTable(this.supabase, 'affiliate_profiles').select('*').in('id', chunk);
      if (error) throw new Error('Could not read partner profiles.', { cause: error });
      for (const row of normalizeAffiliateRows(data, normalizeAffiliateProfileRow)) profiles.set(row.id, row);
    }
    return profiles;
  }

  /* ---------------------------------------------------------------- readiness --- */

  /**
   * Can the partner receive a transfer now? Asks Stripe (`accounts.retrieve`) once per partner
   * per call and records the answer on the profile; an account of the other key mode is refused
   * without a call.
   */
  async readinessFor(profile: AffiliateProfileRow): Promise<AffiliatePayoutReadiness> {
    const cached = this.readinessCache.get(profile.id);
    if (cached) return cached;
    const readiness = await this.checkReadiness(profile);
    this.readinessCache.set(profile.id, readiness);
    return readiness;
  }

  private async checkReadiness(profile: AffiliateProfileRow): Promise<AffiliatePayoutReadiness> {
    if (!profile.stripe_connect_account_id) return { ready: false, reason: 'no_account' };
    if (this.livemode === null) return { ready: false, reason: 'unknown_mode' };
    if (this.hasLivemodeMismatch(profile)) return { ready: false, reason: 'livemode_mismatch' };
    try {
      const { status, firstReady } = await syncAffiliateConnectStatus(this.supabase, this.stripe, {
        profile,
        livemode: this.livemode,
        now: this.now(),
      });
      this.noteStripeAnswer();
      if (firstReady) {
        await this.runHook(() => this.hooks.onConnectFirstReady?.(profile.id));
      }
      if (status.ready) return { ready: true };
      return { ready: false, reason: status.accountMissing ? 'account_missing' : status.livemodeMismatch ? 'livemode_mismatch' : 'not_ready' };
    } catch (error) {
      this.noteStripeFailure(error);
      this.recordError('account', error, { affiliateId: profile.id });
      return { ready: false, reason: 'error' };
    }
  }

  /* ---------------------------------------------------------------- reconcile --- */

  /**
   * Asks Stripe whether the payout's transfer group holds a transfer (B1). Found: the payout is
   * completed with it (a FAILED payout too, unless it was released or emptied, which raises a
   * mismatch). None: a PROCESSING payout is failed as `stale` when `failStale` is set. A payout
   * of the other key mode is left alone (`other_mode`) without asking Stripe.
   */
  async reconcile(payout: AffiliatePayoutRow, options: { failStale: boolean }): Promise<AffiliatePayoutReconcileOutcome> {
    const ids = { payoutId: payout.id, affiliateId: payout.affiliate_id };
    // A manual (02036) or PayPal (02037) payout has no transfer at Stripe to find: never this engine's to resolve.
    if ((payout.method ?? 'stripe_connect') !== 'stripe_connect' || this.isOtherMode(payout)) return { kind: 'other_mode' };
    let lookup: AffiliatePayoutTransferLookup;
    try {
      lookup = await findAffiliatePayoutTransfer(this.stripe, payout);
      this.noteStripeAnswer();
    } catch (error) {
      this.noteStripeFailure(error);
      this.recordError('reconcile_payouts', error, ids);
      return { kind: 'error' };
    }

    const transfer = lookup.transfer;
    if (transfer) {
      let completed: boolean;
      try {
        completed = await completeAffiliatePayoutViaRpc(this.supabase, payout.id, transfer.id);
      } catch (error) {
        this.recordError('complete', error, ids);
        return { kind: 'error' };
      }
      if (completed) {
        const done = this.completedRow(payout, transfer.id);
        this.summary.sent += 1;
        await this.runHook(() => this.hooks.onPayoutSent?.({ payout: done, transferId: transfer.id, via: 'reconcile' }));
        await this.reportMismatch(done, transfer, lookup.activeCount);
        return { kind: 'completed', transferId: transfer.id };
      }
      await this.reportRefusedCompletion(payout, transfer, lookup.activeCount);
      return { kind: 'transfer_unusable', transferId: transfer.id };
    }

    if (options.failStale && payout.status === 'PROCESSING') {
      let failed: boolean;
      try {
        failed = await failAffiliatePayoutViaRpc(this.supabase, payout.id, 'stale');
      } catch (error) {
        this.recordError('fail', error, ids);
        return { kind: 'error' };
      }
      if (!failed) return { kind: 'no_transfer' };
      this.summary.failed += 1;
      if (payout.attempt_count >= this.maxAttempts) {
        await this.runHook(() =>
          this.hooks.onPayoutFailed?.({ payout: this.failedRow(payout, 'stale'), reason: 'stale', exhausted: true })
        );
      }
      return { kind: 'failed_stale' };
    }
    return { kind: 'no_transfer' };
  }

  /**
   * `complete_affiliate_payout` refused a transfer Stripe holds for the payout. Judged on the row
   * as it is now, not on the caller's copy, which another run (the cron route and the `after()`
   * fallback, or an admin Retry during a cycle) may have overtaken:
   * - FAILED: the payout was given up (released, emptied, or handed back below the minimum)
   *   while money left for it, so its commissions may be paid again: a `released` alert;
   * - COMPLETED: another run finished it, nothing to say, unless the group holds more than one
   *   live transfer (a double payment: `duplicate`);
   * - unreadable: the caller's copy decides, as before.
   */
  private async reportRefusedCompletion(
    payout: AffiliatePayoutRow,
    transfer: AffiliateStripeTransferLike,
    activeCount: number
  ): Promise<void> {
    let current: AffiliatePayoutRow = payout;
    try {
      current = (await this.loadPayout(payout.id)) ?? payout;
    } catch (error) {
      this.recordError('load', error, { payoutId: payout.id, affiliateId: payout.affiliate_id });
    }
    let kind: AffiliatePayoutTransferMismatchEvent['kind'] | null = null;
    if (current.status === 'FAILED') kind = 'released';
    else if (current.status === 'COMPLETED' && activeCount > 1) kind = 'duplicate';
    if (!kind) return;
    const mismatch = kind;
    await this.runHook(() =>
      this.hooks.onTransferMismatch?.({ payout: current, transfer, kind: mismatch, activeTransfers: activeCount })
    );
  }

  private async reportMismatch(payout: AffiliatePayoutRow, transfer: AffiliateStripeTransferLike, activeCount: number): Promise<void> {
    let kind: AffiliatePayoutTransferMismatchEvent['kind'] | null = null;
    if (activeCount > 1) kind = 'duplicate';
    else if (typeof transfer.currency === 'string' && transfer.currency.toUpperCase() !== payout.currency.toUpperCase()) kind = 'currency';
    else if (transfer.amount !== payout.amount_cents) kind = 'amount';
    if (!kind) return;
    const mismatch = kind;
    await this.runHook(() => this.hooks.onTransferMismatch?.({ payout, transfer, kind: mismatch, activeTransfers: activeCount }));
  }

  private completedRow(payout: AffiliatePayoutRow, transferId: string): AffiliatePayoutRow {
    return { ...payout, status: 'COMPLETED', stripe_transfer_id: transferId, failure_reason: null, paid_at: this.nowIso() };
  }

  private failedRow(payout: AffiliatePayoutRow, reason: string): AffiliatePayoutRow {
    return { ...payout, status: 'FAILED', failure_reason: reason };
  }

  /* ----------------------------------------------------------------- transfer --- */

  /**
   * Sends one claimed (PROCESSING) payout. Definitive refusal: FAILED with Stripe's code.
   * Unknown outcome, or a transfer Stripe accepted that could not be recorded: left PROCESSING.
   */
  async attemptTransfer(payout: AffiliatePayoutRow): Promise<AffiliatePayoutTransferOutcome> {
    const ids = { payoutId: payout.id, affiliateId: payout.affiliate_id };
    let transfer: AffiliateStripeTransferLike;
    try {
      transfer = await createAffiliatePayoutTransfer(this.stripe, payout);
      this.noteStripeAnswer();
    } catch (error) {
      const reason = affiliateStripeErrorCode(error);
      if (classifyAffiliateStripeError(error) !== 'definitive') {
        this.noteStripeFailure(error);
        this.recordError('transfer', error, ids);
        this.summary.pending += 1;
        return { kind: 'pending', reason, transferId: null };
      }

      this.noteStripeAnswer();
      if (reason === 'balance_insufficient') {
        this.noteShortfall(payout.currency, payout.amount_cents);
        // Our balance estimate was wrong; stop sending in this currency for this call.
        this.balance?.set(payout.currency.toUpperCase(), 0);
      }
      let failed: boolean;
      try {
        failed = await failAffiliatePayoutViaRpc(this.supabase, payout.id, reason);
      } catch (failError) {
        // Still PROCESSING: the stale reconciliation fails it later (no transfer exists).
        this.recordError('fail', failError, ids);
        this.summary.pending += 1;
        return { kind: 'pending', reason, transferId: null };
      }
      if (failed) {
        this.summary.failed += 1;
        const exhausted = payout.attempt_count >= this.maxAttempts;
        if (!isAffiliatePayoutTransientFailureReason(reason) || exhausted) {
          await this.runHook(() =>
            this.hooks.onPayoutFailed?.({ payout: this.failedRow(payout, reason), reason, exhausted })
          );
        }
      }
      return { kind: 'failed', reason };
    }

    this.debit(payout.currency, payout.amount_cents);
    let completed: boolean;
    try {
      completed = await completeAffiliatePayoutViaRpc(this.supabase, payout.id, transfer.id);
    } catch (error) {
      // The money left; the next cycle's reconciliation finds the transfer and completes the row.
      this.recordError('complete', error, ids);
      this.summary.pending += 1;
      return { kind: 'pending', reason: 'complete_failed', transferId: transfer.id };
    }
    if (!completed) {
      this.summary.pending += 1;
      return { kind: 'pending', reason: 'complete_refused', transferId: transfer.id };
    }

    const done = this.completedRow(payout, transfer.id);
    this.summary.sent += 1;
    await this.runHook(() => this.hooks.onPayoutSent?.({ payout: done, transferId: transfer.id, via: 'transfer' }));
    await this.reportMismatch(done, transfer, 1);
    return { kind: 'sent', transferId: transfer.id };
  }

  /* -------------------------------------------------------------------- retry --- */

  /**
   * Retries a FAILED payout (B1): reconcile first (a transfer found completes the payout instead),
   * then the partner's eligibility, Connect readiness and the platform balance, then
   * `prepare_affiliate_payout_retry` (attempt_count + 1, fresh amount and destination) and the
   * transfer with that attempt's idempotency key. A payout of the other key mode is never
   * retried. `minAmountCents` (automatic retries: the program minimum; an admin retry: none)
   * hands a payout whose refunds left less than that back to the cleared balance instead of
   * sending it (`below_minimum`).
   */
  async retry(
    payout: AffiliatePayoutRow,
    options: { profile?: AffiliateProfileRow | null; skipReconcile?: boolean; minAmountCents?: number } = {}
  ): Promise<AffiliatePayoutRetryOutcome> {
    const ids = { payoutId: payout.id, affiliateId: payout.affiliate_id };
    // A manual (02036) or PayPal (02037) payout is never sent through Stripe.
    if ((payout.method ?? 'stripe_connect') !== 'stripe_connect' || this.isOtherMode(payout)) return { kind: 'skipped', reason: 'other_mode' };
    if (!options.skipReconcile) {
      const reconciled = await this.reconcile(payout, { failStale: false });
      if (reconciled.kind === 'completed') return { kind: 'completed', transferId: reconciled.transferId };
      if (reconciled.kind === 'transfer_unusable') return { kind: 'skipped', reason: 'transfer_unusable' };
      if (reconciled.kind === 'other_mode') return { kind: 'skipped', reason: 'other_mode' };
      if (reconciled.kind === 'error') return { kind: 'skipped', reason: 'reconcile_failed' };
    }

    let profile = options.profile ?? null;
    if (!profile) {
      try {
        profile = (await this.loadProfiles([payout.affiliate_id])).get(payout.affiliate_id) ?? null;
      } catch (error) {
        this.recordError('load', error, ids);
        return { kind: 'skipped', reason: 'unknown' };
      }
    }
    if (!profile || profile.status !== 'ACTIVE' || !profile.first_published_at || !profile.stripe_connect_account_id) {
      return { kind: 'skipped', reason: 'not_eligible' };
    }

    const readiness = await this.readinessFor(profile);
    if (!readiness.ready) {
      this.countNotReady(profile.id);
      return { kind: 'skipped', reason: 'account_not_ready' };
    }

    if (!this.covers(payout.currency, payout.amount_cents)) {
      this.noteShortfall(payout.currency, payout.amount_cents);
      this.summary.skippedInsufficientBalance += 1;
      return { kind: 'skipped', reason: 'balance_insufficient' };
    }

    let prepared: AffiliatePayoutRow | null;
    try {
      prepared = await prepareAffiliatePayoutRetryViaRpc(this.supabase, payout.id, options.minAmountCents ?? 0);
    } catch (error) {
      this.recordError('retry_payouts', error, ids);
      return { kind: 'skipped', reason: 'unknown' };
    }
    if (!prepared) {
      let current: AffiliatePayoutRow | null = null;
      try {
        current = await this.loadPayout(payout.id);
      } catch (error) {
        this.recordError('load', error, ids);
      }
      if (current?.failure_reason === 'below_minimum') {
        this.summary.skippedBelowMinimum += 1;
        return { kind: 'skipped', reason: 'below_minimum' };
      }
      return { kind: 'skipped', reason: current?.failure_reason === 'nothing_to_pay' ? 'nothing_to_pay' : 'not_eligible' };
    }

    this.summary.retried += 1;
    return this.attemptTransfer(prepared);
  }
}
