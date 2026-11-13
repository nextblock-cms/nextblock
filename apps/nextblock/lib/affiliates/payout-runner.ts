import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { getStripeClient, StripeNotConfiguredError } from '@nextblock-cms/ecommerce/server';
import {
  AFFILIATE_ALERT_TYPES,
  AFFILIATE_CMS_STRIPE_PATH,
  affiliateGatewaysPaidByStripe,
  formatAffiliateMoney,
  type AffiliateGateway,
  type AffiliatePayoutRow,
} from '@nextblock-cms/affiliates';
import {
  AFFILIATE_PAYOUT_STALE_AFTER_MS,
  affiliatePayoutRunDate,
  affiliateStripeErrorCode,
  claimAffiliatePayoutRunViaRpc,
  createAffiliatePayoutCycleSummary,
  finishAffiliatePayoutRunViaRpc,
  getAffiliatePlatformAccountInfo,
  isAffiliateStripeAuthenticationError,
  isAffiliateStripePermissionError,
  mergeAffiliatePayoutRunSummary,
  readAffiliatePayoutRunSummary,
  readAffiliateTransferableBalance,
  releaseAffiliatePayout,
  retryAffiliatePayout,
  runAffiliateLedgerRepair,
  runAffiliatePayoutCycle,
  type AffiliatePayoutActionResult,
  type AffiliatePayoutCycleSummary,
  type AffiliatePayoutHooks,
  type AffiliatePayoutShortfall,
  type AffiliatePayoutTransferMismatchEvent,
  type AffiliatePlatformAccountInfo,
  type AffiliatesStripeLike,
} from '@nextblock-cms/affiliates/server';
import { requireCmsAdmin } from '../auth/cms-actor';
import { z } from '../zod-config';
import {
  notifyAffiliateLifecycle,
  scheduleAffiliateNotification,
  sweepAffiliateCommissionNotifications,
  sweepAffiliateRefundAlertEmails,
} from './notify';
import { readAffiliatesSettingsStrict } from './settings';
import { isAffiliatesProgramActive } from './package-state';
import type { AffiliatePayPalRunSummary } from './paypal/engine';
import { runAffiliatePayPalStep } from './paypal/runner';

/**
 * Runs the automated affiliate payouts (SPEC §10 W2-PAYOUTS; ADDENDUM B1, B2, B3, B8) with the
 * app's clients: the service-role Supabase client (the payout RPCs are revoked from every API
 * role), `getStripeClient()` from the ecommerce lib (DB-first secret key) and the lifecycle
 * notifier. Three ways in, none of which authorizes a browser session by itself:
 *
 * - `maybeRunAffiliatePayouts()`: the daily fallback the CMS and portal layouts schedule in
 *   `after()`. Fast unless a run is due; claims the UTC day (`claim_affiliate_payout_run`) or
 *   continues the day's run while partners are left; never throws.
 * - `runAffiliatePayoutCycleNow('cron' | 'admin')`: the cron route (after its CRON_SECRET check)
 *   and the CMS "Run payouts now" button (re-checks ADMIN itself).
 * - `retryAffiliatePayoutNow` / `releaseAffiliatePayoutNow`: the CMS payout actions (re-check ADMIN).
 *
 * Every one of them checks the Affiliates package itself (a server action is a POST endpoint of
 * its own, whatever page it came from), and reads the program settings strictly: a run is
 * skipped when they cannot be read, never paid with defaults. The sandbox
 * (`NEXT_PUBLIC_IS_SANDBOX=true`) never creates transfers or Connect accounts.
 *
 * Gateways paid by hand (02036, `affiliates_settings.payoutMethods`): the cycle claims only the
 * gateways routed to Stripe (`affiliateGatewaysPaidByStripe`). When none is, when no Stripe key is
 * configured, or while automatic payouts are off (the switch stops Stripe transfers only), the
 * daily run is the ledger repair alone (`runAffiliateLedgerRepair`: missed commissions recorded,
 * cleared ones promoted, the "you earned" sweep) without asking Stripe, so commissions clear on a
 * store that pays its partners from PayPal or Interac whatever the switch says. Such a day is
 * claimed with the trigger `repair`: once Stripe transfers can run (the switch turned on, a key
 * added, a gateway back on Stripe), the `after()` fallback takes the day over for them instead of
 * waiting for the next one, and an explicit Stripe run marks the day as its own. Retry and Release
 * act on Stripe payouts and still need Stripe.
 *
 * Gateways paid with PayPal (02037): every run ends with the PayPal step (`paypal/runner.ts`). It
 * checks the PayPal payouts in flight with PayPal whatever the switch says (the books follow PayPal's
 * answer), and claims and sends new PayPal payouts only while automatic payouts are on (the daily run,
 * the cron route) or for "Run payouts now"; never on the sandbox. It needs no Stripe client.
 */

type AnyClient = SupabaseClient<any>;

/** Why a run did nothing (or, for `stripe_not_configured` / `unavailable`, only the ledger repair). */
export type AffiliatePayoutRunSkip =
  | 'sandbox'
  | 'package_inactive'
  | 'settings_unavailable'
  | 'stripe_not_configured'
  | 'disabled'
  | 'unavailable'
  | 'already_running';

/**
 * What became of the Stripe side of an explicit run: `ran` (the payout cycle ran), `not_needed`
 * (no gateway's commissions are paid through Stripe: the ledger repair alone, nothing skipped) or
 * `skipped` (see `skipped`; with `stripe_not_configured` or `unavailable` the repair still ran).
 */
