/**
 * The automated payout cycle (SPEC §10 W2-PAYOUTS; ADDENDUM B1, B2, B8, A11). One call, in order:
 *
 *  1. ledger repair: `reconcile_affiliate_commissions` (commissions the order trigger missed,
 *     refunds it did not void), `promote_cleared_affiliate_commissions`, then the "you earned"
 *     notification sweep;
 *  2. the platform balance and key mode are read (`balance.retrieve()`); without them no Stripe
 *     work follows, because every later step only touches payouts and commissions of that mode;
 *  3. stale PROCESSING payouts of the key's mode (untouched for 15 minutes) are reconciled
 *     against Stripe's transfer list: a transfer found completes the payout, none fails it as
 *     `stale`;
 *  4. FAILED payouts of the key's mode with a transient reason (`balance_insufficient`, `stale`)
 *     are retried, at most 5 attempts, in a later cycle than the one that failed them; one whose
 *     refunds left less than the minimum is handed back to the cleared balance instead;
 *  5. every eligible partner (ACTIVE, approved, a Connect account) with CLEARED commissions of
 *     the key's mode, not under dispute, at or above the minimum and covered by the balance:
 *     Connect readiness from `accounts.retrieve` (and a matching key mode),
 *     `claim_affiliate_payout`, the transfer, then completion;
 *  6. at most one insufficient-balance alert per day (the caller says whether it went out).
 *
 * A sale paid with a Stripe test key (or in the Freemius sandbox) is therefore only ever paid by
 * a test-mode transfer, and a live sale only by a live one.
 *
 * `gateways` (02036) names the sale gateways whose commissions Stripe Connect pays (the program's
 * `payoutMethods`); steps 2-6 claim and size only those, and the commissions of the others wait for
 * a manual payout the CMS prepares and records (`claim_manual_affiliate_payout`,
 * `record_manual_affiliate_payout`). With none, the cycle is the ledger repair alone and never calls
 * Stripe: {@link runAffiliateLedgerRepair} is that repair without a Stripe client, for the app to
 * run while no gateway needs Stripe, none is configured or automatic payouts are off, so
 * commissions still clear. Steps 3 and 4 only ever read Stripe payouts (`method` stripe_connect): a
 * prepared manual payout is PROCESSING until an admin records or cancels it, and Stripe holds no
 * transfer for it. FAILED payouts claimed before a gateway was switched to manual keep their
 * commissions and are retried as before; an admin releases them to pay those by hand.
 *
 * The batch cap bounds the partners that get Stripe work per call (default 25); what is left is
 * reported as `remaining` so the caller can continue the run. The cycle never throws: every
 * failure is collected in `errors` (short codes only) and the money stays where the database put it.
 */
import { AFFILIATE_GATEWAYS } from '../core/statuses';
import type { AffiliateGateway, AffiliatePayoutTrigger, AffiliateProfileRow } from '../core/types';
import { affiliateTable, type AffiliateRepositoryClient } from '../repository/client';
import { normalizeAffiliatePayoutRow, normalizeAffiliateProfileRow, normalizeAffiliateRows } from '../repository/rows';
import {
  AffiliatePayoutEngine,
  appendAffiliatePayoutCycleError,
  createAffiliatePayoutCycleSummary,
  type AffiliatePayoutCycleStep,
  type AffiliatePayoutCycleSummary,
  type AffiliatePayoutEngineOptions,
  type AffiliatePayoutHooks,
} from './engine';
import {
  AFFILIATE_PAYOUT_AUTO_RETRY_DELAY_MS,
  AFFILIATE_PAYOUT_MAX_RECONCILES_PER_CYCLE,
  AFFILIATE_PAYOUT_STALE_AFTER_MS,
  AFFILIATE_PAYOUT_TRANSIENT_FAILURE_REASONS,
} from './payout-config';
import { readAffiliateClaimableCommissionPage } from './obligations';
import {
  claimAffiliatePayoutViaRpc,
  promoteClearedAffiliateCommissionsViaRpc,
  reconcileAffiliateCommissionsViaRpc,
} from './rpc';

export interface AffiliatePayoutCycleDeps extends AffiliatePayoutEngineOptions {
  trigger: AffiliatePayoutTrigger;
  /** Minimum payout in minor units (`affiliates_settings.minPayoutCents`). */
  minPayoutCents: number;
  /** The day's insufficient-balance alert already went out (B2: at most one per UTC day). */
  insufficientBalanceAlerted?: boolean;
  /**
   * The gateways whose commissions Stripe Connect pays (`affiliateGatewaysPaidByStripe`): only
   * those are sized and claimed. Omitted or null: every gateway (the behaviour before 02036). An
   * empty list: the ledger repair alone, without a Stripe call.
   */
  gateways?: readonly AffiliateGateway[] | null;
}

