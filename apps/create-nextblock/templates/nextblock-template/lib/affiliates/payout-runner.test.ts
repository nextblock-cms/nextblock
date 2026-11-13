import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The app side of automated payouts: when a run is due (package, setting, sandbox, Stripe), the
 * day claim and the same-day continuation, the per-instance guard, the one insufficient-balance
 * alert per day, the ADMIN re-checks of the explicit entry points and the notification wiring.
 * The money rules themselves are tested in libs/affiliates/src/lib/payouts/payouts.test.ts; here
 * the lib's cycle is a mock that reports what a cycle would.
 */

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  db: null as any,
  verifyPackageOnline: vi.fn(),
  getStripeClient: vi.fn(),
  runCycle: vi.fn(),
  runRepair: vi.fn(),
  retry: vi.fn(),
  release: vi.fn(),
  platformInfo: vi.fn(),
  requireCmsAdmin: vi.fn(),
  readSettings: vi.fn(),
  notify: vi.fn(),
  sweep: vi.fn(),
  refundAlertSweep: vi.fn(),
  paypalStep: vi.fn(),
  scheduled: [] as Array<() => unknown>,
}));

// 02037: the PayPal step of every run (its own module and tests); here only how the runner calls it.
vi.mock('./paypal/runner', () => ({ runAffiliatePayPalStep: mocks.paypalStep }));

vi.mock('@nextblock-cms/db/server', () => ({
  getServiceRoleSupabaseClient: () => mocks.db,
  verifyPackageOnline: mocks.verifyPackageOnline,
}));

vi.mock('@nextblock-cms/ecommerce/server', () => ({
  getStripeClient: mocks.getStripeClient,
  StripeNotConfiguredError: class StripeNotConfiguredError extends Error {},
}));

// The constants contract and the money formatter (vi.importActual, not import(): Nx would treat
// the lib as lazy-loaded otherwise).
vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/constants')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/money')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/payout-methods')),
}));

// The real payout helpers (RPC wrappers, run summary), with the Stripe-facing work mocked.
vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/payouts/index')),
  runAffiliatePayoutCycle: mocks.runCycle,
  runAffiliateLedgerRepair: mocks.runRepair,
  retryAffiliatePayout: mocks.retry,
  releaseAffiliatePayout: mocks.release,
  getAffiliatePlatformAccountInfo: mocks.platformInfo,
}));

vi.mock('../auth/cms-actor', () => ({ requireCmsAdmin: mocks.requireCmsAdmin }));
vi.mock('./settings', () => ({ readAffiliatesSettingsStrict: mocks.readSettings }));
vi.mock('./notify', () => ({
  notifyAffiliateLifecycle: mocks.notify,
  sweepAffiliateCommissionNotifications: mocks.sweep,
  sweepAffiliateRefundAlertEmails: mocks.refundAlertSweep,
  scheduleAffiliateNotification: (task: () => unknown) => {
    mocks.scheduled.push(task);
  },
}));

/* ------------------------------------------------------------------ fake database --- */

function readPath(row: Row, column: string): unknown {
  const json = /^(\w+)->>(\w+)$/.exec(column);
  if (json) {
    const value = row[json[1]]?.[json[2]];
    return value == null ? null : String(value);
  }
  return row[column];
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private mode: 'select' | 'update' | 'insert' = 'select';
  private values: Row | null = null;
  private returning = false;
  private single = false;
  private max: number | null = null;

  constructor(
    private readonly db: FakeRunnerDb,
    private readonly table: string
  ) {}

  select() {
    if (this.mode !== 'select') this.returning = true;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => readPath(row, column) === value);
    return this;
  }
  is(column: string, value: null) {
    this.filters.push((row) => (value === null ? row[column] == null : row[column] === value));
    return this;
  }
  limit(count: number) {
    this.max = count;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  update(values: Row) {
    this.mode = 'update';
    this.values = values;
    return this;
  }
  insert(values: Row) {
    this.mode = 'insert';
    this.values = values;
    return this;
  }
  then<T1 = { data: unknown; error: unknown }, T2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
  private run(): { data: unknown; error: unknown } {
    const rows = (this.db.tables[this.table] ??= []);
    if (this.mode === 'insert') {
      rows.push({ id: `row-${rows.length + 1}`, is_resolved: false, ...this.values });
      return { data: null, error: null };
    }
    let matched = rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.mode === 'update') {
      for (const row of matched) Object.assign(row, this.values);
      return { data: this.returning ? matched.map((row) => ({ ...row })) : null, error: null };
    }
    if (this.max !== null) matched = matched.slice(0, this.max);
    const copies = matched.map((row) => ({ ...row }));
    return { data: this.single ? (copies[0] ?? null) : copies, error: null };
  }
}

class FakeRunnerDb {
  tables: Record<string, Row[]> = {
    affiliate_payout_runs: [],
    system_alerts: [],
    currencies: [{ code: 'USD', is_default: true }],
  };
  rpcCalls: Array<{ name: string; args: Row }> = [];
  rpcThrows = false;

  from(table: string) {
    return new FakeQuery(this, table);
  }

