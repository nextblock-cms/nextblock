import 'server-only';

import { randomUUID } from 'node:crypto';
import {
  AFFILIATE_PAYPAL_ACKNOWLEDGED_RELEASE_DAYS,
  AFFILIATE_PAYPAL_RESEND_MAX_AGE_DAYS,
  AFFILIATE_PAYPAL_UNCONFIRMED_RELEASE_HOURS,
  isAffiliatePayPalPayoutReceiver,
  isAffiliatePayPalReceiverFailureReason,
  type AffiliateGateway,
  type AffiliatePayoutRow,
  type AffiliatePayoutTrigger,
} from '@nextblock-cms/affiliates';
import {
  claimPayPalAffiliatePayoutViaRpc,
  completePayPalAffiliatePayoutViaRpc,
  failPayPalAffiliatePayoutViaRpc,
  normalizeAffiliatePayoutRow,
  normalizeAffiliateRows,
  notePayPalAffiliatePayoutItemViaRpc,
  readAffiliateClaimableCommissionPage,
  recordPayPalAffiliatePayoutBatchViaRpc,
  releasePayPalAffiliatePayoutViaRpc,
  type AffiliateRepositoryClient,
} from '@nextblock-cms/affiliates/server';
import { affiliatePayPalPayoutNote } from '../paypal-payouts-csv';
import {
  AFFILIATE_PAYPAL_PAYOUTS_SCOPE,
  canAffiliatePayPalSendAmount,
  createAffiliatePayPalClient,
  isAffiliatePayPalError,
  isAffiliatePayPalPayoutCurrency,
  type AffiliatePayPalClient,
  type AffiliatePayPalCredentials,
  type AffiliatePayPalEnvironment,
  type AffiliatePayPalError,
  type AffiliatePayPalItem,
} from './client';

/**
 * The PayPal side of the daily payout run (02037, docs/15 → "Paying partners with PayPal"). Pure of
 * the app: the caller passes the service-role client, the credentials per environment, the program
 * settings it read and the hooks, so every path is unit-tested with a fake PayPal client.
 *
 * One call, in order:
 *
 *  1. Sync. Every PayPal payout in flight (PROCESSING) whose batch PayPal acknowledged is checked with
 *     PayPal, batch by batch (`GET /v1/payments/payouts/{id}`, every page), with the credentials of
 *     the payout's own environment (`livemode`). Item SUCCESS completes it
 *     (`complete_paypal_affiliate_payout`, exactly once; PAYOUT_SENT); FAILED, BLOCKED, RETURNED,
 *     REFUNDED, REVERSED (and a DENIED or CANCELED batch, for its items PayPal never processed) fail it
 *     and hand its commissions back (`fail_paypal_affiliate_payout`; PAYOUT_FAILED unless the cause is
 *     the operator's, such as an empty PayPal balance); PENDING, ONHOLD and UNCLAIMED keep it in flight
 *     with the status noted (PAYPAL_UNCLAIMED the first time an item is unclaimed: PayPal returns it
 *     after 30 days, and the run fails it once PayPal says RETURNED); a status this file does not know
 *     keeps it in flight and raises an admin alert, and so does a batch PayPal will not show (another
 *     account's credentials, a 404): only a timeout, a 5xx or a rate limit stays silent.
 *  2. Only with `send` (automatic payouts on, or "Run payouts now"): batches whose create call had an
 *     unknown outcome (a timeout, a 5xx, an unreadable answer: the payouts carry their saved
 *     `sender_batch_id` and no batch id) are sent again with the SAME id, which PayPal pays once
 *     (PayPal-Request-Id replays the first answer; a reused sender_batch_id is refused with a link to
 *     the original batch, which is then adopted). Each resend first stamps the send on the payouts
 *     (`last_attempt_at`: the CMS Release waits an hour after it) and sends exactly the payouts that
 *     still carry the id, so a payout an admin released meanwhile is not sent. A refusal of a resend
 *     never releases anything (PayPal may hold the first batch): the payouts stay in flight with an
 *     alert. PayPal remembers an id for 30 days only, so a batch first claimed over 25 days ago is not
 *     sent again: the admin checks PayPal and releases it.
 *  3. Only with `send` and a gateway routed to PayPal: the active environment's token is checked for
 *     the Payouts scope, then every ACTIVE, approved partner whose payout email is a PayPal account
 *     (and whose last PayPal payout was not returned to that same address since they last saved it)
 *     and whose cleared commissions of the PayPal gateways and the environment's mode reach the
 *     minimum, in a currency PayPal Payouts sends (whole units for HUF, JPY and TWD), is claimed
 *     (`claim_paypal_affiliate_payout`); one batch per currency and language gets a new
 *     `sender_batch_id`, saved on its payouts BEFORE the create call; PayPal's batch id is saved after.
 *     A timeout or a 5xx keeps the payouts in flight for step 2 of the next run; a definitive refusal
 *     of a first send fails them and hands their commissions back (INSUFFICIENT_FUNDS raises the "Add
 *     {currency} to your PayPal balance" alert; Payouts not enabled and rejected credentials stop the
 *     step and raise their alert).
 *
 * A live payout holds live-mode commissions only and a PayPal sandbox payout test-mode ones (the
 * claim filters on `livemode`), so a real sale is never marked paid with sandbox money. The call never
 * throws: failures are collected as short codes in `errors`, and the money stays where the database
 * put it.
 */

export type AffiliatePayPalItemAction =
  | { kind: 'complete' }
  | { kind: 'fail'; reason: string; operatorSide: boolean }
  | { kind: 'keep'; status: string | null }
  | { kind: 'unknown'; status: string };

/** Item statuses that keep a payout in flight. */
const KEEP_STATUSES: ReadonlySet<string> = new Set(['PENDING', 'ONHOLD', 'UNCLAIMED']);

/** Item (and batch) statuses after which PayPal will not pay: the payout fails and its commissions go back. */
const FAIL_STATUSES: ReadonlySet<string> = new Set(['FAILED', 'BLOCKED', 'RETURNED', 'REFUNDED', 'REVERSED', 'DENIED', 'CANCELED', 'CANCELLED']);

/** Error names that are the operator's to fix (the PayPal balance), not the partner's. */
const OPERATOR_SIDE_ERRORS: ReadonlySet<string> = new Set([
  'INSUFFICIENT_FUNDS',
  'NEGATIVE_BALANCE',
  'NON_HOLDING_CURRENCY',
  'USER_FUNDING_SOURCE_INELIGIBLE',
]);

/** A status the 02037 CHECK accepts (`paypal_item_status`). */
const STORABLE_STATUS = /^[A-Z][A-Z_]{0,39}$/;

/**
 * Item statuses of a DENIED or CANCELED batch that mean PayPal never processed the item: none yet,
 * PENDING, NEW. Such an item fails with the batch; an item PayPal did process (UNCLAIMED, ONHOLD, a
 * final status) is settled by its own status.
 */
const UNPROCESSED_ITEM_STATUSES: ReadonlySet<string> = new Set(['', 'PENDING', 'NEW']);

/** Batch statuses after which PayPal processes none of the batch's unprocessed items. */
const REFUSED_BATCH_STATUSES: ReadonlySet<string> = new Set(['DENIED', 'CANCELED', 'CANCELLED']);

/** A CMS Release of a payout PayPal never acknowledged waits this long after its last send (02037 enforces it). */
export const AFFILIATE_PAYPAL_UNCONFIRMED_RELEASE_AFTER_MS = AFFILIATE_PAYPAL_UNCONFIRMED_RELEASE_HOURS * 60 * 60 * 1000;

/** A CMS Release of a payout PayPal acknowledged but never settled waits this long after its last send (02037 enforces it). */
export const AFFILIATE_PAYPAL_ACKNOWLEDGED_RELEASE_AFTER_MS = AFFILIATE_PAYPAL_ACKNOWLEDGED_RELEASE_DAYS * 24 * 60 * 60 * 1000;

/**
 * A batch with an unknown outcome is sent again with the same sender_batch_id only while its payouts
 * were claimed less than this long ago: PayPal refuses a reused sender_batch_id, and replays a
 * PayPal-Request-Id, for 30 days only, after which the same id could be paid as a new batch. Measured
 * from the claim (`created_at`), which is never later than the first send; 5 days of margin.
 */