export type AffiliatePayoutRunStripeTransfers = 'ran' | 'not_needed' | 'skipped';

export type AffiliatePayoutRunNowSummary = AffiliatePayoutCycleSummary & {
  skipped: AffiliatePayoutRunSkip | null;
  stripeTransfers: AffiliatePayoutRunStripeTransfers;
  /** The PayPal step (02037): null when it did not run (a skipped run, the sandbox). */
  paypal: AffiliatePayPalRunSummary | null;
};

export type AffiliateStripeResolution =
  | { ok: true; stripe: AffiliatesStripeLike }
  | { ok: false; error: 'sandbox' | 'stripe_not_configured' | 'unknown' };

export interface AffiliatePayoutPlatformInfo {
  /** A Stripe secret key is configured; null when the client could not be built for another reason. */
  stripeConfigured: boolean | null;
  sandbox: boolean;
  /** ISO country of the platform's Stripe account. */
  platformCountry: string | null;
  /** Settlement currency of the platform's Stripe account (uppercase). */
  platformDefaultCurrency: string | null;
  /** `currencies.is_default`: the currency commissions are recorded and paid in. */
  storeBaseCurrency: string | null;
  /** The CMS warns: transfers need a balance in the store currency. */
  currencyMismatch: boolean;
  /** Mode of the configured key (from the balance), null when Stripe could not be asked. */
  livemode: boolean | null;
  /** Total available platform balance per currency (minor units), null when Stripe could not be asked. */
  available: Array<{ currency: string; amount: number }> | null;
  /** What a transfer may draw now: the available `card`-source balance per currency (the cycle's rule). */
  transferable: Array<{ currency: string; amount: number }> | null;
  /** The pending `card`-source balance per currency: transferable once Stripe settles it. */
  pending: Array<{ currency: string; amount: number }> | null;
  /**
   * Why Stripe facts are missing: `stripe_authentication` (Stripe rejected the key),
   * `stripe_permission` (a restricted key lacks a permission) or `stripe_unavailable`; null when
   * every read worked, no key is configured, or this is the sandbox.
   */
  error: 'stripe_authentication' | 'stripe_permission' | 'stripe_unavailable' | null;
}

/**
 * `affiliate_payout_runs.trigger` of a day whose run was the ledger repair alone (no Stripe
 * transfer: automatic payouts off, no gateway on Stripe, or no key). A Stripe-capable run takes such
 * a day over instead of treating it as done.
 */
export const AFFILIATE_PAYOUT_REPAIR_ONLY_TRIGGER = 'repair';

/** Re-check of an automatic run at most this often per instance. */
const AUTO_CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** After a repair-only day (no Stripe transfer), look again this often for transfers to run. */
const REPAIR_ONLY_RECHECK_MS = 60 * 60 * 1000;
/** A run with partners left is continued this long after its last call finished. */
const CONTINUE_AFTER_MS = AFFILIATE_PAYOUT_STALE_AFTER_MS;
/** A claimed run that never finished is taken over after this long (the instance died). */
const ABANDONED_RUN_MS = 30 * 60 * 1000;
/** The `after()` fallback runs inside a page request: keep its Stripe work short. */
const AUTO_TIME_BUDGET_MS = 20_000;
/** Cron route and admin button (route maxDuration 60 s). */
const NOW_TIME_BUDGET_MS = 45_000;
const NOW_MAX_PASSES = 8;
/** The PayPal step of the `after()` fallback (02037), after the Stripe work. */
const PAYPAL_AUTO_TIME_BUDGET_MS = 15_000;
/** An explicit run's PayPal step gets what is left of the route's 60 s, at least 5 s and at most 30 s. */
const PAYPAL_NOW_DEADLINE_MS = 52_000;
const PLATFORM_INFO_TTL_MS = 10 * 60 * 1000;

const payoutIdSchema = z.string().trim().min(1).max(64).pipe(z.uuid());

const autoState: { inFlight: Promise<void> | null; nextCheckAt: number; doneForDay: string | null } = {
  inFlight: null,
  nextCheckAt: 0,
  doneForDay: null,
};

/** An explicit (cron / admin) run in progress on this instance. */
let explicitRunInFlight = false;

