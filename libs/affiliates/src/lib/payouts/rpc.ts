/**
 * Typed wrappers around the service-role payout RPCs of migrations 02030, 02036 (manual payouts) and
 * 02037 (PayPal payouts). Every money
 * write is one of these SQL functions (row locks taken in one order: profile, commissions, payout),
 * so the runner never updates ledger rows itself. Pass the service-role client: the functions are
 * revoked from the API roles.
 */
import type {
  AffiliateGateway,
  AffiliateManualPayoutChannel,
  AffiliatePayoutRow,
  AffiliatePayoutTrigger,
} from '../core/types';
import type { AffiliateRepositoryClient } from '../repository/client';
import { normalizeAffiliatePayoutRow, normalizeAffiliateRows } from '../repository/rows';

/**
 * A failed payout RPC. The message is generic on purpose (it can reach logs and run summaries);
 * the PostgREST error stays on `cause` and its code on `code`.
 */
export class AffiliatePayoutRpcError extends Error {
  readonly rpc: string;
  /** PostgREST / Postgres error code (`PGRST202`, `22023`, …) when there is one. */
  readonly code: string | null;

  constructor(rpc: string, cause: unknown) {
    super(`Affiliate payouts: ${rpc} failed`, { cause });
    this.name = 'AffiliatePayoutRpcError';
    this.rpc = rpc;
    const code = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
    this.code = typeof code === 'string' && code ? code : null;
  }
}

async function callPayoutRpc(supabase: AffiliateRepositoryClient, rpc: string, args: Record<string, unknown>): Promise<unknown> {
  let response: { data: unknown; error: unknown };
  try {
    response = (await supabase.rpc(rpc, args)) as { data: unknown; error: unknown };
  } catch (error) {
    throw new AffiliatePayoutRpcError(rpc, error);
  }
  if (response.error) throw new AffiliatePayoutRpcError(rpc, response.error);
  return response.data;
}

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function firstPayout(data: unknown): AffiliatePayoutRow | null {
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return normalizeAffiliateRows(rows, normalizeAffiliatePayoutRow)[0] ?? null;
}

/** A1/A11 repair pass: records commissions the order trigger missed, voids refunded ones. */
export async function reconcileAffiliateCommissionsViaRpc(
  supabase: AffiliateRepositoryClient,
  limit = 200
): Promise<{ recorded: number; voided: number }> {
  const data = await callPayoutRpc(supabase, 'reconcile_affiliate_commissions', { p_limit: limit });
  const record = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return { recorded: count(record['recorded']), voided: count(record['voided']) };
}

/** PENDING_CLEARANCE commissions past `clears_at` become CLEARED. Returns how many. */
export async function promoteClearedAffiliateCommissionsViaRpc(supabase: AffiliateRepositoryClient): Promise<number> {
  return count(await callPayoutRpc(supabase, 'promote_cleared_affiliate_commissions', {}));
}

/**
 * Attaches the partner's CLEARED, unattached commissions in `currency` to a new PROCESSING
 * payout and returns it, or null when nothing is claimable (partner not eligible, nothing
 * cleared, or the sum is below `minAmountCents`). Only commissions of the partner's Connect
 * account mode (`stripe_connect_livemode`; none while it is unknown) and not under dispute are
 * claimed, and the payout records that mode (`livemode`). `gateways` (02036) limits the claim to
 * the commissions of those gateways (the ones the program pays through Stripe); omitted or null,
 * every gateway is claimed (and `p_gateways` is not sent, as before 02036).
 */
export async function claimAffiliatePayoutViaRpc(
  supabase: AffiliateRepositoryClient,
  input: {
    affiliateId: string;
    currency: string;
    minAmountCents: number;
    trigger: AffiliatePayoutTrigger;
    gateways?: readonly AffiliateGateway[] | null;
  }
): Promise<AffiliatePayoutRow | null> {
  const args: Record<string, unknown> = {
    p_affiliate_id: input.affiliateId,
    p_currency: input.currency,
    p_min_amount: Math.max(0, Math.trunc(input.minAmountCents)),
    p_trigger: input.trigger,
  };
  if (Array.isArray(input.gateways)) args['p_gateways'] = [...input.gateways];
  const data = await callPayoutRpc(supabase, 'claim_affiliate_payout', args);
  return firstPayout(data);
}