  async rpc(name: string, args: Row) {
    if (this.rpcThrows) throw new Error('database unreachable');
    this.rpcCalls.push({ name, args });
    const runs = this.tables['affiliate_payout_runs'];
    if (name === 'claim_affiliate_payout_run') {
      if (runs.some((run) => run['run_date'] === args['p_run_date'])) return { data: false, error: null };
      runs.push({ run_date: args['p_run_date'], trigger: args['p_trigger'], started_at: new Date().toISOString(), finished_at: null, summary: {} });
      return { data: true, error: null };
    }
    if (name === 'finish_affiliate_payout_run') {
      const run = runs.find((row) => row['run_date'] === args['p_run_date']);
      if (run) Object.assign(run, { finished_at: new Date().toISOString(), summary: args['p_summary'] });
      return { data: null, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  }

  get runs() {
    return this.tables['affiliate_payout_runs'];
  }
  get alerts() {
    return this.tables['system_alerts'];
  }
}

/* ---------------------------------------------------------------------- fixtures --- */

const STRIPE = { balance: { retrieve: vi.fn() }, kind: 'fake-stripe' };
const TODAY = '2026-10-27';
const MINUTE = 60 * 1000;

function cycleSummary(overrides: Row = {}) {
  const startedAt = new Date().toISOString();
  return {
    trigger: 'auto',
    startedAt,
    finishedAt: startedAt,
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
    ...overrides,
  };
}

async function loadRunner() {
  return import('./payout-runner');
}

function storedRun(overrides: Row = {}) {
  const row: Row = {
    run_date: TODAY,
    trigger: 'auto',
    started_at: '2026-10-27T06:00:00.000Z',
    finished_at: '2026-10-27T06:00:30.000Z',
    summary: {
      ...cycleSummary({ startedAt: '2026-10-27T06:00:00.000Z', finishedAt: '2026-10-27T06:00:30.000Z', remaining: 3, sent: 25 }),
      calls: 1,
      firstStartedAt: '2026-10-27T06:00:00.000Z',
      insufficientBalanceAlertedAt: null,
      totals: { claimed: 25, sent: 25, failed: 0, pending: 0, retried: 0, reconciled: 0 },
    },
    ...overrides,
  };
  mocks.db.runs.push(row);
  return row;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-27T07:00:00.000Z'));
  mocks.db = new FakeRunnerDb();
  mocks.scheduled = [];
  for (const mock of [
    mocks.verifyPackageOnline,
    mocks.getStripeClient,
    mocks.runCycle,
    mocks.runRepair,
    mocks.retry,
    mocks.release,
    mocks.platformInfo,
    mocks.requireCmsAdmin,
    mocks.readSettings,
    mocks.notify,
    mocks.sweep,
    mocks.refundAlertSweep,
    mocks.paypalStep,
  ]) {
    mock.mockReset();
  }
  mocks.paypalStep.mockResolvedValue(null);
  mocks.verifyPackageOnline.mockResolvedValue(true);
  mocks.getStripeClient.mockResolvedValue(STRIPE);
  mocks.readSettings.mockResolvedValue({ notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: true });
  mocks.requireCmsAdmin.mockResolvedValue({ supabase: mocks.db, userId: 'admin-1' });
  mocks.runCycle.mockImplementation(async () => cycleSummary());
  mocks.runRepair.mockImplementation(async (deps: any) => cycleSummary({ trigger: deps.trigger, livemode: null, promoted: 2 }));
  mocks.sweep.mockResolvedValue(0);
  mocks.refundAlertSweep.mockResolvedValue(0);
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  warn.mockRestore();
});

/* ------------------------------------------------------------------------- tests --- */

describe('maybeRunAffiliatePayouts: returns fast unless due', () => {
  it('does nothing in the sandbox', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const { maybeRunAffiliatePayouts } = await loadRunner();
    await maybeRunAffiliatePayouts();
    expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();
    expect(mocks.db.rpcCalls).toEqual([]);
    expect(mocks.runCycle).not.toHaveBeenCalled();
  });

  it('does nothing when the caller knows the package is inactive, or the package check says so', async () => {
    const { maybeRunAffiliatePayouts } = await loadRunner();
    await maybeRunAffiliatePayouts(false);
    expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();

    vi.resetModules();
    mocks.verifyPackageOnline.mockResolvedValue(false);
    const fresh = await loadRunner();
    await fresh.maybeRunAffiliatePayouts();
    expect(mocks.db.rpcCalls).toEqual([]);
    expect(mocks.runCycle).not.toHaveBeenCalled();
  });

  it('with automatic payouts off, sends no Stripe transfer but still clears commissions (the switch stops transfers only, 02036)', async () => {
    mocks.readSettings.mockResolvedValue({
      notificationEmails: [],
      minPayoutCents: 500,
      autoPayoutsEnabled: false,
      payoutMethods: { stripeSales: 'manual', freemiusSales: 'manual' },
    });
    const runner = await loadRunner();
    await runner.maybeRunAffiliatePayouts(true);
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.runCycle).not.toHaveBeenCalled();
    expect(mocks.runRepair).toHaveBeenCalledTimes(1);
    expect(mocks.runRepair.mock.calls[0][0]).toMatchObject({ supabase: mocks.db, trigger: 'auto' });
    // a repair-only day: a Stripe-capable run may take it over later today
    expect(mocks.db.rpcCalls[0]).toEqual({ name: 'claim_affiliate_payout_run', args: { p_run_date: TODAY, p_trigger: 'repair' } });
    expect(mocks.db.runs[0]).toMatchObject({ trigger: 'repair', finished_at: expect.any(String) });

    // Within the hour, on the same instance: nothing; later, a cheap look (the day is claimed, the repair ran).
    vi.setSystemTime(new Date(Date.now() + 30 * MINUTE));
    await runner.maybeRunAffiliatePayouts(true);
    expect(mocks.db.rpcCalls).toHaveLength(2);
    vi.setSystemTime(new Date(Date.now() + 61 * MINUTE));
    await runner.maybeRunAffiliatePayouts(true);
    expect(mocks.runRepair).toHaveBeenCalledTimes(1);
    expect(mocks.db.rpcCalls.filter((call) => call.name === 'claim_affiliate_payout_run')).toHaveLength(2);
  });

  it('does nothing while the Stripe client fails for a transient reason', async () => {
    mocks.getStripeClient.mockRejectedValue(new Error('ECONNRESET'));
    const runner = await loadRunner();
    await runner.maybeRunAffiliatePayouts(true);
    expect(mocks.db.rpcCalls).toEqual([]);
    expect(mocks.runCycle).not.toHaveBeenCalled();
    expect(mocks.runRepair).not.toHaveBeenCalled();
  });

  it('without a Stripe key, the day is the ledger repair alone, so commissions still clear (02036)', async () => {
    mocks.getStripeClient.mockRejectedValue(Object.assign(new Error('Stripe is not configured'), { name: 'StripeNotConfiguredError' }));
    const { maybeRunAffiliatePayouts } = await loadRunner();
    await maybeRunAffiliatePayouts(true);

    expect(mocks.runCycle).not.toHaveBeenCalled();
    expect(mocks.runRepair).toHaveBeenCalledTimes(1);
    expect(mocks.runRepair.mock.calls[0][0]).toMatchObject({ supabase: mocks.db, trigger: 'auto' });
    expect(mocks.runRepair.mock.calls[0][0]).not.toHaveProperty('stripe');
    expect(mocks.db.rpcCalls[0]).toEqual({ name: 'claim_affiliate_payout_run', args: { p_run_date: TODAY, p_trigger: 'repair' } });
    expect(mocks.db.runs[0]).toMatchObject({ finished_at: expect.any(String), summary: expect.objectContaining({ promoted: 2, calls: 1 }) });
  });