export const AFFILIATE_PAYPAL_RESEND_MAX_AGE_MS = AFFILIATE_PAYPAL_RESEND_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * What a PayPal item status means for its payout. Null or empty: PayPal has not processed it yet
 * (kept). `errorName` (the item's `errors.name`) decides whether a failure is the operator's.
 */
export function classifyAffiliatePayPalItemStatus(status: string | null | undefined, errorName?: string | null): AffiliatePayPalItemAction {
  const value = typeof status === 'string' ? status.trim().toUpperCase() : '';
  if (!value) return { kind: 'keep', status: null };
  if (value === 'SUCCESS') return { kind: 'complete' };
  if (KEEP_STATUSES.has(value)) return { kind: 'keep', status: value };
  if (FAIL_STATUSES.has(value)) {
    const error = typeof errorName === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(errorName) ? errorName : null;
    return {
      kind: 'fail',
      reason: `paypal_${value.toLowerCase()}${error ? `:${error.toLowerCase()}` : ''}`,
      operatorSide: error !== null && OPERATOR_SIDE_ERRORS.has(error),
    };
  }
  return { kind: 'unknown', status: value };
}

/**
 * Whether a failure reason means the address cannot be paid (returned, blocked, refunded, reversed,
 * cancelled, refused for the receiver): the lib's rule, which the partner's failure email follows too.
 */
export function isAffiliatePayPalReceiverFailure(reason: string | null | undefined): boolean {
  return isAffiliatePayPalReceiverFailureReason(reason);
}

/* ---------------------------------------------------------------- events, alerts --- */

export interface AffiliatePayPalEventPayout {
  payoutId: string;
  affiliateId: string;
  amountCents: number;
  currency: string;
  /** The partner's PayPal email the payout went to. */
  receiver: string | null;
  environment: AffiliatePayPalEnvironment;
}

/**
 * What happened to a partner's PayPal payout, for the notifications (docs/15 → "Paying partners with
 * PayPal"): PAYOUT_SENT (PayPal paid the item), PAYPAL_UNCLAIMED (the item waits for the partner to
 * claim it, first seen), PAYOUT_FAILED (PayPal will not pay it, or an admin cancelled it; operator-side
 * causes such as an empty PayPal balance raise an admin alert instead).
 */
export type AffiliatePayPalPayoutEvent =
  | { type: 'PAYOUT_SENT'; payout: AffiliatePayPalEventPayout; transactionId: string; feeCents: number | null }
  | { type: 'PAYPAL_UNCLAIMED'; payout: AffiliatePayPalEventPayout }
  | { type: 'PAYOUT_FAILED'; payout: AffiliatePayPalEventPayout; reason: string; itemStatus: string | null; cancelledByAdmin: boolean };

export type AffiliatePayPalAlertKind =
  | 'paypal_insufficient_funds'
  | 'paypal_not_enabled'
  | 'paypal_credentials'
  | 'paypal_refused'
  | 'paypal_unknown_status'
  | 'paypal_batch_unresolved'
  | 'paypal_currency_unsupported';

/**
 * Why a batch is unresolved (`paypal_batch_unresolved`), when it is not the default "sent again and
 * refused without naming the original batch":
 * - `insufficient_funds`, `not_enabled`, `credentials`: a resend PayPal refused before it could look at
 *   the first batch (the token, the account, the balance); the payouts stay in flight;
 * - `expired`: first claimed over 25 days ago and never confirmed, so it is not sent again;
 * - `malformed`: PayPal answered the create call with a body this site could not read;
 * - `not_recorded`: PayPal accepted a batch but some of its payouts could not be linked to it (released
 *   meanwhile);
 * - `unreadable`: PayPal will not show an acknowledged batch (another account's credentials, a 404).
 */
export type AffiliatePayPalUnresolvedCause =
  | 'insufficient_funds'
  | 'not_enabled'
  | 'credentials'
  | 'expired'
  | 'malformed'
  | 'not_recorded'
  | 'unreadable';

/** An operator problem the admin must fix (one `affiliate_payout_failed` alert per kind and UTC day, `metadata.kind`). */
export interface AffiliatePayPalAlert {
  kind: AffiliatePayPalAlertKind;
  environment: AffiliatePayPalEnvironment;
  /** Payouts it concerns. */
  payouts: number;
  currency?: string | null;
  amountCents?: number | null;
  /** PayPal's error name, or the status PayPal reported. */
  code?: string | null;
  senderBatchId?: string | null;
  /** PayPal's payout_batch_id, for a batch PayPal acknowledged. */
  batchId?: string | null;
  /** `paypal_batch_unresolved` only: why (see {@link AffiliatePayPalUnresolvedCause}). */
  cause?: AffiliatePayPalUnresolvedCause | null;
}

export interface AffiliatePayPalHooks {
  onEvent?: (event: AffiliatePayPalPayoutEvent) => unknown;
  /** Returns false when no alert was recorded. */
  onAlert?: (alert: AffiliatePayPalAlert) => unknown;
  onError?: (error: AffiliatePayPalRunError, cause: unknown) => void;
}

export interface AffiliatePayPalRunError {
  step: 'read' | 'sync' | 'complete' | 'fail' | 'note' | 'token' | 'candidates' | 'claim' | 'batch' | 'create' | 'hook' | 'run';
  /** A short machine code (PayPal's error kind or name, a PostgREST code, `unknown`), never a message. */
  code: string;
  payoutId?: string;
}

export interface AffiliatePayPalRunSummary {
  environment: AffiliatePayPalEnvironment;
  /** The gateways the program pays with PayPal (what the run claims for). */
  gateways: AffiliateGateway[];
  startedAt: string;
  finishedAt: string;
  /** Why no new payout was sent this run (the sync may still have run; `sandbox`: nothing ran). */
  skipped: 'sandbox' | 'not_configured' | 'not_enabled' | 'credentials' | 'unavailable' | null;
  /** In-flight payouts PayPal was asked about. */
  synced: number;
  completed: number;
  /** Payouts failed with their commissions handed back (by the sync or a definitive refusal). */
  failed: number;
  /** Payouts still in flight after the sync (pending, on hold, unclaimed, unknown). */
  inFlight: number;
  unclaimed: number;
  unknown: number;
  claimed: number;
  /** Payouts in batches PayPal accepted (or confirmed) this run. */
  submitted: number;
  /**
   * Payouts kept in flight after a create call with an unknown outcome, or a resend PayPal refused
   * (sent again by the next run that sends; see `AFFILIATE_PAYPAL_RESEND_MAX_AGE_MS`).
   */
  pendingRetry: number;
  /** Partners left for a later run (the cap or the time budget). */
  remaining: number;
  errors: AffiliatePayPalRunError[];
}

export interface AffiliatePayPalRunDeps {
  /** Service-role client: the PayPal RPCs are revoked from every API role. */
  supabase: AffiliateRepositoryClient;
  /** The environment new payouts go out in. */
  environment: AffiliatePayPalEnvironment;
  /** The credentials of an environment, or null when none are configured. */
  credentialsFor: (environment: AffiliatePayPalEnvironment) => Promise<AffiliatePayPalCredentials | null>;
  /** Builds the client (tests pass a fake). Default: {@link createAffiliatePayPalClient}. */
  createClient?: (credentials: AffiliatePayPalCredentials) => AffiliatePayPalClient;
  trigger: AffiliatePayoutTrigger;
  /** The gateways the program pays with PayPal (`affiliateGatewaysPaidByPayPal`). */
  gateways: readonly AffiliateGateway[];
  minPayoutCents: number;
  /** Claim and send, and resend batches with an unknown outcome; false checks PayPal only. */
  send: boolean;
  /** For PayPal's email to the partner. */
  siteName: string;
  now?: () => Date;
  /** No new PayPal work starts after this many ms. Default 40 s. */
  timeBudgetMs?: number;
  /** Partners claimed per call at most. Default 500. */
  maxClaims?: number;
  /** A new sender_batch_id (tests pin it). Default: a UUID. */
  newSenderBatchId?: () => string;
  hooks?: AffiliatePayPalHooks;
}

const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const ID_CHUNK = 100;
const DEFAULT_TIME_BUDGET_MS = 40_000;
const DEFAULT_MAX_CLAIMS = 500;
const MAX_RECORDED_ERRORS = 50;

function errorCode(error: unknown): string {
  if (isAffiliatePayPalError(error)) return error.code ? `${error.kind}:${error.code}` : error.kind;
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return code;
  }
  return 'unknown';
}

function environmentOf(payout: AffiliatePayoutRow): AffiliatePayPalEnvironment {
  return payout.livemode === false ? 'sandbox' : 'live';
}

function storableStatus(status: string | null): string | null {
  return status && STORABLE_STATUS.test(status) ? status : null;
}