const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const ID_CHUNK = 100;

type ClaimableSums = Map<string, Map<string, number>>;

/** What the ledger repair needs: the engine has it, and so does the Stripe-free repair entry. */
interface AffiliateLedgerRepairContext {
  supabase: AffiliateRepositoryClient;
  summary: AffiliatePayoutCycleSummary;
  hooks: AffiliatePayoutHooks;
  recordError(step: AffiliatePayoutCycleStep, cause: unknown): void;
}

async function repairLedger(context: AffiliateLedgerRepairContext): Promise<void> {
  try {
    const result = await reconcileAffiliateCommissionsViaRpc(context.supabase);
    context.summary.recorded = result.recorded;
    context.summary.voided = result.voided;
  } catch (error) {
    context.recordError('reconcile_commissions', error);
  }

  try {
    context.summary.promoted = await promoteClearedAffiliateCommissionsViaRpc(context.supabase);
  } catch (error) {
    context.recordError('promote_commissions', error);
  }

  const sweep = context.hooks.sweepCommissionNotifications;
  if (sweep) {
    try {
      const claimed = Number(await sweep());
      context.summary.notified = Number.isFinite(claimed) && claimed > 0 ? Math.trunc(claimed) : 0;
    } catch (error) {
      context.recordError('notify_commissions', error);
    }
  }
}

/** The gateway filter for the claim: undefined when it covers every gateway (`p_gateways` is then not sent). */
function claimGateways(gateways: readonly AffiliateGateway[] | null | undefined): readonly AffiliateGateway[] | undefined {
  if (!Array.isArray(gateways)) return undefined;
  return AFFILIATE_GATEWAYS.every((gateway) => gateways.includes(gateway)) ? undefined : gateways;
}

export interface AffiliateLedgerRepairDeps {
  /** Service-role client: the repair RPCs are revoked from every API role. */
  supabase: AffiliateRepositoryClient;
  trigger: AffiliatePayoutTrigger;
  /** The "you earned" sweep and the error log; no payout hook ever fires here. */
  hooks?: Pick<AffiliatePayoutHooks, 'sweepCommissionNotifications' | 'onError'>;
  now?: () => Date;
}

/**
 * The cycle's step 1 alone, without a Stripe client: `reconcile_affiliate_commissions`,
 * `promote_cleared_affiliate_commissions` and the "you earned" sweep. The app runs it in place of
 * {@link runAffiliatePayoutCycle} when no gateway's commissions are paid through Stripe, when no
 * Stripe key is configured, or while automatic payouts are off (that switch stops Stripe transfers
 * only), so commissions still clear (and missed ones are recorded) on a store that pays its partners
 * by hand. It never calls Stripe and never claims or completes a payout.
 * Returns a cycle summary (`livemode` null, no payout counts); never throws.
 */
export async function runAffiliateLedgerRepair(deps: AffiliateLedgerRepairDeps): Promise<AffiliatePayoutCycleSummary> {
  const clock = deps.now ?? (() => new Date());
  const hooks: AffiliatePayoutHooks = { ...(deps.hooks ?? {}) };
  const summary = createAffiliatePayoutCycleSummary(deps.trigger, clock().toISOString());
  const recordError = (step: AffiliatePayoutCycleStep, cause: unknown) => appendAffiliatePayoutCycleError(summary, hooks, step, cause);
  try {
    await repairLedger({ supabase: deps.supabase, summary, hooks, recordError });
  } catch (error) {
    recordError('cycle', error);
  }
  summary.finishedAt = clock().toISOString();
  return summary;
}

async function reconcileStalePayouts(engine: AffiliatePayoutEngine): Promise<void> {
  // A key only sees transfers of its own mode: a payout of the other mode is left PROCESSING
  // until a key of its mode reconciles it (an empty list would wrongly fail it as stale).
  if (engine.stripeBlocked || engine.livemode === null) return;
  const cutoff = new Date(engine.now().getTime() - AFFILIATE_PAYOUT_STALE_AFTER_MS).toISOString();

  let payouts;
  try {
    // Stripe payouts only: a prepared manual payout (02036) stays PROCESSING until an admin records
    // or cancels it, and Stripe never holds a transfer for it (an empty list would fail it as stale).
    const { data, error } = await affiliateTable(engine.supabase, 'affiliate_payouts')
      .select('*')
      .eq('status', 'PROCESSING')
      .eq('method', 'stripe_connect')
      .eq('livemode', engine.livemode)
      .lt('last_attempt_at', cutoff)
      .order('last_attempt_at', { ascending: true })
      .limit(AFFILIATE_PAYOUT_MAX_RECONCILES_PER_CYCLE);
    if (error) throw new Error('Could not list processing payouts.', { cause: error });
    payouts = normalizeAffiliateRows(data, normalizeAffiliatePayoutRow);
  } catch (error) {
    engine.recordError('reconcile_payouts', error);
    return;
  }

  for (const payout of payouts) {
    if (engine.stripeBlocked || engine.outOfTime()) break;
    const outcome = await engine.reconcile(payout, { failStale: true });
    if (outcome.kind === 'completed' || outcome.kind === 'failed_stale') engine.summary.reconciled += 1;
  }
}