/* ------------------------------------------------------------- manual payouts --- */
// 02036: a manual payout is claimed before the money is sent (claim_manual_affiliate_payout:
// PROCESSING, its commissions reserved), then recorded once the money left
// (record_manual_affiliate_payout: COMPLETED, PAID) or cancelled before it did
// (cancel_manual_affiliate_payout: the commissions handed back, the row deleted). Each function
// answers a jsonb status for every expected case; these read it into typed results and throw
// AffiliatePayoutRpcError for anything malformed.

/** Every answer of `claim_manual_affiliate_payout` (02036). */
export const AFFILIATE_MANUAL_PAYOUT_CLAIM_STATUSES = [
  'prepared',
  'invalid_input',
  'not_found',
  'not_eligible',
  'already_prepared',
  'nothing_owed',
  'below_minimum',
] as const;

/** Every answer of `record_manual_affiliate_payout` (02036). */
export const AFFILIATE_MANUAL_PAYOUT_RECORD_STATUSES = [
  'recorded',
  'invalid_input',
  'reference_required',
  'not_found',
  'already_recorded',
  'duplicate_reference',
] as const;

/** Every answer of `cancel_manual_affiliate_payout` (02036). */
export const AFFILIATE_MANUAL_PAYOUT_CANCEL_STATUSES = ['cancelled', 'not_found', 'already_recorded'] as const;

export type AffiliateManualPayoutClaimStatus = (typeof AFFILIATE_MANUAL_PAYOUT_CLAIM_STATUSES)[number];
export type AffiliateManualPayoutRecordStatus = (typeof AFFILIATE_MANUAL_PAYOUT_RECORD_STATUSES)[number];
export type AffiliateManualPayoutCancelStatus = (typeof AFFILIATE_MANUAL_PAYOUT_CANCEL_STATUSES)[number];

/** What `claim_manual_affiliate_payout` did (see the 02036 comment of the function). */
export type AffiliateManualPayoutClaimResult =
  | { status: 'prepared'; payoutId: string; amountCents: number; commissionCount: number }
  /** A prepared payout of that currency waits to be recorded or cancelled: this one. */
  | { status: 'already_prepared'; payoutId: string; amountCents: number }
  /** What is owed is below the minimum asked for: nothing was reserved. */
  | { status: 'below_minimum'; amountCents: number; commissionCount: number }
  | { status: Exclude<AffiliateManualPayoutClaimStatus, 'prepared' | 'already_prepared' | 'below_minimum'> };

/** What `record_manual_affiliate_payout` did. */
export type AffiliateManualPayoutRecordResult =
  | { status: 'recorded'; payoutId: string; affiliateId: string; amountCents: number; currency: string; commissionCount: number }
  | { status: Exclude<AffiliateManualPayoutRecordStatus, 'recorded'> };

/** What `cancel_manual_affiliate_payout` did. */
export type AffiliateManualPayoutCancelResult =
  | { status: 'cancelled'; commissionCount: number }
  | { status: Exclude<AffiliateManualPayoutCancelStatus, 'cancelled'> };

export interface AffiliateManualPayoutClaimInput {
  affiliateId: string;
  /** The store base currency the commissions were recorded in. */
  currency: string;
  /** Below this sum nothing is reserved (`below_minimum`); 0 prepares whatever is owed. */
  minAmountCents?: number;
  /** The gateways the program pays manually (`affiliateGatewaysPaidManually`); an empty list reserves nothing. */
  gateways: readonly AffiliateGateway[];
}

export interface AffiliateManualPayoutRecordInput {
  /** The prepared (PROCESSING) manual payout whose money left. */
  payoutId: string;
  channel: AffiliateManualPayoutChannel;
  /** The PayPal transaction ID, e-Transfer or bank reference (required, at most 120 characters). */
  reference: string;
  /** A note the partner reads (at most 500 characters). */
  note?: string | null;
  /** The admin recording it: the app passes the verified actor (`requireCmsAdmin()`), never input. */
  recordedBy: string;
}

