import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AffiliateRepositoryClient } from '../repository/client';
import { releaseAffiliatePayout, retryAffiliatePayout } from './admin';
import { runAffiliateLedgerRepair, runAffiliatePayoutCycle, type AffiliatePayoutCycleDeps } from './cycle';
import type { AffiliatePayoutHooks } from './engine';
import {
  AffiliatePayoutRpcError,
  cancelManualAffiliatePayoutViaRpc,
  claimManualAffiliatePayoutViaRpc,
  recordManualAffiliatePayoutViaRpc,
} from './rpc';
import { mergeAffiliatePayoutRunSummary, readAffiliatePayoutRunSummary } from './run-summary';
import type {
  AffiliateStripeAccountCreateParams,
  AffiliateStripeAccountLike,
  AffiliateStripeTransferCreateParams,
  AffiliateStripeTransferLike,
  AffiliatesStripeLike,
} from './stripe-like';

/**
 * The payout cycle against a fake Stripe and an in-memory fake of the 02030 payout RPCs. The
 * money guarantees under test (ADDENDUM B1/B2): one transfer per payout whatever fails in
 * between, a crash after Stripe accepted a transfer is completed by the next reconciliation, only
 * a definitive refusal fails a payout, a short balance claims nothing and alerts once, and
 * partners whose Connect account cannot receive transfers (or belongs to the other key mode) are
 * skipped.
 */

type Row = Record<string, any>;