async function retryFailedPayouts(engine: AffiliatePayoutEngine, minPayoutCents: number): Promise<void> {
  if (engine.stripeBlocked || engine.livemode === null) return;
  const retryBefore = new Date(engine.now().getTime() - AFFILIATE_PAYOUT_AUTO_RETRY_DELAY_MS).toISOString();

  let payouts;
  let profiles: Map<string, AffiliateProfileRow>;
  try {
    const { data, error } = await affiliateTable(engine.supabase, 'affiliate_payouts')
      .select('*')
      .eq('status', 'FAILED')
      .eq('method', 'stripe_connect')
      .eq('livemode', engine.livemode)
      .in('failure_reason', [...AFFILIATE_PAYOUT_TRANSIENT_FAILURE_REASONS])
      .lt('attempt_count', engine.maxAttempts)
      .lt('last_attempt_at', retryBefore)
      .order('last_attempt_at', { ascending: true })
      .limit(engine.batchSize * 4);
    if (error) throw new Error('Could not list failed payouts.', { cause: error });
    payouts = normalizeAffiliateRows(data, normalizeAffiliatePayoutRow);
    profiles = await engine.loadProfiles(payouts.map((payout) => payout.affiliate_id));
  } catch (error) {
    engine.recordError('retry_payouts', error);
    return;
  }

  for (const payout of payouts) {
    const profile = profiles.get(payout.affiliate_id);
    // Not eligible (suspended, not approved, no account): prepare_affiliate_payout_retry would
    // refuse it anyway, so it costs no Stripe call and no batch slot. An admin can release it.
    if (!profile || profile.status !== 'ACTIVE' || !profile.first_published_at || !profile.stripe_connect_account_id) continue;
    if (engine.wasCheckedEarlierInRun(profile)) continue;
    if (engine.hasLivemodeMismatch(profile)) {
      engine.countNotReady(profile.id);
      continue;
    }
    if (!engine.covers(payout.currency, payout.amount_cents)) {
      engine.noteShortfall(payout.currency, payout.amount_cents);
      engine.summary.skippedInsufficientBalance += 1;
      continue;
    }
    if (engine.stripeBlocked || engine.outOfTime() || !engine.takeBatchSlot(profile.id)) {
      engine.markRemaining(profile.id);
      continue;
    }
    // The minimum applies to what is left after refunds: below it, the payout is handed back to
    // the cleared balance (`below_minimum`) instead of sending a tiny transfer.
    await engine.retry(payout, { profile, minAmountCents: minPayoutCents });
  }
}

/** ACTIVE, approved partners with a Connect account, by id (paged past PostgREST's row cap). */
async function listPayablePartners(engine: AffiliatePayoutEngine): Promise<AffiliateProfileRow[]> {
  const profiles: AffiliateProfileRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await affiliateTable(engine.supabase, 'affiliate_profiles')
      .select('*')
      .eq('status', 'ACTIVE')
      .not('first_published_at', 'is', null)
      .not('stripe_connect_account_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error('Could not list payable partners.', { cause: error });
    const rows = normalizeAffiliateRows(data, normalizeAffiliateProfileRow);
    profiles.push(...rows);
    if (!Array.isArray(data) || data.length < PAGE_SIZE) break;
  }
  return profiles;
}

/**
 * CLEARED, unattached commissions per partner and currency, net of partial refunds: only those
 * `claim_affiliate_payout` would take with this key (the key's mode, not under dispute), so a
 * test-mode balance after going live raises no shortfall alert and costs no Stripe call.
 */
async function loadClaimableSums(
  engine: AffiliatePayoutEngine,
  affiliateIds: string[],
  livemode: boolean,
  gateways: readonly AffiliateGateway[] | undefined
): Promise<ClaimableSums> {
  const sums: ClaimableSums = new Map();
  for (let index = 0; index < affiliateIds.length; index += ID_CHUNK) {
    const chunk = affiliateIds.slice(index, index + ID_CHUNK);
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const from = page * PAGE_SIZE;
      // The same query as the CMS "owed now" figure (obligations.ts), limited to these partners
      // and to the gateways Stripe pays.
      const { rows, error } = await readAffiliateClaimableCommissionPage(engine.supabase, {
        livemode,
        columns: 'id, affiliate_id, currency, commission_amount_cents, refunded_amount_cents',
        affiliateIds: chunk,
        gateways,
        from,
        to: from + PAGE_SIZE - 1,
      });
      if (error) throw new Error('Could not read cleared commissions.', { cause: error });
      for (const row of rows) {
        const affiliateId = typeof row['affiliate_id'] === 'string' ? row['affiliate_id'] : null;
        const currency = typeof row['currency'] === 'string' ? row['currency'].trim().toUpperCase() : '';
        if (!affiliateId || !/^[A-Z]{3}$/.test(currency)) continue;
        const net = Math.trunc(Number(row['commission_amount_cents']) - Number(row['refunded_amount_cents'] ?? 0));
        if (!Number.isFinite(net) || net <= 0) continue;
        const byCurrency = sums.get(affiliateId) ?? new Map<string, number>();
        byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + net);
        sums.set(affiliateId, byCurrency);
      }
      if (rows.length < PAGE_SIZE) break;
    }
  }
  return sums;
}