  it('takes a repair-only day over for Stripe transfers once they can run, renames it, and runs them once', async () => {
    // Earlier today: automatic payouts were off, so the day was claimed for the repair alone.
    storedRun({ trigger: 'repair', finished_at: new Date(Date.now() - 2 * MINUTE).toISOString(), summary: { ...cycleSummary({ livemode: null }), calls: 1 } });
    const runner = await loadRunner();
    await runner.maybeRunAffiliatePayouts(true);

    expect(mocks.runCycle).toHaveBeenCalledTimes(1);
    // a fresh run: nobody was checked earlier by a repair that checks no Connect account
    expect(mocks.runCycle.mock.calls[0][0]).toMatchObject({ trigger: 'auto', skipCheckedSince: null });
    expect(mocks.db.runs[0]).toMatchObject({ trigger: 'auto', finished_at: expect.any(String), summary: expect.objectContaining({ calls: 1 }) });

    // A later check finds an ordinary day: done, no second Stripe run.
    vi.resetModules();
    const later = await loadRunner();
    vi.setSystemTime(new Date(Date.now() + 2 * 60 * MINUTE));
    await later.maybeRunAffiliatePayouts(true);
    expect(mocks.runCycle).toHaveBeenCalledTimes(1);
  });

  it('renames an abandoned repair-only day it takes over, so later checks do not take it again', async () => {
    storedRun({ trigger: 'repair', finished_at: null, started_at: new Date(Date.now() - 45 * MINUTE).toISOString(), summary: {} });
    const runner = await loadRunner();
    await runner.maybeRunAffiliatePayouts(true);
    expect(mocks.runCycle).toHaveBeenCalledTimes(1);
    expect(mocks.db.runs[0]).toMatchObject({ trigger: 'auto' });
  });

  it('skips the package check when the caller already knows it is active', async () => {
    const { maybeRunAffiliatePayouts } = await loadRunner();
    await maybeRunAffiliatePayouts(true);
    expect(mocks.verifyPackageOnline).not.toHaveBeenCalled();
    expect(mocks.runCycle).toHaveBeenCalledTimes(1);
  });

  it('runs nothing when the program settings cannot be read (never the defaults: payouts on, minimum 100)', async () => {
    // readAffiliatesSettingsStrict answers null for a read error, a throwing client or a corrupt row.
    mocks.readSettings.mockResolvedValue(null);
    const { maybeRunAffiliatePayouts } = await loadRunner();
    await maybeRunAffiliatePayouts(true);
    expect(mocks.db.rpcCalls).toEqual([]);
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.runCycle).not.toHaveBeenCalled();

    // The next check (5 minutes later) reads them again and runs.
    mocks.readSettings.mockResolvedValue({ notificationEmails: [], minPayoutCents: 5000, autoPayoutsEnabled: true });
    vi.setSystemTime(new Date(Date.now() + 6 * MINUTE));
    await maybeRunAffiliatePayouts(true);
    expect(mocks.runCycle).toHaveBeenCalledTimes(1);
    expect(mocks.runCycle.mock.calls[0][0]).toMatchObject({ minPayoutCents: 5000 });
  });
});

describe('maybeRunAffiliatePayouts: the day claim and continuation', () => {
  it('claims the UTC day, runs one auto cycle and records the summary; the day is then done for the instance', async () => {
    const { maybeRunAffiliatePayouts } = await loadRunner();
    await maybeRunAffiliatePayouts();

    expect(mocks.db.rpcCalls[0]).toEqual({ name: 'claim_affiliate_payout_run', args: { p_run_date: TODAY, p_trigger: 'auto' } });
    expect(mocks.runCycle).toHaveBeenCalledTimes(1);
    expect(mocks.runCycle.mock.calls[0][0]).toMatchObject({
      supabase: mocks.db,
      stripe: STRIPE,
      trigger: 'auto',
      minPayoutCents: 500,
      skipCheckedSince: null,
      insufficientBalanceAlerted: false,
    });
    expect(mocks.db.runs[0]).toMatchObject({ run_date: TODAY, finished_at: expect.any(String), summary: expect.objectContaining({ calls: 1 }) });

    // 02037: the day's run ends with the PayPal step, sending only while automatic payouts are on.
    expect(mocks.paypalStep).toHaveBeenCalledTimes(1);
    expect(mocks.paypalStep.mock.calls[0]?.[0]).toMatchObject({ trigger: 'auto', send: true });

    // Later the same day, on the same instance: nothing at all (not even a database call).
    vi.setSystemTime(new Date('2026-10-27T15:00:00.000Z'));
    const calls = mocks.db.rpcCalls.length;
    await maybeRunAffiliatePayouts();
    expect(mocks.db.rpcCalls).toHaveLength(calls);
    expect(mocks.runCycle).toHaveBeenCalledTimes(1);
    expect(mocks.paypalStep).toHaveBeenCalledTimes(1);
  });

  it('continues a same-day run with partners left once its last call finished 15+ minutes ago', async () => {
    storedRun({ finished_at: new Date(Date.now() - 20 * MINUTE).toISOString() });
    const { maybeRunAffiliatePayouts } = await loadRunner();
    await maybeRunAffiliatePayouts();

    expect(mocks.runCycle).toHaveBeenCalledTimes(1);
    expect(mocks.runCycle.mock.calls[0][0]).toMatchObject({ skipCheckedSince: '2026-10-27T06:00:00.000Z' });
    expect(mocks.db.runs[0]['summary']).toMatchObject({ calls: 2, firstStartedAt: '2026-10-27T06:00:00.000Z', totals: { sent: 25 } });
  });

  it('waits while the last call finished less than 15 minutes ago, and stops once nothing is left', async () => {
    storedRun({ finished_at: new Date(Date.now() - 5 * MINUTE).toISOString() });
    let runner = await loadRunner();
    await runner.maybeRunAffiliatePayouts();
    expect(mocks.runCycle).not.toHaveBeenCalled();

    vi.resetModules();
    mocks.db = new FakeRunnerDb();
    storedRun({ finished_at: new Date(Date.now() - 60 * MINUTE).toISOString(), summary: { ...cycleSummary({ remaining: 0 }), calls: 1 } });
    runner = await loadRunner();
    await runner.maybeRunAffiliatePayouts();
    expect(mocks.runCycle).not.toHaveBeenCalled();
  });

  it('leaves a run in progress alone and takes over one abandoned for 30+ minutes', async () => {
    storedRun({ finished_at: null, started_at: new Date(Date.now() - 5 * MINUTE).toISOString(), summary: {} });
    let runner = await loadRunner();
    await runner.maybeRunAffiliatePayouts();
    expect(mocks.runCycle).not.toHaveBeenCalled();

    vi.resetModules();
    mocks.db = new FakeRunnerDb();
    const abandonedAt = new Date(Date.now() - 45 * MINUTE).toISOString();
    storedRun({ finished_at: null, started_at: abandonedAt, summary: {} });
    runner = await loadRunner();
    await runner.maybeRunAffiliatePayouts();
    expect(mocks.runCycle).toHaveBeenCalledTimes(1);
    expect(mocks.runCycle.mock.calls[0][0]).toMatchObject({ skipCheckedSince: abandonedAt });
  });

  it('lets one call per instance run at a time', async () => {
    let release: () => void = () => undefined;
    mocks.runCycle.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(cycleSummary());
        })
    );
    const { maybeRunAffiliatePayouts } = await loadRunner();
    const first = maybeRunAffiliatePayouts(true);
    const second = maybeRunAffiliatePayouts(true);
    await vi.waitFor(() => expect(mocks.runCycle).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(mocks.runCycle).toHaveBeenCalledTimes(1);
  });

  it('never throws', async () => {
    mocks.db.rpcThrows = true;
    const { maybeRunAffiliatePayouts } = await loadRunner();
    await expect(maybeRunAffiliatePayouts(true)).resolves.toBeUndefined();
    mocks.readSettings.mockRejectedValue(new Error('boom'));
    vi.setSystemTime(new Date(Date.now() + 10 * MINUTE));
    await expect(maybeRunAffiliatePayouts(true)).resolves.toBeUndefined();
  });
});