interface PartnerCandidate {
  affiliateId: string;
  email: string;
  /** When the partner last saved the payout email (`payout_email_saved_at`), or null. */
  emailSavedAt: string | null;
  locale: 'en' | 'fr';
}

interface RunContext {
  deps: AffiliatePayPalRunDeps;
  summary: AffiliatePayPalRunSummary;
  clients: Map<AffiliatePayPalEnvironment, AffiliatePayPalClient | null>;
  locales: Map<string, 'en' | 'fr'>;
  startedMs: number;
  timeBudgetMs: number;
  /** Set by a refusal that will repeat for every batch (Payouts not enabled, credentials rejected). */
  stopSending: boolean;
  /** Operator alerts collected during the run, sent once each at the end. */
  alerts: Map<string, AffiliatePayPalAlert>;
  /** Payouts this run completed or failed (no longer in flight). */
  settled: Set<string>;
}

function recordError(ctx: RunContext, step: AffiliatePayPalRunError['step'], cause: unknown, payoutId?: string): void {
  const entry: AffiliatePayPalRunError = { step, code: errorCode(cause) };
  if (payoutId) entry.payoutId = payoutId;
  if (ctx.summary.errors.length < MAX_RECORDED_ERRORS) ctx.summary.errors.push(entry);
  try {
    ctx.deps.hooks?.onError?.(entry, cause);
  } catch {
    // Logging never breaks a money step.
  }
}

function outOfTime(ctx: RunContext): boolean {
  return Date.now() - ctx.startedMs > ctx.timeBudgetMs;
}

async function emit(ctx: RunContext, event: AffiliatePayPalPayoutEvent): Promise<void> {
  const hook = ctx.deps.hooks?.onEvent;
  if (!hook) return;
  try {
    await hook(event);
  } catch (error) {
    recordError(ctx, 'hook', error, event.payout.payoutId);
  }
}

/** The run's clock (tests pin it), in ms since the epoch. */
function nowMs(ctx: RunContext): number {
  return (ctx.deps.now ?? (() => new Date()))().getTime();
}

/** Collects an operator alert; one per kind (and currency, code and cause) per run, merged. */
function noteAlert(ctx: RunContext, alert: AffiliatePayPalAlert): void {
  const key = `${alert.kind}|${alert.currency ?? ''}|${alert.code ?? ''}|${alert.cause ?? ''}`;
  const existing = ctx.alerts.get(key);
  if (existing) {
    existing.payouts += alert.payouts;
    existing.amountCents = (existing.amountCents ?? 0) + (alert.amountCents ?? 0);
  } else {
    ctx.alerts.set(key, { ...alert });
  }
}

async function clientFor(ctx: RunContext, environment: AffiliatePayPalEnvironment): Promise<AffiliatePayPalClient | null> {
  if (ctx.clients.has(environment)) return ctx.clients.get(environment) ?? null;
  let client: AffiliatePayPalClient | null = null;
  try {
    const credentials = await ctx.deps.credentialsFor(environment);
    if (credentials) client = (ctx.deps.createClient ?? createAffiliatePayPalClient)(credentials);
  } catch (error) {
    recordError(ctx, 'token', error);
  }
  ctx.clients.set(environment, client);
  return client;
}

function eventPayout(payout: AffiliatePayoutRow): AffiliatePayPalEventPayout {
  return {
    payoutId: payout.id,
    affiliateId: payout.affiliate_id,
    amountCents: payout.amount_cents,
    currency: payout.currency,
    receiver: payout.paypal_receiver ?? null,
    environment: environmentOf(payout),
  };
}

/* ---------------------------------------------------------------------- reads --- */

/** Every PayPal payout in flight (PROCESSING), keyset by id. */
async function readInFlight(db: AffiliateRepositoryClient): Promise<AffiliatePayoutRow[]> {
  const rows: AffiliatePayoutRow[] = [];
  let afterId: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = db.from('affiliate_payouts').select('*').eq('method', 'paypal').eq('status', 'PROCESSING');
    if (afterId) query = query.gt('id', afterId);
    const { data, error } = await query.order('id', { ascending: true }).limit(PAGE_SIZE);
    if (error) throw new Error('Could not read the PayPal payouts in flight.', { cause: error });
    const pageRows = normalizeAffiliateRows(data, normalizeAffiliatePayoutRow);
    rows.push(...pageRows);
    const last = pageRows[pageRows.length - 1]?.id;
    if (!Array.isArray(data) || data.length < PAGE_SIZE || !last) break;
    afterId = last;
  }
  return rows;
}

/** The payouts that carry a sender_batch_id (the exact set a batch sends). */
async function readBatchPayouts(db: AffiliateRepositoryClient, senderBatchId: string): Promise<AffiliatePayoutRow[]> {
  const { data, error } = await db
    .from('affiliate_payouts')
    .select('*')
    .eq('method', 'paypal')
    .eq('status', 'PROCESSING')
    .eq('paypal_sender_batch_id', senderBatchId)
    .order('id', { ascending: true })
    .limit(PAGE_SIZE * 15);
  if (error) throw new Error('Could not read the payouts of a PayPal batch.', { cause: error });
  return normalizeAffiliateRows(data, normalizeAffiliatePayoutRow);
}

/** The partners' languages (for PayPal's email), 100 ids per read; unknown reads as English. */
async function loadLocales(ctx: RunContext, affiliateIds: readonly string[]): Promise<void> {
  const missing = [...new Set(affiliateIds)].filter((id) => !ctx.locales.has(id));
  for (let index = 0; index < missing.length; index += ID_CHUNK) {
    const chunk = missing.slice(index, index + ID_CHUNK);
    const { data, error } = await ctx.deps.supabase.from('affiliate_profiles').select('id, preferred_locale').in('id', chunk);
    if (error) throw new Error('Could not read partner languages.', { cause: error });
    for (const row of Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []) {
      if (typeof row['id'] === 'string') ctx.locales.set(row['id'], row['preferred_locale'] === 'fr' ? 'fr' : 'en');
    }
  }
}

/** A partner whose PayPal history the blocked-receiver rule reads. */
export interface AffiliatePayPalReceiverCheck {
  affiliateId: string;
  email: string | null;
  /** When the partner last saved the payout email (`payout_email_saved_at`, 02037), or null (never since 02037). */
  emailSavedAt?: string | null;
}

/**
 * Partners whose latest PayPal payout failed because of the address it went to (returned, blocked,
 * refunded, reversed, cancelled, or refused for the receiver), who still have that same payout email
 * and have not saved it since that failure: the run does not send to that address again (they appear
 * under Pay manually) until the partner saves their payout email again, a new address or the same one
 * once they opened or confirmed their PayPal account ("Try PayPal again" in the portal). 100 partners
 * per read.
 */
export async function loadAffiliatePayPalBlockedReceivers(
  db: AffiliateRepositoryClient,
  partners: ReadonlyArray<AffiliatePayPalReceiverCheck>
): Promise<Set<string>> {
  const blocked = new Set<string>();
  const known = new Map(
    partners
      .filter((partner) => partner.email)
      .map((partner) => [partner.affiliateId, { email: (partner.email ?? '').toLowerCase(), savedAt: partner.emailSavedAt ?? null }])
  );
  const ids = [...known.keys()];
  for (let index = 0; index < ids.length; index += ID_CHUNK) {
    const chunk = ids.slice(index, index + ID_CHUNK);
    const { data, error } = await db
      .from('affiliate_payouts')
      .select('affiliate_id, status, failure_reason, paypal_receiver, created_at, updated_at')
      .eq('method', 'paypal')
      .in('affiliate_id', chunk)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE);
    if (error) throw new Error('Could not read the PayPal payout history.', { cause: error });
    const seen = new Set<string>();
    for (const row of Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []) {
      const affiliateId = typeof row['affiliate_id'] === 'string' ? row['affiliate_id'] : '';
      if (!affiliateId || seen.has(affiliateId)) continue;
      seen.add(affiliateId);
      const partner = known.get(affiliateId);
      const receiver = typeof row['paypal_receiver'] === 'string' ? row['paypal_receiver'].toLowerCase() : '';
      if (
        !partner ||
        row['status'] !== 'FAILED' ||
        !isAffiliatePayPalReceiverFailure(typeof row['failure_reason'] === 'string' ? row['failure_reason'] : null) ||
        !receiver ||
        receiver !== partner.email
      ) {
        continue;
      }
      // A save of the payout email after the failure (the same address included) lifts the block.
      const failedAt = Date.parse(typeof row['updated_at'] === 'string' ? row['updated_at'] : '');
      const savedAt = partner.savedAt ? Date.parse(partner.savedAt) : Number.NaN;
      if (Number.isFinite(savedAt) && Number.isFinite(failedAt) && savedAt > failedAt) continue;
      blocked.add(affiliateId);
    }
  }
  return blocked;
}