const START = new Date('2026-10-27T06:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

let now = new Date(START);
const clock = () => new Date(now);
const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

/* ------------------------------------------------------------------ fake database --- */

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const da = typeof a === 'string' ? Date.parse(a) : Number.NaN;
  const db = typeof b === 'string' ? Date.parse(b) : Number.NaN;
  if (Number.isFinite(da) && Number.isFinite(db)) return da - db;
  return String(a).localeCompare(String(b));
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private mode: 'select' | 'update' = 'select';
  private values: Row | null = null;
  private returnRows = false;
  private sorter: { column: string; ascending: boolean } | null = null;
  private window: { from: number; to: number } | null = null;
  private max: number | null = null;
  private single = false;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string
  ) {}

  select() {
    if (this.mode === 'update') this.returnRows = true;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  is(column: string, value: null) {
    this.filters.push((row) => (value === null ? row[column] == null : row[column] === value));
    return this;
  }
  not(column: string, operator: string, value: unknown) {
    if (operator !== 'is' || value !== null) throw new Error(`fake: unsupported not(${operator})`);
    this.filters.push((row) => row[column] != null);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  lt(column: string, value: unknown) {
    this.filters.push((row) => row[column] != null && compare(row[column], value) < 0);
    return this;
  }
  order(column: string, options: { ascending?: boolean } = {}) {
    this.sorter = { column, ascending: options.ascending !== false };
    return this;
  }
  range(from: number, to: number) {
    this.window = { from, to };
    return this;
  }
  limit(count: number) {
    this.max = count;
    return this;
  }
  update(values: Row) {
    this.mode = 'update';
    this.values = values;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }

  private run(): { data: unknown; error: unknown } {
    const failure = this.db.failNextRead[this.table];
    if (this.mode === 'select' && failure) {
      this.db.failNextRead[this.table] = failure - 1;
      return { data: null, error: { message: 'read failed', code: 'XX000' } };
    }
    const rows = (this.db.tables[this.table] ??= []);
    let matched = rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.mode === 'update') {
      for (const row of matched) Object.assign(row, this.values, { updated_at: clock().toISOString() });
      return { data: this.returnRows ? matched.map((row) => ({ ...row })) : null, error: null };
    }
    if (this.sorter) {
      const { column, ascending } = this.sorter;
      matched = [...matched].sort((a, b) => (ascending ? 1 : -1) * compare(a[column], b[column]));
    }
    if (this.window) matched = matched.slice(this.window.from, this.window.to + 1);
    if (this.max !== null) matched = matched.slice(0, this.max);
    const copies = matched.map((row) => ({ ...row }));
    return { data: this.single ? (copies[0] ?? null) : copies, error: null };
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

const LIVE_COMMISSION = new Set(['PENDING_CLEARANCE', 'CLEARED']);

/** What PostgREST hands supabase-js for a failed statement: a message and a SQLSTATE code. */
function postgresError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

class FakeDb {
  tables: Record<string, Row[]> = { affiliate_profiles: [], affiliate_commissions: [], affiliate_payouts: [] };
  /** rpc name → how many upcoming calls fail with a database error. */
  failNextRpc: Record<string, number> = {};
  failNextRead: Record<string, number> = {};
  rpcCalls: Array<{ name: string; args: Row }> = [];

  from(table: string) {
    return new FakeQuery(this, table);
  }

  async rpc(name: string, args: Row = {}) {
    this.rpcCalls.push({ name, args });
    if ((this.failNextRpc[name] ?? 0) > 0) {
      this.failNextRpc[name] -= 1;
      return { data: null, error: { message: `${name} exploded`, code: 'XX000' } };
    }
    const implementation = (this as unknown as Record<string, (args: Row) => unknown>)[`rpc_${name}`];
    if (!implementation) return { data: null, error: { message: `unknown rpc ${name}`, code: 'PGRST202' } };
    try {
      return { data: implementation.call(this, args), error: null };
    } catch (error) {
      return { data: null, error };
    }
  }

  profile(id: string) {
    return this.tables['affiliate_profiles'].find((row) => row['id'] === id) ?? null;
  }
  payout(id: string) {
    return this.tables['affiliate_payouts'].find((row) => row['id'] === id) ?? null;
  }
  commissionsOf(payoutId: string) {
    return this.tables['affiliate_commissions'].filter((row) => row['payout_id'] === payoutId);
  }

  rpc_reconcile_affiliate_commissions() {
    return { recorded: 0, voided: 0 };
  }

  rpc_promote_cleared_affiliate_commissions() {
    let promoted = 0;
    for (const row of this.tables['affiliate_commissions']) {
      if (row['status'] === 'PENDING_CLEARANCE' && compare(row['clears_at'], clock().toISOString()) <= 0) {
        row['status'] = 'CLEARED';
        row['cleared_at'] = clock().toISOString();
        promoted += 1;
      }
    }
    return promoted;
  }

  private eligible(profile: Row | null) {
    return Boolean(
      profile &&
        profile['status'] === 'ACTIVE' &&
        profile['first_published_at'] &&
        profile['stripe_connect_account_id'] &&
        profile['stripe_connect_onboarding_complete']
    );
  }

  rpc_claim_affiliate_payout(args: Row) {
    const profile = this.profile(args['p_affiliate_id']);
    if (!this.eligible(profile)) return [];
    // 02030: only commissions of the destination account's key mode, none while it is unknown,
    // and never one under dispute; the payout records that mode.
    const mode = profile?.['stripe_connect_livemode'];
    if (typeof mode !== 'boolean') return [];
    const currency = String(args['p_currency']).toUpperCase();
    // 02036: p_gateways (absent or null = every gateway) limits the claim to those gateways.
    const gateways = Array.isArray(args['p_gateways']) ? (args['p_gateways'] as string[]) : null;
    const cleared = this.tables['affiliate_commissions'].filter(
      (row) =>
        row['affiliate_id'] === args['p_affiliate_id'] &&
        row['status'] === 'CLEARED' &&
        row['payout_id'] == null &&
        row['currency'] === currency &&
        row['livemode'] === mode &&
        row['disputed_at'] == null &&
        (gateways === null || gateways.includes(row['gateway']))
    );
    const amount = cleared.reduce((sum, row) => sum + row['commission_amount_cents'] - row['refunded_amount_cents'], 0);
    if (amount <= 0 || amount < Number(args['p_min_amount'] ?? 0)) return [];
    const payout: Row = {
      id: randomUUID(),
      affiliate_id: args['p_affiliate_id'],
      amount_cents: amount,
      currency,
      stripe_destination_account: profile?.['stripe_connect_account_id'],
      stripe_transfer_id: null,
      method: 'stripe_connect',
      livemode: mode,
      status: 'PROCESSING',
      attempt_count: 1,
      last_attempt_at: clock().toISOString(),
      failure_reason: null,
      trigger: args['p_trigger'] ?? 'cron',
      paid_at: null,
      created_at: clock().toISOString(),
      updated_at: clock().toISOString(),
    };
    this.tables['affiliate_payouts'].push(payout);
    for (const row of cleared) row['payout_id'] = payout['id'];
    return [{ ...payout }];
  }

  rpc_complete_affiliate_payout(args: Row) {
    const transferId = String(args['p_transfer_id'] ?? '').trim();
    if (!transferId) throw postgresError('affiliate_transfer_id_required', '22023');
    const payout = this.payout(args['p_payout_id']);
    if (!payout) return false;
    const completable =
      payout['status'] === 'PROCESSING' ||
      (payout['status'] === 'FAILED' && !['released', 'nothing_to_pay', 'below_minimum'].includes(payout['failure_reason'] ?? ''));
    if (!completable) return false;
    if (this.tables['affiliate_payouts'].some((row) => row !== payout && row['stripe_transfer_id'] === transferId)) {
      throw postgresError('duplicate key value violates unique constraint', '23505');
    }
    Object.assign(payout, { status: 'COMPLETED', paid_at: clock().toISOString(), stripe_transfer_id: transferId, failure_reason: null });
    for (const row of this.commissionsOf(payout['id'])) {
      if (LIVE_COMMISSION.has(row['status'])) Object.assign(row, { status: 'PAID', paid_at: clock().toISOString(), stripe_transfer_id: transferId });
    }
    const profile = this.profile(payout['affiliate_id']);
    if (profile) profile['total_paid_cents'] += payout['amount_cents'];
    return true;
  }

  rpc_fail_affiliate_payout(args: Row) {
    const payout = this.payout(args['p_payout_id']);
    if (!payout || payout['status'] !== 'PROCESSING') return false;
    payout['status'] = 'FAILED';
    payout['failure_reason'] = String(args['p_reason'] || 'failed').slice(0, 500);
    return true;
  }

  rpc_prepare_affiliate_payout_retry(args: Row) {
    const payout = this.payout(args['p_payout_id']);
    if (!payout || payout['status'] !== 'FAILED') return [];
    const profile = this.profile(payout['affiliate_id']);
    if (!this.eligible(profile)) return [];
    // 02030: a payout of the other key mode is never re-sent (no row, no change).
    if (profile?.['stripe_connect_livemode'] !== payout['livemode']) return [];
    // A commission put on hold by a dispute is detached before the amount is recomputed.
    for (const row of this.commissionsOf(payout['id'])) {
      if (row['disputed_at'] != null && LIVE_COMMISSION.has(row['status'])) row['payout_id'] = null;
    }
    const attached = this.commissionsOf(payout['id']).filter((row) => row['status'] === 'CLEARED');
    const amount = attached.reduce((sum, row) => sum + row['commission_amount_cents'] - row['refunded_amount_cents'], 0);
    if (amount <= 0) {
      for (const row of this.commissionsOf(payout['id'])) row['payout_id'] = null;
      payout['failure_reason'] = 'nothing_to_pay';
      return [];
    }
    // Below the minimum (automatic retries pass it, an admin retry passes 0): handed back.
    if (amount < Math.max(0, Number(args['p_min_amount'] ?? 0))) {
      for (const row of this.commissionsOf(payout['id'])) row['payout_id'] = null;
      payout['failure_reason'] = 'below_minimum';
      return [];
    }
    Object.assign(payout, {
      status: 'PROCESSING',
      attempt_count: payout['attempt_count'] + 1,
      last_attempt_at: clock().toISOString(),
      amount_cents: amount,
      failure_reason: null,
      stripe_destination_account: profile?.['stripe_connect_account_id'],
    });
    return [{ ...payout }];
  }

  rpc_release_affiliate_payout(args: Row) {
    const payout = this.payout(args['p_payout_id']);
    if (!payout || payout['status'] !== 'FAILED') return false;
    for (const row of this.commissionsOf(payout['id'])) row['payout_id'] = null;
    payout['failure_reason'] = 'released';
    return true;
  }
}

/* -------------------------------------------------------------------- fake Stripe --- */

function stripeError(type: string, code: string | null, statusCode: number) {
  return Object.assign(new Error(`${type}: ${code ?? 'no code'}`), {
    type,
    rawType: type === 'StripeInvalidRequestError' ? 'invalid_request_error' : type === 'StripeAPIError' ? 'api_error' : undefined,
    code: code ?? undefined,
    statusCode,
  });
}

const timeoutError = () => Object.assign(new Error('Request timed out'), { type: 'StripeConnectionError' });

interface ScriptedTransferFailure {
  error: unknown;
  /** True: Stripe created the transfer, but the client saw the error (timeout after commit). */
  created: boolean;
}

class FakeStripe implements AffiliatesStripeLike {
  livemode = false;
  available: Record<string, number> = { usd: 1_000_000 };
  readonly connected = new Map<string, AffiliateStripeAccountLike>();
  readonly createdTransfers: AffiliateStripeTransferLike[] = [];
  readonly transferCreates: Array<{ params: AffiliateStripeTransferCreateParams; idempotencyKey: string | undefined }> = [];
  readonly retrievedAccounts: string[] = [];
  readonly scriptedTransferFailures: ScriptedTransferFailure[] = [];
  balanceError: unknown = null;
  listError: unknown = null;
  private readonly byIdempotencyKey = new Map<string, AffiliateStripeTransferLike>();
  private sequence = 0;

  balance = {
    retrieve: async () => {
      if (this.balanceError) throw this.balanceError;
      return {
        livemode: this.livemode,
        available: Object.entries(this.available).map(([currency, amount]) => ({ currency, amount, source_types: { card: amount } })),
      };
    },
  };

  accounts = {
    retrieve: async (id: string | null): Promise<AffiliateStripeAccountLike> => {
      if (id === null) return { id: 'acct_platform', country: 'US', default_currency: 'usd' };
      this.retrievedAccounts.push(id);
      const account = this.connected.get(id);
      if (!account) throw stripeError('StripeInvalidRequestError', 'resource_missing', 404);
      return account;
    },
    create: async (params: AffiliateStripeAccountCreateParams): Promise<AffiliateStripeAccountLike> => {
      const account = { id: `acct_new${++this.sequence}`, country: params.country, details_submitted: false, payouts_enabled: false };
      this.connected.set(account.id, account);
      return account;
    },
    createLoginLink: async () => ({ url: 'https://connect.stripe.com/express/login' }),
  };

  accountLinks = {
    create: async () => ({ url: 'https://connect.stripe.com/setup/e/link' }),
  };

  transfers = {
    create: async (params: AffiliateStripeTransferCreateParams, options?: { idempotencyKey?: string }) => {
      const key = options?.idempotencyKey;
      this.transferCreates.push({ params, idempotencyKey: key });
      if (key && this.byIdempotencyKey.has(key)) return this.byIdempotencyKey.get(key) as AffiliateStripeTransferLike;
      const failure = this.scriptedTransferFailures.shift();
      if (failure && !failure.created) throw failure.error;
      const available = this.available[params.currency] ?? 0;
      if (available < params.amount) throw stripeError('StripeInvalidRequestError', 'balance_insufficient', 400);
      const transfer: AffiliateStripeTransferLike = {
        id: `tr_${++this.sequence}`,
        amount: params.amount,
        currency: params.currency,
        destination: params.destination,
        transfer_group: params.transfer_group,
        metadata: params.metadata ?? {},
        reversed: false,
        livemode: this.livemode,
      };
      this.available[params.currency] = available - params.amount;
      this.createdTransfers.push(transfer);
      if (key) this.byIdempotencyKey.set(key, transfer);
      if (failure?.created) throw failure.error;
      return transfer;
    },
    list: async (params: { destination?: string; transfer_group?: string; limit?: number }) => {
      if (this.listError) throw this.listError;
      const data = this.createdTransfers.filter(
        (transfer) =>
          (!params.destination || transfer.destination === params.destination) &&
          (!params.transfer_group || transfer.transfer_group === params.transfer_group)
      );
      return { data: data.slice(0, params.limit ?? 10), has_more: false };
    },
  };
}

/* ---------------------------------------------------------------------- fixtures --- */

let db: FakeDb;
let stripe: FakeStripe;
function createHooks() {
  return {
    onPayoutSent: vi.fn(),
    onPayoutFailed: vi.fn(),
    onInsufficientBalance: vi.fn(),
    onTransferMismatch: vi.fn(),
    onConnectFirstReady: vi.fn(),
    sweepCommissionNotifications: vi.fn(async () => 2),
  } satisfies AffiliatePayoutHooks;
}

let hooks: ReturnType<typeof createHooks>;

function addPartner(overrides: Row = {}, account: Partial<AffiliateStripeAccountLike> | null = {}) {
  const id = randomUUID();
  const accountId = `acct_${id.replace(/-/g, '').slice(0, 16)}`;
  const profile: Row = {
    id,
    user_id: randomUUID(),
    tier_id: randomUUID(),
    handle: `partner-${id.slice(0, 6)}`,
    display_name: 'Partner',
    bio: null,
    avatar_object_key: null,
    social_links: {},
    preferred_locale: 'en',
    onboarding_step: 'ACTIVE_PUBLISHED',
    status: 'ACTIVE',
    suspended_reason: null,
    stripe_connect_account_id: accountId,
    stripe_connect_livemode: false,
    stripe_connect_onboarding_complete: true,
    stripe_connect_details_submitted: true,
    stripe_connect_payouts_enabled: true,
    stripe_connect_checked_at: null,
    total_clicks: 0,
    last_click_at: null,
    total_earned_cents: 0,
    total_paid_cents: 0,
    profile_completed_at: START.toISOString(),
    payout_configured_at: START.toISOString(),
    page_submitted_at: START.toISOString(),
    first_published_at: START.toISOString(),
    signup_ip_masked: null,
    created_at: START.toISOString(),
    updated_at: START.toISOString(),
    ...overrides,
  };
  db.tables['affiliate_profiles'].push(profile);
  if (account && profile['stripe_connect_account_id']) {
    stripe.connected.set(profile['stripe_connect_account_id'], {
      id: profile['stripe_connect_account_id'],
      details_submitted: true,
      payouts_enabled: true,
      capabilities: { transfers: 'active' },
      requirements: { currently_due: [], past_due: [], disabled_reason: null },
      ...account,
    });
  }
  return profile;
}

function addCommission(affiliateId: string, amount: number, overrides: Row = {}) {
  const row: Row = {
    id: randomUUID(),
    affiliate_id: affiliateId,
    order_id: randomUUID(),
    gateway: 'STRIPE',
    order_currency: 'USD',
    order_net_amount_minor: amount * 10,
    exchange_rate_snapshot: 1,
    net_order_amount_cents: amount * 10,
    commission_rate_snapshot: 10,
    commission_amount_cents: amount,
    refunded_amount_cents: 0,
    refund_pending_cents: 0,
    void_requested_at: null,
    disputed_at: null,
    // Test mode, like the default partner's account and the FakeStripe key.
    livemode: false,
    currency: 'USD',
    status: 'CLEARED',
    clears_at: START.toISOString(),
    cleared_at: START.toISOString(),
    paid_at: null,
    voided_at: null,
    void_reason: null,
    payout_id: null,
    stripe_transfer_id: null,
    notified_at: null,
    created_at: START.toISOString(),
    updated_at: START.toISOString(),
    ...overrides,
  };
  db.tables['affiliate_commissions'].push(row);
  return row;
}

/** A payout row as an earlier cycle left it (FAILED for a short balance two days ago, test mode). */
function addPayout(partner: Row, overrides: Row = {}) {
  const payout: Row = {
    id: randomUUID(),
    affiliate_id: partner['id'],
    amount_cents: 2500,
    currency: 'USD',
    stripe_destination_account: partner['stripe_connect_account_id'],
    stripe_transfer_id: null,
    method: 'stripe_connect',
    livemode: false,
    status: 'FAILED',
    attempt_count: 1,
    last_attempt_at: new Date(START.getTime() - 2 * 24 * HOUR).toISOString(),
    failure_reason: 'balance_insufficient',
    trigger: 'cron',
    paid_at: null,
    created_at: START.toISOString(),
    updated_at: START.toISOString(),
    ...overrides,
  };
  db.tables['affiliate_payouts'].push(payout);
  return payout;
}

function cycle(overrides: Partial<AffiliatePayoutCycleDeps> = {}) {
  return runAffiliatePayoutCycle({
    supabase: db as unknown as AffiliateRepositoryClient,
    stripe,
    trigger: 'cron',
    minPayoutCents: 100,
    now: clock,
    hooks,
    ...overrides,
  });
}

function connectedAccount(partner: Row): AffiliateStripeAccountLike {
  const account = stripe.connected.get(partner['stripe_connect_account_id']);
  if (!account) throw new Error('fixture: no connected account');
  return account;
}

const adminDeps = () => ({ supabase: db as unknown as AffiliateRepositoryClient, stripe, now: clock, hooks });

const payouts = () => db.tables['affiliate_payouts'];

beforeEach(() => {
  now = new Date(START);
  db = new FakeDb();
  stripe = new FakeStripe();
  hooks = createHooks();
});

/* ------------------------------------------------------------------------- tests --- */

describe('runAffiliatePayoutCycle: the happy path', () => {
  it('repairs the ledger, sweeps notifications, claims, transfers and completes', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 1500);
    addCommission(partner['id'], 500, { refunded_amount_cents: 200 });
    addCommission(partner['id'], 900, { status: 'PENDING_CLEARANCE', clears_at: new Date(START.getTime() - MINUTE).toISOString() });

    const summary = await cycle();

    expect(db.rpcCalls.map((call) => call.name).slice(0, 2)).toEqual([
      'reconcile_affiliate_commissions',
      'promote_cleared_affiliate_commissions',
    ]);
    expect(hooks.sweepCommissionNotifications).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ promoted: 1, notified: 2, claimed: 1, sent: 1, failed: 0, pending: 0, remaining: 0, livemode: false });
    expect(summary.errors).toEqual([]);

    const [payout] = payouts();
    expect(payout).toMatchObject({ status: 'COMPLETED', amount_cents: 2700, currency: 'USD', attempt_count: 1, trigger: 'cron' });
    expect(stripe.transferCreates).toHaveLength(1);
    expect(stripe.transferCreates[0]).toEqual({
      params: {
        amount: 2700,
        currency: 'usd',
        destination: partner['stripe_connect_account_id'],
        transfer_group: `affiliate_payout_${payout['id']}`,
        metadata: { payout_id: payout['id'], affiliate_id: partner['id'], attempt: '1' },
      },
      idempotencyKey: `affiliate-payout-${payout['id']}-1`,
    });
    expect(db.commissionsOf(payout['id']).every((row) => row['status'] === 'PAID')).toBe(true);
    expect(db.profile(partner['id'])?.['total_paid_cents']).toBe(2700);
    expect(hooks.onPayoutSent).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: payout['stripe_transfer_id'], via: 'transfer', payout: expect.objectContaining({ id: payout['id'] }) })
    );
  });

  it('pays nothing twice: a second cycle finds nothing left to claim', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 1500);
    await cycle();
    const second = await cycle();
    expect(second.claimed).toBe(0);
    expect(stripe.createdTransfers).toHaveLength(1);
  });

  it('skips balances below the minimum payout without calling Stripe for the partner', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 80);
    const summary = await cycle({ minPayoutCents: 100 });
    expect(summary).toMatchObject({ skippedBelowMinimum: 1, claimed: 0 });
    expect(stripe.retrievedAccounts).toEqual([]);
  });
});

