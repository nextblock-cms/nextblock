import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Commissions paid outside Stripe (02036), app side. A manual payout is prepared before any money is
 * sent: the "Pay manually" queue reads what claim_manual_affiliate_payout would reserve (live mode,
 * the manual gateways, CLEARED, unattached, undisputed) keyset by id past the 1000-row cap, counting
 * a commission once; "Prepare payout" and "Prepare PayPal payouts" claim with the gateways from the
 * settings; "Record payout" records the prepared payout with the verified admin as recorder (never a
 * value from the request) and mails the partner; "Cancel" gives a prepared payout up; every write
 * refuses on the sandbox; the PayPal file lists only prepared payouts of active partners whose email
 * it can carry as typed.
 */

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  db: null as any,
  requireCmsAdmin: vi.fn(),
  packageActive: vi.fn(),
  readSettings: vi.fn(),
  schedule: vi.fn(),
  siteSettings: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('../auth/cms-actor', () => ({ requireCmsAdmin: mocks.requireCmsAdmin }));
vi.mock('./package-state', () => ({ isAffiliatesProgramActive: mocks.packageActive }));
vi.mock('./settings', () => ({ readAffiliatesSettingsStrict: mocks.readSettings }));
vi.mock('./notify', () => ({ scheduleAffiliateLifecycleNotification: mocks.schedule }));
vi.mock('../../app/lib/site-settings', () => ({ getSiteSettings: mocks.siteSettings }));
vi.mock('../../app/lib/seo', () => ({ DEFAULT_SITE_TITLE: 'NextBlock' }));
// The lib's real rules (vi.importActual, not import(): Nx would treat the lib as lazy-loaded otherwise).
vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/constants')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/statuses')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/payout-methods')),
}));
vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/repository/client')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/payouts/obligations')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/payouts/rpc')),
}));

import {
  AFFILIATE_MANUAL_PAYOUT_PREPARE_BATCH,
  buildAffiliatePayPalPayoutsFileNow,
  cancelManualAffiliatePayoutNow,
  loadAffiliateManualPayoutQueue,
  loadAffiliatePreparedManualPayouts,
  prepareManualAffiliatePayoutNow,
  prepareManualAffiliatePayPalPayoutsNow,
  recordManualAffiliatePayoutNow,
} from './manual-payouts';

const ADMIN_ID = '0b0b0b0b-1111-4111-8111-0b0b0b0b0b0b';
const JANE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const MAX = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const PAUSED = 'cccccccc-3333-4333-8333-cccccccccccc';
const PAYOUT_ID = 'dddddddd-4444-4444-8444-dddddddddddd';
const PAYOUT_TWO = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

type RpcAnswer = { data: unknown; error: unknown };

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private window: { from: number; to: number } | null = null;
  private sortColumn: string | null = null;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string
  ) {}

  select(columns: string) {
    this.db.selects.push({ table: this.table, columns });
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
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  gt(column: string, value: string) {
    this.filters.push((row) => String(row[column]).localeCompare(value) > 0);
    return this;
  }
  order(column: string) {
    this.sortColumn = column;
    return this;
  }
  range(from: number, to: number) {
    this.window = { from, to };
    return this;
  }
  limit(count: number) {
    this.window = { from: 0, to: count - 1 };
    return this;
  }
  then<T1 = { data: unknown; error: unknown }, T2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    this.db.reads.push(this.table);
    this.db.beforeRead?.(this.table);
    let rows = (this.db.tables[this.table] ?? []).filter((row) => this.filters.every((filter) => filter(row)));
    if (this.sortColumn) {
      const column = this.sortColumn;
      rows = [...rows].sort((a, b) => String(a[column]).localeCompare(String(b[column])));
    }
    if (this.window) rows = rows.slice(this.window.from, this.window.to + 1);
    return Promise.resolve({ data: rows.map((row) => ({ ...row })), error: null }).then(onfulfilled, onrejected);
  }
}

class FakeDb {
  tables: Record<string, Row[]> = { affiliate_commissions: [], affiliate_profiles: [], affiliate_payouts: [] };
  reads: string[] = [];
  selects: Array<{ table: string; columns: string }> = [];
  rpcCalls: Array<{ name: string; args: Row }> = [];
  /** One answer for every call, or one per call (name and arguments in hand). */
  rpcAnswer: RpcAnswer | ((name: string, args: Row) => RpcAnswer) = { data: null, error: null };
  /** Runs before each read resolves (a write landing between two page reads). */
  beforeRead: ((table: string) => void) | null = null;
  from(table: string) {
    return new FakeQuery(this, table);
  }
  async rpc(name: string, args: Row) {
    this.rpcCalls.push({ name, args });
    return typeof this.rpcAnswer === 'function' ? this.rpcAnswer(name, args) : this.rpcAnswer;
  }
}

let sequence = 0;
function commission(overrides: Row = {}): Row {
  sequence += 1;
  return {
    id: `c-${String(sequence).padStart(5, '0')}`,
    affiliate_id: JANE,
    order_id: '99999999-9999-4999-8999-999999999999',
    gateway: 'FREEMIUS',
    currency: 'CAD',
    commission_amount_cents: 1000,
    refunded_amount_cents: 0,
    refund_pending_cents: 0,
    void_requested_at: null,
    status: 'CLEARED',
    livemode: true,
    payout_id: null,
    disputed_at: null,
    created_at: `2026-10-${String(1 + (sequence % 28)).padStart(2, '0')}T00:00:00.000Z`,
    ...overrides,
  };
}