let platformInfoCache: { stripe: AffiliatesStripeLike; info: AffiliatePlatformAccountInfo; expiresAt: number } | null = null;

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 299)}…` : message;
}

function serviceClient(): AnyClient {
  return getServiceRoleSupabaseClient() as unknown as AnyClient;
}

/** Payouts and Connect are off in the public sandbox (B3). */
export function isAffiliatePayoutSandbox(): boolean {
  return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
}

/** The package gate of every payout entry point; a failed check counts as inactive (fails closed). */
async function isAffiliatesPackageActive(): Promise<boolean> {
  try {
    return await isAffiliatesProgramActive();
  } catch {
    return false;
  }
}

/** The Stripe client for payouts and Connect, or why there is none. Never throws. */
export async function resolveAffiliateStripeClient(): Promise<AffiliateStripeResolution> {
  if (isAffiliatePayoutSandbox()) return { ok: false, error: 'sandbox' };
  try {
    const stripe: AffiliatesStripeLike = await getStripeClient();
    return { ok: true, stripe };
  } catch (error) {
    if (error instanceof StripeNotConfiguredError || (error instanceof Error && error.name === 'StripeNotConfiguredError')) {
      return { ok: false, error: 'stripe_not_configured' };
    }
    console.warn('[affiliates] Could not create the Stripe client:', describeError(error));
    return { ok: false, error: 'unknown' };
  }
}

/**
 * The platform's country, settlement currency and key mode, cached per instance for 10 minutes
 * and per Stripe client (a rotated key builds a new client, so the cache follows it).
 */
export async function getCachedAffiliatePlatformInfo(stripe: AffiliatesStripeLike): Promise<AffiliatePlatformAccountInfo> {
  const now = Date.now();
  if (platformInfoCache && platformInfoCache.stripe === stripe && platformInfoCache.expiresAt > now) {
    return platformInfoCache.info;
  }
  const info = await getAffiliatePlatformAccountInfo(stripe);
  platformInfoCache = { stripe, info, expiresAt: now + PLATFORM_INFO_TTL_MS };
  return info;
}

/* ------------------------------------------------------------- notifications --- */

/** English (CMS) wording of a failure code for the admin alert and email. */
function describeFailure(reason: string): string {
  switch (reason) {
    case 'balance_insufficient':
      return 'The Stripe balance could not cover the transfer (balance_insufficient).';
    case 'stale':
      return 'No transfer reached Stripe after repeated attempts (stale).';
    case 'account_invalid':
    case 'transfers_not_allowed':
    case 'capability_not_active':
    case 'insufficient_capabilities_for_transfer':
      return `The partner's Stripe account cannot receive transfers (${reason}).`;
    case 'amount_too_small':
      return 'Stripe refused the amount as too small (amount_too_small).';
    default:
      return `Stripe refused the transfer (${reason}).`;
  }
}

function money(amountCents: number, currency: string): string {
  try {
    return formatAffiliateMoney(amountCents, currency, 'en');
  } catch {
    return `${amountCents} ${currency}`;
  }
}

function describeMismatch(event: AffiliatePayoutTransferMismatchEvent): string {
  const transfer = event.transfer;
  const sent = money(Number(transfer.amount), String(transfer.currency || event.payout.currency).toUpperCase());
  const expected = money(event.payout.amount_cents, event.payout.currency);
  switch (event.kind) {
    case 'duplicate':
      return `Stripe holds ${event.activeTransfers} transfers for this payout (transfer group affiliate_payout_${event.payout.id}). Reverse the extra transfer in Stripe.`;
    case 'released':
      return `Stripe transfer ${transfer.id} (${sent}) exists for a payout that was released, emptied or handed back below the minimum; its commissions may be paid again. Check Stripe before the next payout.`;
    case 'currency':
    case 'amount':
    default:
      return `Completed by reconciliation, but Stripe transfer ${transfer.id} moved ${sent} instead of ${expected}. Check the transfer in Stripe.`;
  }
}

function payoutPayload(payout: AffiliatePayoutRow, extra: { transferId?: string | null; reason?: string | null } = {}) {
  return {
    affiliateId: payout.affiliate_id,
    payout: {
      payoutId: payout.id,
      amountCents: payout.amount_cents,
      currency: payout.currency,
      transferId: extra.transferId ?? payout.stripe_transfer_id ?? null,
      reason: extra.reason ?? null,
    },
  };
}

/**
 * How the insufficient-balance alert ends. Only the automatic run tries again by itself: the cron
 * route and the `after()` fallback skip while automatic payouts are off, and an admin's "Run
 * payouts now" works with them off too, so a retry is promised only while they are on. Null (not
 * known to the caller) gives the rule instead.
 */
function insufficientBalanceNextStep(autoPayoutsEnabled: boolean | null): string {
  if (autoPayoutsEnabled === true) return 'The next automatic payout run tries again.';
  if (autoPayoutsEnabled === false) return 'Automatic payouts are off: run payouts again once the balance is funded.';
  return 'The next automatic payout run tries again while automatic payouts are on; otherwise run payouts again once the balance is funded.';
}

/**
 * B2: one `affiliate_payout_failed` alert per UTC day for a short platform balance (the run
 * summary tracks the day; an unresolved alert of the same day also counts). True when an alert
 * exists afterwards.
 */