describe('B1: a timeout never pays twice', () => {
  it('timeout after Stripe created the transfer: PROCESSING, then completed by reconciliation, one transfer', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 2000);
    stripe.scriptedTransferFailures.push({ error: timeoutError(), created: true });

    const first = await cycle();
    expect(first).toMatchObject({ claimed: 1, sent: 0, pending: 1, failed: 0 });
    expect(payouts()[0]).toMatchObject({ status: 'PROCESSING' });

    // Inside the stale window nothing touches the in-flight payout.
    advance(5 * MINUTE);
    const early = await cycle();
    expect(early.reconciled).toBe(0);
    expect(stripe.transferCreates).toHaveLength(1);

    advance(11 * MINUTE);
    const second = await cycle();
    expect(second).toMatchObject({ reconciled: 1, sent: 1, claimed: 0 });
    expect(payouts()[0]).toMatchObject({ status: 'COMPLETED', stripe_transfer_id: stripe.createdTransfers[0].id });
    expect(stripe.createdTransfers).toHaveLength(1);
    expect(stripe.transferCreates).toHaveLength(1);
    expect(hooks.onPayoutSent).toHaveBeenCalledWith(expect.objectContaining({ via: 'reconcile' }));
  });

  it('timeout before Stripe created anything: stale, retried in a later day with attempt 2, one transfer', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 2000);
    stripe.scriptedTransferFailures.push({ error: timeoutError(), created: false });

    await cycle();
    expect(payouts()[0]).toMatchObject({ status: 'PROCESSING', attempt_count: 1 });

    advance(16 * MINUTE);
    const reconciled = await cycle();
    expect(reconciled).toMatchObject({ reconciled: 1, failed: 1, retried: 0 });
    expect(payouts()[0]).toMatchObject({ status: 'FAILED', failure_reason: 'stale' });
    // A stale failure is retried automatically: no admin alert.
    expect(hooks.onPayoutFailed).not.toHaveBeenCalled();

    advance(13 * HOUR);
    const retried = await cycle();
    expect(retried).toMatchObject({ retried: 1, sent: 1 });
    const [payout] = payouts();
    expect(payout).toMatchObject({ status: 'COMPLETED', attempt_count: 2 });
    expect(stripe.createdTransfers).toHaveLength(1);
    expect(stripe.transferCreates.map((call) => call.idempotencyKey)).toEqual([
      `affiliate-payout-${payout['id']}-1`,
      `affiliate-payout-${payout['id']}-2`,
    ]);
  });

  it('a crash after a successful transfer (completion failed) is completed by the next cycle', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 3000);
    db.failNextRpc['complete_affiliate_payout'] = 1;

    const first = await cycle();
    expect(first).toMatchObject({ claimed: 1, sent: 0, pending: 1 });
    expect(first.errors).toEqual([expect.objectContaining({ step: 'complete', code: 'XX000', payoutId: payouts()[0]['id'] })]);
    expect(payouts()[0]['status']).toBe('PROCESSING');
    expect(stripe.createdTransfers).toHaveLength(1);

    advance(20 * MINUTE);
    const second = await cycle();
    expect(second).toMatchObject({ reconciled: 1, sent: 1 });
    expect(payouts()[0]).toMatchObject({ status: 'COMPLETED', stripe_transfer_id: stripe.createdTransfers[0].id });
    expect(stripe.createdTransfers).toHaveLength(1);
    expect(db.profile(partner['id'])?.['total_paid_cents']).toBe(3000);
  });
});