describe('runAffiliatePayoutCycleNow', () => {
  it('re-checks the ADMIN for the admin trigger and runs even with automatic payouts off', async () => {
    mocks.readSettings.mockResolvedValue({ notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: false });
    const { runAffiliatePayoutCycleNow } = await loadRunner();
    const summary = await runAffiliatePayoutCycleNow('admin');
    expect(mocks.requireCmsAdmin).toHaveBeenCalledTimes(1);
    expect(summary.skipped).toBeNull();
    expect(mocks.runCycle.mock.calls[0][0]).toMatchObject({ trigger: 'admin' });

    mocks.requireCmsAdmin.mockRejectedValue(new Error('Forbidden'));
    await expect(runAffiliatePayoutCycleNow('admin')).rejects.toThrow('Forbidden');
    expect(mocks.runCycle).toHaveBeenCalledTimes(1);
  });

  it('cron: with automatic payouts off, sends no transfer but still clears commissions (02036); the sandbox and a missing key', async () => {
    const { runAffiliatePayoutCycleNow } = await loadRunner();
    mocks.readSettings.mockResolvedValue({ notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: false });
    await expect(runAffiliatePayoutCycleNow('cron')).resolves.toMatchObject({ skipped: 'disabled', stripeTransfers: 'skipped', promoted: 2 });
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.runCycle).not.toHaveBeenCalled();
    expect(mocks.runRepair).toHaveBeenCalledTimes(1);
    expect(mocks.runRepair.mock.calls[0][0]).toMatchObject({ trigger: 'cron' });
    // a repair-only day, which the after() fallback takes over if transfers are switched on later today
    expect(mocks.db.runs).toEqual([expect.objectContaining({ run_date: TODAY, trigger: 'repair' })]);

    mocks.db = new FakeRunnerDb();
    mocks.readSettings.mockResolvedValue({ notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: true });
    mocks.getStripeClient.mockRejectedValue(Object.assign(new Error('nope'), { name: 'StripeNotConfiguredError' }));
    // No transfer without a key, but the ledger repair still runs (02036) and the day is recorded.
    await expect(runAffiliatePayoutCycleNow('cron')).resolves.toMatchObject({
      skipped: 'stripe_not_configured',
      stripeTransfers: 'skipped',
      promoted: 2,
    });
    expect(mocks.runRepair).toHaveBeenCalledTimes(2);
    expect(mocks.db.runs).toEqual([expect.objectContaining({ run_date: TODAY, trigger: 'repair' })]);

    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    await expect(runAffiliatePayoutCycleNow('cron')).resolves.toMatchObject({ skipped: 'sandbox' });
    expect(mocks.runCycle).not.toHaveBeenCalled();
    expect(mocks.runRepair).toHaveBeenCalledTimes(2);
    expect(mocks.requireCmsAdmin).not.toHaveBeenCalled();
  });

  it('ends with the PayPal step (02037): "Run payouts now" always sends, the scheduler only while automatic payouts are on', async () => {
    const paypalSummary = { environment: 'live', submitted: 2, completed: 1 };
    mocks.paypalStep.mockResolvedValue(paypalSummary);
    const { runAffiliatePayoutCycleNow } = await loadRunner();

    mocks.readSettings.mockResolvedValue({ notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: false });
    await expect(runAffiliatePayoutCycleNow('admin')).resolves.toMatchObject({ paypal: paypalSummary });
    expect(mocks.paypalStep.mock.calls[0]?.[0]).toMatchObject({ trigger: 'admin', send: true });

    await expect(runAffiliatePayoutCycleNow('cron')).resolves.toMatchObject({ skipped: 'disabled', paypal: paypalSummary });
    // The scheduler still checks PayPal (the books follow PayPal's answer), but sends nothing new.
    expect(mocks.paypalStep.mock.calls[1]?.[0]).toMatchObject({ trigger: 'cron', send: false });

    mocks.readSettings.mockResolvedValue({ notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: true });
    await runAffiliatePayoutCycleNow('cron');
    expect(mocks.paypalStep.mock.calls[2]?.[0]).toMatchObject({ trigger: 'cron', send: true });
    const budget = mocks.paypalStep.mock.calls[2]?.[0].timeBudgetMs;
    expect(budget).toBeGreaterThanOrEqual(5_000);
    expect(budget).toBeLessThanOrEqual(30_000);

    // Skipped runs (sandbox, package, settings) never reach PayPal.
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    await expect(runAffiliatePayoutCycleNow('cron')).resolves.toMatchObject({ skipped: 'sandbox', paypal: null });
    expect(mocks.paypalStep).toHaveBeenCalledTimes(3);
  });

  it('runs the PayPal step even when no gateway is paid through Stripe (02037)', async () => {
    mocks.readSettings.mockResolvedValue({
      notificationEmails: [],
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
      payoutMethods: { stripeSales: 'paypal', freemiusSales: 'paypal' },
    });
    const { runAffiliatePayoutCycleNow } = await loadRunner();
    await expect(runAffiliatePayoutCycleNow('admin')).resolves.toMatchObject({ stripeTransfers: 'not_needed' });
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.runCycle).not.toHaveBeenCalled();
    expect(mocks.paypalStep).toHaveBeenCalledTimes(1);
    expect(mocks.paypalStep.mock.calls[0]?.[0].settings).toMatchObject({ payoutMethods: { stripeSales: 'paypal', freemiusSales: 'paypal' } });
  });

  it('an explicit Stripe run on a repair-only day marks the day as its own (the fallback then sends no second run)', async () => {
    storedRun({ trigger: 'repair', summary: { ...cycleSummary({ livemode: null }), calls: 1 } });
    const { runAffiliatePayoutCycleNow } = await loadRunner();
    await expect(runAffiliatePayoutCycleNow('admin')).resolves.toMatchObject({ stripeTransfers: 'ran' });
    expect(mocks.runCycle).toHaveBeenCalledTimes(1);
    expect(mocks.db.runs[0]).toMatchObject({ trigger: 'admin' });
  });

  it('pays only the gateways routed to Stripe, and never asks Stripe when every gateway is paid by hand (02036)', async () => {
    const { runAffiliatePayoutCycleNow } = await loadRunner();

    // Freemius sales paid by hand: the cycle claims Stripe's gateway only.
    mocks.readSettings.mockResolvedValue({
      notificationEmails: [],
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
      payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' },
    });
    await expect(runAffiliatePayoutCycleNow('admin')).resolves.toMatchObject({ skipped: null, stripeTransfers: 'ran' });
    expect(mocks.runCycle.mock.calls[0][0]).toMatchObject({ gateways: ['STRIPE'], stripe: STRIPE });

    // Every gateway paid by hand: the ledger repair alone, nothing skipped, no Stripe client built.
    mocks.getStripeClient.mockClear();
    mocks.readSettings.mockResolvedValue({
      notificationEmails: [],
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
      payoutMethods: { stripeSales: 'manual', freemiusSales: 'manual' },
    });
    await expect(runAffiliatePayoutCycleNow('admin')).resolves.toMatchObject({ skipped: null, stripeTransfers: 'not_needed', promoted: 2 });
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.runCycle).toHaveBeenCalledTimes(1);
    expect(mocks.runRepair).toHaveBeenCalledTimes(1);
    expect(mocks.runRepair.mock.calls[0][0]).toMatchObject({ trigger: 'admin' });

    // Settings without payoutMethods (older rows) pay every gateway through Stripe, as before.
    mocks.readSettings.mockResolvedValue({ notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: true });
    await runAffiliatePayoutCycleNow('cron');
    expect(mocks.runCycle.mock.calls[1][0]).toMatchObject({ gateways: ['STRIPE', 'FREEMIUS'] });
  });

  it('runs the repair but records no day while Stripe is needed and unreachable (the fallback still tries later)', async () => {
    mocks.getStripeClient.mockRejectedValue(new Error('ECONNRESET'));
    const { runAffiliatePayoutCycleNow } = await loadRunner();

    await expect(runAffiliatePayoutCycleNow('admin')).resolves.toMatchObject({ skipped: 'unavailable', stripeTransfers: 'skipped' });
    expect(mocks.runRepair).toHaveBeenCalledTimes(1);
    expect(mocks.runCycle).not.toHaveBeenCalled();
    expect(mocks.db.runs).toEqual([]);
    expect(mocks.db.rpcCalls).toEqual([]);
  });

  it('the after() fallback routes the same way: Stripe gateways to the cycle, a store paying everyone by hand to the repair', async () => {
    mocks.readSettings.mockResolvedValue({
      notificationEmails: [],
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
      payoutMethods: { stripeSales: 'manual', freemiusSales: 'manual' },
    });
    let runner = await loadRunner();
    await runner.maybeRunAffiliatePayouts(true);
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.runRepair).toHaveBeenCalledTimes(1);
    expect(mocks.runCycle).not.toHaveBeenCalled();

    vi.resetModules();
    mocks.db = new FakeRunnerDb();
    mocks.readSettings.mockResolvedValue({
      notificationEmails: [],
      minPayoutCents: 500,
      autoPayoutsEnabled: true,
      payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' },
    });
    runner = await loadRunner();
    await runner.maybeRunAffiliatePayouts(true);
    expect(mocks.runCycle).toHaveBeenCalledTimes(1);
    expect(mocks.runCycle.mock.calls[0][0]).toMatchObject({ trigger: 'auto', gateways: ['STRIPE'] });
  });

  it.each([
    ['reads inactive', () => mocks.verifyPackageOnline.mockResolvedValue(false)],
    ['cannot be checked', () => mocks.verifyPackageOnline.mockRejectedValue(new Error('license service unreachable'))],
  ])('skips both triggers while the Affiliates package %s', async (_label, arrange) => {
    arrange();
    const { runAffiliatePayoutCycleNow } = await loadRunner();

    await expect(runAffiliatePayoutCycleNow('admin')).resolves.toMatchObject({ skipped: 'package_inactive', sent: 0 });
    await expect(runAffiliatePayoutCycleNow('cron')).resolves.toMatchObject({ skipped: 'package_inactive' });

    expect(mocks.verifyPackageOnline).toHaveBeenCalledWith('affiliates');
    expect(mocks.readSettings).not.toHaveBeenCalled();
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.runCycle).not.toHaveBeenCalled();
    expect(mocks.db.rpcCalls).toEqual([]);
  });

  it('skips both triggers while the program settings cannot be read, instead of paying with the defaults', async () => {
    mocks.readSettings.mockResolvedValue(null);
    const { runAffiliatePayoutCycleNow } = await loadRunner();

    await expect(runAffiliatePayoutCycleNow('cron')).resolves.toMatchObject({ skipped: 'settings_unavailable' });
    await expect(runAffiliatePayoutCycleNow('admin')).resolves.toMatchObject({ skipped: 'settings_unavailable' });

    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.runCycle).not.toHaveBeenCalled();
    expect(mocks.db.rpcCalls).toEqual([]);
  });

  it('records the day without gating on it, and repeats passes while partners are left', async () => {
    storedRun({ trigger: 'auto', finished_at: new Date().toISOString(), summary: { ...cycleSummary({ remaining: 0 }), calls: 1 } });
    const first = cycleSummary({ trigger: 'cron', startedAt: '2026-10-27T07:00:00.000Z', sent: 25, claimed: 25, remaining: 4 });
    const second = cycleSummary({ trigger: 'cron', startedAt: '2026-10-27T07:00:20.000Z', sent: 4, claimed: 4, remaining: 0 });
    mocks.runCycle.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const { runAffiliatePayoutCycleNow } = await loadRunner();
    const summary = await runAffiliatePayoutCycleNow('cron');

    expect(mocks.db.rpcCalls[0]).toEqual({ name: 'claim_affiliate_payout_run', args: { p_run_date: TODAY, p_trigger: 'cron' } });
    expect(mocks.runCycle).toHaveBeenCalledTimes(2);
    expect(mocks.runCycle.mock.calls[0][0]).toMatchObject({ trigger: 'cron', skipCheckedSince: null });
    expect(mocks.runCycle.mock.calls[1][0]).toMatchObject({ skipCheckedSince: first.startedAt });
    expect(summary).toMatchObject({ skipped: null, sent: 29, claimed: 29, remaining: 0, startedAt: first.startedAt });
    expect(mocks.db.runs[0]['summary']).toMatchObject({ calls: 3, totals: { sent: 29 } });
  });

  it('skips a second explicit run while one is in progress on the instance', async () => {
    let release: () => void = () => undefined;
    mocks.runCycle.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(cycleSummary({ trigger: 'admin' }));
        })
    );
    const { runAffiliatePayoutCycleNow } = await loadRunner();
    const first = runAffiliatePayoutCycleNow('admin');
    await vi.waitFor(() => expect(mocks.runCycle).toHaveBeenCalledTimes(1));
    await expect(runAffiliatePayoutCycleNow('cron')).resolves.toMatchObject({ skipped: 'already_running' });
    release();
    await expect(first).resolves.toMatchObject({ skipped: null });
    await expect(runAffiliatePayoutCycleNow('cron')).resolves.toMatchObject({ skipped: null });
  });

  it('raises at most one insufficient-balance alert per UTC day', async () => {
    mocks.runCycle.mockImplementation(async (deps: any) => {
      const shortfalls = [{ currency: 'USD', availableCents: 1200, requiredCents: 5000 }];
      let alerted = Boolean(deps.insufficientBalanceAlerted);
      if (!alerted) alerted = (await deps.hooks.onInsufficientBalance(shortfalls)) !== false;
      return cycleSummary({ skippedInsufficientBalance: 1, insufficientBalance: shortfalls, insufficientBalanceAlerted: alerted });
    });
    const { runAffiliatePayoutCycleNow } = await loadRunner();

    await runAffiliatePayoutCycleNow('admin');
    await runAffiliatePayoutCycleNow('cron');
    await runAffiliatePayoutCycleNow('admin');

    expect(mocks.db.alerts).toHaveLength(1);
    expect(mocks.db.alerts[0]).toMatchObject({
      alert_type: 'affiliate_payout_failed',
      title: 'Insufficient Stripe balance for affiliate payouts',
      metadata: expect.objectContaining({
        kind: 'insufficient_balance',
        run_date: TODAY,
        action_url: '/cms/affiliates/stripe',
        action_label: 'Open Stripe payouts',
      }),
    });
    expect(mocks.db.alerts[0]['message']).toContain('$50.00 waiting, $12.00 available');
    // The advice: keep money in Stripe (minimum balance or manual payouts); Freemius never funds it.
    expect(mocks.db.alerts[0]['message']).toContain('keep a minimum balance in Stripe or switch your Stripe payouts to manual');
    // Automatic payouts are on (the default fixture): the next automatic run tries again.
    expect(mocks.db.alerts[0]['message']).toMatch(/^Affiliate payouts are waiting for funds/);
    expect(mocks.db.alerts[0]['message']).toContain(
      'Freemius sales never add money to your Stripe balance. The next automatic payout run tries again.'
    );
    expect(mocks.db.alerts[0]['message']).not.toContain('Top up');
    expect(mocks.runCycle.mock.calls[1][0]).toMatchObject({ insufficientBalanceAlerted: true });
    expect(mocks.db.runs[0]['summary']['insufficientBalanceAlertedAt']).toEqual(expect.any(String));

    // A new UTC day alerts again.
    vi.setSystemTime(new Date('2026-10-28T07:00:00.000Z'));
    await runAffiliatePayoutCycleNow('cron');
    expect(mocks.db.alerts).toHaveLength(2);
  });

  it('promises no automatic retry while automatic payouts are off ("Run payouts now" still runs)', async () => {
    mocks.readSettings.mockResolvedValue({ notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: false });
    mocks.runCycle.mockImplementation(async (deps: any) => {
      const shortfalls = [{ currency: 'USD', availableCents: 1200, requiredCents: 5000 }];
      const alerted = (await deps.hooks.onInsufficientBalance(shortfalls)) !== false;
      return cycleSummary({ trigger: 'admin', skippedInsufficientBalance: 1, insufficientBalance: shortfalls, insufficientBalanceAlerted: alerted });
    });
    const { runAffiliatePayoutCycleNow } = await loadRunner();

    await expect(runAffiliatePayoutCycleNow('admin')).resolves.toMatchObject({ skipped: null });

    expect(mocks.db.alerts).toHaveLength(1);
    const message = String(mocks.db.alerts[0]['message']);
    expect(message).toMatch(/^Affiliate payouts are waiting for funds \(\$50\.00 waiting, \$12\.00 available\)/);
    expect(message).toContain('keep a minimum balance in Stripe or switch your Stripe payouts to manual');
    expect(message).toMatch(/Automatic payouts are off: run payouts again once the balance is funded\.$/);
    expect(message).not.toMatch(/retry automatically|tries again|^Automated/);
  });

  it('wires the lifecycle notifications and the commission sweep', async () => {
    mocks.runCycle.mockImplementation(async (deps: any) => {
      const payout = { id: 'p1', affiliate_id: 'a1', amount_cents: 2700, currency: 'USD', stripe_transfer_id: null };
      await deps.hooks.sweepCommissionNotifications();
      await deps.hooks.onPayoutSent({ payout, transferId: 'tr_1', via: 'transfer' });
      await deps.hooks.onPayoutFailed({ payout, reason: 'account_invalid', exhausted: false });
      await deps.hooks.onConnectFirstReady('a2');
      await deps.hooks.onTransferMismatch({
        payout,
        transfer: { id: 'tr_9', amount: 2600, currency: 'usd', destination: 'acct_1', transfer_group: 'affiliate_payout_p1' },
        kind: 'amount',
        activeTransfers: 1,
      });
      return cycleSummary();
    });
    const { runAffiliatePayoutCycleNow } = await loadRunner();
    await runAffiliatePayoutCycleNow('cron');
    for (const task of mocks.scheduled) await task();

    expect(mocks.sweep).toHaveBeenCalledWith(50);
    // Every cycle also mails the refund-after-payout alerts raised since the last one.
    expect(mocks.refundAlertSweep).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith('PAYOUT_SENT', {
      affiliateId: 'a1',
      payout: { payoutId: 'p1', amountCents: 2700, currency: 'USD', transferId: 'tr_1', reason: null },
    });
    expect(mocks.notify).toHaveBeenCalledWith(
      'PAYOUT_FAILED',
      expect.objectContaining({ affiliateId: 'a1', payout: expect.objectContaining({ reason: expect.stringContaining('account_invalid') }) })
    );
    expect(mocks.notify).toHaveBeenCalledWith('PAYOUT_CONFIGURED', { affiliateId: 'a2' });
    expect(mocks.notify).toHaveBeenCalledWith(
      'PAYOUT_FAILED',
      expect.objectContaining({ payout: expect.objectContaining({ transferId: 'tr_9', reason: expect.stringContaining('$26.00 instead of $27.00') }) })
    );
  });
});