async function claimAndSendPayouts(
  engine: AffiliatePayoutEngine,
  minPayoutCents: number,
  gateways: readonly AffiliateGateway[] | undefined
): Promise<void> {
  const livemode = engine.livemode;
  if (engine.stripeBlocked || livemode === null) return;

  let partners: AffiliateProfileRow[];
  let sums: ClaimableSums;
  try {
    partners = await listPayablePartners(engine);
    sums = await loadClaimableSums(
      engine,
      partners.map((partner) => partner.id),
      livemode,
      gateways
    );
  } catch (error) {
    engine.recordError('list_candidates', error);
    return;
  }

  for (const partner of partners) {
    const currencies = sums.get(partner.id);
    if (!currencies) continue;
    for (const [currency, amount] of [...currencies.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (amount < minPayoutCents) {
        engine.summary.skippedBelowMinimum += 1;
        continue;
      }
      if (engine.wasCheckedEarlierInRun(partner)) continue;
      if (engine.hasLivemodeMismatch(partner)) {
        engine.countNotReady(partner.id);
        continue;
      }
      if (!engine.covers(currency, amount)) {
        engine.noteShortfall(currency, amount);
        engine.summary.skippedInsufficientBalance += 1;
        continue;
      }
      if (engine.stripeBlocked || engine.outOfTime() || !engine.takeBatchSlot(partner.id)) {
        engine.markRemaining(partner.id);
        continue;
      }

      const readiness = await engine.readinessFor(partner);
      if (!readiness.ready) {
        engine.countNotReady(partner.id);
        continue;
      }

      let payout;
      try {
        payout = await claimAffiliatePayoutViaRpc(engine.supabase, {
          affiliateId: partner.id,
          currency,
          minAmountCents: minPayoutCents,
          trigger: engine.trigger,
          gateways,
        });
      } catch (error) {
        engine.recordError('claim', error, { affiliateId: partner.id });
        continue;
      }
      if (!payout) continue;
      engine.summary.claimed += 1;
      await engine.attemptTransfer(payout);
    }
  }
}

/** B2: at most one insufficient-balance alert per UTC day; the caller tracks the day. */
async function alertShortfalls(engine: AffiliatePayoutEngine, alreadyAlerted: boolean): Promise<void> {
  if (alreadyAlerted) {
    engine.summary.insufficientBalanceAlerted = true;
    return;
  }
  const shortfalls = engine.currentShortfalls();
  const notify = engine.hooks.onInsufficientBalance;
  if (shortfalls.length === 0 || !notify) return;
  try {
    const result = await notify(shortfalls);
    engine.summary.insufficientBalanceAlerted = result !== false;
  } catch (error) {
    engine.recordError('hook', error);
  }
}

/**
 * One payout cycle (see the file comment). Never throws; returns what it did. Pass the
 * service-role client and the Stripe client; the caller authorizes and decides when it runs.
 */
export async function runAffiliatePayoutCycle(deps: AffiliatePayoutCycleDeps): Promise<AffiliatePayoutCycleSummary> {
  const engine = new AffiliatePayoutEngine(deps);
  const minPayoutCents = Math.max(1, Math.trunc(Number(deps.minPayoutCents) || 0));
  // No gateway paid through Stripe: the ledger repair alone, and Stripe is never asked.
  const stripeWork = !Array.isArray(deps.gateways) || deps.gateways.length > 0;
  const gateways = claimGateways(deps.gateways);
  try {
    await repairLedger(engine);
    // The key mode comes first: reconciliation, retries and claims only touch its mode.
    if (stripeWork && (await engine.loadBalance())) {
      await reconcileStalePayouts(engine);
      await retryFailedPayouts(engine, minPayoutCents);
      await claimAndSendPayouts(engine, minPayoutCents, gateways);
    }
    await alertShortfalls(engine, deps.insufficientBalanceAlerted === true);
  } catch (error) {
    engine.recordError('cycle', error);
  }
  return engine.finish();
}