describe('B1: only a definitive refusal fails a payout', () => {
  it('definitive error → FAILED with the Stripe code, an admin alert, and no automatic retry', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 2000);
    stripe.scriptedTransferFailures.push({ error: stripeError('StripeInvalidRequestError', 'account_invalid', 400), created: false });

    const summary = await cycle();
    expect(summary).toMatchObject({ claimed: 1, failed: 1, sent: 0, pending: 0 });
    expect(payouts()[0]).toMatchObject({ status: 'FAILED', failure_reason: 'account_invalid' });
    expect(hooks.onPayoutFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'account_invalid', exhausted: false, payout: expect.objectContaining({ status: 'FAILED' }) })
    );

    advance(2 * 24 * HOUR);
    const later = await cycle();
    expect(later.retried).toBe(0);
    expect(stripe.transferCreates).toHaveLength(1);
  });

  it('transient error (Stripe 500) → stays PROCESSING', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 2000);
    stripe.scriptedTransferFailures.push({ error: stripeError('StripeAPIError', null, 500), created: false });

    const summary = await cycle();
    expect(summary).toMatchObject({ claimed: 1, failed: 0, pending: 1 });
    expect(summary.errors).toEqual([expect.objectContaining({ step: 'transfer', code: 'stripe_api_error' })]);
    expect(payouts()[0]['status']).toBe('PROCESSING');
    expect(hooks.onPayoutFailed).not.toHaveBeenCalled();
  });

  it('stops automatic retries after 5 attempts and alerts once they are exhausted', async () => {
    const partner = addPartner();
    const commission = addCommission(partner['id'], 2000);
    const payout: Row = {
      id: randomUUID(),
      affiliate_id: partner['id'],
      amount_cents: 2000,
      currency: 'USD',
      stripe_destination_account: partner['stripe_connect_account_id'],
      stripe_transfer_id: null,
      method: 'stripe_connect',
      livemode: false,
      status: 'FAILED',
      attempt_count: 5,
      last_attempt_at: new Date(START.getTime() - 2 * 24 * HOUR).toISOString(),
      failure_reason: 'stale',
      trigger: 'cron',
      paid_at: null,
      created_at: START.toISOString(),
      updated_at: START.toISOString(),
    };
    db.tables['affiliate_payouts'].push(payout);
    commission['payout_id'] = payout['id'];

    const summary = await cycle();
    expect(summary.retried).toBe(0);
    expect(stripe.transferCreates).toHaveLength(0);

    // Attempt 4 failing as balance_insufficient is retried; attempt 5 failing again is exhausted.
    payout['attempt_count'] = 4;
    stripe.available['usd'] = 2000;
    stripe.scriptedTransferFailures.push({ error: stripeError('StripeInvalidRequestError', 'balance_insufficient', 400), created: false });
    const retried = await cycle();
    expect(retried).toMatchObject({ retried: 1, failed: 1 });
    expect(payout).toMatchObject({ status: 'FAILED', failure_reason: 'balance_insufficient', attempt_count: 5 });
    expect(hooks.onPayoutFailed).toHaveBeenCalledWith(expect.objectContaining({ reason: 'balance_insufficient', exhausted: true }));
  });
});

describe('B2: the platform balance gates claims', () => {
  it('claims nothing when the balance is short and alerts once per day', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 5000);
    stripe.available['usd'] = 1200;

    const first = await cycle();
    expect(first).toMatchObject({ claimed: 0, skippedInsufficientBalance: 1, insufficientBalanceAlerted: true });
    expect(first.insufficientBalance).toEqual([{ currency: 'USD', availableCents: 1200, requiredCents: 5000 }]);
    expect(payouts()).toHaveLength(0);
    expect(db.tables['affiliate_commissions'][0]['payout_id']).toBeNull();
    expect(hooks.onInsufficientBalance).toHaveBeenCalledTimes(1);
    expect(stripe.retrievedAccounts).toEqual([]);

    // The caller tracks the day: a later call of the same day passes the flag and is not alerted again.
    const second = await cycle({ insufficientBalanceAlerted: true });
    expect(second).toMatchObject({ claimed: 0, insufficientBalanceAlerted: true });
    expect(hooks.onInsufficientBalance).toHaveBeenCalledTimes(1);
  });

  it('records an alert that could not be written as not sent', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 5000);
    stripe.available['usd'] = 0;
    hooks.onInsufficientBalance.mockImplementation(async () => false);
    const summary = await cycle();
    expect(summary.insufficientBalanceAlerted).toBe(false);
  });

  it('spends the balance as it goes: the second partner waits when the first used it up', async () => {
    const first = addPartner({ id: '00000000-0000-4000-8000-000000000001' });
    const second = addPartner({ id: '00000000-0000-4000-8000-000000000002' });
    addCommission(first['id'], 4000);
    addCommission(second['id'], 4000);
    stripe.available['usd'] = 6000;

    const summary = await cycle();
    expect(summary).toMatchObject({ claimed: 1, sent: 1, skippedInsufficientBalance: 1 });
    expect(summary.insufficientBalance).toEqual([{ currency: 'USD', availableCents: 2000, requiredCents: 4000 }]);
  });

  it('claims nothing when the balance cannot be read', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 5000);
    stripe.balanceError = timeoutError();
    const summary = await cycle();
    expect(summary).toMatchObject({ claimed: 0, livemode: null });
    expect(summary.errors).toEqual([expect.objectContaining({ step: 'balance', code: 'stripe_connection' })]);
    expect(payouts()).toHaveLength(0);
  });
});

describe('Connect readiness and key mode', () => {
  it('skips partners whose account cannot receive transfers and records that on the profile', async () => {
    const partner = addPartner({}, { payouts_enabled: false });
    addCommission(partner['id'], 5000);

    const summary = await cycle();
    expect(summary).toMatchObject({ claimed: 0, skippedNotReady: 1 });
    expect(payouts()).toHaveLength(0);
    expect(db.profile(partner['id'])).toMatchObject({
      stripe_connect_onboarding_complete: false,
      stripe_connect_payouts_enabled: false,
      stripe_connect_checked_at: START.toISOString(),
    });
  });

  it('requires the transfers capability to be active', async () => {
    const partner = addPartner({}, { capabilities: { transfers: 'pending' } });
    addCommission(partner['id'], 5000);
    const summary = await cycle();
    expect(summary).toMatchObject({ claimed: 0, skippedNotReady: 1 });
  });

  it('skips an account of the other key mode without asking Stripe', async () => {
    stripe.livemode = true;
    const partner = addPartner({ stripe_connect_livemode: false });
    // A live sale whose partner still holds a test-mode account.
    addCommission(partner['id'], 5000, { livemode: true });

    const summary = await cycle();
    expect(summary).toMatchObject({ livemode: true, claimed: 0, skippedNotReady: 1 });
    expect(stripe.retrievedAccounts).toEqual([]);
    expect(stripe.transferCreates).toHaveLength(0);
  });

  it('pays a partner who finished onboarding without coming back to the portal, and reports the first readiness', async () => {
    const partner = addPartner({
      stripe_connect_onboarding_complete: false,
      stripe_connect_livemode: null,
      payout_configured_at: null,
    });
    addCommission(partner['id'], 5000);

    const summary = await cycle();
    expect(summary).toMatchObject({ claimed: 1, sent: 1 });
    expect(db.profile(partner['id'])).toMatchObject({ stripe_connect_onboarding_complete: true, stripe_connect_livemode: false });
    expect(hooks.onConnectFirstReady).toHaveBeenCalledWith(partner['id']);
  });

  it('skips a partner whose account Stripe no longer knows', async () => {
    const partner = addPartner({}, null);
    addCommission(partner['id'], 5000);
    const summary = await cycle();
    expect(summary).toMatchObject({ claimed: 0, skippedNotReady: 1 });
  });
});