async function recordInsufficientBalanceAlert(
  db: AnyClient,
  runDate: string,
  shortfalls: AffiliatePayoutShortfall[],
  autoPayoutsEnabled: boolean | null
): Promise<boolean> {
  try {
    const { data: existing, error: lookupError } = await db
      .from('system_alerts')
      .select('id')
      .eq('alert_type', AFFILIATE_ALERT_TYPES.PAYOUT_FAILED)
      .eq('is_resolved', false)
      .eq('metadata->>kind', 'insufficient_balance')
      .eq('metadata->>run_date', runDate)
      .limit(1);
    if (!lookupError && Array.isArray(existing) && existing.length > 0) return true;

    const details = shortfalls
      .slice(0, 5)
      .map((shortfall) => `${money(shortfall.requiredCents, shortfall.currency)} waiting, ${money(shortfall.availableCents, shortfall.currency)} available`)
      .join('; ');
    const { error } = await db.from('system_alerts').insert({
      alert_type: AFFILIATE_ALERT_TYPES.PAYOUT_FAILED,
      title: 'Insufficient Stripe balance for affiliate payouts',
      message: `Affiliate payouts are waiting for funds (${details}). Stripe sends your available balance to your bank on its payout schedule: keep a minimum balance in Stripe or switch your Stripe payouts to manual (Stripe Dashboard > Settings > Payouts). Freemius sales never add money to your Stripe balance. ${insufficientBalanceNextStep(autoPayoutsEnabled)}`.slice(
        0,
        2000
      ),
      metadata: {
        kind: 'insufficient_balance',
        run_date: runDate,
        shortfalls: shortfalls.slice(0, 5).map((shortfall) => ({ ...shortfall })),
        action_url: AFFILIATE_CMS_STRIPE_PATH,
        action_label: 'Open Stripe payouts',
      },
    });
    if (error) {
      console.warn('[affiliates] Could not record the insufficient-balance alert:', error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[affiliates] Could not record the insufficient-balance alert:', describeError(error));
    return false;
  }
}

/** `autoPayoutsEnabled`: the program setting the run read (null where no run calls the balance hook: Retry and Release). */
function payoutHooks(db: AnyClient, runDate: string, autoPayoutsEnabled: boolean | null): AffiliatePayoutHooks {
  return {
    sweepCommissionNotifications: async () => {
      const claimed = await sweepAffiliateCommissionNotifications(50);
      // Refund-after-payout alerts raised since the last run on paths with no sweep of their own
      // (a CMS order status change, a deleted order). Never throws.
      await sweepAffiliateRefundAlertEmails();
      return claimed;
    },
    onPayoutSent: ({ payout, transferId }) => {
      scheduleAffiliateNotification(() => notifyAffiliateLifecycle('PAYOUT_SENT', payoutPayload(payout, { transferId })));
    },
    onPayoutFailed: ({ payout, reason }) => {
      scheduleAffiliateNotification(() =>
        notifyAffiliateLifecycle('PAYOUT_FAILED', payoutPayload(payout, { reason: describeFailure(reason) }))
      );
    },
    onTransferMismatch: (event) => {
      scheduleAffiliateNotification(() =>
        notifyAffiliateLifecycle(
          'PAYOUT_FAILED',
          payoutPayload(event.payout, { transferId: event.transfer.id, reason: describeMismatch(event) })
        )
      );
    },
    onConnectFirstReady: (affiliateId) => {
      scheduleAffiliateNotification(() => notifyAffiliateLifecycle('PAYOUT_CONFIGURED', { affiliateId }));
    },
    onInsufficientBalance: (shortfalls) => recordInsufficientBalanceAlert(db, runDate, shortfalls, autoPayoutsEnabled),
    onError: (error, cause) => {
      console.warn(
        `[affiliates] Payout ${error.step} problem (${error.code})${error.payoutId ? ` payout ${error.payoutId}` : ''}:`,
        describeError(cause)
      );
    },
  };
}

/* ------------------------------------------------------------------- run days --- */

interface PayoutRunRow {
  run_date: string;
  trigger: string | null;
  started_at: string | null;
  finished_at: string | null;
  summary: unknown;
}

async function readPayoutRun(db: AnyClient, runDate: string): Promise<PayoutRunRow | null> {
  const { data, error } = await db
    .from('affiliate_payout_runs')
    .select('run_date, trigger, started_at, finished_at, summary')
    .eq('run_date', runDate)
    .maybeSingle();
  if (error) throw new Error('Could not read the payout run.', { cause: error });
  return (data as PayoutRunRow | null) ?? null;
}

async function saveRun(db: AnyClient, runDate: string, previousSummary: unknown, summary: AffiliatePayoutCycleSummary) {
  const merged = mergeAffiliatePayoutRunSummary(previousSummary, summary);
  try {
    await finishAffiliatePayoutRunViaRpc(db, runDate, merged as unknown as Record<string, unknown>);
  } catch (error) {
    console.warn('[affiliates] Could not record the payout run:', describeError(error));
  }
  return merged;
}

type RunDecision =
  | { kind: 'done' }
  | { kind: 'wait'; until: number }
  | { kind: 'continue' }
  | { kind: 'take_over' };

function decideOnClaimedRun(run: PayoutRunRow, nowMs: number): RunDecision {
  if (!run.finished_at) {
    const started = run.started_at ? Date.parse(run.started_at) : Number.NaN;
    if (Number.isFinite(started) && nowMs - started < ABANDONED_RUN_MS) return { kind: 'wait', until: started + ABANDONED_RUN_MS };
    return { kind: 'take_over' };
  }
  const summary = readAffiliatePayoutRunSummary(run.summary);
  if (!summary || summary.remaining <= 0 || summary.aborted) return { kind: 'done' };
  const finished = Date.parse(run.finished_at);
  if (Number.isFinite(finished) && nowMs - finished < CONTINUE_AFTER_MS) return { kind: 'wait', until: finished + CONTINUE_AFTER_MS };
  return { kind: 'continue' };
}

/**
 * Conditional update: only one instance continues (or takes over) the day's run. `trigger` renames
 * the day (a repair-only day taken over for Stripe transfers becomes `auto`).
 */
async function takeRun(
  db: AnyClient,
  run: PayoutRunRow,
  decision: 'continue' | 'take_over',
  nowIso: string,
  trigger?: string
): Promise<boolean> {
  const changes: Record<string, unknown> = decision === 'continue' ? { finished_at: null, started_at: nowIso } : { started_at: nowIso };
  if (trigger) changes['trigger'] = trigger;
  let query = db.from('affiliate_payout_runs').update(changes).eq('run_date', run.run_date);
  if (decision === 'continue') {
    query = query.eq('finished_at', run.finished_at);
  } else {
    query = query.is('finished_at', null);
    query = run.started_at ? query.eq('started_at', run.started_at) : query.is('started_at', null);
  }
  const { data, error } = await query.select('run_date');
  if (error) throw new Error('Could not continue the payout run.', { cause: error });
  return Array.isArray(data) && data.length > 0;
}

async function runAutoPayoutsIfDue(today: string, knownActive: boolean): Promise<void> {
  if (!knownActive && !(await isAffiliatesPackageActive())) return;

  // Unreadable settings: no run (the next check comes in 5 minutes), never one with defaults.
  const settings = await readAffiliatesSettingsStrict();
  if (!settings) return;

  // 02036: only the gateways paid through Stripe need Stripe, and only while automatic payouts are on
  // (the switch stops Stripe transfers, never the clearing). With none of them, the switch off or no
  // Stripe key, the day's run is the ledger repair alone: commissions still clear and missed ones are
  // recorded on a store paying by hand.
  const stripeGateways = settings.autoPayoutsEnabled ? affiliateGatewaysPaidByStripe(settings) : [];
  let stripe: AffiliatesStripeLike | null = null;
  if (stripeGateways.length > 0) {
    const resolved = await resolveAffiliateStripeClient();
    if (resolved.ok) stripe = resolved.stripe;
    // A client that failed for another reason may be transient: try again at the next check.
    else if (resolved.error !== 'stripe_not_configured') return;
  }

  const db = serviceClient();
  let previousSummary: unknown = null;
  let skipCheckedSince: string | null = null;

  if (!(await claimAffiliatePayoutRunViaRpc(db, today, stripe ? 'auto' : AFFILIATE_PAYOUT_REPAIR_ONLY_TRIGGER))) {
    const run = await readPayoutRun(db, today);
    if (!run) return;
    // Every run starts with the ledger repair: today's already did it (or is doing it). Check again
    // later in case Stripe transfers become possible today.
    if (!stripe) {
      autoState.nextCheckAt = Math.max(autoState.nextCheckAt, Date.now() + REPAIR_ONLY_RECHECK_MS);
      return;
    }
    if (run.trigger === AFFILIATE_PAYOUT_REPAIR_ONLY_TRIGGER && run.finished_at) {
      // Today's run was the repair alone, and Stripe transfers can run now (the switch turned on, a key
      // added, a gateway back on Stripe): take the day over for them. A fresh summary, so no partner is
      // skipped as "checked earlier in this run" by a run that never checked anyone.
      if (!(await takeRun(db, run, 'continue', new Date().toISOString(), 'auto'))) return;
    } else {
      const decision = decideOnClaimedRun(run, Date.now());
      if (decision.kind === 'done') {
        autoState.doneForDay = today;
        return;
      }
      if (decision.kind === 'wait') {
        autoState.nextCheckAt = Math.max(autoState.nextCheckAt, decision.until);
        return;
      }
      // An abandoned repair-only run taken over for Stripe work is renamed too, or every later check
      // would take the day over again.
      const rename = run.trigger === AFFILIATE_PAYOUT_REPAIR_ONLY_TRIGGER ? 'auto' : undefined;
      if (!(await takeRun(db, run, decision.kind, new Date().toISOString(), rename))) return;
      previousSummary = run.summary;
      skipCheckedSince = readAffiliatePayoutRunSummary(run.summary)?.firstStartedAt ?? run.started_at ?? null;
    }
  }

  const previous = readAffiliatePayoutRunSummary(previousSummary);
  const hooks = payoutHooks(db, today, settings.autoPayoutsEnabled);
  const summary = stripe
    ? await runAffiliatePayoutCycle({
        supabase: db,
        stripe,
        trigger: 'auto',
        minPayoutCents: settings.minPayoutCents,
        timeBudgetMs: AUTO_TIME_BUDGET_MS,
        skipCheckedSince,
        insufficientBalanceAlerted: Boolean(previous?.insufficientBalanceAlertedAt),
        gateways: stripeGateways,
        hooks,
      })
    : await runAffiliateLedgerRepair({ supabase: db, trigger: 'auto', hooks });
  await saveRun(db, today, previousSummary, summary);
  // 02037: PayPal payouts in flight are checked with PayPal; new ones go out while automatic payouts are on.
  await runAffiliatePayPalStep({ trigger: 'auto', settings, send: settings.autoPayoutsEnabled, timeBudgetMs: PAYPAL_AUTO_TIME_BUDGET_MS });

  if (!stripe) {
    // A repair-only day: transfers may become possible later today (the switch, a key, a gateway).
    autoState.nextCheckAt = Date.now() + REPAIR_ONLY_RECHECK_MS;
  } else if (summary.remaining > 0 && !summary.aborted) {
    autoState.nextCheckAt = Date.now() + CONTINUE_AFTER_MS;
  } else {
    autoState.doneForDay = today;
  }
}

/**
 * The daily payout fallback for installs without a scheduler: call it from `after()` in the CMS
 * and portal layouts. Returns at once unless a run is due (package active — pass what the caller
 * already knows —, not the sandbox, and a Stripe client that did not fail for a transient reason
 * when one is needed); then claims the UTC day or continues the day's run (partners left, last
 * call finished 15+ minutes ago). With automatic payouts off, no gateway paid through Stripe, or no
 * Stripe key, the day's run is the ledger repair alone (claimed as `repair`, taken over for Stripe
 * transfers if they become possible later that day). One run per instance at a time. Never throws.
 */
export async function maybeRunAffiliatePayouts(isAffiliatesActive?: boolean): Promise<void> {
  try {
    if (autoState.inFlight) return;
    if (isAffiliatePayoutSandbox() || isAffiliatesActive === false) return;
    const nowMs = Date.now();
    const today = affiliatePayoutRunDate(new Date(nowMs));
    if (autoState.doneForDay === today || nowMs < autoState.nextCheckAt) return;
    autoState.nextCheckAt = nowMs + AUTO_CHECK_INTERVAL_MS;

    const run = runAutoPayoutsIfDue(today, isAffiliatesActive === true);
    autoState.inFlight = run;
    try {
      await run;
    } finally {
      autoState.inFlight = null;
    }
  } catch (error) {
    console.warn('[affiliates] Automated payout run failed:', describeError(error));
  }
}

/* ------------------------------------------------------------ explicit runs --- */

function addSummaries(total: AffiliatePayoutCycleSummary, next: AffiliatePayoutCycleSummary): AffiliatePayoutCycleSummary {
  const shortfalls = new Map(total.insufficientBalance.map((shortfall) => [shortfall.currency, { ...shortfall }]));
  for (const shortfall of next.insufficientBalance) {
    const existing = shortfalls.get(shortfall.currency);
    if (existing) {
      existing.requiredCents = Math.max(existing.requiredCents, shortfall.requiredCents);
      existing.availableCents = Math.min(existing.availableCents, shortfall.availableCents);
    } else {
      shortfalls.set(shortfall.currency, { ...shortfall });
    }
  }
  return {
    ...next,
    startedAt: total.startedAt,
    livemode: next.livemode ?? total.livemode,
    recorded: total.recorded + next.recorded,
    voided: total.voided + next.voided,
    promoted: total.promoted + next.promoted,
    notified: total.notified + next.notified,
    reconciled: total.reconciled + next.reconciled,
    claimed: total.claimed + next.claimed,
    sent: total.sent + next.sent,
    failed: total.failed + next.failed,
    pending: total.pending + next.pending,
    retried: total.retried + next.retried,
    skippedNotReady: total.skippedNotReady + next.skippedNotReady,
    skippedBelowMinimum: Math.max(total.skippedBelowMinimum, next.skippedBelowMinimum),
    skippedInsufficientBalance: Math.max(total.skippedInsufficientBalance, next.skippedInsufficientBalance),
    insufficientBalance: [...shortfalls.values()],
    insufficientBalanceAlerted: total.insufficientBalanceAlerted || next.insufficientBalanceAlerted,
    errors: [...total.errors, ...next.errors].slice(0, 50),
  };
}

/**
 * One payout run now, for the cron route (trigger `cron`, after its CRON_SECRET check; with
 * "automatic payouts" off it sends no Stripe transfer but still runs the ledger repair, reported as
 * `skipped: 'disabled'`) and the CMS "Run payouts now" button (trigger `admin`; re-checks the ADMIN
 * itself and runs even when automatic payouts are off). No day claim gates it: the day row is only
 * recorded so the `after()` fallback does not run again today. Passes of up to 25 partners repeat
 * while partners are left and time allows. A second explicit run on the same instance while one is
 * in progress is skipped (`already_running`). Skipped too while the Affiliates package is inactive
 * (`package_inactive`, for both triggers: the CMS button is a server action anyone with an open tab
 * can still post) and while the program settings cannot be read (`settings_unavailable`). With no
 * gateway paid through Stripe (02036) the run is the ledger repair alone (`stripeTransfers:
 * 'not_needed'`, nothing skipped); with Stripe needed but not configured or unreachable it is the
 * repair too, reported as skipped (`stripe_not_configured` / `unavailable`). Throws only
 * `Unauthorized` / `Forbidden` for a non-admin `admin` call.
 */
export async function runAffiliatePayoutCycleNow(trigger: 'admin' | 'cron'): Promise<AffiliatePayoutRunNowSummary> {
  if (trigger === 'admin') await requireCmsAdmin();

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const skipped = (reason: AffiliatePayoutRunSkip): AffiliatePayoutRunNowSummary => ({
    ...createAffiliatePayoutCycleSummary(trigger, startedAt),
    skipped: reason,
    stripeTransfers: 'skipped',
    paypal: null,
  });

  if (isAffiliatePayoutSandbox()) return skipped('sandbox');
  if (!(await isAffiliatesPackageActive())) return skipped('package_inactive');
  const settings = await readAffiliatesSettingsStrict();
  if (!settings) return skipped('settings_unavailable');
  // The scheduler honours the switch for Stripe transfers only: commissions still clear (02036).
  const transfersOff = trigger === 'cron' && !settings.autoPayoutsEnabled;

  const stripeGateways = transfersOff ? [] : affiliateGatewaysPaidByStripe(settings);
  let stripe: AffiliatesStripeLike | null = null;
  let stripeSkip: AffiliatePayoutRunSkip | null = transfersOff ? 'disabled' : null;
  if (stripeGateways.length > 0) {
    const resolved = await resolveAffiliateStripeClient();
    if (resolved.ok) stripe = resolved.stripe;
    else stripeSkip = resolved.error === 'unknown' ? 'unavailable' : resolved.error;
  }

  if (explicitRunInFlight) return skipped('already_running');
  explicitRunInFlight = true;
  try {
    const result = stripe
      ? await runExplicitPasses(trigger, stripe, settings.minPayoutCents, startedAt, settings.autoPayoutsEnabled, stripeGateways)
      : await runLedgerRepairNow(trigger, settings.autoPayoutsEnabled, stripeSkip);
    // 02037: the PayPal step, after the ledger repair cleared what is due. "Run payouts now" always
    // sends; the scheduler only while automatic payouts are on (it still checks PayPal either way).
    const paypal = await runAffiliatePayPalStep({
      trigger,
      settings,
      send: trigger === 'admin' || settings.autoPayoutsEnabled,
      timeBudgetMs: Math.min(30_000, Math.max(5_000, PAYPAL_NOW_DEADLINE_MS - (Date.now() - startedMs))),
    });
    return { ...result, paypal };
  } finally {
    explicitRunInFlight = false;
  }
}

/**
 * The explicit run without Stripe: the ledger repair once. The day is recorded as a repair-only day
 * (trigger `repair`: the `after()` fallback does not repeat the repair, and takes the day over if
 * Stripe transfers become possible later) unless Stripe was needed and merely unreachable, when the
 * fallback should still try the transfers later today.
 */
async function runLedgerRepairNow(
  trigger: 'admin' | 'cron',
  autoPayoutsEnabled: boolean,
  stripeSkip: AffiliatePayoutRunSkip | null
): Promise<Omit<AffiliatePayoutRunNowSummary, 'paypal'>> {
  const db = serviceClient();
  const today = affiliatePayoutRunDate();
  const recordDay = stripeSkip !== 'unavailable';
  let stored: unknown = null;
  if (recordDay) {
    try {
      await claimAffiliatePayoutRunViaRpc(db, today, AFFILIATE_PAYOUT_REPAIR_ONLY_TRIGGER);
      stored = (await readPayoutRun(db, today))?.summary ?? null;
    } catch (error) {
      console.warn('[affiliates] Could not record the payout run day:', describeError(error));
    }
  }
  const summary = await runAffiliateLedgerRepair({ supabase: db, trigger, hooks: payoutHooks(db, today, autoPayoutsEnabled) });
  if (recordDay) await saveRun(db, today, stored, summary);
  return { ...summary, skipped: stripeSkip, stripeTransfers: stripeSkip ? 'skipped' : 'not_needed' };
}

async function runExplicitPasses(
  trigger: 'admin' | 'cron',
  stripe: AffiliatesStripeLike,
  minPayoutCents: number,
  startedAt: string,
  autoPayoutsEnabled: boolean,
  gateways: readonly AffiliateGateway[]
): Promise<Omit<AffiliatePayoutRunNowSummary, 'paypal'>> {
  const db = serviceClient();
  const today = affiliatePayoutRunDate();
  let stored: unknown = null;
  try {
    await claimAffiliatePayoutRunViaRpc(db, today, trigger);
    const run = await readPayoutRun(db, today);
    stored = run?.summary ?? null;
    // Today's run so far was the repair alone: this one does the day's Stripe work, so the after()
    // fallback must not take the day over for transfers again.
    if (run?.trigger === AFFILIATE_PAYOUT_REPAIR_ONLY_TRIGGER) {
      const { error } = await db
        .from('affiliate_payout_runs')
        .update({ trigger })
        .eq('run_date', today)
        .eq('trigger', AFFILIATE_PAYOUT_REPAIR_ONLY_TRIGGER);
      if (error) throw new Error('Could not record the payout run day.', { cause: error });
    }
  } catch (error) {
    console.warn('[affiliates] Could not record the payout run day:', describeError(error));
  }

  const deadline = Date.now() + NOW_TIME_BUDGET_MS;
  let total: AffiliatePayoutCycleSummary | null = null;
  for (let pass = 0; pass < NOW_MAX_PASSES; pass += 1) {
    const alerted = Boolean(readAffiliatePayoutRunSummary(stored)?.insufficientBalanceAlertedAt) || Boolean(total?.insufficientBalanceAlerted);
    const summary = await runAffiliatePayoutCycle({
      supabase: db,
      stripe,
      trigger,
      minPayoutCents,
      timeBudgetMs: Math.max(1_000, deadline - Date.now()),
      skipCheckedSince: total ? total.startedAt : null,
      insufficientBalanceAlerted: alerted,
      gateways,
      hooks: payoutHooks(db, today, autoPayoutsEnabled),
    });
    stored = await saveRun(db, today, stored, summary);
    total = total ? addSummaries(total, summary) : summary;
    if (summary.remaining <= 0 || summary.aborted || Date.now() > deadline - 5_000) break;
  }

  return { ...(total ?? createAffiliatePayoutCycleSummary(trigger, startedAt)), skipped: null, stripeTransfers: 'ran' };
}

function invalidPayoutId(): AffiliatePayoutActionResult {
  return { ok: false, error: 'invalid_id', payoutId: null, reason: null };
}

async function adminPayoutAction(
  payoutId: string,
  action: typeof retryAffiliatePayout | typeof releaseAffiliatePayout
): Promise<AffiliatePayoutActionResult> {
  try {
    await requireCmsAdmin();
  } catch {
    return { ok: false, error: 'forbidden', payoutId: null, reason: null };
  }
  const parsed = payoutIdSchema.safeParse(payoutId);
  if (!parsed.success) return invalidPayoutId();

  // A Retry or Release moves money: refused while the package is inactive, like the runs.
  if (!(await isAffiliatesPackageActive())) {
    return { ok: false, error: 'package_inactive', payoutId: parsed.data, reason: null };
  }

  const resolved = await resolveAffiliateStripeClient();
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error === 'unknown' ? 'stripe_error' : resolved.error,
      payoutId: parsed.data,
      reason: null,
    };
  }

  const db = serviceClient();
  try {
    return await action({ supabase: db, stripe: resolved.stripe, hooks: payoutHooks(db, affiliatePayoutRunDate(), null) }, parsed.data);
  } catch (error) {
    console.warn('[affiliates] Payout action failed:', describeError(error));
    return { ok: false, error: 'unknown', payoutId: parsed.data, reason: null };
  }
}