function rpcRecord(rpc: string, data: unknown, statuses: ReadonlySet<string>): { record: Record<string, unknown>; status: string } {
  const record = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  const status = typeof record?.['status'] === 'string' ? record['status'] : '';
  if (!record || !statuses.has(status)) throw new AffiliatePayoutRpcError(rpc, new Error('Unexpected answer.'));
  return { record, status };
}

/** A positive amount of minor units from a jsonb answer, or a thrown error. */
function rpcAmount(rpc: string, value: unknown): number {
  const amount = Math.trunc(Number(value));
  if (!Number.isFinite(amount) || amount <= 0) throw new AffiliatePayoutRpcError(rpc, new Error('Unexpected amount.'));
  return amount;
}

/** A count from a jsonb answer, or a thrown error. */
function rpcCount(rpc: string, value: unknown): number {
  const amount = Math.trunc(Number(value));
  if (!Number.isFinite(amount) || amount < 0) throw new AffiliatePayoutRpcError(rpc, new Error('Unexpected count.'));
  return amount;
}

function rpcId(rpc: string, value: unknown): string {
  if (typeof value !== 'string' || !value) throw new AffiliatePayoutRpcError(rpc, new Error('No id.'));
  return value;
}

const CLAIM_STATUSES: ReadonlySet<string> = new Set(AFFILIATE_MANUAL_PAYOUT_CLAIM_STATUSES);
const RECORD_STATUSES: ReadonlySet<string> = new Set(AFFILIATE_MANUAL_PAYOUT_RECORD_STATUSES);
const CANCEL_STATUSES: ReadonlySet<string> = new Set(AFFILIATE_MANUAL_PAYOUT_CANCEL_STATUSES);

/**
 * Prepares a manual payout BEFORE any money is sent (02036): the partner's CLEARED, unattached,
 * undisputed, live-mode commissions in `currency` and `gateways` are attached to a new PROCESSING
 * manual payout, so the amount the admin then sends, the PayPal file and the later record all name
 * the same commissions. Nothing here moves money. Two admins preparing at once cannot both win: the
 * function checks for a prepared payout under the partner's row lock (the second one answers
 * `already_prepared`), and the one-prepared-payout index is the backstop (a violation throws).
 */
export async function claimManualAffiliatePayoutViaRpc(
  supabase: AffiliateRepositoryClient,
  input: AffiliateManualPayoutClaimInput
): Promise<AffiliateManualPayoutClaimResult> {
  const rpc = 'claim_manual_affiliate_payout';
  const minimum = Number.isFinite(input.minAmountCents) ? Math.max(0, Math.trunc(Number(input.minAmountCents))) : 0;
  const data = await callPayoutRpc(supabase, rpc, {
    p_affiliate_id: input.affiliateId,
    p_currency: input.currency,
    p_min_amount: minimum,
    p_gateways: [...input.gateways],
  });
  const { record, status } = rpcRecord(rpc, data, CLAIM_STATUSES);
  if (status === 'prepared') {
    return {
      status,
      payoutId: rpcId(rpc, record['payout_id']),
      amountCents: rpcAmount(rpc, record['amount_cents']),
      commissionCount: rpcCount(rpc, record['commission_count']),
    };
  }
  if (status === 'already_prepared') {
    return { status, payoutId: rpcId(rpc, record['payout_id']), amountCents: rpcAmount(rpc, record['amount_cents']) };
  }
  if (status === 'below_minimum') {
    return { status, amountCents: rpcAmount(rpc, record['amount_cents']), commissionCount: rpcCount(rpc, record['commission_count']) };
  }
  return { status: status as Exclude<AffiliateManualPayoutClaimStatus, 'prepared' | 'already_prepared' | 'below_minimum'> };
}

/**
 * Records that the money of a prepared manual payout was sent (02036): that exact payout COMPLETED
 * with the channel, reference and note, its commissions PAID, `total_paid_cents` up by its amount.
 * Nothing here moves money. A unique violation on the reference index (two admins recording the
 * same reference at once) reads as `duplicate_reference`. Throws {@link AffiliatePayoutRpcError}
 * for anything else.
 */
