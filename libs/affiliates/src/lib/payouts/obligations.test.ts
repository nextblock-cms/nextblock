import { describe, expect, it } from 'vitest';
import type { AffiliateRepositoryClient } from '../repository/client';
import { AFFILIATE_PAYOUT_MAX_ATTEMPTS } from './payout-config';
import {
  AFFILIATE_PAYOUT_CLOSED_FAILURE_REASONS,
  affiliatePayoutObligationNeededCents,
  loadAffiliatePayoutObligations,
  readAffiliateClaimableCommissionPage,
} from './obligations';

/**
 * What the CMS "Balance vs what you owe" card counts, against an in-memory table fake: owed now is
 * the cycle's claimable query (CLEARED, unattached, undisputed, the key's mode, net of refunds)
 * split by gateway; PROCESSING payouts are in flight; FAILED payouts split into the ones the daily
 * cycle retries by itself and the ones waiting for an admin (closed ones count nowhere); pending
 * commissions count when their hold ends within the window; and the last window's commissions give
 * the month a Stripe minimum balance should cover. Nothing of the other key mode counts.
 */

type Row = Record<string, any>;

const NOW = new Date('2026-11-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY).toISOString();

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private sortColumn: string | null = null;
  private window: { from: number; to: number } | null = null;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string
  ) {}

  select() {
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
  lte(column: string, value: string) {
    this.filters.push((row) => typeof row[column] === 'string' && Date.parse(row[column]) <= Date.parse(value));
    return this;
  }
  gte(column: string, value: string) {
    this.filters.push((row) => typeof row[column] === 'string' && Date.parse(row[column]) >= Date.parse(value));
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
    if (this.db.failing === this.table) {
      return Promise.resolve({ data: null, error: { code: 'XX000', message: 'read failed' } }).then(onfulfilled, onrejected);
    }
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
  tables: Record<string, Row[]> = { affiliate_commissions: [], affiliate_payouts: [], affiliate_profiles: [] };
  reads: string[] = [];
  failing: string | null = null;
  from(table: string) {
    return new FakeQuery(this, table);
  }
}

let sequence = 0;
function commission(overrides: Row = {}): Row {
  sequence += 1;
  return {
    id: `c-${String(sequence).padStart(4, '0')}`,
    affiliate_id: 'a-1',
    gateway: 'STRIPE',
    currency: 'USD',
    commission_amount_cents: 1000,
    refunded_amount_cents: 0,
    status: 'CLEARED',
    livemode: true,
    payout_id: null,
    disputed_at: null,
    clears_at: iso(-1),
    created_at: iso(-40),
    ...overrides,
  };
}

function payout(overrides: Row = {}): Row {
  sequence += 1;
  return {
    id: `p-${String(sequence).padStart(4, '0')}`,
    affiliate_id: 'a-1',
    amount_cents: 2000,
    currency: 'USD',
    status: 'FAILED',
    failure_reason: 'balance_insufficient',
    attempt_count: 1,
    livemode: true,
    method: 'stripe_connect',
    ...overrides,
  };
}

const PAYABLE = { id: 'a-1', status: 'ACTIVE', first_published_at: iso(-90), stripe_connect_account_id: 'acct_1' };

function client(db: FakeDb): AffiliateRepositoryClient {
  return db as unknown as AffiliateRepositoryClient;
}

describe('loadAffiliatePayoutObligations', () => {
  it('counts each bucket per currency in the key mode only', async () => {
    const db = new FakeDb();
    db.tables['affiliate_profiles'] = [PAYABLE, { id: 'a-2', status: 'SUSPENDED', first_published_at: iso(-90), stripe_connect_account_id: 'acct_2' }];
    db.tables['affiliate_commissions'] = [
      // Owed now: net of refunds, split by gateway.
      commission({ commission_amount_cents: 5000, refunded_amount_cents: 1000 }),
      commission({ gateway: 'FREEMIUS', commission_amount_cents: 3000 }),
      // Not owed now: attached to a payout, disputed, fully refunded, another mode.
      commission({ payout_id: 'p-x' }),
      commission({ disputed_at: iso(-2) }),
      commission({ commission_amount_cents: 700, refunded_amount_cents: 700 }),
      commission({ livemode: false, commission_amount_cents: 99_999 }),
      // Clearing soon: within 30 days, not disputed; one past the window, one disputed.
      commission({ status: 'PENDING_CLEARANCE', clears_at: iso(10), commission_amount_cents: 1500, created_at: iso(-20) }),
      commission({ status: 'PENDING_CLEARANCE', clears_at: iso(45), commission_amount_cents: 800, created_at: iso(-5) }),
      commission({ status: 'PENDING_CLEARANCE', clears_at: iso(3), disputed_at: iso(-1), commission_amount_cents: 600, created_at: iso(-27) }),
      // Another currency (the base currency changed once).
      commission({ currency: 'cad', commission_amount_cents: 2500 }),
      // Voided recently: counts nowhere.
      commission({ status: 'VOIDED_REFUND', created_at: iso(-3), commission_amount_cents: 400 }),
    ];
    db.tables['affiliate_payouts'] = [
      payout({ status: 'PROCESSING', failure_reason: null, amount_cents: 1200 }),
      payout({ amount_cents: 2000 }), // transient, payable: retried by the cycle
      payout({ affiliate_id: 'a-2', amount_cents: 900 }), // suspended partner: waits for an admin
      payout({ failure_reason: 'account_closed', amount_cents: 300 }), // definitive: waits for an admin
      payout({ failure_reason: 'stale', attempt_count: AFFILIATE_PAYOUT_MAX_ATTEMPTS, amount_cents: 100 }), // out of attempts
      payout({ failure_reason: 'released', amount_cents: 5000 }), // closed: counts nowhere
      payout({ status: 'COMPLETED', failure_reason: null, amount_cents: 7000 }),
      payout({ livemode: false, status: 'PROCESSING', failure_reason: null, amount_cents: 8000 }),
    ];

    const result = await loadAffiliatePayoutObligations(client(db), { livemode: true, automatedPayoutsRunning: true, now: NOW });

    expect(result).toEqual({
      livemode: true,
      windowDays: 30,
      truncated: false,
      currencies: [
        {
          currency: 'CAD',
          owedNowCents: 2500,
          owedNowStripeCents: 2500,
          owedNowFreemiusCents: 0,
          inFlightCents: 0,
          retryingCents: 0,
          needsAdminCents: 0,
          clearingSoonCents: 0,
          lastWindowCents: 0,
          owedManuallyCents: 0,
        },
        {
          currency: 'USD',
          owedNowCents: 7000,
          owedNowStripeCents: 4000,
          owedNowFreemiusCents: 3000,
          inFlightCents: 1200,
          retryingCents: 2000,
          needsAdminCents: 1300,
          clearingSoonCents: 1500,
          lastWindowCents: 1500 + 800 + 600,
          owedManuallyCents: 0,
        },
      ],
    });
    expect(affiliatePayoutObligationNeededCents(result.currencies[1])).toBe(7000 + 2000 + 1300 + 1500);
  });

  it('leaves the commissions paid by hand out of every Stripe figure and counts them as owed manually (02036)', async () => {
    const db = new FakeDb();
    db.tables['affiliate_profiles'] = [PAYABLE];
    db.tables['affiliate_commissions'] = [
      commission({ commission_amount_cents: 5000 }),
      commission({ gateway: 'FREEMIUS', commission_amount_cents: 3000, refunded_amount_cents: 500 }),
      // Paid by hand from live sales only, whatever the key's mode; never attached, disputed or refunded ones.
      commission({ gateway: 'FREEMIUS', livemode: false, commission_amount_cents: 777 }),
      commission({ gateway: 'FREEMIUS', payout_id: 'p-x', commission_amount_cents: 888 }),
      commission({ gateway: 'FREEMIUS', disputed_at: iso(-2), commission_amount_cents: 999 }),
      // Clearing soon and the last window: Stripe's gateway only.
      commission({ status: 'PENDING_CLEARANCE', clears_at: iso(5), commission_amount_cents: 1500, created_at: iso(-25) }),
      commission({ gateway: 'FREEMIUS', status: 'PENDING_CLEARANCE', clears_at: iso(5), commission_amount_cents: 4200, created_at: iso(-25) }),
    ];
    // A FAILED Stripe payout claimed before the switch still needs the balance.
    db.tables['affiliate_payouts'] = [payout({ amount_cents: 2000 })];

    const result = await loadAffiliatePayoutObligations(client(db), {
      livemode: true,
      automatedPayoutsRunning: true,
      now: NOW,
      gateways: ['STRIPE'],
    });

    expect(result.currencies).toEqual([
      {
        currency: 'USD',
        owedNowCents: 5000,
        owedNowStripeCents: 5000,
        owedNowFreemiusCents: 0,
        inFlightCents: 0,
        retryingCents: 2000,
        needsAdminCents: 0,
        clearingSoonCents: 1500,
        lastWindowCents: 1500,
        owedManuallyCents: 2500,
      },
    ]);
    expect(affiliatePayoutObligationNeededCents(result.currencies[0])).toBe(5000 + 2000 + 1500);

    // A test key: the Stripe figures follow its mode, the manual ones stay live.
    const test = await loadAffiliatePayoutObligations(client(db), { livemode: false, automatedPayoutsRunning: true, now: NOW, gateways: ['STRIPE'] });
    expect(test.currencies).toEqual([expect.objectContaining({ currency: 'USD', owedNowCents: 0, owedManuallyCents: 2500 })]);
  });

  it('counts a prepared manual payout as owed manually, never as a Stripe transfer in flight (02036)', async () => {
    const db = new FakeDb();
    db.tables['affiliate_profiles'] = [PAYABLE];
    db.tables['affiliate_payouts'] = [
      // Prepared, not recorded: its money leaves by PayPal or Interac, not from Stripe (live only, whatever the key).
      payout({ method: 'manual', status: 'PROCESSING', failure_reason: null, amount_cents: 4200 }),
      payout({ method: 'manual', status: 'PROCESSING', failure_reason: null, amount_cents: 9999, livemode: false }),
      // Recorded: nothing owed any more.
      payout({ method: 'manual', status: 'COMPLETED', failure_reason: null, amount_cents: 7777 }),
      // A Stripe transfer in flight still needs the balance.
      payout({ status: 'PROCESSING', failure_reason: null, amount_cents: 1200 }),
    ];

    const result = await loadAffiliatePayoutObligations(client(db), { livemode: true, automatedPayoutsRunning: true, now: NOW, gateways: ['STRIPE'] });

    expect(result.currencies).toEqual([expect.objectContaining({ currency: 'USD', inFlightCents: 1200, owedManuallyCents: 4200, retryingCents: 0 })]);
    expect(affiliatePayoutObligationNeededCents(result.currencies[0])).toBe(0);

    // A test key: the prepared manual payout is still owed (it is live), and in flight shows only Stripe's own.
    const test = await loadAffiliatePayoutObligations(client(db), { livemode: false, automatedPayoutsRunning: true, now: NOW, gateways: ['STRIPE'] });
    expect(test.currencies).toEqual([expect.objectContaining({ currency: 'USD', inFlightCents: 0, owedManuallyCents: 4200 })]);
  });

  it('reads no Stripe-side commission figure when every gateway is paid by hand', async () => {
    const db = new FakeDb();
    db.tables['affiliate_commissions'] = [
      commission({ commission_amount_cents: 1000 }),
      commission({ gateway: 'FREEMIUS', commission_amount_cents: 2000 }),
      commission({ status: 'PENDING_CLEARANCE', clears_at: iso(5), commission_amount_cents: 4000, created_at: iso(-3) }),
    ];

    const result = await loadAffiliatePayoutObligations(client(db), { livemode: true, automatedPayoutsRunning: true, now: NOW, gateways: [] });

    expect(result.currencies).toEqual([
      expect.objectContaining({ currency: 'USD', owedNowCents: 0, clearingSoonCents: 0, lastWindowCents: 0, owedManuallyCents: 3000 }),
    ]);
    expect(affiliatePayoutObligationNeededCents(result.currencies[0])).toBe(0);
  });

  it('counts every transient failure as waiting for an admin while automated payouts do not run', async () => {
    const db = new FakeDb();
    db.tables['affiliate_profiles'] = [PAYABLE];
    db.tables['affiliate_payouts'] = [payout({ amount_cents: 2000 }), payout({ failure_reason: 'stale', amount_cents: 500 })];

    const result = await loadAffiliatePayoutObligations(client(db), { livemode: true, automatedPayoutsRunning: false, now: NOW });

    expect(result.currencies).toEqual([expect.objectContaining({ currency: 'USD', retryingCents: 0, needsAdminCents: 2500 })]);
  });

  it('reads the test-mode ledger with a test key', async () => {
    const db = new FakeDb();
    db.tables['affiliate_commissions'] = [commission({ livemode: false, commission_amount_cents: 1234 }), commission({ commission_amount_cents: 9 })];

    const result = await loadAffiliatePayoutObligations(client(db), { livemode: false, automatedPayoutsRunning: true, now: NOW });

    expect(result.livemode).toBe(false);
    expect(result.currencies).toEqual([expect.objectContaining({ currency: 'USD', owedNowCents: 1234 })]);
  });

  it('pages past the 1000-row cap and reads no profile without a failed payout', async () => {
    const db = new FakeDb();
    db.tables['affiliate_commissions'] = Array.from({ length: 2345 }, () => commission({ commission_amount_cents: 10 }));

    const result = await loadAffiliatePayoutObligations(client(db), { livemode: true, automatedPayoutsRunning: true, now: NOW });

    expect(result.currencies[0]).toMatchObject({ currency: 'USD', owedNowCents: 23_450 });
    expect(result.truncated).toBe(false);
    expect(db.reads).not.toContain('affiliate_profiles');
  });

  it('throws on a failed read instead of reporting a smaller debt', async () => {
    const db = new FakeDb();
    db.failing = 'affiliate_payouts';
    await expect(loadAffiliatePayoutObligations(client(db), { livemode: true, automatedPayoutsRunning: true, now: NOW })).rejects.toThrow(
      'Could not read payouts.'
    );
  });

  it('names the closed failure reasons the payouts screen shows without Retry or Release', () => {
    expect(AFFILIATE_PAYOUT_CLOSED_FAILURE_REASONS).toEqual(['released', 'nothing_to_pay', 'below_minimum']);
  });
});

describe('readAffiliateClaimableCommissionPage', () => {
  it('applies the claim filter and limits to the given partners', async () => {
    const db = new FakeDb();
    db.tables['affiliate_commissions'] = [
      commission({ affiliate_id: 'a-1' }),
      commission({ affiliate_id: 'a-2' }),
      commission({ affiliate_id: 'a-1', status: 'PENDING_CLEARANCE' }),
      commission({ affiliate_id: 'a-1', livemode: false }),
    ];

    const page = await readAffiliateClaimableCommissionPage(client(db), { livemode: true, columns: 'id', affiliateIds: ['a-1'], from: 0, to: 999 });

    expect(page.error).toBeNull();
    expect(page.rows.map((row) => row['affiliate_id'])).toEqual(['a-1']);
  });

  it('pages by id after a given row (keyset), so a row added between two reads shifts nothing (02036)', async () => {
    const db = new FakeDb();
    db.tables['affiliate_commissions'] = ['c-a', 'c-c', 'c-e', 'c-g'].map((id) => commission({ id }));

    const first = await readAffiliateClaimableCommissionPage(client(db), { livemode: true, columns: 'id', from: 0, to: 1, afterId: null });
    expect(first.rows.map((row) => row['id'])).toEqual(['c-a', 'c-c']);
    // A commission clears between the two reads, before the boundary: an OFFSET window would read c-c again.
    db.tables['affiliate_commissions'].push(commission({ id: 'c-b' }));
    const second = await readAffiliateClaimableCommissionPage(client(db), { livemode: true, columns: 'id', from: 0, to: 1, afterId: 'c-c' });
    expect(second.rows.map((row) => row['id'])).toEqual(['c-e', 'c-g']);
    // The OFFSET window, for comparison, repeats the boundary row.
    const offset = await readAffiliateClaimableCommissionPage(client(db), { livemode: true, columns: 'id', from: 2, to: 3 });
    expect(offset.rows.map((row) => row['id'])).toEqual(['c-c', 'c-e']);
  });

  it('limits to the given gateways, and reads nothing for an empty list (02036)', async () => {
    const db = new FakeDb();
    db.tables['affiliate_commissions'] = [commission({ gateway: 'STRIPE' }), commission({ gateway: 'FREEMIUS' })];

    const freemius = await readAffiliateClaimableCommissionPage(client(db), { livemode: true, columns: 'id', gateways: ['FREEMIUS'], from: 0, to: 999 });
    expect(freemius.rows.map((row) => row['gateway'])).toEqual(['FREEMIUS']);

    const every = await readAffiliateClaimableCommissionPage(client(db), { livemode: true, columns: 'id', gateways: null, from: 0, to: 999 });
    expect(every.rows).toHaveLength(2);

    db.reads = [];
    const none = await readAffiliateClaimableCommissionPage(client(db), { livemode: true, columns: 'id', gateways: [], from: 0, to: 999 });
    expect(none).toEqual({ rows: [], error: null });
    expect(db.reads).toEqual([]);
  });
});