function profile(id: string, overrides: Row = {}): Row {
  return {
    id,
    handle: id === JANE ? 'jane' : id === MAX ? 'max' : 'paused-pat',
    display_name: id === JANE ? 'Jane Partner' : id === MAX ? 'Max' : 'Pat',
    payout_email: id === JANE ? 'jane@paypal.example' : null,
    status: id === PAUSED ? 'SUSPENDED' : 'ACTIVE',
    first_published_at: '2026-09-01T00:00:00.000Z',
    preferred_locale: id === MAX ? 'fr' : 'en',
    ...overrides,
  };
}

function preparedPayout(id: string, affiliateId: string, overrides: Row = {}): Row {
  return {
    id,
    affiliate_id: affiliateId,
    amount_cents: 3000,
    currency: 'CAD',
    method: 'manual',
    status: 'PROCESSING',
    created_at: '2026-11-10T12:00:00.000Z',
    ...overrides,
  };
}

const MANUAL_FREEMIUS = {
  notificationEmails: [],
  minPayoutCents: 2500,
  autoPayoutsEnabled: true,
  termsUrlEn: '',
  termsUrlFr: '',
  payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' },
};

const RECORD = {
  payoutIdToRecord: PAYOUT_ID,
  channel: 'paypal' as const,
  reference: ' 5TY12345AB678901C ',
  note: ' Thanks! ',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.db = new FakeDb();
  mocks.requireCmsAdmin.mockResolvedValue({ supabase: mocks.db, userId: ADMIN_ID });
  mocks.packageActive.mockResolvedValue(true);
  mocks.readSettings.mockResolvedValue(MANUAL_FREEMIUS);
  mocks.siteSettings.mockResolvedValue({ siteTitle: 'Maple Shop' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadAffiliateManualPayoutQueue (owed, not prepared yet)', () => {
  it('sums what claim_manual_affiliate_payout would reserve, per partner and currency, with the dialog details', async () => {
    const db = new FakeDb();
    db.tables['affiliate_profiles'] = [profile(JANE), profile(MAX), profile(PAUSED)];
    db.tables['affiliate_commissions'] = [
      commission({ commission_amount_cents: 2000, refunded_amount_cents: 500 }),
      commission({ commission_amount_cents: 1500 }),
      // Not taken: Stripe-routed, test mode, attached (prepared), disputed, not cleared.
      commission({ gateway: 'STRIPE', commission_amount_cents: 99_000 }),
      commission({ livemode: false, commission_amount_cents: 98_000 }),
      commission({ payout_id: PAYOUT_ID, commission_amount_cents: 97_000 }),
      commission({ disputed_at: '2026-10-20T00:00:00.000Z', commission_amount_cents: 96_000 }),
      commission({ status: 'PENDING_CLEARANCE', commission_amount_cents: 95_000 }),
      commission({ affiliate_id: MAX, commission_amount_cents: 900 }),
      commission({ affiliate_id: MAX, currency: 'USD', commission_amount_cents: 4000 }),
      commission({ affiliate_id: PAUSED, commission_amount_cents: 50_000 }),
    ];

    const queue = await loadAffiliateManualPayoutQueue(db as never, { gateways: ['FREEMIUS'], minPayoutCents: 2500 });

    expect(queue.gateways).toEqual(['FREEMIUS']);
    expect(queue.total).toBe(4);
    // Payable first, then reaching the minimum, then the largest amount.
    expect(
      queue.rows.map((row) => [row.handle, row.currency, row.amountCents, row.commissionCount, row.reachesMinimum, row.payable, row.paypalReady])
    ).toEqual([
      ['max', 'USD', 4000, 1, true, true, false],
      ['jane', 'CAD', 3000, 2, true, true, true],
      ['max', 'CAD', 900, 1, false, true, false],
      ['paused-pat', 'CAD', 50_000, 1, true, false, false],
    ]);
    const jane = queue.rows[1];
    expect(jane).toMatchObject({ displayName: 'Jane Partner', payoutEmail: 'jane@paypal.example', partnerStatus: 'ACTIVE', preferredLocale: 'en' });
    expect(jane?.commissions.map((entry) => entry.amountCents).sort()).toEqual([1500, 1500]);
    expect(jane?.commissions.every((entry) => entry.flag === null)).toBe(true);
    expect(queue.rows[0]?.payoutEmail).toBeNull();
    // "Prepare PayPal payouts" would take Jane only: Max has no payout email, Pat is paused.
    expect(queue.totals).toEqual([
      { currency: 'CAD', amountCents: 53_900, partners: 3, paypalAmountCents: 3000, paypalPartners: 1 },
      { currency: 'USD', amountCents: 4000, partners: 1, paypalAmountCents: 0, paypalPartners: 0 },
    ]);
    // The claim's own read, live mode and the manual gateways only, then the partners' profiles.
    expect(db.selects[0]).toEqual({
      table: 'affiliate_commissions',
      columns: 'id, affiliate_id, order_id, gateway, currency, commission_amount_cents, refunded_amount_cents, created_at',
    });
    expect(db.selects.at(-1)?.columns).toContain('payout_email');
  });

  it('keeps a partner whose email PayPal cannot take as is out of the PayPal preparation', async () => {
    const db = new FakeDb();
    db.tables['affiliate_profiles'] = [profile(JANE, { payout_email: '+jane@paypal.example' })];
    db.tables['affiliate_commissions'] = [commission({ commission_amount_cents: 5000 })];
    const queue = await loadAffiliateManualPayoutQueue(db as never, { gateways: ['FREEMIUS'], minPayoutCents: 2500 });
    expect(queue.rows[0]).toMatchObject({ payoutEmail: '+jane@paypal.example', reachesMinimum: true, paypalReady: false });
    expect(queue.totals[0]).toMatchObject({ paypalPartners: 0, paypalAmountCents: 0 });
  });

  it('pages by id past the 1000-row cap, slices a page of rows, and reads nothing without a manual gateway', async () => {
    const db = new FakeDb();
    db.tables['affiliate_profiles'] = [profile(JANE)];
    db.tables['affiliate_commissions'] = Array.from({ length: 2345 }, () => commission({ commission_amount_cents: 10 }));

    const queue = await loadAffiliateManualPayoutQueue(db as never, { gateways: ['FREEMIUS'], minPayoutCents: 100, page: 1, pageSize: 25 });
    expect(queue.rows[0]).toMatchObject({ amountCents: 23_450, commissionCount: 2345 });
    expect(queue.rows[0]?.commissions).toHaveLength(25);
    expect(queue.truncated).toBe(false);
    expect(db.reads.filter((table) => table === 'affiliate_commissions')).toHaveLength(3);

    const nothing = new FakeDb();
    expect(await loadAffiliateManualPayoutQueue(nothing as never, { gateways: [], minPayoutCents: 100 })).toEqual({
      gateways: [],
      rows: [],
      total: 0,
      totals: [],
      truncated: false,
    });
    expect(nothing.reads).toEqual([]);
  });

  it('never counts a commission twice when one clears between two page reads (keyset by id, then a seen set)', async () => {
    const db = new FakeDb();
    db.tables['affiliate_profiles'] = [profile(JANE)];
    db.tables['affiliate_commissions'] = Array.from({ length: 1500 }, (_, index) =>
      commission({ id: `c-${String(index * 2 + 10).padStart(6, '0')}`, commission_amount_cents: 10 })
    );
    // After the first page, a commission clears with an id before the page boundary: an OFFSET read
    // would return the first page's last row again.
    let reads = 0;
    db.beforeRead = (table) => {
      if (table !== 'affiliate_commissions') return;
      reads += 1;
      if (reads === 2) db.tables['affiliate_commissions'].push(commission({ id: 'c-000001', commission_amount_cents: 7 }));
    };

    const queue = await loadAffiliateManualPayoutQueue(db as never, { gateways: ['FREEMIUS'], minPayoutCents: 100 });

    expect(queue.rows[0]).toMatchObject({ amountCents: 15_000, commissionCount: 1500 });
  });
});

describe('commissions paid with PayPal (02037): the partners PayPal cannot pay are paid by hand', () => {
  const PAYPAL_FREEMIUS = { ...MANUAL_FREEMIUS, payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'paypal' } };

  it('lists only the partners automatic PayPal Payouts cannot pay, with why and the gateways a payout reserves', async () => {
    const db = new FakeDb();
    db.tables['affiliate_profiles'] = [
      // A PayPal account PayPal takes as is: the daily run pays her, so she is not listed.
      profile(JANE),
      profile(MAX, { payout_email: 'max@interac.example', payout_email_kind: 'interac' }),
      profile(PAUSED, { status: 'ACTIVE', payout_email: null }),
    ];
    db.tables['affiliate_commissions'] = [
      commission({ commission_amount_cents: 4000 }),
      commission({ affiliate_id: MAX, commission_amount_cents: 3000 }),
      commission({ affiliate_id: PAUSED, commission_amount_cents: 2000 }),
      // Stripe-routed: never here.
      commission({ affiliate_id: MAX, gateway: 'STRIPE', commission_amount_cents: 99_000 }),
    ];

    const queue = await loadAffiliateManualPayoutQueue(db as never, { gateways: [], paypalGateways: ['FREEMIUS'], minPayoutCents: 2500 });

    expect(queue.gateways).toEqual(['FREEMIUS']);
    expect(queue.rows.map((row) => [row.handle, row.amountCents, row.payPalFallback, row.claimGateways, row.paypalReady])).toEqual([
      ['max', 3000, 'interac', ['FREEMIUS'], false],
      ['paused-pat', 2000, 'no_email', ['FREEMIUS'], false],
    ]);
    // An Interac address is never put in a PayPal file.
    expect(queue.totals).toEqual([{ currency: 'CAD', amountCents: 5000, partners: 2, paypalAmountCents: 0, paypalPartners: 0 }]);
    expect(db.selects.find((select) => select.table === 'affiliate_profiles')?.columns).toContain('payout_email_kind');
  });

  it('lists a partner whose last PayPal payout came back from the address they still have', async () => {
    const db = new FakeDb();
    db.tables['affiliate_profiles'] = [profile(JANE)];
    db.tables['affiliate_commissions'] = [commission({ commission_amount_cents: 4000 })];
    db.tables['affiliate_payouts'] = [
      {
        id: PAYOUT_ID,
        affiliate_id: JANE,
        method: 'paypal',
        status: 'FAILED',
        failure_reason: 'paypal_returned',
        paypal_receiver: 'jane@paypal.example',
        created_at: '2026-11-01T00:00:00.000Z',
      },
    ];
    const queue = await loadAffiliateManualPayoutQueue(db as never, { gateways: [], paypalGateways: ['FREEMIUS'], minPayoutCents: 2500 });
    expect(queue.rows.map((row) => [row.handle, row.payPalFallback, row.paypalReady])).toEqual([['jane', 'returned', false]]);

    // Saved again since that return ("I checked it: try PayPal again"): the daily run pays her with PayPal again.
    db.tables['affiliate_profiles'] = [profile(JANE, { payout_email_saved_at: '2026-11-02T00:00:00.000Z' })];
    db.tables['affiliate_payouts'] = [
      {
        id: PAYOUT_ID,
        affiliate_id: JANE,
        method: 'paypal',
        status: 'FAILED',
        failure_reason: 'paypal_returned',
        paypal_receiver: 'jane@paypal.example',
        created_at: '2026-11-01T00:00:00.000Z',
        updated_at: '2026-11-01T00:00:00.000Z',
      },
    ];
    const resaved = await loadAffiliateManualPayoutQueue(db as never, { gateways: [], paypalGateways: ['FREEMIUS'], minPayoutCents: 2500 });
    expect(resaved.rows).toEqual([]);
    expect(db.selects.find((select) => select.table === 'affiliate_profiles')?.columns).toContain('payout_email_saved_at');
  });

  it('lists the PayPal commissions of a currency PayPal Payouts does not send, for every partner, and prepares them', async () => {
    const db = new FakeDb();
    db.tables['affiliate_profiles'] = [profile(JANE)];
    db.tables['affiliate_commissions'] = [
      commission({ commission_amount_cents: 4000 }),
      commission({ commission_amount_cents: 90000, currency: 'KRW' }),
    ];
    const queue = await loadAffiliateManualPayoutQueue(db as never, { gateways: [], paypalGateways: ['FREEMIUS'], minPayoutCents: 2500 });
    // CAD: PayPal pays Jane automatically; KRW: PayPal cannot send it, so the store pays it by hand.
    expect(queue.rows.map((row) => [row.handle, row.currency, row.amountCents, row.payPalFallback, row.claimGateways])).toEqual([
      ['jane', 'KRW', 90000, 'currency', ['FREEMIUS']],
    ]);

    mocks.readSettings.mockResolvedValue(PAYPAL_FREEMIUS);
    mocks.db.tables['affiliate_profiles'] = [profile(JANE)];
    mocks.db.rpcAnswer = { data: { status: 'prepared', payout_id: PAYOUT_ID, amount_cents: 90000, commission_count: 1 }, error: null };
    await expect(prepareManualAffiliatePayoutNow({ affiliateIdToPay: JANE, currency: 'KRW' })).resolves.toMatchObject({ status: 'prepared' });
    expect(mocks.db.rpcCalls).toEqual([
      { name: 'claim_manual_affiliate_payout', args: { p_affiliate_id: JANE, p_currency: 'KRW', p_min_amount: 0, p_gateways: ['FREEMIUS'] } },
    ]);
  });

  it('keeps commissions paid by hand for every partner, and adds the PayPal ones only for those PayPal cannot pay', async () => {
    const db = new FakeDb();
    db.tables['affiliate_profiles'] = [profile(JANE), profile(MAX, { payout_email: 'max@interac.example', payout_email_kind: 'interac' })];
    db.tables['affiliate_commissions'] = [
      commission({ gateway: 'STRIPE', commission_amount_cents: 3000 }),
      commission({ gateway: 'FREEMIUS', commission_amount_cents: 4000 }),
      commission({ affiliate_id: MAX, gateway: 'STRIPE', commission_amount_cents: 1000 }),
      commission({ affiliate_id: MAX, gateway: 'FREEMIUS', commission_amount_cents: 2000 }),
    ];
    const queue = await loadAffiliateManualPayoutQueue(db as never, { gateways: ['STRIPE'], paypalGateways: ['FREEMIUS'], minPayoutCents: 100 });
    expect(queue.rows.map((row) => [row.handle, row.amountCents, row.payPalFallback, row.claimGateways])).toEqual([
      ['jane', 3000, null, ['STRIPE']],
      ['max', 3000, 'interac', ['STRIPE', 'FREEMIUS']],
    ]);
  });

  it('prepares a payout for such a partner with the PayPal gateways, and none for a partner PayPal pays', async () => {
    mocks.readSettings.mockResolvedValue(PAYPAL_FREEMIUS);
    mocks.db.tables['affiliate_profiles'] = [profile(JANE), profile(MAX, { payout_email: 'max@interac.example', payout_email_kind: 'interac' })];
    mocks.db.rpcAnswer = { data: { status: 'prepared', payout_id: PAYOUT_ID, amount_cents: 3000, commission_count: 1 }, error: null };

    await expect(prepareManualAffiliatePayoutNow({ affiliateIdToPay: MAX, currency: 'CAD' })).resolves.toMatchObject({ status: 'prepared' });
    expect(mocks.db.rpcCalls).toEqual([
      { name: 'claim_manual_affiliate_payout', args: { p_affiliate_id: MAX, p_currency: 'CAD', p_min_amount: 0, p_gateways: ['FREEMIUS'] } },
    ]);
    // Jane's PayPal account: the daily run pays her, and nothing of hers is paid by hand.
    await expect(prepareManualAffiliatePayoutNow({ affiliateIdToPay: JANE, currency: 'CAD' })).resolves.toEqual({ status: 'not_manual' });
    expect(mocks.db.rpcCalls).toHaveLength(1);
  });
});