/**
 * Retry one FAILED (or stale PROCESSING) payout now. Re-checks the ADMIN itself; reconciles with
 * Stripe first, so a payout whose transfer exists is completed instead of paid twice.
 */
export async function retryAffiliatePayoutNow(payoutIdToRetry: string): Promise<AffiliatePayoutActionResult> {
  return adminPayoutAction(payoutIdToRetry, retryAffiliatePayout);
}

/**
 * Give one FAILED (or stale PROCESSING) payout up: its commissions become claimable again.
 * Re-checks the ADMIN itself; refused while Stripe holds a transfer of the payout.
 */
export async function releaseAffiliatePayoutNow(payoutIdToRelease: string): Promise<AffiliatePayoutActionResult> {
  return adminPayoutAction(payoutIdToRelease, releaseAffiliatePayout);
}

async function readStoreBaseCurrency(db: AnyClient): Promise<string | null> {
  try {
    const { data, error } = await db.from('currencies').select('code').eq('is_default', true).limit(1).maybeSingle();
    if (error) return null;
    const code = typeof (data as { code?: unknown } | null)?.code === 'string' ? String((data as { code: string }).code).toUpperCase() : '';
    return /^[A-Z]{3}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * A failed Stripe read as the code the CMS shows: `stripe_authentication` (Stripe rejected the
 * key), `stripe_permission` (a restricted key lacks the permission) or `stripe_unavailable`.
 */
export function affiliateStripeReadErrorCode(error: unknown): NonNullable<AffiliatePayoutPlatformInfo['error']> {
  if (isAffiliateStripeAuthenticationError(error)) return 'stripe_authentication';
  if (isAffiliateStripePermissionError(error)) return 'stripe_permission';
  return 'stripe_unavailable';
}

function amountList(amounts: Map<string, number>): Array<{ currency: string; amount: number }> {
  return [...amounts.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * What the CMS payout screens show about Stripe (ADMIN only, re-checked here): whether a key is
 * configured and Stripe accepts it (`error`), the key mode, the platform country and settlement
 * currency (B2: warn when it differs from the store base currency), and per currency the total
 * available balance, the transferable one (the `card` source, as the cycle reads it) and the
 * pending one. Logs Stripe error codes only. Never throws past the ADMIN check.
 */
export async function getAffiliatePayoutPlatformInfo(): Promise<AffiliatePayoutPlatformInfo> {
  await requireCmsAdmin();
  const sandbox = isAffiliatePayoutSandbox();
  const db = serviceClient();
  const storeBaseCurrency = await readStoreBaseCurrency(db);
  const info: AffiliatePayoutPlatformInfo = {
    stripeConfigured: false,
    sandbox,
    platformCountry: null,
    platformDefaultCurrency: null,
    storeBaseCurrency,
    currencyMismatch: false,
    livemode: null,
    available: null,
    transferable: null,
    pending: null,
    error: null,
  };
  if (sandbox) return info;

  const resolved = await resolveAffiliateStripeClient();
  if (!resolved.ok) {
    // No key is "not configured"; any other failure says nothing about the key (it may be transient).
    if (resolved.error !== 'stripe_not_configured') {
      info.stripeConfigured = null;
      info.error = 'stripe_unavailable';
    }
    return info;
  }
  info.stripeConfigured = true;

  try {
    const platform = await getCachedAffiliatePlatformInfo(resolved.stripe);
    info.platformCountry = platform.country;
    info.platformDefaultCurrency = platform.defaultCurrency;
    info.livemode = platform.livemode;
  } catch (error) {
    info.error = affiliateStripeReadErrorCode(error);
    console.warn(`[affiliates] Could not read the Stripe platform account (${affiliateStripeErrorCode(error)}).`);
  }
  // A rejected key answers every call the same way: no second request.
  if (info.error !== 'stripe_authentication') {
    try {
      const balance = await resolved.stripe.balance.retrieve();
      info.livemode = balance?.livemode === true;
      info.available = (Array.isArray(balance?.available) ? balance.available : [])
        .filter((entry) => typeof entry?.currency === 'string' && Number.isFinite(Number(entry.amount)))
        .map((entry) => ({ currency: entry.currency.toUpperCase(), amount: Math.trunc(Number(entry.amount)) }));
      info.transferable = amountList(readAffiliateTransferableBalance(balance));
      // The same card-source rule, applied to the pending side of the balance.
      info.pending = amountList(
        readAffiliateTransferableBalance({ livemode: info.livemode, available: Array.isArray(balance?.pending) ? balance.pending : [] })
      );
    } catch (error) {
      info.error ??= affiliateStripeReadErrorCode(error);
      console.warn(`[affiliates] Could not read the Stripe balance (${affiliateStripeErrorCode(error)}).`);
    }
  }
  info.currencyMismatch = Boolean(
    info.platformDefaultCurrency && storeBaseCurrency && info.platformDefaultCurrency !== storeBaseCurrency
  );
  return info;
}