describe('batching and continuation', () => {
  it('caps the partners per call and reports the rest as remaining', async () => {
    for (let index = 1; index <= 3; index += 1) {
      const partner = addPartner({ id: `00000000-0000-4000-8000-00000000000${index}` });
      addCommission(partner['id'], 1000);
    }
    const first = await cycle({ batchSize: 2 });
    expect(first).toMatchObject({ claimed: 2, sent: 2, remaining: 1 });

    const second = await cycle({ batchSize: 2, skipCheckedSince: first.startedAt });
    expect(second).toMatchObject({ claimed: 1, sent: 1, remaining: 0 });
  });

  it('a continuation skips partners already found not ready earlier in the run', async () => {
    const notReady = addPartner({ id: '00000000-0000-4000-8000-000000000001' }, { payouts_enabled: false });
    const ready = addPartner({ id: '00000000-0000-4000-8000-000000000002' });
    addCommission(notReady['id'], 1000);
    addCommission(ready['id'], 1000);

    const first = await cycle({ batchSize: 1 });
    expect(first).toMatchObject({ skippedNotReady: 1, claimed: 0, remaining: 1 });

    advance(16 * MINUTE);
    const second = await cycle({ batchSize: 1, skipCheckedSince: first.startedAt });
    expect(second).toMatchObject({ skippedNotReady: 0, claimed: 1, remaining: 0 });
    expect(stripe.retrievedAccounts.filter((id) => id === notReady['stripe_connect_account_id'])).toHaveLength(1);
  });

  it('stops calling Stripe after an authentication error', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 1000);
    stripe.balanceError = stripeError('StripeAuthenticationError', null, 401);
    const summary = await cycle();
    expect(summary.aborted).toBe('stripe_authentication');
    expect(stripe.transferCreates).toHaveLength(0);
  });
});

describe('never throws', () => {
  it('collects database and hook failures as short codes and keeps going', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 1000);
    db.failNextRpc['reconcile_affiliate_commissions'] = 1;
    db.failNextRpc['promote_cleared_affiliate_commissions'] = 1;
    hooks.sweepCommissionNotifications.mockRejectedValueOnce(new Error('smtp down'));
    hooks.onPayoutSent.mockImplementationOnce(() => {
      throw new Error('mailer exploded with a secret');
    });

    const summary = await cycle();
    expect(summary.sent).toBe(1);
    expect(summary.errors.map((error) => `${error.step}:${error.code}`)).toEqual([
      'reconcile_commissions:XX000',
      'promote_commissions:XX000',
      'notify_commissions:unknown',
      'hook:unknown',
    ]);
    expect(JSON.stringify(summary)).not.toContain('secret');
  });

  it('survives a client whose every call throws', async () => {
    const broken = {
      rpc: () => {
        throw new Error('network');
      },
      from: () => {
        throw new Error('network');
      },
    } as unknown as AffiliateRepositoryClient;
    const summary = await runAffiliatePayoutCycle({ supabase: broken, stripe, trigger: 'auto', minPayoutCents: 100, now: clock });
    expect(summary.errors.length).toBeGreaterThan(0);
    expect(summary.claimed).toBe(0);
  });
});

describe('retryAffiliatePayout / releaseAffiliatePayout (admin)', () => {
  async function failedPayout(reason: string) {
    const partner = addPartner();
    addCommission(partner['id'], 2500);
    stripe.scriptedTransferFailures.push({ error: stripeError('StripeInvalidRequestError', reason, 400), created: false });
    await cycle();
    const [payout] = payouts();
    expect(payout).toMatchObject({ status: 'FAILED', failure_reason: reason });
    return { partner, payout };
  }

  it('retries a FAILED payout with the next attempt key', async () => {
    const { payout } = await failedPayout('account_invalid');
    const result = await retryAffiliatePayout(adminDeps(), payout['id']);
    expect(result).toEqual({ ok: true, outcome: 'sent', payoutId: payout['id'], transferId: stripe.createdTransfers[0].id });
    expect(payout).toMatchObject({ status: 'COMPLETED', attempt_count: 2 });
    expect(stripe.transferCreates.at(-1)?.idempotencyKey).toBe(`affiliate-payout-${payout['id']}-2`);
  });

  it('refuses to send again when Stripe already holds a transfer of the group; completes the payout instead', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 2500);
    stripe.scriptedTransferFailures.push({ error: timeoutError(), created: true });
    await cycle();
    const [payout] = payouts();
    // An operator marks it failed by hand (or a stale run did) while the transfer exists.
    payout['status'] = 'FAILED';
    payout['failure_reason'] = 'stale';

    const result = await retryAffiliatePayout(adminDeps(), payout['id']);
    expect(result).toMatchObject({ ok: true, outcome: 'completed', transferId: stripe.createdTransfers[0].id });
    expect(stripe.createdTransfers).toHaveLength(1);
    expect(payout['status']).toBe('COMPLETED');
  });

  it('reconciles a stale PROCESSING payout before retrying, and refuses one still in flight', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 2500);
    stripe.scriptedTransferFailures.push({ error: timeoutError(), created: false });
    await cycle();
    const [payout] = payouts();

    expect(await retryAffiliatePayout(adminDeps(), payout['id'])).toMatchObject({ ok: false, error: 'in_flight' });

    advance(20 * MINUTE);
    const result = await retryAffiliatePayout(adminDeps(), payout['id']);
    expect(result).toMatchObject({ ok: true, outcome: 'sent' });
    expect(payout).toMatchObject({ status: 'COMPLETED', attempt_count: 2 });
    expect(stripe.createdTransfers).toHaveLength(1);
  });

  it('reports a refusal, an unknown id and a completed payout', async () => {
    const { payout } = await failedPayout('account_invalid');
    stripe.scriptedTransferFailures.push({ error: stripeError('StripeInvalidRequestError', 'transfers_not_allowed', 400), created: false });
    expect(await retryAffiliatePayout(adminDeps(), payout['id'])).toMatchObject({
      ok: false,
      error: 'transfer_failed',
      reason: 'transfers_not_allowed',
    });
    expect(await retryAffiliatePayout(adminDeps(), 'not-a-uuid')).toMatchObject({ ok: false, error: 'invalid_id' });
    expect(await retryAffiliatePayout(adminDeps(), randomUUID())).toMatchObject({ ok: false, error: 'not_found' });
    payout['status'] = 'COMPLETED';
    expect(await retryAffiliatePayout(adminDeps(), payout['id'])).toMatchObject({ ok: false, error: 'not_failed' });
  });

  it('refuses a retry while the account is not ready or the balance is short', async () => {
    const { partner, payout } = await failedPayout('account_invalid');
    connectedAccount(partner).payouts_enabled = false;
    expect(await retryAffiliatePayout(adminDeps(), payout['id'])).toMatchObject({ ok: false, error: 'account_not_ready' });

    connectedAccount(partner).payouts_enabled = true;
    stripe.available['usd'] = 100;
    expect(await retryAffiliatePayout(adminDeps(), payout['id'])).toMatchObject({ ok: false, error: 'balance_insufficient' });
    expect(payout['attempt_count']).toBe(1);
  });

  it('releases a FAILED payout and detaches its commissions', async () => {
    const { payout } = await failedPayout('account_invalid');
    const result = await releaseAffiliatePayout(adminDeps(), payout['id']);
    expect(result).toEqual({ ok: true, outcome: 'released', payoutId: payout['id'], transferId: null });
    expect(payout['failure_reason']).toBe('released');
    expect(db.commissionsOf(payout['id'])).toHaveLength(0);
  });

  it('refuses a release while a transfer exists, completing the payout instead', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 2500);
    stripe.scriptedTransferFailures.push({ error: timeoutError(), created: true });
    await cycle();
    const [payout] = payouts();
    payout['status'] = 'FAILED';
    payout['failure_reason'] = 'stale';

    expect(await releaseAffiliatePayout(adminDeps(), payout['id'])).toMatchObject({ ok: false, error: 'transfer_exists' });
    expect(payout['status']).toBe('COMPLETED');
    expect(db.commissionsOf(payout['id']).every((row) => row['status'] === 'PAID')).toBe(true);
  });

  it('refuses a release when Stripe cannot be asked', async () => {
    const { payout } = await failedPayout('account_invalid');
    stripe.listError = timeoutError();
    expect(await releaseAffiliatePayout(adminDeps(), payout['id'])).toMatchObject({ ok: false, error: 'reconcile_failed' });
    expect(payout['failure_reason']).toBe('account_invalid');
  });
});