export async function recordManualAffiliatePayoutViaRpc(
  supabase: AffiliateRepositoryClient,
  input: AffiliateManualPayoutRecordInput
): Promise<AffiliateManualPayoutRecordResult> {
  const rpc = 'record_manual_affiliate_payout';
  let data: unknown;
  try {
    data = await callPayoutRpc(supabase, rpc, {
      p_payout_id: input.payoutId,
      p_channel: input.channel,
      p_reference: input.reference,
      p_note: input.note ?? null,
      p_recorded_by: input.recordedBy,
    });
  } catch (error) {
    if (error instanceof AffiliatePayoutRpcError && error.code === '23505') return { status: 'duplicate_reference' };
    throw error;
  }
  const { record, status } = rpcRecord(rpc, data, RECORD_STATUSES);
  if (status === 'recorded') {
    const currency = typeof record['currency'] === 'string' ? record['currency'].trim().toUpperCase() : '';
    if (!/^[A-Z]{3}$/.test(currency)) throw new AffiliatePayoutRpcError(rpc, new Error('Unexpected currency.'));
    return {
      status,
      payoutId: rpcId(rpc, record['payout_id']),
      affiliateId: rpcId(rpc, record['affiliate_id']),
      amountCents: rpcAmount(rpc, record['amount_cents']),
      currency,
      commissionCount: rpcCount(rpc, record['commission_count']),
    };
  }
  return { status: status as Exclude<AffiliateManualPayoutRecordStatus, 'recorded'> };
}

/**
 * Gives up a prepared manual payout before any money left (02036): the refund work owed to its
 * commissions applied, the rest handed back to the cleared balance, the row deleted. Refused once
 * the payout is recorded (`already_recorded`).
 */
export async function cancelManualAffiliatePayoutViaRpc(
  supabase: AffiliateRepositoryClient,
  payoutId: string
): Promise<AffiliateManualPayoutCancelResult> {
  const rpc = 'cancel_manual_affiliate_payout';
  const data = await callPayoutRpc(supabase, rpc, { p_payout_id: payoutId });
  const { record, status } = rpcRecord(rpc, data, CANCEL_STATUSES);
  if (status === 'cancelled') return { status, commissionCount: rpcCount(rpc, record['commission_count']) };
  return { status: status as Exclude<AffiliateManualPayoutCancelStatus, 'cancelled'> };
}

/* ------------------------------------------------------------- PayPal payouts --- */
// 02037: a PayPal payout is claimed (claim_paypal_affiliate_payout: PROCESSING, its commissions
// reserved, the partner's PayPal email snapshotted) BEFORE the batch is created; the batch's
// sender_batch_id is saved on it before the create call and PayPal's payout_batch_id after it
// (record_paypal_affiliate_payout_batch); each sync notes the item's status
// (note_paypal_affiliate_payout_item); SUCCESS completes it exactly once
// (complete_paypal_affiliate_payout) and a definitive failure fails it and hands its commissions
// back (fail_paypal_affiliate_payout). Nothing here talks to PayPal.

/** Every answer of `claim_paypal_affiliate_payout` (02037). */
export const AFFILIATE_PAYPAL_PAYOUT_CLAIM_STATUSES = [
  'claimed',
  'invalid_input',
  'not_found',
  'not_eligible',
  'no_paypal_email',
  'already_in_flight',
  'nothing_owed',
  'below_minimum',
] as const;

/** Every answer of `record_paypal_affiliate_payout_batch` (02037). */
export const AFFILIATE_PAYPAL_PAYOUT_BATCH_STATUSES = ['recorded', 'invalid_input'] as const;

/** Every answer of `note_paypal_affiliate_payout_item` (02037). */
export const AFFILIATE_PAYPAL_PAYOUT_NOTE_STATUSES = ['noted', 'invalid_input', 'not_found'] as const;

/** Every answer of `complete_paypal_affiliate_payout` (02037). */
export const AFFILIATE_PAYPAL_PAYOUT_COMPLETE_STATUSES = [
  'completed',
  'invalid_input',
  'not_found',
  'already_completed',
  'not_processing',
  'item_mismatch',
  'duplicate_transaction',
] as const;

/** Every answer of `fail_paypal_affiliate_payout` (02037). */
export const AFFILIATE_PAYPAL_PAYOUT_FAIL_STATUSES = ['failed', 'not_found', 'already_completed', 'already_failed'] as const;