describe('retryAffiliatePayoutNow / releaseAffiliatePayoutNow', () => {
  const PAYOUT_ID = '7f8b5c1e-2d3a-4b6c-9d0e-1f2a3b4c5d6e';

  it('refuses a caller who is not an ADMIN before anything else', async () => {
    mocks.requireCmsAdmin.mockRejectedValue(new Error('Unauthorized'));
    const { retryAffiliatePayoutNow, releaseAffiliatePayoutNow } = await loadRunner();
    await expect(retryAffiliatePayoutNow(PAYOUT_ID)).resolves.toEqual({ ok: false, error: 'forbidden', payoutId: null, reason: null });
    await expect(releaseAffiliatePayoutNow(PAYOUT_ID)).resolves.toMatchObject({ ok: false, error: 'forbidden' });
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it('validates the id and refuses in the sandbox', async () => {
    const { retryAffiliatePayoutNow } = await loadRunner();
    await expect(retryAffiliatePayoutNow('1; drop table')).resolves.toMatchObject({ ok: false, error: 'invalid_id' });
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    await expect(retryAffiliatePayoutNow(PAYOUT_ID)).resolves.toMatchObject({ ok: false, error: 'sandbox' });
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it('refuses a Release in the sandbox before Stripe or the lib', async () => {
    mocks.release.mockResolvedValue({ ok: true, outcome: 'released', payoutId: PAYOUT_ID, transferId: null });
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const { releaseAffiliatePayoutNow } = await loadRunner();

    await expect(releaseAffiliatePayoutNow(PAYOUT_ID)).resolves.toEqual({ ok: false, error: 'sandbox', payoutId: PAYOUT_ID, reason: null });

    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(mocks.db.rpcCalls).toEqual([]);
    expect(mocks.scheduled).toEqual([]);
  });

  it('runs a Retry and a Release off the sandbox (only the exact value "true" is the sandbox)', async () => {
    mocks.retry.mockResolvedValue({ ok: true, outcome: 'sent', payoutId: PAYOUT_ID, transferId: 'tr_1' });
    mocks.release.mockResolvedValue({ ok: true, outcome: 'released', payoutId: PAYOUT_ID, transferId: null });
    const { retryAffiliatePayoutNow, releaseAffiliatePayoutNow } = await loadRunner();

    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      await expect(retryAffiliatePayoutNow(PAYOUT_ID), value).resolves.toMatchObject({ ok: true, outcome: 'sent' });
      await expect(releaseAffiliatePayoutNow(PAYOUT_ID), value).resolves.toMatchObject({ ok: true, outcome: 'released' });
    }

    expect(mocks.retry).toHaveBeenCalledTimes(4);
    expect(mocks.release).toHaveBeenCalledTimes(4);
    expect(mocks.release.mock.calls[0][0]).toMatchObject({ supabase: mocks.db, stripe: STRIPE });
    expect(mocks.release.mock.calls[0][1]).toBe(PAYOUT_ID);
  });

  it('delegates to the lib with the service-role and Stripe clients', async () => {
    mocks.retry.mockResolvedValue({ ok: true, outcome: 'sent', payoutId: PAYOUT_ID, transferId: 'tr_1' });
    mocks.release.mockResolvedValue({ ok: true, outcome: 'released', payoutId: PAYOUT_ID, transferId: null });
    const { retryAffiliatePayoutNow, releaseAffiliatePayoutNow } = await loadRunner();

    await expect(retryAffiliatePayoutNow(PAYOUT_ID)).resolves.toMatchObject({ ok: true, outcome: 'sent' });
    expect(mocks.retry.mock.calls[0][0]).toMatchObject({ supabase: mocks.db, stripe: STRIPE });
    expect(mocks.retry.mock.calls[0][1]).toBe(PAYOUT_ID);

    await expect(releaseAffiliatePayoutNow(PAYOUT_ID)).resolves.toMatchObject({ ok: true, outcome: 'released' });
    mocks.release.mockRejectedValue(new Error('db gone'));
    await expect(releaseAffiliatePayoutNow(PAYOUT_ID)).resolves.toEqual({ ok: false, error: 'unknown', payoutId: PAYOUT_ID, reason: null });
  });

  it.each([
    ['reads inactive', () => mocks.verifyPackageOnline.mockResolvedValue(false)],
    ['cannot be checked', () => mocks.verifyPackageOnline.mockRejectedValue(new Error('license service unreachable'))],
  ])('refuses a Retry or a Release while the Affiliates package %s', async (_label, arrange) => {
    arrange();
    const { retryAffiliatePayoutNow, releaseAffiliatePayoutNow } = await loadRunner();

    await expect(retryAffiliatePayoutNow(PAYOUT_ID)).resolves.toEqual({ ok: false, error: 'package_inactive', payoutId: PAYOUT_ID, reason: null });
    await expect(releaseAffiliatePayoutNow(PAYOUT_ID)).resolves.toEqual({ ok: false, error: 'package_inactive', payoutId: PAYOUT_ID, reason: null });

    expect(mocks.requireCmsAdmin).toHaveBeenCalled();
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
});

describe('resolveAffiliateStripeClient', () => {
  // Retry and Release (above) have no sandbox check of their own: this refusal is theirs.
  it('answers sandbox on the sandbox without building a Stripe client', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const { resolveAffiliateStripeClient } = await loadRunner();
    await expect(resolveAffiliateStripeClient()).resolves.toEqual({ ok: false, error: 'sandbox' });
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
  });

  it('builds the Stripe client off the sandbox (only the exact value "true" is the sandbox)', async () => {
    const { resolveAffiliateStripeClient } = await loadRunner();
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      await expect(resolveAffiliateStripeClient(), value).resolves.toEqual({ ok: true, stripe: STRIPE });
    }
    expect(mocks.getStripeClient).toHaveBeenCalledTimes(4);
  });
});

describe('getAffiliatePayoutPlatformInfo', () => {
  function stripeError(type: string, statusCode: number) {
    return Object.assign(new Error('Invalid API Key provided: sk_test_****1234'), { type, statusCode });
  }

  beforeEach(() => {
    STRIPE.balance.retrieve.mockReset();
  });

  it('reports the platform facts, the key mode, the balances and a currency mismatch', async () => {
    mocks.platformInfo.mockResolvedValue({ country: 'US', defaultCurrency: 'CAD', livemode: true });
    STRIPE.balance.retrieve.mockResolvedValue({ livemode: true, available: [{ amount: 12345, currency: 'cad' }] });
    const { getAffiliatePayoutPlatformInfo } = await loadRunner();
    await expect(getAffiliatePayoutPlatformInfo()).resolves.toEqual({
      stripeConfigured: true,
      sandbox: false,
      platformCountry: 'US',
      platformDefaultCurrency: 'CAD',
      storeBaseCurrency: 'USD',
      currencyMismatch: true,
      livemode: true,
      available: [{ currency: 'CAD', amount: 12345 }],
      transferable: [{ currency: 'CAD', amount: 12345 }],
      pending: [],
      error: null,
    });
    expect(mocks.requireCmsAdmin).toHaveBeenCalled();
  });

  it('shows what a transfer can draw (the card source) apart from the total, and the pending side', async () => {
    mocks.platformInfo.mockResolvedValue({ country: 'CA', defaultCurrency: 'USD', livemode: false });
    STRIPE.balance.retrieve.mockResolvedValue({
      livemode: false,
      available: [{ amount: 50_000, currency: 'usd', source_types: { card: 12_000, bank_account: 38_000 } }],
      pending: [
        { amount: 9_000, currency: 'usd', source_types: { card: 7_000, bank_account: 2_000 } },
        { amount: 400, currency: 'eur' },
      ],
    });
    const { getAffiliatePayoutPlatformInfo } = await loadRunner();
    await expect(getAffiliatePayoutPlatformInfo()).resolves.toMatchObject({
      livemode: false,
      platformCountry: 'CA',
      available: [{ currency: 'USD', amount: 50_000 }],
      transferable: [{ currency: 'USD', amount: 12_000 }],
      pending: [
        { currency: 'EUR', amount: 400 },
        { currency: 'USD', amount: 7_000 },
      ],
      currencyMismatch: false,
      error: null,
    });
  });

  it('reports a key Stripe rejects as stripe_authentication, not as configured facts, and asks only once', async () => {
    mocks.platformInfo.mockRejectedValue(stripeError('StripeAuthenticationError', 401));
    const { getAffiliatePayoutPlatformInfo } = await loadRunner();
    const info = await getAffiliatePayoutPlatformInfo();
    expect(info).toMatchObject({ stripeConfigured: true, error: 'stripe_authentication', livemode: null, transferable: null, pending: null });
    expect(STRIPE.balance.retrieve).not.toHaveBeenCalled();
    // Codes only in the logs: never the message (it quotes part of the key).
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk_test');
    expect(JSON.stringify(warn.mock.calls)).toContain('stripe_authentication');
  });

  it('reports a restricted key without a permission, and keeps what it could read', async () => {
    mocks.platformInfo.mockRejectedValue(stripeError('StripePermissionError', 403));
    STRIPE.balance.retrieve.mockResolvedValue({ livemode: true, available: [{ amount: 100, currency: 'usd' }] });
    const { getAffiliatePayoutPlatformInfo } = await loadRunner();
    await expect(getAffiliatePayoutPlatformInfo()).resolves.toMatchObject({
      error: 'stripe_permission',
      livemode: true,
      transferable: [{ currency: 'USD', amount: 100 }],
    });

    mocks.platformInfo.mockResolvedValue({ country: 'US', defaultCurrency: 'USD', livemode: true });
    STRIPE.balance.retrieve.mockRejectedValue(stripeError('StripeConnectionError', 0));
    vi.resetModules();
    const fresh = await loadRunner();
    await expect(fresh.getAffiliatePayoutPlatformInfo()).resolves.toMatchObject({ error: 'stripe_unavailable', platformCountry: 'US', transferable: null });
  });

  it('says nothing about the key when the Stripe client fails for another reason', async () => {
    mocks.getStripeClient.mockRejectedValue(new Error('site_settings unreachable'));
    const { getAffiliatePayoutPlatformInfo } = await loadRunner();
    await expect(getAffiliatePayoutPlatformInfo()).resolves.toMatchObject({ stripeConfigured: null, error: 'stripe_unavailable' });
  });

  it('says so when Stripe is not configured, and never asks Stripe in the sandbox', async () => {
    mocks.getStripeClient.mockRejectedValue(Object.assign(new Error('nope'), { name: 'StripeNotConfiguredError' }));
    const { getAffiliatePayoutPlatformInfo } = await loadRunner();
    await expect(getAffiliatePayoutPlatformInfo()).resolves.toMatchObject({ stripeConfigured: false, available: null, error: null });

    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    mocks.getStripeClient.mockClear();
    await expect(getAffiliatePayoutPlatformInfo()).resolves.toMatchObject({ sandbox: true, stripeConfigured: false });
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
  });

  it('requires an ADMIN', async () => {
    mocks.requireCmsAdmin.mockRejectedValue(new Error('Forbidden'));
    const { getAffiliatePayoutPlatformInfo } = await loadRunner();
    await expect(getAffiliatePayoutPlatformInfo()).rejects.toThrow('Forbidden');
  });
});