/** ACTIVE, approved partners whose payout email is a PayPal account PayPal can take, by id. */
async function listCandidates(ctx: RunContext): Promise<PartnerCandidate[]> {
  const candidates: PartnerCandidate[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await ctx.deps.supabase
      .from('affiliate_profiles')
      .select('id, status, first_published_at, payout_email, payout_email_kind, payout_email_saved_at, preferred_locale')
      .eq('status', 'ACTIVE')
      .not('first_published_at', 'is', null)
      .not('payout_email', 'is', null)
      .eq('payout_email_kind', 'paypal')
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error('Could not list the partners paid with PayPal.', { cause: error });
    const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    for (const row of rows) {
      const id = typeof row['id'] === 'string' ? row['id'] : '';
      const email = typeof row['payout_email'] === 'string' ? row['payout_email'] : '';
      if (!id || !isAffiliatePayPalPayoutReceiver(email, row['payout_email_kind'])) continue;
      const locale = row['preferred_locale'] === 'fr' ? 'fr' : 'en';
      ctx.locales.set(id, locale);
      const savedAt = row['payout_email_saved_at'];
      candidates.push({ affiliateId: id, email, emailSavedAt: typeof savedAt === 'string' && savedAt ? savedAt : null, locale });
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return candidates;
}

/** CLEARED, unattached, undisputed commissions of the PayPal gateways and mode, per partner and currency. */
async function loadClaimableSums(
  ctx: RunContext,
  affiliateIds: readonly string[],
  livemode: boolean
): Promise<Map<string, Map<string, number>>> {
  const sums = new Map<string, Map<string, number>>();
  for (let index = 0; index < affiliateIds.length; index += ID_CHUNK) {
    const chunk = affiliateIds.slice(index, index + ID_CHUNK);
    let afterId: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { rows, error } = await readAffiliateClaimableCommissionPage(ctx.deps.supabase, {
        livemode,
        columns: 'id, affiliate_id, currency, commission_amount_cents, refunded_amount_cents',
        affiliateIds: chunk,
        gateways: ctx.deps.gateways,
        from: 0,
        to: PAGE_SIZE - 1,
        afterId,
      });
      if (error) throw new Error('Could not read cleared commissions.', { cause: error });
      for (const row of rows) {
        const affiliateId = typeof row['affiliate_id'] === 'string' ? row['affiliate_id'] : null;
        const currency = typeof row['currency'] === 'string' ? row['currency'].trim().toUpperCase() : '';
        const net = Math.trunc(Number(row['commission_amount_cents']) - Number(row['refunded_amount_cents'] ?? 0));
        if (!affiliateId || !/^[A-Z]{3}$/.test(currency) || !Number.isFinite(net) || net <= 0) continue;
        const byCurrency = sums.get(affiliateId) ?? new Map<string, number>();
        byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + net);
        sums.set(affiliateId, byCurrency);
      }
      const last = rows.length > 0 ? rows[rows.length - 1]?.['id'] : null;
      if (rows.length < PAGE_SIZE || typeof last !== 'string') break;
      afterId = last;
    }
  }
  return sums;
}

/* ------------------------------------------------------------------- the sync --- */

async function applyItem(
  ctx: RunContext,
  client: AffiliatePayPalClient,
  payout: AffiliatePayoutRow,
  item: AffiliatePayPalItem
): Promise<void> {
  let current = item;
  const action = classifyAffiliatePayPalItemStatus(current.status, current.errorName);
  const db = ctx.deps.supabase;

  if (action.kind === 'complete') {
    if (!current.transactionId) {
      try {
        current = await client.getPayoutItem(current.itemId);
      } catch (error) {
        recordError(ctx, 'sync', error, payout.id);
      }
    }
    if (!current.transactionId) {
      ctx.summary.unknown += 1;
      ctx.summary.inFlight += 1;
      // PayPal says it paid: noted as SUCCESS, so the payout can never be released (and paid again)
      // while the next sync waits for the transaction id.
      try {
        await notePayPalAffiliatePayoutItemViaRpc(db, { payoutId: payout.id, itemId: current.itemId, itemStatus: 'SUCCESS' });
      } catch (error) {
        recordError(ctx, 'note', error, payout.id);
      }
      noteAlert(ctx, { kind: 'paypal_unknown_status', environment: environmentOf(payout), payouts: 1, code: 'SUCCESS_WITHOUT_TRANSACTION' });
      return;
    }
    const feeCents = current.feeCurrency === payout.currency ? current.feeCents : null;
    try {
      const result = await completePayPalAffiliatePayoutViaRpc(db, {
        payoutId: payout.id,
        itemId: current.itemId,
        transactionId: current.transactionId,
        feeCents,
        itemStatus: 'SUCCESS',
      });
      if (result.status === 'completed') {
        ctx.summary.completed += 1;
        ctx.settled.add(payout.id);
        await emit(ctx, { type: 'PAYOUT_SENT', payout: eventPayout(payout), transactionId: result.transactionId, feeCents });
      } else if (result.status === 'already_completed') {
        ctx.settled.add(payout.id);
      } else {
        ctx.summary.unknown += 1;
        ctx.summary.inFlight += 1;
        recordError(ctx, 'complete', { code: result.status }, payout.id);
        noteAlert(ctx, { kind: 'paypal_unknown_status', environment: environmentOf(payout), payouts: 1, code: result.status.toUpperCase() });
      }
    } catch (error) {
      ctx.summary.inFlight += 1;
      recordError(ctx, 'complete', error, payout.id);
    }
    return;
  }

  if (action.kind === 'fail') {
    try {
      const result = await failPayPalAffiliatePayoutViaRpc(db, { payoutId: payout.id, reason: action.reason, itemStatus: storableStatus(current.status) });
      if (result.status !== 'not_found') ctx.settled.add(payout.id);
      if (result.status === 'failed') {
        ctx.summary.failed += 1;
        if (action.operatorSide) {
          noteAlert(ctx, {
            kind: 'paypal_insufficient_funds',
            environment: environmentOf(payout),
            payouts: 1,
            currency: payout.currency,
            amountCents: payout.amount_cents,
          });
        } else {
          await emit(ctx, {
            type: 'PAYOUT_FAILED',
            payout: eventPayout(payout),
            reason: action.reason,
            itemStatus: storableStatus(current.status),
            cancelledByAdmin: false,
          });
        }
      }
    } catch (error) {
      ctx.summary.inFlight += 1;
      recordError(ctx, 'fail', error, payout.id);
    }
    return;
  }

  // keep or unknown: the payout stays in flight with what PayPal said noted
  const status = action.kind === 'keep' ? action.status : storableStatus(action.status);
  try {
    await notePayPalAffiliatePayoutItemViaRpc(db, {
      payoutId: payout.id,
      itemId: current.itemId,
      itemStatus: storableStatus(status),
      feeCents: current.feeCurrency === payout.currency ? current.feeCents : null,
    });
  } catch (error) {
    recordError(ctx, 'note', error, payout.id);
  }
  ctx.summary.inFlight += 1;
  if (action.kind === 'unknown') {
    ctx.summary.unknown += 1;
    noteAlert(ctx, { kind: 'paypal_unknown_status', environment: environmentOf(payout), payouts: 1, code: action.status });
    return;
  }
  if (action.status === 'UNCLAIMED') {
    ctx.summary.unclaimed += 1;
    if (payout.paypal_item_status !== 'UNCLAIMED') await emit(ctx, { type: 'PAYPAL_UNCLAIMED', payout: eventPayout(payout) });
  }
}