/** Every answer of `release_paypal_affiliate_payout` (02037). */
export const AFFILIATE_PAYPAL_PAYOUT_RELEASE_STATUSES = [
  'released',
  'not_found',
  'already_completed',
  'already_failed',
  'held_by_paypal',
  'too_recent',
] as const;

export type AffiliatePayPalPayoutClaimStatus = (typeof AFFILIATE_PAYPAL_PAYOUT_CLAIM_STATUSES)[number];
export type AffiliatePayPalPayoutCompleteStatus = (typeof AFFILIATE_PAYPAL_PAYOUT_COMPLETE_STATUSES)[number];
export type AffiliatePayPalPayoutFailStatus = (typeof AFFILIATE_PAYPAL_PAYOUT_FAIL_STATUSES)[number];
export type AffiliatePayPalPayoutReleaseStatus = (typeof AFFILIATE_PAYPAL_PAYOUT_RELEASE_STATUSES)[number];

/** What `claim_paypal_affiliate_payout` did (see the 02037 comment of the function). */
export type AffiliatePayPalPayoutClaimResult =
  | { status: 'claimed'; payoutId: string; amountCents: number; commissionCount: number; receiver: string }
  /** A PayPal payout of that currency is still in flight for the partner: this one. */
  | { status: 'already_in_flight'; payoutId: string; amountCents: number }
  /** What is owed is below the minimum asked for: nothing was reserved. */
  | { status: 'below_minimum'; amountCents: number; commissionCount: number }
  | { status: Exclude<AffiliatePayPalPayoutClaimStatus, 'claimed' | 'already_in_flight' | 'below_minimum'> };

export type AffiliatePayPalPayoutCompleteResult =
  | {
      status: 'completed';
      payoutId: string;
      affiliateId: string;
      amountCents: number;
      currency: string;
      commissionCount: number;
      transactionId: string;
    }
  | { status: Exclude<AffiliatePayPalPayoutCompleteStatus, 'completed'> };

export type AffiliatePayPalPayoutFailResult =
  | { status: 'failed'; payoutId: string; affiliateId: string; amountCents: number; currency: string; commissionCount: number }
  | { status: Exclude<AffiliatePayPalPayoutFailStatus, 'failed'> };

export type AffiliatePayPalPayoutReleaseResult =
  | {
      status: 'released';
      payoutId: string;
      affiliateId: string;
      amountCents: number;
      currency: string;
      commissionCount: number;
      /** PayPal had acknowledged the payout's batch (released a week on, with no status PayPal holds money in). */
      acknowledged: boolean;
    }
  | { status: Exclude<AffiliatePayPalPayoutReleaseStatus, 'released'> };

export interface AffiliatePayPalPayoutClaimInput {
  affiliateId: string;
  /** The store base currency the commissions were recorded in (the payout currency). */
  currency: string;
  /** Below this sum nothing is reserved (`below_minimum`). */
  minAmountCents: number;
  /** The gateways the program pays with PayPal (`affiliateGatewaysPaidByPayPal`); at least one. */
  gateways: readonly AffiliateGateway[];
  /**
   * The PayPal environment's money: true for live (only live-mode commissions), false for the PayPal
   * sandbox (only test-mode commissions). Real sales are never marked paid by sandbox money.
   */
  livemode: boolean;
  trigger: AffiliatePayoutTrigger;
}

const PAYPAL_CLAIM_STATUSES: ReadonlySet<string> = new Set(AFFILIATE_PAYPAL_PAYOUT_CLAIM_STATUSES);
const PAYPAL_BATCH_STATUSES: ReadonlySet<string> = new Set(AFFILIATE_PAYPAL_PAYOUT_BATCH_STATUSES);
const PAYPAL_NOTE_STATUSES: ReadonlySet<string> = new Set(AFFILIATE_PAYPAL_PAYOUT_NOTE_STATUSES);
const PAYPAL_COMPLETE_STATUSES: ReadonlySet<string> = new Set(AFFILIATE_PAYPAL_PAYOUT_COMPLETE_STATUSES);
const PAYPAL_FAIL_STATUSES: ReadonlySet<string> = new Set(AFFILIATE_PAYPAL_PAYOUT_FAIL_STATUSES);
const PAYPAL_RELEASE_STATUSES: ReadonlySet<string> = new Set(AFFILIATE_PAYPAL_PAYOUT_RELEASE_STATUSES);