describe('transfer mismatches', () => {
  it('completes a reconciled payout whose transfer amount differs, and reports the mismatch', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 2500);
    stripe.scriptedTransferFailures.push({ error: timeoutError(), created: true });
    await cycle();
    stripe.createdTransfers[0].amount = 2400;

    advance(20 * MINUTE);
    const summary = await cycle();
    expect(summary.sent).toBe(1);
    expect(hooks.onTransferMismatch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'amount' }));
  });
});

describe('C: a payout never mixes Stripe key modes', () => {
  it('a live key never claims, retries or raises a balance alert for test-mode commissions', async () => {
    stripe.livemode = true;
    stripe.available['usd'] = 0;
    // The partner re-onboarded on the live account after the switch; their sales were test-mode.
    const partner = addPartner({ stripe_connect_livemode: true });
    addCommission(partner['id'], 5000);
    const testPayout = addPayout(partner, { amount_cents: 3000 });
    addCommission(partner['id'], 3000, { payout_id: testPayout['id'] });

    const summary = await cycle();

    expect(summary).toMatchObject({
      livemode: true,
      claimed: 0,
      retried: 0,
      skippedInsufficientBalance: 0,
      skippedBelowMinimum: 0,
      skippedNotReady: 0,
    });
    expect(summary.insufficientBalance).toEqual([]);
    expect(hooks.onInsufficientBalance).not.toHaveBeenCalled();
    const rpcNames = db.rpcCalls.map((call) => call.name);
    expect(rpcNames).not.toContain('claim_affiliate_payout');
    expect(rpcNames).not.toContain('prepare_affiliate_payout_retry');
    expect(stripe.retrievedAccounts).toEqual([]);
    expect(stripe.transferCreates).toHaveLength(0);
    expect(testPayout).toMatchObject({ status: 'FAILED', attempt_count: 1, failure_reason: 'balance_insufficient' });
  });

  it('pays each sale only with a payout of its own mode', async () => {
    stripe.livemode = true;
    const partner = addPartner({ stripe_connect_livemode: true });
    const testSale = addCommission(partner['id'], 5000);
    const liveSale = addCommission(partner['id'], 3000, { livemode: true });

    const summary = await cycle();

    expect(summary).toMatchObject({ claimed: 1, sent: 1 });
    const [payout] = payouts();
    expect(payout).toMatchObject({ status: 'COMPLETED', amount_cents: 3000, livemode: true });
    expect(stripe.transferCreates.map((call) => call.params.amount)).toEqual([3000]);
    expect(liveSale).toMatchObject({ status: 'PAID', payout_id: payout['id'] });
    expect(testSale).toMatchObject({ status: 'CLEARED', payout_id: null });
  });

  it('a FAILED test-mode payout is neither retried nor released with a live key', async () => {
    stripe.livemode = true;
    const partner = addPartner({ stripe_connect_livemode: true });
    const payout = addPayout(partner, { stripe_destination_account: 'acct_test_old' });
    addCommission(partner['id'], 2500, { payout_id: payout['id'] });
    const list = vi.spyOn(stripe.transfers, 'list');

    const summary = await cycle();
    expect(summary).toMatchObject({ retried: 0, claimed: 0 });
    expect(payout).toMatchObject({
      status: 'FAILED',
      attempt_count: 1,
      stripe_destination_account: 'acct_test_old',
      failure_reason: 'balance_insufficient',
    });

    expect(await retryAffiliatePayout(adminDeps(), payout['id'])).toMatchObject({ ok: false, error: 'other_mode' });
    expect(await releaseAffiliatePayout(adminDeps(), payout['id'])).toMatchObject({ ok: false, error: 'other_mode' });
    expect(list).not.toHaveBeenCalled();
    expect(stripe.transferCreates).toHaveLength(0);
    expect(payout['failure_reason']).toBe('balance_insufficient');
    expect(db.commissionsOf(payout['id'])).toHaveLength(1);
    expect(db.rpcCalls.map((call) => call.name)).not.toContain('prepare_affiliate_payout_retry');
  });

  it('a PROCESSING payout of the other mode is neither failed as stale nor released', async () => {
    stripe.livemode = true;
    const partner = addPartner({ stripe_connect_livemode: true });
    const payout = addPayout(partner, {
      status: 'PROCESSING',
      failure_reason: null,
      last_attempt_at: new Date(START.getTime() - HOUR).toISOString(),
    });
    addCommission(partner['id'], 2500, { payout_id: payout['id'] });
    const list = vi.spyOn(stripe.transfers, 'list');

    const summary = await cycle();
    expect(summary).toMatchObject({ reconciled: 0, failed: 0 });
    expect(payout['status']).toBe('PROCESSING');

    expect(await releaseAffiliatePayout(adminDeps(), payout['id'])).toMatchObject({ ok: false, error: 'other_mode' });
    expect(await retryAffiliatePayout(adminDeps(), payout['id'])).toMatchObject({ ok: false, error: 'other_mode' });
    expect(list).not.toHaveBeenCalled();
    expect(payout['status']).toBe('PROCESSING');
    expect(db.commissionsOf(payout['id'])).toHaveLength(1);
  });
});

describe('Z: the minimum payout applies to automatic retries', () => {
  /** A 5200 payout failed for a short balance; while FAILED, a full refund voided (and detached) its 5000 commission. */
  function failedThenRefunded() {
    const partner = addPartner();
    const payout = addPayout(partner, { amount_cents: 5200 });
    addCommission(partner['id'], 5000, { status: 'VOIDED_REFUND', void_reason: 'refunded', voided_at: START.toISOString() });
    const remainder = addCommission(partner['id'], 200, { payout_id: payout['id'] });
    return { payout, remainder };
  }

  it('hands a retry whose remainder is below the minimum back to the cleared balance instead of sending it', async () => {
    const { payout, remainder } = failedThenRefunded();

    const summary = await cycle({ minPayoutCents: 5000 });

    const prepare = db.rpcCalls.find((call) => call.name === 'prepare_affiliate_payout_retry');
    expect(prepare?.args).toEqual({ p_payout_id: payout['id'], p_min_amount: 5000 });
    expect(payout).toMatchObject({ status: 'FAILED', failure_reason: 'below_minimum', attempt_count: 1, amount_cents: 5200 });
    expect(remainder).toMatchObject({ status: 'CLEARED', payout_id: null });
    expect(stripe.transferCreates).toHaveLength(0);
    // The retry handed the payout back, then the claim pass found the partner's 200 below the minimum.
    expect(summary).toMatchObject({ retried: 0, claimed: 0, sent: 0, skippedBelowMinimum: 2 });
  });

  it('an admin retry still sends what is left', async () => {
    const { payout } = failedThenRefunded();

    const result = await retryAffiliatePayout(adminDeps(), payout['id']);

    expect(result).toMatchObject({ ok: true, outcome: 'sent' });
    const prepare = db.rpcCalls.find((call) => call.name === 'prepare_affiliate_payout_retry');
    expect(prepare?.args).toEqual({ p_payout_id: payout['id'], p_min_amount: 0 });
    expect(stripe.transferCreates.map((call) => call.params.amount)).toEqual([200]);
    expect(payout).toMatchObject({ status: 'COMPLETED', amount_cents: 200, attempt_count: 2 });
  });
});