/** Step 1: every acknowledged batch with payouts in flight, checked with PayPal. Returns the payouts still in flight. */
async function syncInFlight(ctx: RunContext, payouts: AffiliatePayoutRow[]): Promise<void> {
  const acknowledged = payouts.filter((payout) => payout.paypal_batch_id);
  const batches = new Map<string, AffiliatePayoutRow[]>();
  for (const payout of acknowledged) {
    const key = `${environmentOf(payout)}|${payout.paypal_batch_id}`;
    batches.set(key, [...(batches.get(key) ?? []), payout]);
  }
  for (const [key, group] of batches) {
    const [environment, batchId] = key.split('|') as [AffiliatePayPalEnvironment, string];
    if (outOfTime(ctx)) {
      ctx.summary.inFlight += group.length;
      continue;
    }
    const client = await clientFor(ctx, environment);
    if (!client) {
      ctx.summary.inFlight += group.length;
      recordError(ctx, 'sync', { code: `not_configured_${environment}` });
      continue;
    }
    let batch;
    try {
      batch = await client.getPayoutBatchItems(batchId);
    } catch (error) {
      ctx.summary.inFlight += group.length;
      recordError(ctx, 'sync', error);
      if (isAffiliatePayPalError(error) && error.kind === 'credentials') {
        noteAlert(ctx, { kind: 'paypal_credentials', environment, payouts: group.length });
      } else if (!isAffiliatePayPalError(error) || (error.kind !== 'unavailable' && error.kind !== 'rate_limited')) {
        // PayPal will not show this batch (a 404 or 403 after the credentials moved to another PayPal
        // account, an answer that does not validate): its payouts keep their commissions until the
        // admin restores the credentials or checks PayPal and releases them. A timeout, a 5xx or a rate
        // limit is tried again by the next run without an alert.
        const code = isAffiliatePayPalError(error) ? (error.code ?? error.kind.toUpperCase()) : 'UNKNOWN';
        noteAlert(ctx, { kind: 'paypal_batch_unresolved', environment, payouts: group.length, code, batchId, cause: 'unreadable' });
      }
      continue;
    }
    ctx.summary.synced += group.length;
    const byItem = new Map(batch.items.map((item) => [item.itemId, item]));
    const bySender = new Map(batch.items.filter((item) => item.senderItemId).map((item) => [item.senderItemId as string, item]));
    const batchStatus = (batch.status ?? '').toUpperCase();
    const batchRefused = REFUSED_BATCH_STATUSES.has(batchStatus);
    for (const payout of group) {
      const item = (payout.paypal_item_id ? byItem.get(payout.paypal_item_id) : undefined) ?? bySender.get(payout.id) ?? null;
      // A DENIED or CANCELED batch processes none of its items PayPal had not processed yet, listed or
      // not; an item PayPal did process (UNCLAIMED, ONHOLD, a final status) follows its own status.
      if (item && !(batchRefused && UNPROCESSED_ITEM_STATUSES.has((item.status ?? '').trim().toUpperCase()))) {
        await applyItem(ctx, client, payout, item);
        continue;
      }
      if (batchRefused) {
        // The batch was not processed (PayPal checks the balance and the account first).
        try {
          const result = await failPayPalAffiliatePayoutViaRpc(ctx.deps.supabase, {
            payoutId: payout.id,
            reason: `paypal_${batchStatus.toLowerCase()}`,
            itemStatus: batchStatus,
          });
          if (result.status !== 'not_found') ctx.settled.add(payout.id);
          if (result.status === 'failed') {
            ctx.summary.failed += 1;
            noteAlert(ctx, { kind: 'paypal_refused', environment, payouts: 1, code: batchStatus, currency: payout.currency, amountCents: payout.amount_cents });
          }
        } catch (error) {
          ctx.summary.inFlight += 1;
          recordError(ctx, 'fail', error, payout.id);
        }
      } else if (batchStatus === 'SUCCESS') {
        ctx.summary.inFlight += 1;
        ctx.summary.unknown += 1;
        noteAlert(ctx, { kind: 'paypal_unknown_status', environment, payouts: 1, code: 'ITEM_MISSING', batchId });
      } else {
        // PENDING / PROCESSING: PayPal has not listed the items yet.
        ctx.summary.inFlight += 1;
        try {
          await notePayPalAffiliatePayoutItemViaRpc(ctx.deps.supabase, { payoutId: payout.id, itemId: null, itemStatus: null });
        } catch (error) {
          recordError(ctx, 'note', error, payout.id);
        }
      }
    }
  }
}

/* ----------------------------------------------------------- creating batches --- */

function batchTexts(siteName: string, locale: 'en' | 'fr'): { subject: string; message: string } {
  const site = siteName.replace(/\s+/g, ' ').trim() || 'Our store';
  return locale === 'fr'
    ? { subject: `Vous avez un versement de ${site}`, message: `${site} vous a envoyé vos commissions de partenaire.` }
    : { subject: `You have a payout from ${site}`, message: `${site} sent you your partner commissions.` };
}