function rpcCurrency(rpc: string, value: unknown): string {
  const currency = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) throw new AffiliatePayoutRpcError(rpc, new Error('Unexpected currency.'));
  return currency;
}

/**
 * Claims a PayPal payout BEFORE any PayPal call (02037): for an ACTIVE, approved partner whose payout
 * email is a PayPal account, the CLEARED, unattached, undisputed commissions of `currency`, of the
 * PayPal gateways and of the environment's mode are attached to a new PROCESSING PayPal payout with
 * the email as its recipient. One in flight per partner and currency (`already_in_flight`, read under
 * the partner's row lock; a unique index is the backstop). Nothing here moves money.
 */
export async function claimPayPalAffiliatePayoutViaRpc(
  supabase: AffiliateRepositoryClient,
  input: AffiliatePayPalPayoutClaimInput
): Promise<AffiliatePayPalPayoutClaimResult> {
  const rpc = 'claim_paypal_affiliate_payout';
  const minimum = Number.isFinite(input.minAmountCents) ? Math.max(0, Math.trunc(input.minAmountCents)) : 0;
  const data = await callPayoutRpc(supabase, rpc, {
    p_affiliate_id: input.affiliateId,
    p_currency: input.currency,
    p_min_amount: minimum,
    p_gateways: [...input.gateways],
    p_livemode: input.livemode === true,
    p_trigger: input.trigger,
  });
  const { record, status } = rpcRecord(rpc, data, PAYPAL_CLAIM_STATUSES);
  if (status === 'claimed') {
    const receiver = typeof record['receiver'] === 'string' ? record['receiver'] : '';
    if (!receiver) throw new AffiliatePayoutRpcError(rpc, new Error('No receiver.'));
    return {
      status,
      payoutId: rpcId(rpc, record['payout_id']),
      amountCents: rpcAmount(rpc, record['amount_cents']),
      commissionCount: rpcCount(rpc, record['commission_count']),
      receiver,
    };
  }
  if (status === 'already_in_flight') {
    return { status, payoutId: rpcId(rpc, record['payout_id']), amountCents: rpcAmount(rpc, record['amount_cents']) };
  }
  if (status === 'below_minimum') {
    return { status, amountCents: rpcAmount(rpc, record['amount_cents']), commissionCount: rpcCount(rpc, record['commission_count']) };
  }
  return { status: status as Exclude<AffiliatePayPalPayoutClaimStatus, 'claimed' | 'already_in_flight' | 'below_minimum'> };
}

/**
 * Saves a batch's ids on its PROCESSING PayPal payouts (02037): the `sender_batch_id` BEFORE the
 * create call (so a timed-out create is retried with the same id), PayPal's `payout_batch_id`
 * after it. Never overwrites a different id. Returns how many of `payoutIds` now carry them.
 */
export async function recordPayPalAffiliatePayoutBatchViaRpc(
  supabase: AffiliateRepositoryClient,
  input: { payoutIds: readonly string[]; senderBatchId: string; payoutBatchId?: string | null }
): Promise<{ status: 'recorded'; count: number } | { status: 'invalid_input' }> {
  const rpc = 'record_paypal_affiliate_payout_batch';
  const data = await callPayoutRpc(supabase, rpc, {
    p_payout_ids: [...input.payoutIds],
    p_sender_batch_id: input.senderBatchId,
    p_payout_batch_id: input.payoutBatchId ?? null,
  });
  const { record, status } = rpcRecord(rpc, data, PAYPAL_BATCH_STATUSES);
  if (status === 'recorded') return { status, count: rpcCount(rpc, record['count']) };
  return { status: 'invalid_input' };
}

/**
 * Notes what PayPal said about an in-flight PayPal payout (02037): its item id (never replaced by
 * another), the item's status and fee, and when it was checked. Only a PROCESSING PayPal payout.
 */