describe('AB: a refused completion is judged on the payout as it is now', () => {
  /** On the next transfers.list, another run (cron, the after() fallback, an admin Retry) sends and records the payout first. */
  function anotherRunCompletesFirst(payout: Row, transferId = 'tr_other') {
    const list = stripe.transfers.list;
    stripe.transfers.list = async (params) => {
      stripe.transfers.list = list;
      stripe.createdTransfers.push({
        id: transferId,
        amount: payout['amount_cents'],
        currency: 'usd',
        destination: payout['stripe_destination_account'],
        transfer_group: `affiliate_payout_${payout['id']}`,
        metadata: {},
        reversed: false,
        livemode: false,
      });
      db.rpc_complete_affiliate_payout({ p_payout_id: payout['id'], p_transfer_id: transferId });
      return list(params);
    };
  }

  it('raises no released alert for a payout another run completed meanwhile', async () => {
    const partner = addPartner();
    const payout = addPayout(partner);
    addCommission(partner['id'], 2500, { payout_id: payout['id'] });
    anotherRunCompletesFirst(payout);

    const summary = await cycle();

    expect(payout).toMatchObject({ status: 'COMPLETED', stripe_transfer_id: 'tr_other' });
    expect(hooks.onTransferMismatch).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ sent: 0, retried: 0 });
    expect(stripe.transferCreates).toHaveLength(0);
  });

  it('answers transfer_exists to an admin retry of a copy completed meanwhile, without an alert', async () => {
    const partner = addPartner();
    const payout = addPayout(partner, { failure_reason: 'account_invalid' });
    addCommission(partner['id'], 2500, { payout_id: payout['id'] });
    anotherRunCompletesFirst(payout);

    expect(await retryAffiliatePayout(adminDeps(), payout['id'])).toMatchObject({ ok: false, error: 'transfer_exists' });
    expect(hooks.onTransferMismatch).not.toHaveBeenCalled();
    expect(stripe.transferCreates).toHaveLength(0);
  });

  it('still reports a double payment when the completed payout\'s group holds two live transfers', async () => {
    const partner = addPartner();
    const payout = addPayout(partner);
    addCommission(partner['id'], 2500, { payout_id: payout['id'] });
    stripe.createdTransfers.push({
      id: 'tr_earlier',
      amount: 2500,
      currency: 'usd',
      destination: payout['stripe_destination_account'],
      transfer_group: `affiliate_payout_${payout['id']}`,
      metadata: {},
      reversed: false,
      livemode: false,
    });
    anotherRunCompletesFirst(payout);

    await retryAffiliatePayout(adminDeps(), payout['id']);

    expect(hooks.onTransferMismatch).toHaveBeenCalledTimes(1);
    expect(hooks.onTransferMismatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'duplicate', activeTransfers: 2, payout: expect.objectContaining({ status: 'COMPLETED' }) })
    );
  });

  it('raises released for a transfer of a payout released meanwhile, even from a PROCESSING copy', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 3000);
    db.failNextRpc['complete_affiliate_payout'] = 1;
    await cycle();
    const [payout] = payouts();
    expect(payout['status']).toBe('PROCESSING');

    advance(20 * MINUTE);
    const list = stripe.transfers.list;
    stripe.transfers.list = async (params) => {
      stripe.transfers.list = list;
      // Meanwhile another run failed it and an admin released it: its commissions are claimable again.
      Object.assign(payout, { status: 'FAILED', failure_reason: 'released' });
      for (const row of db.commissionsOf(payout['id'])) row['payout_id'] = null;
      return list(params);
    };

    await cycle({ minPayoutCents: 1_000_000 });

    expect(hooks.onTransferMismatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'released',
        transfer: expect.objectContaining({ id: stripe.createdTransfers[0].id }),
        payout: expect.objectContaining({ id: payout['id'], status: 'FAILED', failure_reason: 'released' }),
      })
    );
  });
});

describe('02036: gateways paid outside Stripe', () => {
  it('claims and sizes only the gateways routed to Stripe; the others stay cleared for a manual payout', async () => {
    const partner = addPartner();
    const stripeSale = addCommission(partner['id'], 1500);
    const freemiusSale = addCommission(partner['id'], 2500, { gateway: 'FREEMIUS' });

    const summary = await cycle({ gateways: ['STRIPE'] });

    expect(summary).toMatchObject({ claimed: 1, sent: 1 });
    const [payout] = payouts();
    expect(payout).toMatchObject({ amount_cents: 1500, status: 'COMPLETED' });
    expect(stripe.transferCreates.map((call) => call.params.amount)).toEqual([1500]);
    expect(stripeSale['status']).toBe('PAID');
    expect(freemiusSale).toMatchObject({ status: 'CLEARED', payout_id: null });
    expect(db.rpcCalls.find((call) => call.name === 'claim_affiliate_payout')?.args).toMatchObject({ p_gateways: ['STRIPE'] });
  });

  it('a partner owed only manual-routed commissions gets no Stripe call at all', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 5000, { gateway: 'FREEMIUS' });

    const summary = await cycle({ gateways: ['STRIPE'] });

    expect(summary).toMatchObject({ claimed: 0, skippedBelowMinimum: 0 });
    expect(stripe.retrievedAccounts).toEqual([]);
    expect(db.rpcCalls.map((call) => call.name)).not.toContain('claim_affiliate_payout');
  });

  it('sends no p_gateways while every gateway is routed to Stripe (the call is exactly the one before 02036)', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 1500);
    addCommission(partner['id'], 700, { gateway: 'FREEMIUS' });

    await cycle({ gateways: ['FREEMIUS', 'STRIPE'] });

    const claim = db.rpcCalls.find((call) => call.name === 'claim_affiliate_payout');
    expect(claim?.args).not.toHaveProperty('p_gateways');
    expect(payouts()[0]).toMatchObject({ amount_cents: 2200 });
  });

  it('with no gateway routed to Stripe: the ledger repair alone, and Stripe is never asked', async () => {
    const partner = addPartner();
    addCommission(partner['id'], 900, { status: 'PENDING_CLEARANCE', clears_at: new Date(START.getTime() - MINUTE).toISOString() });
    const balance = vi.spyOn(stripe.balance, 'retrieve');

    const summary = await cycle({ gateways: [] });

    expect(summary).toMatchObject({ promoted: 1, notified: 2, claimed: 0, livemode: null, errors: [] });
    expect(balance).not.toHaveBeenCalled();
    expect(stripe.transferCreates).toEqual([]);
    expect(db.rpcCalls.map((call) => call.name)).toEqual(['reconcile_affiliate_commissions', 'promote_cleared_affiliate_commissions']);
  });
});

describe('02036: a prepared manual payout is never a Stripe payout', () => {
  /** A manual payout the CMS prepared an hour ago (PROCESSING, no Stripe field), holding one commission. */
  function preparedManualPayout(partner: Row) {
    const payout = addPayout(partner, {
      method: 'manual',
      status: 'PROCESSING',
      failure_reason: null,
      stripe_destination_account: null,
      livemode: true,
      trigger: 'admin',
      last_attempt_at: new Date(START.getTime() - HOUR).toISOString(),
    });
    const commission = addCommission(partner['id'], 3000, { gateway: 'FREEMIUS', livemode: true });
    commission['payout_id'] = payout['id'];
    return { payout, commission };
  }

  it('the daily reconciliation leaves it PROCESSING (Stripe holds no transfer for it) and never fails it as stale', async () => {
    const partner = addPartner({ stripe_connect_livemode: true });
    stripe.livemode = true;
    const { payout, commission } = preparedManualPayout(partner);
    const lists = vi.spyOn(stripe.transfers, 'list');

    const summary = await cycle({ gateways: ['STRIPE'] });

    expect(summary.reconciled).toBe(0);
    expect(payout).toMatchObject({ status: 'PROCESSING', failure_reason: null });
    expect(commission['payout_id']).toBe(payout['id']);
    expect(lists).not.toHaveBeenCalled();
    expect(db.rpcCalls.map((call) => call.name)).not.toContain('fail_affiliate_payout');
  });

  it('Retry and Release refuse it before any Stripe call (it is recorded or cancelled under Pay manually)', async () => {
    const partner = addPartner({ stripe_connect_livemode: true });
    const { payout } = preparedManualPayout(partner);
    const balance = vi.spyOn(stripe.balance, 'retrieve');

    await expect(retryAffiliatePayout(adminDeps(), payout['id'])).resolves.toEqual({
      ok: false,
      error: 'manual_payout',
      payoutId: payout['id'],
      reason: null,
    });
    await expect(releaseAffiliatePayout(adminDeps(), payout['id'])).resolves.toMatchObject({ ok: false, error: 'manual_payout' });
    expect(balance).not.toHaveBeenCalled();
    expect(payout['status']).toBe('PROCESSING');
  });
});