/** The commissions each payout holds (for PayPal's note to the partner). */
async function commissionCounts(ctx: RunContext, payoutIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let index = 0; index < payoutIds.length; index += ID_CHUNK) {
    const chunk = payoutIds.slice(index, index + ID_CHUNK);
    const { data, error } = await ctx.deps.supabase.from('affiliate_commissions').select('payout_id').in('payout_id', chunk).limit(PAGE_SIZE * 10);
    if (error) throw new Error('Could not count the commissions of PayPal payouts.', { cause: error });
    for (const row of Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []) {
      if (typeof row['payout_id'] === 'string') counts.set(row['payout_id'], (counts.get(row['payout_id']) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Saves the batch PayPal accepted (or the original one a reused sender_batch_id links) on the payouts
 * that carry its sender id. Every payout of the batch should take it: one that does not (an admin
 * released it while PayPal was creating the batch) may still be paid by PayPal, so the admin is told.
 */
async function recordAcceptedBatch(
  ctx: RunContext,
  environment: AffiliatePayPalEnvironment,
  senderBatchId: string,
  ids: readonly string[],
  batchId: string
): Promise<void> {
  const recorded = await recordPayPalAffiliatePayoutBatchViaRpc(ctx.deps.supabase, { payoutIds: ids, senderBatchId, payoutBatchId: batchId });
  ctx.summary.submitted += ids.length;
  const count = recorded.status === 'recorded' ? recorded.count : 0;
  if (count < ids.length) {
    noteAlert(ctx, {
      kind: 'paypal_batch_unresolved',
      environment,
      payouts: ids.length - count,
      code: 'BATCH_NOT_RECORDED',
      senderBatchId,
      batchId,
      cause: 'not_recorded',
    });
  }
}

async function failBatch(ctx: RunContext, rows: readonly AffiliatePayoutRow[], reason: string): Promise<number> {
  let failed = 0;
  for (const payout of rows) {
    try {
      const result = await failPayPalAffiliatePayoutViaRpc(ctx.deps.supabase, { payoutId: payout.id, reason, itemStatus: null });
      if (result.status === 'failed') failed += 1;
    } catch (error) {
      recordError(ctx, 'fail', error, payout.id);
    }
  }
  ctx.summary.failed += failed;
  return failed;
}

/**
 * A resend PayPal refused before it could look at the first batch (the token, the account's Payouts
 * access, the balance): that says nothing about the first request, which PayPal may hold and pay, so
 * the payouts stay in flight with their sender_batch_id (sent again once the cause is fixed) and the
 * admin is told why. Releasing them here could pay them twice.
 */
function keepAfterRefusedResend(
  ctx: RunContext,
  environment: AffiliatePayPalEnvironment,
  senderBatchId: string,
  rows: readonly AffiliatePayoutRow[],
  error: AffiliatePayPalError,
  cause: 'insufficient_funds' | 'not_enabled' | 'credentials'
): void {
  ctx.summary.pendingRetry += rows.length;
  noteAlert(ctx, {
    kind: 'paypal_batch_unresolved',
    environment,
    payouts: rows.length,
    currency: rows[0]?.currency ?? null,
    amountCents: rows.reduce((sum, row) => sum + row.amount_cents, 0),
    code: error.code ?? error.kind.toUpperCase(),
    senderBatchId,
    cause,
  });
}

/**
 * Sends one batch (a new one, or again with the same sender_batch_id after an unknown outcome) and
 * settles its payouts by PayPal's answer (see the file comment).
 */
async function sendBatch(
  ctx: RunContext,
  environment: AffiliatePayPalEnvironment,
  senderBatchId: string,
  rows: AffiliatePayoutRow[],
  retry: boolean
): Promise<void> {
  if (rows.length === 0) return;
  const client = await clientFor(ctx, environment);
  if (!client) {
    ctx.summary.pendingRetry += rows.length;
    recordError(ctx, 'create', { code: `not_configured_${environment}` });
    return;
  }
  let counts = new Map<string, number>();
  try {
    await loadLocales(ctx, rows.map((row) => row.affiliate_id));
    counts = await commissionCounts(ctx, rows.map((row) => row.id));
  } catch (error) {
    recordError(ctx, 'batch', error);
  }
  const locale = ctx.locales.get(rows[0]?.affiliate_id ?? '') ?? 'en';
  const texts = batchTexts(ctx.deps.siteName, locale);
  const currency = rows[0]?.currency ?? 'USD';
  const amountCents = rows.reduce((sum, row) => sum + row.amount_cents, 0);
  const ids = rows.map((row) => row.id);
  try {
    const created = await client.createPayoutBatch({
      senderBatchId,
      emailSubject: texts.subject,
      emailMessage: texts.message,
      items: rows.map((row) => ({
        receiver: row.paypal_receiver ?? '',
        amountCents: row.amount_cents,
        currency: row.currency,
        note: affiliatePayPalPayoutNote(ctx.deps.siteName, counts.get(row.id) ?? 1, ctx.locales.get(row.affiliate_id) ?? 'en'),
        senderItemId: row.id,
      })),
    });
    await recordAcceptedBatch(ctx, environment, senderBatchId, ids, created.batchId);
    return;
  } catch (error) {
    if (!isAffiliatePayPalError(error)) {
      // A database error after PayPal accepted the batch, or anything unexpected: the outcome is
      // unknown, so the payouts stay in flight with their sender_batch_id and are sent again (PayPal
      // replays the first answer for the same PayPal-Request-Id).
      ctx.summary.pendingRetry += rows.length;
      recordError(ctx, 'create', error);
      return;
    }
    recordError(ctx, 'create', error);
    switch (error.kind) {
      case 'duplicate_batch':
        if (error.batchId) {
          try {
            await recordAcceptedBatch(ctx, environment, senderBatchId, ids, error.batchId);
          } catch (recordFailure) {
            ctx.summary.pendingRetry += rows.length;
            recordError(ctx, 'batch', recordFailure);
          }
        } else {
          ctx.summary.pendingRetry += rows.length;
          noteAlert(ctx, { kind: 'paypal_batch_unresolved', environment, payouts: rows.length, code: error.code, senderBatchId });
        }
        return;
      case 'unavailable':
      case 'rate_limited':
        ctx.summary.pendingRetry += rows.length;
        return;
      case 'malformed':
        // A 2xx this site could not read (the client already tried to pick PayPal's batch id out of
        // it): PayPal probably created the batch. Kept in flight, sent again with the same id (PayPal
        // replays its answer), and the admin is told.
        ctx.summary.pendingRetry += rows.length;
        noteAlert(ctx, { kind: 'paypal_batch_unresolved', environment, payouts: rows.length, code: 'MALFORMED_RESPONSE', senderBatchId, cause: 'malformed' });
        return;
      case 'insufficient_funds':
        if (retry) {
          keepAfterRefusedResend(ctx, environment, senderBatchId, rows, error, 'insufficient_funds');
          return;
        }
        await failBatch(ctx, rows, 'paypal_insufficient_funds');
        noteAlert(ctx, { kind: 'paypal_insufficient_funds', environment, payouts: rows.length, currency, amountCents });
        return;
      case 'not_enabled':
        ctx.stopSending = true;
        if (retry) {
          keepAfterRefusedResend(ctx, environment, senderBatchId, rows, error, 'not_enabled');
          return;
        }
        await failBatch(ctx, rows, 'paypal_not_enabled');
        noteAlert(ctx, { kind: 'paypal_not_enabled', environment, payouts: rows.length, code: error.code });
        return;
      case 'credentials':
        ctx.stopSending = true;
        if (retry) {
          // The token request failed: the resend never even reached the create call.
          keepAfterRefusedResend(ctx, environment, senderBatchId, rows, error, 'credentials');
          return;
        }
        await failBatch(ctx, rows, 'paypal_credentials');
        noteAlert(ctx, { kind: 'paypal_credentials', environment, payouts: rows.length });
        return;
      default:
        if (retry) {
          // A batch sent again and refused without naming the original: PayPal may hold the first
          // one, so nothing is released (it could be paid twice). The admin checks it in PayPal.
          ctx.summary.pendingRetry += rows.length;
          noteAlert(ctx, { kind: 'paypal_batch_unresolved', environment, payouts: rows.length, code: error.code, senderBatchId });
          return;
        }
        // A first send PayPal refused outright (it validates before it creates anything).
        await failBatch(ctx, rows, `paypal_refused${error.code ? `:${error.code.toLowerCase()}` : ''}`.slice(0, 120));
        noteAlert(ctx, { kind: 'paypal_refused', environment, payouts: rows.length, code: error.code, currency, amountCents });
    }
  }
}

/** The payouts sent with an unknown outcome (a sender id, no batch id), by environment and sender id. */
function unconfirmedGroups(ctx: RunContext, payouts: readonly AffiliatePayoutRow[]): Map<string, AffiliatePayoutRow[]> {
  const groups = new Map<string, AffiliatePayoutRow[]>();
  for (const payout of payouts) {
    if (!payout.paypal_sender_batch_id || payout.paypal_batch_id || ctx.settled.has(payout.id)) continue;
    const key = `${environmentOf(payout)}|${payout.paypal_sender_batch_id}`;
    groups.set(key, [...(groups.get(key) ?? []), payout]);
  }
  return groups;
}

/** The batch's payouts were first claimed {@link AFFILIATE_PAYPAL_RESEND_MAX_AGE_MS} ago or more (an unreadable date counts). */
function pastResendWindow(ctx: RunContext, rows: readonly AffiliatePayoutRow[]): boolean {
  const claimed = rows.map((row) => Date.parse(row.created_at)).map((ms) => (Number.isFinite(ms) ? ms : 0));
  return claimed.length > 0 && nowMs(ctx) - Math.min(...claimed) >= AFFILIATE_PAYPAL_RESEND_MAX_AGE_MS;
}

/** A batch past the resend window: kept in flight, never sent again; the admin checks PayPal. */
function noteExpiredBatch(ctx: RunContext, environment: AffiliatePayPalEnvironment, senderBatchId: string, rows: readonly AffiliatePayoutRow[]): void {
  noteAlert(ctx, {
    kind: 'paypal_batch_unresolved',
    environment,
    payouts: rows.length,
    code: 'RESEND_WINDOW_PASSED',
    senderBatchId,
    cause: 'expired',
  });
}

/**
 * Step 2: batches whose create call had an unknown outcome, sent again with the same sender_batch_id.
 * A batch first claimed over {@link AFFILIATE_PAYPAL_RESEND_MAX_AGE_MS} ago is not sent again (PayPal
 * may have forgotten the id and would pay it as a new batch): its payouts stay in flight and the admin
 * checks PayPal. Before each resend the send is stamped on the payouts (`last_attempt_at`, which the
 * CMS Release waits an hour after) and the payouts that still carry the id with no batch id are read
 * again: exactly those are sent, so a payout released meanwhile never is.
 */
async function resendUnconfirmed(ctx: RunContext, payouts: AffiliatePayoutRow[]): Promise<void> {
  const db = ctx.deps.supabase;
  for (const [key, rows] of unconfirmedGroups(ctx, payouts)) {
    const [environment, senderBatchId] = key.split('|') as [AffiliatePayPalEnvironment, string];
    if (pastResendWindow(ctx, rows)) {
      ctx.summary.pendingRetry += rows.length;
      noteExpiredBatch(ctx, environment, senderBatchId, rows);
      continue;
    }
    if (ctx.stopSending || outOfTime(ctx)) {
      ctx.summary.pendingRetry += rows.length;
      continue;
    }
    // No credentials for the payout's environment: nothing can be sent, so no send is stamped either.
    if (!(await clientFor(ctx, environment))) {
      ctx.summary.pendingRetry += rows.length;
      recordError(ctx, 'create', { code: `not_configured_${environment}` });
      continue;
    }
    let current: AffiliatePayoutRow[];
    try {
      await recordPayPalAffiliatePayoutBatchViaRpc(db, { payoutIds: rows.map((row) => row.id), senderBatchId });
      current = (await readBatchPayouts(db, senderBatchId)).filter((row) => !row.paypal_batch_id && environmentOf(row) === environment);
    } catch (error) {
      // Nothing was sent: the next run tries again.
      ctx.summary.pendingRetry += rows.length;
      recordError(ctx, 'batch', error);
      continue;
    }
    await sendBatch(ctx, environment, senderBatchId, current, true);
  }
}

/** Saves a new sender_batch_id on payouts, then sends exactly the payouts that carry it. */
async function sendNewBatch(ctx: RunContext, environment: AffiliatePayPalEnvironment, payoutIds: string[]): Promise<void> {
  if (payoutIds.length === 0) return;
  const senderBatchId = (ctx.deps.newSenderBatchId ?? randomUUID)();
  let rows: AffiliatePayoutRow[];
  try {
    await recordPayPalAffiliatePayoutBatchViaRpc(ctx.deps.supabase, { payoutIds, senderBatchId });
    rows = await readBatchPayouts(ctx.deps.supabase, senderBatchId);
  } catch (error) {
    // Nothing reached PayPal: the payouts stay claimed and the next run sends them.
    recordError(ctx, 'batch', error);
    return;
  }
  await sendBatch(ctx, environment, senderBatchId, rows, false);
}

/** Step 3: claims for the partners paid with PayPal, then one new batch per currency and language. */
async function claimAndSend(ctx: RunContext, inFlight: AffiliatePayoutRow[]): Promise<void> {
  const environment = ctx.deps.environment;
  const livemode = environment === 'live';
  const client = await clientFor(ctx, environment);
  if (!client) {
    ctx.summary.skipped = 'not_configured';
    return;
  }
  try {
    const token = await client.getToken();
    if (!token.scopes.includes(AFFILIATE_PAYPAL_PAYOUTS_SCOPE)) {
      ctx.summary.skipped = 'not_enabled';
      noteAlert(ctx, { kind: 'paypal_not_enabled', environment, payouts: 0, code: 'REQUIRED_SCOPE_MISSING' });
      return;
    }
  } catch (error) {
    recordError(ctx, 'token', error);
    if (isAffiliatePayPalError(error) && error.kind === 'credentials') {
      ctx.summary.skipped = 'credentials';
      noteAlert(ctx, { kind: 'paypal_credentials', environment, payouts: 0 });
    } else if (isAffiliatePayPalError(error) && error.kind === 'not_enabled') {
      ctx.summary.skipped = 'not_enabled';
      noteAlert(ctx, { kind: 'paypal_not_enabled', environment, payouts: 0, code: error.code });
    } else {
      ctx.summary.skipped = 'unavailable';
    }
    return;
  }

  // Claimed payouts that never got a sender_batch_id (a run that stopped right after its claim): sent
  // now. A payout the sync settled is no longer in flight.
  const stillInFlight = inFlight.filter((payout) => !ctx.settled.has(payout.id) && environmentOf(payout) === environment);
  const orphans = stillInFlight
    .filter((payout) => !payout.paypal_sender_batch_id)
    .map((payout) => ({ id: payout.id, affiliateId: payout.affiliate_id, currency: payout.currency }));
  const busy = new Set(stillInFlight.map((payout) => `${payout.affiliate_id}|${payout.currency}`));

  let candidates: PartnerCandidate[] = [];
  let sums = new Map<string, Map<string, number>>();
  try {
    candidates = await listCandidates(ctx);
    const blocked = await loadAffiliatePayPalBlockedReceivers(ctx.deps.supabase, candidates);
    candidates = candidates.filter((candidate) => !blocked.has(candidate.affiliateId));
    sums = await loadClaimableSums(
      ctx,
      candidates.map((candidate) => candidate.affiliateId),
      livemode
    );
  } catch (error) {
    recordError(ctx, 'candidates', error);
  }

  const toSend: Array<{ id: string; affiliateId: string; currency: string }> = orphans;
  const maxClaims = Math.max(1, Math.trunc(ctx.deps.maxClaims ?? DEFAULT_MAX_CLAIMS));
  const minimum = Math.max(1, Math.trunc(Number(ctx.deps.minPayoutCents) || 0));
  let claims = 0;
  for (const candidate of candidates) {
    const currencies = sums.get(candidate.affiliateId);
    if (!currencies) continue;
    for (const [currency, amount] of [...currencies.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (amount < minimum || busy.has(`${candidate.affiliateId}|${currency}`)) continue;
      // PayPal Payouts sends 24 currencies, HUF, JPY and TWD in whole units only: anything else would be
      // refused on every run. It stays owed (an unsupported currency is listed under Pay manually).
      if (!canAffiliatePayPalSendAmount(amount, currency)) {
        noteAlert(ctx, {
          kind: 'paypal_currency_unsupported',
          environment,
          payouts: 1,
          currency,
          amountCents: amount,
          code: isAffiliatePayPalPayoutCurrency(currency) ? 'NOT_WHOLE_UNITS' : 'CURRENCY_NOT_SUPPORTED',
        });
        continue;
      }
      if (claims >= maxClaims || outOfTime(ctx) || ctx.stopSending) {
        ctx.summary.remaining += 1;
        continue;
      }
      claims += 1;
      try {
        const result = await claimPayPalAffiliatePayoutViaRpc(ctx.deps.supabase, {
          affiliateId: candidate.affiliateId,
          currency,
          minAmountCents: minimum,
          gateways: ctx.deps.gateways,
          livemode,
          trigger: ctx.deps.trigger,
        });
        if (result.status === 'claimed') {
          ctx.summary.claimed += 1;
          toSend.push({ id: result.payoutId, affiliateId: candidate.affiliateId, currency });
        }
      } catch (error) {
        recordError(ctx, 'claim', error);
      }
    }
  }

  // One batch per currency and language (PayPal's email to the partner is the batch's).
  try {
    await loadLocales(ctx, toSend.map((payout) => payout.affiliateId));
  } catch (error) {
    recordError(ctx, 'batch', error);
  }
  const groups = new Map<string, string[]>();
  for (const payout of toSend) {
    const key = `${payout.currency}|${ctx.locales.get(payout.affiliateId) ?? 'en'}`;
    groups.set(key, [...(groups.get(key) ?? []), payout.id]);
  }
  for (const ids of groups.values()) {
    if (ctx.stopSending) break;
    await sendNewBatch(ctx, environment, ids);
  }
}

/**
 * One PayPal pass (see the file comment). Never throws; returns what it did. The caller checks the
 * package, the sandbox and (for an admin) the session, and decides `send` (automatic payouts on, or
 * "Run payouts now"). On the public sandbox it returns `skipped: 'sandbox'` before reading anything,
 * whatever the caller checked (the PayPal client refuses there too).
 */
export async function runAffiliatePayPalPayouts(deps: AffiliatePayPalRunDeps): Promise<AffiliatePayPalRunSummary> {
  const clock = deps.now ?? (() => new Date());
  const sandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
  const summary: AffiliatePayPalRunSummary = {
    environment: deps.environment,
    gateways: [...deps.gateways],
    startedAt: clock().toISOString(),
    finishedAt: clock().toISOString(),
    skipped: sandbox ? 'sandbox' : null,
    synced: 0,
    completed: 0,
    failed: 0,
    inFlight: 0,
    unclaimed: 0,
    unknown: 0,
    claimed: 0,
    submitted: 0,
    pendingRetry: 0,
    remaining: 0,
    errors: [],
  };
  const ctx: RunContext = {
    deps,
    summary,
    clients: new Map(),
    locales: new Map(),
    startedMs: Date.now(),
    timeBudgetMs: Math.max(1_000, Math.trunc(deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS)),
    stopSending: false,
    alerts: new Map(),
    settled: new Set(),
  };
  if (sandbox) return summary;

  try {
    let inFlight: AffiliatePayoutRow[] = [];
    try {
      inFlight = await readInFlight(deps.supabase);
    } catch (error) {
      recordError(ctx, 'read', error);
      summary.finishedAt = clock().toISOString();
      return summary;
    }
    await syncInFlight(ctx, inFlight);
    if (deps.send) {
      await resendUnconfirmed(ctx, inFlight);
      if (deps.gateways.length > 0) await claimAndSend(ctx, inFlight);
    } else {
      // Only checking: nothing is sent again, but a batch past the resend window is reported now.
      for (const [key, rows] of unconfirmedGroups(ctx, inFlight)) {
        summary.pendingRetry += rows.length;
        const [environment, senderBatchId] = key.split('|') as [AffiliatePayPalEnvironment, string];
        if (pastResendWindow(ctx, rows)) noteExpiredBatch(ctx, environment, senderBatchId, rows);
      }
    }
  } catch (error) {
    recordError(ctx, 'run', error);
  }

  for (const alert of ctx.alerts.values()) {
    try {
      await deps.hooks?.onAlert?.(alert);
    } catch (error) {
      recordError(ctx, 'hook', error);
    }
  }
  summary.finishedAt = clock().toISOString();
  return summary;
}

/* ------------------------------------------------------- one payout, for the CMS --- */

export type AffiliatePayPalCancelOutcome =
  /** `recorded: false`: PayPal cancelled the item but the ledger write failed; the next PayPal check fails it. */
  | { status: 'cancelled'; result: 'returned'; recorded: boolean }
  | { status: 'released' }
  | { status: 'completed' }
  | { status: 'failed' }
  | { status: 'still_in_flight'; itemStatus: string | null }
  /** PayPal answered the cancel with an error (its name and debug id, for a support ticket); nothing changed. */
  | { status: 'paypal_error'; code: string | null; debugId: string | null }
  | { status: 'sandbox' | 'not_found' | 'not_cancellable' | 'not_configured' | 'unavailable' };

/**
 * Whether the CMS offers Release for a PayPal payout in flight (the screen's guide; 02037's
 * `release_paypal_affiliate_payout` decides under the payout lock): `unconfirmed` for a batch PayPal
 * never acknowledged, an hour after its last send; `acknowledged` for a batch PayPal acknowledged but
 * never settled, a week after its last send while PayPal lists no status it holds money in; null
 * otherwise.
 */
export function affiliatePayPalReleaseKind(
  payout: Pick<AffiliatePayoutRow, 'paypal_batch_id' | 'paypal_item_status' | 'last_attempt_at'>,
  now: Date
): 'unconfirmed' | 'acknowledged' | null {
  const last = Date.parse(payout.last_attempt_at);
  if (!Number.isFinite(last)) return null;
  const age = now.getTime() - last;
  if (!payout.paypal_batch_id) return age >= AFFILIATE_PAYPAL_UNCONFIRMED_RELEASE_AFTER_MS ? 'unconfirmed' : null;
  const status = (payout.paypal_item_status ?? '').toUpperCase();
  if (status === 'SUCCESS' || KEEP_STATUSES.has(status)) return null;
  return age >= AFFILIATE_PAYPAL_ACKNOWLEDGED_RELEASE_AFTER_MS ? 'acknowledged' : null;
}

/**
 * The CMS "Stop payment" and "Release" of one PayPal payout in flight (the caller checked the ADMIN,
 * the sandbox and the package). An item PayPal still lists as UNCLAIMED is cancelled at PayPal
 * (`POST …/cancel`), then the payout fails and its commissions go back (`paypal_cancelled`). PayPal's
 * current status is read first: an item paid meanwhile completes the payout instead, one returned
 * fails it. A payout PayPal cannot be paying, after the admin checked PayPal, is released without a
 * PayPal write (`release_paypal_affiliate_payout`, which decides under the payout lock): a batch PayPal
 * never acknowledged an hour after its last send, one it acknowledged but never settled (no item, an
 * unreadable item, a status this site does not know) a week after it. Anything else is
 * `not_cancellable`. On the public sandbox it answers `sandbox` before reading anything.
 */
export async function cancelAffiliatePayPalPayout(
  deps: Pick<AffiliatePayPalRunDeps, 'supabase' | 'credentialsFor' | 'createClient' | 'hooks' | 'now'>,
  payoutId: string
): Promise<AffiliatePayPalCancelOutcome> {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') return { status: 'sandbox' };
  const { data, error } = await deps.supabase.from('affiliate_payouts').select('*').eq('id', payoutId).eq('method', 'paypal').maybeSingle();
  if (error) throw new Error('Could not read the PayPal payout.', { cause: error });
  const payout = normalizeAffiliatePayoutRow(data);
  if (!payout || payout.status !== 'PROCESSING') return { status: 'not_found' };
  const environment = environmentOf(payout);
  const emitFailed = async (reason: string, itemStatus: string | null, cancelledByAdmin: boolean) => {
    try {
      await deps.hooks?.onEvent?.({ type: 'PAYOUT_FAILED', payout: eventPayout(payout), reason, itemStatus, cancelledByAdmin });
    } catch {
      // A notification never changes a money outcome.
    }
  };
  // The admin checked PayPal paid nothing; the database releases only what PayPal cannot be paying.
  const release = async (): Promise<AffiliatePayPalCancelOutcome> => {
    const result = await releasePayPalAffiliatePayoutViaRpc(deps.supabase, { payoutId });
    switch (result.status) {
      case 'released':
        return { status: 'released' };
      case 'already_completed':
        return { status: 'completed' };
      case 'already_failed':
        return { status: 'failed' };
      case 'not_found':
        return { status: 'not_found' };
      default:
        return { status: 'not_cancellable' };
    }
  };

  if (!payout.paypal_batch_id || !payout.paypal_item_id) {
    // Never acknowledged by PayPal (claimed and never sent, or sent with an unknown outcome), or
    // acknowledged without an item this site knows: nothing to cancel at PayPal.
    return release();
  }

  const credentials = await deps.credentialsFor(environment);
  let item: AffiliatePayPalItem | null = null;
  let client: AffiliatePayPalClient | null = null;
  if (credentials) {
    client = (deps.createClient ?? createAffiliatePayPalClient)(credentials);
    try {
      item = await client.getPayoutItem(payout.paypal_item_id);
    } catch {
      item = null;
    }
  }
  if (!item || !client) {
    // PayPal cannot say (no credentials for this environment any more, the item unreadable): only the
    // release of a payout PayPal never settled applies.
    const released = await release();
    if (released.status !== 'not_cancellable') return released;
    return credentials ? { status: 'unavailable' } : { status: 'not_configured' };
  }
  const before = classifyAffiliatePayPalItemStatus(item.status, item.errorName);
  if (before.kind === 'complete' && item.transactionId) {
    const result = await completePayPalAffiliatePayoutViaRpc(deps.supabase, {
      payoutId,
      itemId: item.itemId,
      transactionId: item.transactionId,
      feeCents: item.feeCurrency === payout.currency ? item.feeCents : null,
    });
    if (result.status === 'completed') {
      try {
        await deps.hooks?.onEvent?.({ type: 'PAYOUT_SENT', payout: eventPayout(payout), transactionId: result.transactionId, feeCents: null });
      } catch {
        // A notification never changes a money outcome.
      }
    }
    return { status: 'completed' };
  }
  if (before.kind === 'fail') {
    const result = await failPayPalAffiliatePayoutViaRpc(deps.supabase, { payoutId, reason: before.reason, itemStatus: storableStatus(item.status) });
    if (result.status === 'failed' && !before.operatorSide) await emitFailed(before.reason, storableStatus(item.status), false);
    return { status: 'failed' };
  }
  if (before.kind === 'unknown') {
    // A status this site does not know: PayPal's answer settles nothing, so only the release of a
    // payout PayPal never settled applies (the database refuses it for a week after the last send).
    const released = await release();
    return released.status === 'not_cancellable' ? { status: 'still_in_flight', itemStatus: storableStatus(item.status) } : released;
  }
  if (before.kind !== 'keep' || before.status !== 'UNCLAIMED') return { status: 'still_in_flight', itemStatus: storableStatus(item.status) };

  let cancelled: AffiliatePayPalItem;
  try {
    cancelled = await client.cancelPayoutItem(item.itemId);
  } catch (error) {
    // PayPal answered with an error (the sandbox answers some cancels with 500 INTERNAL_SERVICE_ERROR):
    // say which, so the operator can retry later or quote the debug id to PayPal. Nothing changed.
    if (isAffiliatePayPalError(error) && error.status !== null) {
      console.warn('[affiliates] PayPal refused to cancel a payout item', { code: errorCode(error), debugId: error.debugId });
      return { status: 'paypal_error', code: error.code, debugId: error.debugId };
    }
    return { status: 'unavailable' };
  }
  // PayPal answers the item, RETURNED once cancelled; anything else is settled by the next sync.
  const after = classifyAffiliatePayPalItemStatus(cancelled.status, cancelled.errorName);
  if (after.kind !== 'fail') return { status: 'still_in_flight', itemStatus: storableStatus(cancelled.status) };
  try {
    const result = await failPayPalAffiliatePayoutViaRpc(deps.supabase, {
      payoutId,
      reason: 'paypal_cancelled',
      itemStatus: storableStatus(cancelled.status),
    });
    if (result.status === 'failed') await emitFailed('paypal_cancelled', storableStatus(cancelled.status), true);
  } catch {
    // PayPal has cancelled the item (the money is back in the PayPal balance): the next PayPal check
    // reads RETURNED and fails the payout then.
    return { status: 'cancelled', result: 'returned', recorded: false };
  }
  return { status: 'cancelled', result: 'returned', recorded: true };
}