describe('loadAffiliatePreparedManualPayouts', () => {
  it('lists the prepared payouts with their commissions, what changed since and who the PayPal file pays', async () => {
    const db = new FakeDb();
    db.tables['affiliate_profiles'] = [profile(JANE), profile(MAX, { payout_email: 'max@paypal.example' }), profile(PAUSED, { payout_email: 'pat@paypal.example' })];
    db.tables['affiliate_payouts'] = [
      preparedPayout(PAYOUT_ID, JANE),
      preparedPayout(PAYOUT_TWO, MAX, { amount_cents: 4000 }),
      preparedPayout('ffffffff-6666-4666-8666-ffffffffffff', PAUSED, { amount_cents: 5000 }),
      // Recorded, Stripe or another status: not prepared.
      preparedPayout('11111111-7777-4777-8777-111111111111', JANE, { status: 'COMPLETED' }),
      preparedPayout('22222222-8888-4888-8888-222222222222', JANE, { method: 'stripe_connect' }),
    ];
    db.tables['affiliate_commissions'] = [
      commission({ payout_id: PAYOUT_ID, commission_amount_cents: 2000 }),
      commission({ payout_id: PAYOUT_ID, commission_amount_cents: 1000, void_requested_at: '2026-11-11T00:00:00.000Z' }),
      commission({ affiliate_id: MAX, payout_id: PAYOUT_TWO, commission_amount_cents: 4000, disputed_at: '2026-11-11T00:00:00.000Z' }),
      commission({ affiliate_id: PAUSED, payout_id: 'ffffffff-6666-4666-8666-ffffffffffff', commission_amount_cents: 5000 }),
    ];

    const prepared = await loadAffiliatePreparedManualPayouts(db as never);

    expect(prepared.total).toBe(3);
    const byHandle = Object.fromEntries(prepared.rows.map((row) => [row.handle, row]));
    expect(byHandle['jane']).toMatchObject({
      payoutId: PAYOUT_ID,
      amountCents: 3000,
      commissionCount: 2,
      refundedCount: 1,
      disputedCount: 0,
      paypalReady: true,
      preparedAt: '2026-11-10T12:00:00.000Z',
    });
    // the flagged commission comes first in the dialog list
    expect(byHandle['jane']?.commissions.map((entry) => entry.flag)).toEqual(['refunded', null]);
    expect(byHandle['max']).toMatchObject({ disputedCount: 1, paypalReady: true });
    // paused since it was prepared: not in the PayPal file
    expect(byHandle['paused-pat']).toMatchObject({ partnerStatus: 'SUSPENDED', paypalReady: false });
    expect(prepared.totals).toEqual([{ currency: 'CAD', amountCents: 12_000, payouts: 3, paypalAmountCents: 7000, paypalPayouts: 2 }]);
    expect(db.selects.find((entry) => entry.table === 'affiliate_payouts')?.columns).toBe('id, affiliate_id, amount_cents, currency, created_at');

    const none = new FakeDb();
    expect(await loadAffiliatePreparedManualPayouts(none as never)).toEqual({ rows: [], total: 0, totals: [], truncated: false });
  });
});