describe('02036: the manual payout RPC wrappers', () => {
  const PAYOUT = '11111111-2222-4333-8444-555555555555';
  const AFFILIATE = '66666666-7777-4888-8999-000000000000';

  function answering(data: unknown, error: unknown = null) {
    const calls: Array<{ name: string; args: Row }> = [];
    const client = {
      async rpc(name: string, args: Row) {
        calls.push({ name, args });
        return { data, error };
      },
    } as unknown as AffiliateRepositoryClient;
    return { client, calls };
  }

  it('claims with the gateways and the minimum, and reads every answer', async () => {
    const prepared = answering({ status: 'prepared', payout_id: PAYOUT, amount_cents: 3000, commission_count: 2 });
    await expect(
      claimManualAffiliatePayoutViaRpc(prepared.client, { affiliateId: AFFILIATE, currency: 'CAD', minAmountCents: 2500.7, gateways: ['FREEMIUS'] })
    ).resolves.toEqual({ status: 'prepared', payoutId: PAYOUT, amountCents: 3000, commissionCount: 2 });
    expect(prepared.calls).toEqual([
      { name: 'claim_manual_affiliate_payout', args: { p_affiliate_id: AFFILIATE, p_currency: 'CAD', p_min_amount: 2500, p_gateways: ['FREEMIUS'] } },
    ]);

    const again = answering({ status: 'already_prepared', payout_id: PAYOUT, amount_cents: 1200 });
    await expect(claimManualAffiliatePayoutViaRpc(again.client, { affiliateId: AFFILIATE, currency: 'CAD', gateways: ['FREEMIUS'] })).resolves.toEqual({
      status: 'already_prepared',
      payoutId: PAYOUT,
      amountCents: 1200,
    });
    expect(again.calls[0]?.args['p_min_amount']).toBe(0);

    const below = answering({ status: 'below_minimum', amount_cents: 900, commission_count: 1 });
    await expect(claimManualAffiliatePayoutViaRpc(below.client, { affiliateId: AFFILIATE, currency: 'CAD', gateways: ['FREEMIUS'] })).resolves.toEqual({
      status: 'below_minimum',
      amountCents: 900,
      commissionCount: 1,
    });
    for (const status of ['invalid_input', 'not_found', 'not_eligible', 'nothing_owed']) {
      const refused = answering({ status });
      await expect(claimManualAffiliatePayoutViaRpc(refused.client, { affiliateId: AFFILIATE, currency: 'CAD', gateways: ['FREEMIUS'] })).resolves.toEqual({
        status,
      });
    }
  });

  it('records with the recorder it is given and reads the payout back; a racing duplicate reference reads as duplicate_reference', async () => {
    const recorded = answering({
      status: 'recorded',
      payout_id: PAYOUT,
      affiliate_id: AFFILIATE,
      amount_cents: 3000,
      currency: 'cad',
      commission_count: 2,
    });
    await expect(
      recordManualAffiliatePayoutViaRpc(recorded.client, { payoutId: PAYOUT, channel: 'paypal', reference: '5TY', note: null, recordedBy: AFFILIATE })
    ).resolves.toEqual({ status: 'recorded', payoutId: PAYOUT, affiliateId: AFFILIATE, amountCents: 3000, currency: 'CAD', commissionCount: 2 });
    expect(recorded.calls[0]).toEqual({
      name: 'record_manual_affiliate_payout',
      args: { p_payout_id: PAYOUT, p_channel: 'paypal', p_reference: '5TY', p_note: null, p_recorded_by: AFFILIATE },
    });
    for (const status of ['invalid_input', 'reference_required', 'not_found', 'already_recorded', 'duplicate_reference']) {
      const refused = answering({ status });
      await expect(
        recordManualAffiliatePayoutViaRpc(refused.client, { payoutId: PAYOUT, channel: 'paypal', reference: '5TY', recordedBy: AFFILIATE })
      ).resolves.toEqual({ status });
    }
    const raced = answering(null, { code: '23505', message: 'duplicate key value violates unique constraint' });
    await expect(
      recordManualAffiliatePayoutViaRpc(raced.client, { payoutId: PAYOUT, channel: 'paypal', reference: '5TY', recordedBy: AFFILIATE })
    ).resolves.toEqual({ status: 'duplicate_reference' });
  });

  it('cancels, and throws on an answer it does not know (no money step trusts a malformed reply)', async () => {
    const cancelled = answering({ status: 'cancelled', commission_count: 3 });
    await expect(cancelManualAffiliatePayoutViaRpc(cancelled.client, PAYOUT)).resolves.toEqual({ status: 'cancelled', commissionCount: 3 });
    expect(cancelled.calls[0]).toEqual({ name: 'cancel_manual_affiliate_payout', args: { p_payout_id: PAYOUT } });
    for (const status of ['not_found', 'already_recorded']) {
      await expect(cancelManualAffiliatePayoutViaRpc(answering({ status }).client, PAYOUT)).resolves.toEqual({ status });
    }

    for (const data of [{ status: 'amount_changed', amount_cents: 1 }, { status: 'prepared', amount_cents: 0, payout_id: PAYOUT, commission_count: 1 }, null]) {
      await expect(
        claimManualAffiliatePayoutViaRpc(answering(data).client, { affiliateId: AFFILIATE, currency: 'CAD', gateways: ['FREEMIUS'] })
      ).rejects.toBeInstanceOf(AffiliatePayoutRpcError);
    }
    await expect(
      recordManualAffiliatePayoutViaRpc(answering({ status: 'recorded', payout_id: PAYOUT, affiliate_id: AFFILIATE, amount_cents: 5, currency: 'CA', commission_count: 1 }).client, {
        payoutId: PAYOUT,
        channel: 'paypal',
        reference: '5TY',
        recordedBy: AFFILIATE,
      })
    ).rejects.toBeInstanceOf(AffiliatePayoutRpcError);
    await expect(cancelManualAffiliatePayoutViaRpc(answering(null, { code: 'XX000', message: 'boom' }).client, PAYOUT)).rejects.toBeInstanceOf(
      AffiliatePayoutRpcError
    );
  });
});

describe('runAffiliateLedgerRepair (no Stripe client)', () => {
  it('reconciles, promotes and sweeps, and touches no payout', async () => {
    const partner = addPartner({ stripe_connect_account_id: null, stripe_connect_onboarding_complete: false });
    const pending = addCommission(partner['id'], 900, { status: 'PENDING_CLEARANCE', clears_at: new Date(START.getTime() - MINUTE).toISOString() });

    const summary = await runAffiliateLedgerRepair({ supabase: db as unknown as AffiliateRepositoryClient, trigger: 'auto', hooks, now: clock });

    expect(summary).toMatchObject({ trigger: 'auto', promoted: 1, notified: 2, recorded: 0, claimed: 0, sent: 0, livemode: null, remaining: 0, errors: [] });
    expect(summary.startedAt).toBe(START.toISOString());
    expect(pending['status']).toBe('CLEARED');
    expect(db.rpcCalls.map((call) => call.name)).toEqual(['reconcile_affiliate_commissions', 'promote_cleared_affiliate_commissions']);
    expect(hooks.sweepCommissionNotifications).toHaveBeenCalledTimes(1);
    expect(payouts()).toEqual([]);
  });

  it('never throws: each failed step is a short code and the next step still runs', async () => {
    db.failNextRpc['reconcile_affiliate_commissions'] = 1;
    hooks.sweepCommissionNotifications.mockRejectedValueOnce(new Error('smtp down'));
    const onError = vi.fn();

    const summary = await runAffiliateLedgerRepair({
      supabase: db as unknown as AffiliateRepositoryClient,
      trigger: 'cron',
      hooks: { ...hooks, onError },
      now: clock,
    });

    expect(summary.errors).toEqual([
      { step: 'reconcile_commissions', code: 'XX000' },
      { step: 'notify_commissions', code: 'unknown' },
    ]);
    expect(db.rpcCalls.map((call) => call.name)).toContain('promote_cleared_affiliate_commissions');
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe('run summary', () => {
  it('merges calls of a day: counts the calls, keeps the first start and the alert time, adds totals', () => {
    const first = { ...cycleSummary(), startedAt: '2026-10-27T06:00:00.000Z', finishedAt: '2026-10-27T06:00:10.000Z', sent: 2, remaining: 3 };
    const stored = mergeAffiliatePayoutRunSummary({}, { ...first, insufficientBalance: [{ currency: 'USD', availableCents: 1, requiredCents: 9 }], insufficientBalanceAlerted: true });
    expect(stored).toMatchObject({ calls: 1, firstStartedAt: first.startedAt, insufficientBalanceAlertedAt: first.finishedAt, totals: { sent: 2 } });

    const second = { ...cycleSummary(), startedAt: '2026-10-27T06:20:00.000Z', finishedAt: '2026-10-27T06:20:05.000Z', sent: 1, remaining: 0 };
    const merged = mergeAffiliatePayoutRunSummary(JSON.parse(JSON.stringify(stored)), second);
    expect(merged).toMatchObject({
      calls: 2,
      firstStartedAt: first.startedAt,
      insufficientBalanceAlertedAt: first.finishedAt,
      insufficientBalanceAlerted: true,
      remaining: 0,
      totals: { sent: 3 },
    });
    expect(readAffiliatePayoutRunSummary(JSON.parse(JSON.stringify(merged)))).toMatchObject({ calls: 2, totals: { sent: 3 } });
    expect(readAffiliatePayoutRunSummary({})).toBeNull();
    expect(readAffiliatePayoutRunSummary('nope')).toBeNull();
  });
});

function cycleSummary() {
  return {
    trigger: 'auto' as const,
    startedAt: START.toISOString(),
    finishedAt: START.toISOString(),
    livemode: false,
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