export async function notePayPalAffiliatePayoutItemViaRpc(
  supabase: AffiliateRepositoryClient,
  input: { payoutId: string; itemId: string | null; itemStatus: string | null; feeCents?: number | null }
): Promise<{ status: (typeof AFFILIATE_PAYPAL_PAYOUT_NOTE_STATUSES)[number] }> {
  const rpc = 'note_paypal_affiliate_payout_item';
  const data = await callPayoutRpc(supabase, rpc, {
    p_payout_id: input.payoutId,
    p_item_id: input.itemId,
    p_item_status: input.itemStatus,
    p_fee_cents: typeof input.feeCents === 'number' && Number.isFinite(input.feeCents) ? Math.max(0, Math.trunc(input.feeCents)) : null,
  });
  const { status } = rpcRecord(rpc, data, PAYPAL_NOTE_STATUSES);
  return { status: status as (typeof AFFILIATE_PAYPAL_PAYOUT_NOTE_STATUSES)[number] };
}

/**
 * PayPal paid the item (SUCCESS): that PROCESSING PayPal payout becomes COMPLETED with the
 * transaction id and fee, its commissions PAID and `total_paid_cents` up by its amount, exactly
 * once (`already_completed` for a second call). Nothing here moves money.
 */
export async function completePayPalAffiliatePayoutViaRpc(
  supabase: AffiliateRepositoryClient,
  input: { payoutId: string; itemId: string; transactionId: string; feeCents?: number | null; itemStatus?: string | null }
): Promise<AffiliatePayPalPayoutCompleteResult> {
  const rpc = 'complete_paypal_affiliate_payout';
  const data = await callPayoutRpc(supabase, rpc, {
    p_payout_id: input.payoutId,
    p_item_id: input.itemId,
    p_transaction_id: input.transactionId,
    p_fee_cents: typeof input.feeCents === 'number' && Number.isFinite(input.feeCents) ? Math.max(0, Math.trunc(input.feeCents)) : null,
    p_item_status: input.itemStatus ?? 'SUCCESS',
  });
  const { record, status } = rpcRecord(rpc, data, PAYPAL_COMPLETE_STATUSES);
  if (status === 'completed') {
    return {
      status,
      payoutId: rpcId(rpc, record['payout_id']),
      affiliateId: rpcId(rpc, record['affiliate_id']),
      amountCents: rpcAmount(rpc, record['amount_cents']),
      currency: rpcCurrency(rpc, record['currency']),
      commissionCount: rpcCount(rpc, record['commission_count']),
      transactionId: rpcId(rpc, record['transaction_id']),
    };
  }
  return { status: status as Exclude<AffiliatePayPalPayoutCompleteStatus, 'completed'> };
}

/**
 * PayPal will not pay the item (a definitive refusal, FAILED, BLOCKED, RETURNED, REFUNDED, REVERSED,
 * a denied batch, an UNCLAIMED item cancelled): that PROCESSING PayPal payout becomes FAILED with
 * the reason, the refund work owed to its commissions is applied and the rest go back to the cleared
 * balance, so they can be paid again. Nothing here moves money.
 */
export async function failPayPalAffiliatePayoutViaRpc(
  supabase: AffiliateRepositoryClient,
  input: { payoutId: string; reason: string; itemStatus?: string | null }
): Promise<AffiliatePayPalPayoutFailResult> {
  const rpc = 'fail_paypal_affiliate_payout';
  const data = await callPayoutRpc(supabase, rpc, {
    p_payout_id: input.payoutId,
    p_reason: input.reason,
    p_item_status: input.itemStatus ?? null,
  });
  const { record, status } = rpcRecord(rpc, data, PAYPAL_FAIL_STATUSES);
  if (status === 'failed') {
    return {
      status,
      payoutId: rpcId(rpc, record['payout_id']),
      affiliateId: rpcId(rpc, record['affiliate_id']),
      amountCents: rpcAmount(rpc, record['amount_cents']),
      currency: rpcCurrency(rpc, record['currency']),
      commissionCount: rpcCount(rpc, record['commission_count']),
    };
  }
  return { status: status as Exclude<AffiliatePayPalPayoutFailStatus, 'failed'> };
}

/**
 * The CMS Release of a PayPal payout PayPal has not settled (02037), once the admin checked in PayPal
 * that nothing was paid. The database decides under the payout lock: a batch PayPal never acknowledged
 * an hour after its last send, an acknowledged one a week after it while PayPal lists no status it
 * holds money in (`too_recent`, `held_by_paypal` otherwise). Released: FAILED
 * (`paypal_released_by_admin`), its refund work applied and its other commissions back in the cleared
 * balance. Nothing here moves money.
 */