describe('prepareManualAffiliatePayoutNow', () => {
  it('claims with no minimum and the manual gateways from the settings, never from the request', async () => {
    mocks.db.rpcAnswer = { data: { status: 'prepared', payout_id: PAYOUT_ID, amount_cents: 3000, commission_count: 2 }, error: null };

    await expect(prepareManualAffiliatePayoutNow({ affiliateIdToPay: JANE, currency: ' cad ' })).resolves.toEqual({
      status: 'prepared',
      payoutId: PAYOUT_ID,
      amountCents: 3000,
      commissionCount: 2,
      currency: 'CAD',
    });
    expect(mocks.db.rpcCalls).toEqual([
      { name: 'claim_manual_affiliate_payout', args: { p_affiliate_id: JANE, p_currency: 'CAD', p_min_amount: 0, p_gateways: ['FREEMIUS'] } },
    ]);
    // a gateway list smuggled into the input changes nothing
    await prepareManualAffiliatePayoutNow({ affiliateIdToPay: JANE, currency: 'CAD', gateways: ['STRIPE'] } as never);
    expect(mocks.db.rpcCalls[1]?.args['p_gateways']).toEqual(['FREEMIUS']);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('passes the refusals through, and refuses before the database: non-admin, package, settings, no manual gateway, bad input', async () => {
    for (const data of [
      { status: 'already_prepared', payout_id: PAYOUT_ID, amount_cents: 1200 },
      { status: 'not_eligible' },
      { status: 'nothing_owed' },
    ]) {
      mocks.db.rpcAnswer = { data, error: null };
      await expect(prepareManualAffiliatePayoutNow({ affiliateIdToPay: JANE, currency: 'CAD' })).resolves.toMatchObject({ status: data.status });
    }
    mocks.db.rpcCalls = [];
    mocks.requireCmsAdmin.mockRejectedValueOnce(new Error('Forbidden'));
    await expect(prepareManualAffiliatePayoutNow({ affiliateIdToPay: JANE, currency: 'CAD' })).resolves.toEqual({ status: 'forbidden' });
    mocks.packageActive.mockResolvedValueOnce(false);
    await expect(prepareManualAffiliatePayoutNow({ affiliateIdToPay: JANE, currency: 'CAD' })).resolves.toEqual({ status: 'package_inactive' });
    mocks.readSettings.mockResolvedValueOnce(null);
    await expect(prepareManualAffiliatePayoutNow({ affiliateIdToPay: JANE, currency: 'CAD' })).resolves.toEqual({ status: 'settings_unavailable' });
    // Settings saved before 02036 carry no payoutMethods: nothing is paid by hand.
    mocks.readSettings.mockResolvedValueOnce({ notificationEmails: [], minPayoutCents: 500, autoPayoutsEnabled: true });
    await expect(prepareManualAffiliatePayoutNow({ affiliateIdToPay: JANE, currency: 'CAD' })).resolves.toEqual({ status: 'not_manual' });
    for (const input of [{ affiliateIdToPay: 'nope', currency: 'CAD' }, { affiliateIdToPay: JANE, currency: 'CA' }]) {
      await expect(prepareManualAffiliatePayoutNow(input)).resolves.toEqual({ status: 'invalid_input' });
    }
    expect(mocks.db.rpcCalls).toEqual([]);

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.db.rpcAnswer = { data: { status: 'amount_changed' }, error: null };
    await expect(prepareManualAffiliatePayoutNow({ affiliateIdToPay: JANE, currency: 'CAD' })).resolves.toEqual({ status: 'unknown' });
    errorLog.mockRestore();
  });

  it('is refused on the public sandbox after the admin check, before the package, the settings or the database', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    await expect(prepareManualAffiliatePayoutNow({ affiliateIdToPay: JANE, currency: 'CAD' })).resolves.toEqual({ status: 'sandbox' });
    expect(mocks.requireCmsAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.packageActive).not.toHaveBeenCalled();
    expect(mocks.readSettings).not.toHaveBeenCalled();
    expect(mocks.db.rpcCalls).toEqual([]);
  });
});

describe('prepareManualAffiliatePayPalPayoutsNow', () => {
  beforeEach(() => {
    mocks.db.tables['affiliate_profiles'] = [
      profile(JANE),
      profile(MAX, { payout_email: 'max@paypal.example' }),
      profile(PAUSED, { payout_email: 'pat@paypal.example' }),
    ];
    mocks.db.tables['affiliate_commissions'] = [
      commission({ commission_amount_cents: 2000 }),
      commission({ commission_amount_cents: 1000 }),
      commission({ affiliate_id: MAX, commission_amount_cents: 2600 }),
      commission({ affiliate_id: PAUSED, commission_amount_cents: 9000 }),
      commission({ affiliate_id: JANE, currency: 'USD', commission_amount_cents: 7000 }),
    ];
  });

  it('prepares a payout for every PayPal-ready partner of the currency, each claimed with the program minimum', async () => {
    mocks.db.rpcAnswer = (_name, args) =>
      args['p_affiliate_id'] === MAX
        ? { data: { status: 'below_minimum', amount_cents: 2000, commission_count: 1 }, error: null }
        : { data: { status: 'prepared', payout_id: PAYOUT_ID, amount_cents: 3000, commission_count: 2 }, error: null };

    await expect(prepareManualAffiliatePayPalPayoutsNow({ currency: 'cad' })).resolves.toEqual({
      status: 'done',
      currency: 'CAD',
      prepared: 1,
      preparedAmountCents: 3000,
      skipped: 1,
      remaining: 0,
    });
    // Jane and Max (a payout email, at the minimum), never the paused partner or the other currency.
    expect(mocks.db.rpcCalls.map((call) => call.args)).toEqual(
      expect.arrayContaining([
        { p_affiliate_id: JANE, p_currency: 'CAD', p_min_amount: 2500, p_gateways: ['FREEMIUS'] },
        { p_affiliate_id: MAX, p_currency: 'CAD', p_min_amount: 2500, p_gateways: ['FREEMIUS'] },
      ])
    );
    expect(mocks.db.rpcCalls).toHaveLength(2);
    expect(AFFILIATE_MANUAL_PAYOUT_PREPARE_BATCH).toBeGreaterThanOrEqual(100);
  });

  it('answers nothing_to_prepare without a PayPal-ready partner, and refuses on the sandbox', async () => {
    await expect(prepareManualAffiliatePayPalPayoutsNow({ currency: 'EUR' })).resolves.toEqual({ status: 'nothing_to_prepare' });
    expect(mocks.db.rpcCalls).toEqual([]);
    await expect(prepareManualAffiliatePayPalPayoutsNow({ currency: 'C4D' })).resolves.toEqual({ status: 'invalid_input' });

    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    await expect(prepareManualAffiliatePayPalPayoutsNow({ currency: 'CAD' })).resolves.toEqual({ status: 'sandbox' });
    expect(mocks.readSettings).toHaveBeenCalledTimes(2);
    expect(mocks.db.rpcCalls).toEqual([]);
  });
});

describe('recordManualAffiliatePayoutNow', () => {
  it('records the prepared payout with the verified admin as recorder, then mails the partner', async () => {
    mocks.db.rpcAnswer = {
      data: { status: 'recorded', payout_id: PAYOUT_ID, affiliate_id: JANE, amount_cents: 3000, currency: 'CAD', commission_count: 2 },
      error: null,
    };

    await expect(recordManualAffiliatePayoutNow(RECORD)).resolves.toEqual({
      status: 'recorded',
      payoutId: PAYOUT_ID,
      affiliateId: JANE,
      amountCents: 3000,
      currency: 'CAD',
      commissionCount: 2,
    });
    expect(mocks.db.rpcCalls).toEqual([
      {
        name: 'record_manual_affiliate_payout',
        args: { p_payout_id: PAYOUT_ID, p_channel: 'paypal', p_reference: '5TY12345AB678901C', p_note: 'Thanks!', p_recorded_by: ADMIN_ID },
      },
    ]);
    expect(mocks.schedule).toHaveBeenCalledWith('PAYOUT_SENT', {
      affiliateId: JANE,
      payout: {
        payoutId: PAYOUT_ID,
        amountCents: 3000,
        currency: 'CAD',
        method: 'manual',
        channel: 'paypal',
        reference: '5TY12345AB678901C',
        note: 'Thanks!',
      },
    });
    // A recorded payout needs no settings: one prepared before its gateway went back to Stripe is still recorded.
    expect(mocks.readSettings).not.toHaveBeenCalled();
  });

  it('a recorder smuggled into the input changes nothing: the session decides', async () => {
    mocks.db.rpcAnswer = { data: { status: 'already_recorded' }, error: null };
    await recordManualAffiliatePayoutNow({ ...RECORD, recordedBy: '99999999-9999-4999-8999-999999999999' } as never);
    expect(mocks.db.rpcCalls[0]?.args['p_recorded_by']).toBe(ADMIN_ID);
  });

  it('passes every refusal through without an email, and maps a broken answer or a failure to unknown', async () => {
    for (const status of ['not_found', 'already_recorded', 'reference_required', 'duplicate_reference', 'invalid_input']) {
      mocks.db.rpcAnswer = { data: { status }, error: null };
      await expect(recordManualAffiliatePayoutNow(RECORD), status).resolves.toEqual({ status });
    }
    // Two admins recording the same reference at once: the unique index answers.
    mocks.db.rpcAnswer = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
    await expect(recordManualAffiliatePayoutNow(RECORD)).resolves.toEqual({ status: 'duplicate_reference' });

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.db.rpcAnswer = { data: { status: 'amount_changed', amount_cents: 2500 }, error: null };
    await expect(recordManualAffiliatePayoutNow(RECORD)).resolves.toEqual({ status: 'unknown' });
    mocks.db.rpcAnswer = { data: null, error: { code: 'XX000', message: 'boom' } };
    await expect(recordManualAffiliatePayoutNow(RECORD)).resolves.toEqual({ status: 'unknown' });
    errorLog.mockRestore();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('refuses before the database: a non-admin, an inactive package, bad input', async () => {
    mocks.requireCmsAdmin.mockRejectedValueOnce(new Error('Forbidden'));
    await expect(recordManualAffiliatePayoutNow(RECORD)).resolves.toEqual({ status: 'forbidden' });
    mocks.packageActive.mockResolvedValueOnce(false);
    await expect(recordManualAffiliatePayoutNow(RECORD)).resolves.toEqual({ status: 'package_inactive' });
    for (const input of [{ ...RECORD, payoutIdToRecord: 'nope' }, { ...RECORD, channel: 'venmo' }]) {
      await expect(recordManualAffiliatePayoutNow(input as never)).resolves.toEqual({ status: 'invalid_input' });
    }
    expect(mocks.db.rpcCalls).toEqual([]);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('is refused on the public sandbox after the admin check, before the package or the database', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    await expect(recordManualAffiliatePayoutNow(RECORD)).resolves.toEqual({ status: 'sandbox' });
    expect(mocks.requireCmsAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.packageActive).not.toHaveBeenCalled();
    expect(mocks.db.rpcCalls).toEqual([]);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});

describe('cancelManualAffiliatePayoutNow', () => {
  it('cancels a prepared payout and passes the refusals through', async () => {
    mocks.db.rpcAnswer = { data: { status: 'cancelled', commission_count: 2 }, error: null };
    await expect(cancelManualAffiliatePayoutNow({ payoutIdToCancel: PAYOUT_ID })).resolves.toEqual({ status: 'cancelled', commissionCount: 2 });
    expect(mocks.db.rpcCalls).toEqual([{ name: 'cancel_manual_affiliate_payout', args: { p_payout_id: PAYOUT_ID } }]);
    for (const status of ['not_found', 'already_recorded']) {
      mocks.db.rpcAnswer = { data: { status }, error: null };
      await expect(cancelManualAffiliatePayoutNow({ payoutIdToCancel: PAYOUT_ID })).resolves.toEqual({ status });
    }
    await expect(cancelManualAffiliatePayoutNow({ payoutIdToCancel: 'nope' })).resolves.toEqual({ status: 'invalid_input' });
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('is refused on the public sandbox and for a non-admin', async () => {
    mocks.requireCmsAdmin.mockRejectedValueOnce(new Error('Unauthorized'));
    await expect(cancelManualAffiliatePayoutNow({ payoutIdToCancel: PAYOUT_ID })).resolves.toEqual({ status: 'forbidden' });
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    await expect(cancelManualAffiliatePayoutNow({ payoutIdToCancel: PAYOUT_ID })).resolves.toEqual({ status: 'sandbox' });
    expect(mocks.db.rpcCalls).toEqual([]);
  });
});

describe('buildAffiliatePayPalPayoutsFileNow', () => {
  beforeEach(() => {
    mocks.db.tables['affiliate_profiles'] = [
      profile(JANE),
      profile(MAX, { payout_email: 'max@paypal.example' }),
      profile(PAUSED, { payout_email: 'pat@paypal.example' }),
    ];
    mocks.db.tables['affiliate_payouts'] = [
      preparedPayout(PAYOUT_ID, JANE),
      preparedPayout(PAYOUT_TWO, MAX, { amount_cents: 2600 }),
      preparedPayout('ffffffff-6666-4666-8666-ffffffffffff', PAUSED, { amount_cents: 9000 }),
      preparedPayout('11111111-7777-4777-8777-111111111111', JANE, { currency: 'USD', amount_cents: 7000 }),
    ];
    mocks.db.tables['affiliate_commissions'] = [
      commission({ payout_id: PAYOUT_ID, commission_amount_cents: 2000 }),
      commission({ payout_id: PAYOUT_ID, commission_amount_cents: 1000 }),
      commission({ affiliate_id: MAX, payout_id: PAYOUT_TWO, commission_amount_cents: 2600 }),
    ];
  });

  it('lists the prepared payouts of active partners with an email, in the asked currency, at the amount prepared', async () => {
    const file = await buildAffiliatePayPalPayoutsFileNow('cad', new Date('2026-11-11T12:00:00.000Z'));
    expect(file).toMatchObject({ ok: true, count: 2, truncated: false, filename: 'paypal-payouts-cad-2026-11-11.csv' });
    const lines = file.ok ? file.csv.split('\r\n').filter(Boolean) : [];
    expect(lines.sort()).toEqual([
      'jane@paypal.example,30.00,CAD,jane,Maple Shop partner commissions (2 orders),PAYPAL',
      'max@paypal.example,26.00,CAD,max,Commissions de partenaire Maple Shop (1 commande),PAYPAL',
    ]);
    // A partner paused since it was prepared, and the other currency, are left out; no storefront link anywhere.
    expect(file.ok ? file.csv : '').not.toContain('pat@paypal.example');
    expect(file.ok ? file.csv : '').not.toContain('/partners/');
    // It only reads: no claim, no record.
    expect(mocks.db.rpcCalls).toEqual([]);
  });

  it('never rewrites a recipient: a payout email a spreadsheet would read as a formula stays out of the file', async () => {
    mocks.db.tables['affiliate_profiles'] = [profile(JANE, { payout_email: '=HYPERLINK("http://evil.example")@x.example' }), profile(MAX, { payout_email: 'max@paypal.example' })];
    const file = await buildAffiliatePayPalPayoutsFileNow('CAD');
    expect(file).toMatchObject({ ok: true, count: 1 });
    expect(file.ok ? file.csv : '').not.toContain('HYPERLINK');
    expect(file.ok ? file.csv : '').toContain('max@paypal.example');
  });

  it('refuses a non-admin, a bad currency, an inactive package and a currency with no prepared PayPal payout', async () => {
    mocks.requireCmsAdmin.mockRejectedValueOnce(new Error('Unauthorized'));
    await expect(buildAffiliatePayPalPayoutsFileNow('CAD')).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(buildAffiliatePayPalPayoutsFileNow('CA$')).resolves.toMatchObject({ ok: false, status: 400 });
    mocks.packageActive.mockResolvedValueOnce(false);
    await expect(buildAffiliatePayPalPayoutsFileNow('CAD')).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(buildAffiliatePayPalPayoutsFileNow('EUR')).resolves.toMatchObject({ ok: false, status: 409 });
  });
});