export async function releasePayPalAffiliatePayoutViaRpc(
  supabase: AffiliateRepositoryClient,
  input: { payoutId: string }
): Promise<AffiliatePayPalPayoutReleaseResult> {
  const rpc = 'release_paypal_affiliate_payout';
  const data = await callPayoutRpc(supabase, rpc, { p_payout_id: input.payoutId });
  const { record, status } = rpcRecord(rpc, data, PAYPAL_RELEASE_STATUSES);
  if (status === 'released') {
    return {
      status,
      payoutId: rpcId(rpc, record['payout_id']),
      affiliateId: rpcId(rpc, record['affiliate_id']),
      amountCents: rpcAmount(rpc, record['amount_cents']),
      currency: rpcCurrency(rpc, record['currency']),
      commissionCount: rpcCount(rpc, record['commission_count']),
      acknowledged: record['acknowledged'] === true,
    };
  }
  return { status: status as Exclude<AffiliatePayPalPayoutReleaseStatus, 'released'> };
}

/** PROCESSING (or a reconciled FAILED) payout → COMPLETED with the transfer id. False when it cannot complete. */
export async function completeAffiliatePayoutViaRpc(
  supabase: AffiliateRepositoryClient,
  payoutId: string,
  transferId: string
): Promise<boolean> {
  return (await callPayoutRpc(supabase, 'complete_affiliate_payout', { p_payout_id: payoutId, p_transfer_id: transferId })) === true;
}

/** PROCESSING → FAILED with a short reason code. False when the payout is not PROCESSING. */
export async function failAffiliatePayoutViaRpc(
  supabase: AffiliateRepositoryClient,
  payoutId: string,
  reason: string
): Promise<boolean> {
  return (await callPayoutRpc(supabase, 'fail_affiliate_payout', { p_payout_id: payoutId, p_reason: reason })) === true;
}

/**
 * FAILED → PROCESSING for another attempt (attempt_count + 1, fresh destination and amount), or
 * null when the partner is no longer eligible, the partner's Connect account is of the other key
 * mode (nothing changes), nothing is left to pay (`failure_reason` 'nothing_to_pay') or what is
 * left is below `minAmountCents` (`failure_reason` 'below_minimum'; the payout stays FAILED and
 * its commissions go back to the cleared balance). Automatic retries pass the program minimum;
 * an admin retry passes 0 and sends whatever is left.
 */
export async function prepareAffiliatePayoutRetryViaRpc(
  supabase: AffiliateRepositoryClient,
  payoutId: string,
  minAmountCents = 0
): Promise<AffiliatePayoutRow | null> {
  const minimum = Number.isFinite(minAmountCents) ? Math.max(0, Math.trunc(minAmountCents)) : 0;
  return firstPayout(
    await callPayoutRpc(supabase, 'prepare_affiliate_payout_retry', { p_payout_id: payoutId, p_min_amount: minimum })
  );
}

/** FAILED payout given up: its commissions are detached (claimable again). False when not FAILED. */
export async function releaseAffiliatePayoutViaRpc(supabase: AffiliateRepositoryClient, payoutId: string): Promise<boolean> {
  return (await callPayoutRpc(supabase, 'release_affiliate_payout', { p_payout_id: payoutId })) === true;
}

/** Claims the UTC day `runDate` (YYYY-MM-DD) for a payout run: true for the first caller only. */
export async function claimAffiliatePayoutRunViaRpc(
  supabase: AffiliateRepositoryClient,
  runDate: string,
  trigger: string
): Promise<boolean> {
  return (await callPayoutRpc(supabase, 'claim_affiliate_payout_run', { p_run_date: runDate, p_trigger: trigger })) === true;
}

/** Marks the day's run finished and stores its summary. */
export async function finishAffiliatePayoutRunViaRpc(
  supabase: AffiliateRepositoryClient,
  runDate: string,
  summary: Record<string, unknown>
): Promise<void> {
  await callPayoutRpc(supabase, 'finish_affiliate_payout_run', { p_run_date: runDate, p_summary: summary });
}
