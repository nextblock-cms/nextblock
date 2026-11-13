import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The PayPal side of the payout run (02037), with a fake PayPal client (never the network) and an
 * in-memory database. It proves: nothing runs on the public sandbox; the sync completes, fails or
 * keeps each payout by PayPal's item status (exactly the events and alerts it should); new payouts
 * are claimed only for PayPal-ready partners, in the environment's mode, and their sender_batch_id is
 * saved BEFORE the create call; an unknown outcome is sent again with the same id; a reused id is
 * adopted; definitive refusals hand the commissions back; and the CMS Cancel only cancels what PayPal
 * still lists as UNCLAIMED.
 */

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  record: vi.fn(),
  note: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  release: vi.fn(),
  calls: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/affiliates/src/lib/core/constants')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/affiliates/src/lib/core/statuses')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/affiliates/src/lib/core/payout-methods')),
}));
vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../../libs/affiliates/src/lib/repository/rows')),
  readAffiliateClaimableCommissionPage: (
    await vi.importActual<Record<string, unknown>>('../../../../../libs/affiliates/src/lib/payouts/obligations')
  )['readAffiliateClaimableCommissionPage'],
  claimPayPalAffiliatePayoutViaRpc: mocks.claim,
  recordPayPalAffiliatePayoutBatchViaRpc: mocks.record,
  notePayPalAffiliatePayoutItemViaRpc: mocks.note,
  completePayPalAffiliatePayoutViaRpc: mocks.complete,
  failPayPalAffiliatePayoutViaRpc: mocks.fail,
  releasePayPalAffiliatePayoutViaRpc: mocks.release,
}));

import { AffiliatePayPalError, type AffiliatePayPalClient, type AffiliatePayPalItem } from './client';
import {
  AFFILIATE_PAYPAL_ACKNOWLEDGED_RELEASE_AFTER_MS,
  AFFILIATE_PAYPAL_RESEND_MAX_AGE_MS,
  AFFILIATE_PAYPAL_UNCONFIRMED_RELEASE_AFTER_MS,
  affiliatePayPalReleaseKind,
  cancelAffiliatePayPalPayout,
  classifyAffiliatePayPalItemStatus,
  loadAffiliatePayPalBlockedReceivers,
  runAffiliatePayPalPayouts,
  type AffiliatePayPalAlert,
  type AffiliatePayPalPayoutEvent,
  type AffiliatePayPalRunDeps,
} from './engine';

/* --------------------------------------------------------------------- fakes --- */

const PAYOUTS_SCOPE = 'https://uri.paypal.com/payments/payouts';
const NOW = new Date('2026-11-11T12:00:00.000Z');

let tables: Record<string, Row[]>;
let reads: string[];

/** A chainable in-memory table: eq / neq / in / gt / is / not-null filters, order, limit, range. */
function fakeDb() {
  return {
    from(table: string) {
      reads.push(table);
      const filters: Array<(row: Row) => boolean> = [];
      let orderBy: { column: string; ascending: boolean } | null = null;
      let window: [number, number] | null = null;
      const run = () => {
        const out = (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
        if (orderBy) {
          const { column, ascending } = orderBy;
          out.sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0) * (ascending ? 1 : -1));
        }
        return (window ? out.slice(window[0], window[1] + 1) : out).map((row) => ({ ...row }));
      };
      const builder: Record<string, any> = {
        select: () => builder,
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        neq: (column: string, value: unknown) => (filters.push((row) => row[column] !== value), builder),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
        gt: (column: string, value: unknown) => (filters.push((row) => String(row[column]) > String(value)), builder),
        is: (column: string, value: unknown) => (filters.push((row) => (row[column] ?? null) === value), builder),
        not: (column: string) => (filters.push((row) => row[column] != null), builder),
        order: (column: string, options?: { ascending?: boolean }) => ((orderBy = { column, ascending: options?.ascending !== false }), builder),
        limit: (count: number) => ((window = [0, count - 1]), builder),
        range: (from: number, to: number) => ((window = [from, to]), builder),
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve({ data: run(), error: null }).then(resolve, reject),
      };
      return builder;
    },
  };
}

function payout(id: string, extra: Row = {}): Row {
  return {
    id,
    affiliate_id: `aff-${id}`,
    amount_cents: 5000,
    currency: 'USD',
    method: 'paypal',
    status: 'PROCESSING',
    livemode: true,
    paypal_receiver: `${id}@example.com`,
    paypal_sender_batch_id: 'sb-1',
    paypal_batch_id: 'BATCH1',
    paypal_item_id: null,
    paypal_item_status: null,
    attempt_count: 1,
    last_attempt_at: NOW.toISOString(),
    trigger: 'cron',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...extra,
  };
}

function item(id: string, status: string | null, extra: Partial<AffiliatePayPalItem> = {}): AffiliatePayPalItem {
  return {
    itemId: `I-${id}`,
    transactionId: status === 'SUCCESS' ? `TX-${id}` : null,
    status,
    feeCents: 25,
    feeCurrency: 'USD',
    senderItemId: id,
    batchId: 'BATCH1',
    errorName: null,
    ...extra,
  };
}

function fakeClient(overrides: Partial<Record<keyof AffiliatePayPalClient, unknown>> = {}) {
  const client = {
    environment: 'live',
    getToken: vi.fn(async () => ({ accessToken: 't', scopes: [PAYOUTS_SCOPE], appId: 'APP-1', expiresAt: Date.now() + 3_600_000 })),
    createPayoutBatch: vi.fn(async () => {
      mocks.calls.push('create');
      return { batchId: 'NEWBATCH', status: 'PENDING' };
    }),
    getPayoutBatch: vi.fn(),
    getPayoutBatchItems: vi.fn(async () => ({ batchId: 'BATCH1', status: 'SUCCESS', items: [], totalPages: 1 })),
    getPayoutItem: vi.fn(),
    cancelPayoutItem: vi.fn(),
    getBalances: vi.fn(),
    ...overrides,
  };
  return client as unknown as AffiliatePayPalClient & Record<string, ReturnType<typeof vi.fn>>;
}

function deps(client: AffiliatePayPalClient, overrides: Partial<AffiliatePayPalRunDeps> = {}) {
  const events: AffiliatePayPalPayoutEvent[] = [];
  const alerts: AffiliatePayPalAlert[] = [];
  const credentialsFor = vi.fn(async (environment: 'sandbox' | 'live') => ({ environment, clientId: 'ClientId1234567890', secret: 's' }));
  let senderBatches = 0;
  const value: AffiliatePayPalRunDeps = {
    supabase: fakeDb() as never,
    environment: 'live',
    credentialsFor,
    createClient: () => client,
    trigger: 'cron',
    gateways: ['FREEMIUS'],
    minPayoutCents: 2000,
    send: true,
    siteName: 'Acme Shop',
    now: () => NOW,
    newSenderBatchId: () => `new-sb-${(senderBatches += 1)}`,
    hooks: {
      onEvent: (event) => void events.push(event),
      onAlert: (alert) => void alerts.push(alert),
    },
    ...overrides,
  };
  return { value, events, alerts, credentialsFor };
}

/** release_paypal_affiliate_payout's rule (02037), as the database applies it under the payout lock. */
function releaseLikeTheDatabase(_db: unknown, input: { payoutId: string }) {
  const row = (tables['affiliate_payouts'] ?? []).find((candidate) => candidate['id'] === input.payoutId && candidate['method'] === 'paypal');
  if (!row) return { status: 'not_found' };
  if (row['status'] === 'COMPLETED') return { status: 'already_completed' };
  if (row['status'] !== 'PROCESSING') return { status: 'already_failed' };
  if (row['paypal_batch_id'] && ['SUCCESS', 'PENDING', 'ONHOLD', 'UNCLAIMED'].includes(row['paypal_item_status'] ?? '')) {
    return { status: 'held_by_paypal' };
  }
  const age = NOW.getTime() - Date.parse(row['last_attempt_at']);
  if (age < (row['paypal_batch_id'] ? 7 * 24 * 3_600_000 : 3_600_000)) return { status: 'too_recent' };
  row['status'] = 'FAILED';
  row['failure_reason'] = 'paypal_released_by_admin';
  return {
    status: 'released',
    payoutId: row['id'],
    affiliateId: row['affiliate_id'],
    amountCents: row['amount_cents'],
    currency: row['currency'],
    commissionCount: 1,
    acknowledged: Boolean(row['paypal_batch_id']),
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  tables = { affiliate_payouts: [], affiliate_profiles: [], affiliate_commissions: [] };
  reads = [];
  mocks.calls = [];
  for (const mock of [mocks.claim, mocks.record, mocks.note, mocks.complete, mocks.fail, mocks.release]) mock.mockReset();
  mocks.release.mockImplementation(async (db: unknown, input: { payoutId: string }) => releaseLikeTheDatabase(db, input));
  mocks.note.mockResolvedValue({ status: 'noted' });
  mocks.complete.mockImplementation(async (_db: unknown, input: { payoutId: string; transactionId: string }) => ({
    status: 'completed',
    payoutId: input.payoutId,
    transactionId: input.transactionId,
    amountCents: 5000,
  }));
  mocks.fail.mockImplementation(async (_db: unknown, input: { payoutId: string }) => ({ status: 'failed', payoutId: input.payoutId }));
  // record_paypal_affiliate_payout_batch: PROCESSING PayPal payouts only, never another sender id; a call
  // without a batch id stamps the send (last_attempt_at, attempt_count on a re-save)
  mocks.record.mockImplementation(async (_db: unknown, input: { payoutIds: string[]; senderBatchId: string; payoutBatchId?: string | null }) => {
    mocks.calls.push(input.payoutBatchId ? `record:${input.payoutBatchId}` : `record-sender:${input.senderBatchId}`);
    let count = 0;
    for (const row of tables['affiliate_payouts'] ?? []) {
      if (!input.payoutIds.includes(row['id']) || row['status'] !== 'PROCESSING') continue;
      if (row['paypal_sender_batch_id'] && row['paypal_sender_batch_id'] !== input.senderBatchId) continue;
      if (!input.payoutBatchId) {
        if (row['paypal_sender_batch_id'] === input.senderBatchId) row['attempt_count'] = Number(row['attempt_count'] ?? 1) + 1;
        row['last_attempt_at'] = NOW.toISOString();
      }
      row['paypal_sender_batch_id'] = input.senderBatchId;
      if (input.payoutBatchId) row['paypal_batch_id'] = input.payoutBatchId;
      count += 1;
    }
    return { status: 'recorded', count };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* --------------------------------------------------------------------- tests --- */

describe('classifyAffiliatePayPalItemStatus', () => {
  it('reads PayPal item statuses', () => {
    expect(classifyAffiliatePayPalItemStatus('SUCCESS')).toEqual({ kind: 'complete' });
    expect(classifyAffiliatePayPalItemStatus('UNCLAIMED')).toEqual({ kind: 'keep', status: 'UNCLAIMED' });
    expect(classifyAffiliatePayPalItemStatus(null)).toEqual({ kind: 'keep', status: null });
    expect(classifyAffiliatePayPalItemStatus('RETURNED')).toEqual({ kind: 'fail', reason: 'paypal_returned', operatorSide: false });
    expect(classifyAffiliatePayPalItemStatus('FAILED', 'INSUFFICIENT_FUNDS')).toEqual({
      kind: 'fail',
      reason: 'paypal_failed:insufficient_funds',
      operatorSide: true,
    });
    expect(classifyAffiliatePayPalItemStatus('SOMETHING_NEW')).toEqual({ kind: 'unknown', status: 'SOMETHING_NEW' });
  });
});

describe('on the public sandbox', () => {
  it('runs nothing and cancels nothing: no credential, no read, no PayPal call', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    tables['affiliate_payouts'] = [payout('p1')];
    const client = fakeClient();
    const { value, credentialsFor } = deps(client);
    const summary = await runAffiliatePayPalPayouts(value);
    expect(summary.skipped).toBe('sandbox');
    expect(await cancelAffiliatePayPalPayout(value, 'p1')).toEqual({ status: 'sandbox' });
    expect(reads).toEqual([]);
    expect(credentialsFor).not.toHaveBeenCalled();
    expect(client.getToken).not.toHaveBeenCalled();
    expect(client.createPayoutBatch).not.toHaveBeenCalled();
    expect(client.cancelPayoutItem).not.toHaveBeenCalled();
  });
});

describe('the sync', () => {
  it('settles each in-flight payout by its PayPal item status', async () => {
    tables['affiliate_payouts'] = [
      payout('p1'),
      payout('p2'),
      payout('p3'),
      payout('p4'),
      payout('p5', { paypal_item_status: 'UNCLAIMED', paypal_item_id: 'I-p5' }),
      payout('p6'),
    ];
    const client = fakeClient({
      getPayoutBatchItems: vi.fn(async () => ({
        batchId: 'BATCH1',
        status: 'SUCCESS',
        items: [
          item('p1', 'SUCCESS'),
          item('p2', 'RETURNED'),
          item('p3', 'UNCLAIMED'),
          item('p4', 'FAILED', { errorName: 'INSUFFICIENT_FUNDS' }),
          item('p5', 'UNCLAIMED'),
          item('p6', 'MYSTERY'),
        ],
        totalPages: 1,
      })),
    });
    const { value, events, alerts } = deps(client, { send: false });
    const summary = await runAffiliatePayPalPayouts(value);

    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.complete.mock.calls[0]?.[1]).toEqual({ payoutId: 'p1', itemId: 'I-p1', transactionId: 'TX-p1', feeCents: 25, itemStatus: 'SUCCESS' });
    expect(mocks.fail.mock.calls.map((call) => call[1])).toEqual([
      { payoutId: 'p2', reason: 'paypal_returned', itemStatus: 'RETURNED' },
      { payoutId: 'p4', reason: 'paypal_failed:insufficient_funds', itemStatus: 'FAILED' },
    ]);
    expect(mocks.note.mock.calls.map((call) => [call[1].payoutId, call[1].itemStatus])).toEqual([
      ['p3', 'UNCLAIMED'],
      ['p5', 'UNCLAIMED'],
      ['p6', 'MYSTERY'],
    ]);
    // PAYOUT_SENT for the paid one, PAYOUT_FAILED for the returned one, PAYPAL_UNCLAIMED only the
    // first time an item is unclaimed; the empty balance is the operator's: an alert, no partner event.
    expect(events.map((event) => `${event.type}:${event.payout.payoutId}`)).toEqual(['PAYOUT_SENT:p1', 'PAYOUT_FAILED:p2', 'PAYPAL_UNCLAIMED:p3']);
    expect(alerts.map((alert) => alert.kind).sort()).toEqual(['paypal_insufficient_funds', 'paypal_unknown_status']);
    expect(summary).toMatchObject({ synced: 6, completed: 1, failed: 2, inFlight: 3, unclaimed: 2, unknown: 1, claimed: 0, submitted: 0 });
    expect(client.createPayoutBatch).not.toHaveBeenCalled();
  });

  it('asks PayPal with the credentials of each payout’s own environment', async () => {
    tables['affiliate_payouts'] = [payout('live1'), payout('test1', { livemode: false, paypal_batch_id: 'BATCHT' })];
    const client = fakeClient();
    const { value, credentialsFor } = deps(client, { send: false });
    await runAffiliatePayPalPayouts(value);
    expect(credentialsFor.mock.calls.map((call) => call[0]).sort()).toEqual(['live', 'sandbox']);
    expect((client.getPayoutBatchItems as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]).sort()).toEqual(['BATCH1', 'BATCHT']);
  });

  it('fails the payouts of a batch PayPal denied, with an operator alert', async () => {
    tables['affiliate_payouts'] = [payout('p1')];
    const client = fakeClient({ getPayoutBatchItems: vi.fn(async () => ({ batchId: 'BATCH1', status: 'DENIED', items: [], totalPages: 1 })) });
    const { value, alerts } = deps(client, { send: false });
    const summary = await runAffiliatePayPalPayouts(value);
    expect(mocks.fail.mock.calls[0]?.[1]).toEqual({ payoutId: 'p1', reason: 'paypal_denied', itemStatus: 'DENIED' });
    expect(alerts.map((alert) => alert.kind)).toEqual(['paypal_refused']);
    expect(summary.failed).toBe(1);
  });

  it('counts unconfirmed batches without sending them when it only checks', async () => {
    tables['affiliate_payouts'] = [payout('p1', { paypal_batch_id: null })];
    const client = fakeClient();
    const { value } = deps(client, { send: false });
    const summary = await runAffiliatePayPalPayouts(value);
    expect(summary.pendingRetry).toBe(1);
    expect(client.createPayoutBatch).not.toHaveBeenCalled();
  });

  it('fails the items a DENIED batch never processed, even when it lists them, and keeps the ones PayPal holds', async () => {
    tables['affiliate_payouts'] = [payout('p1'), payout('p2'), payout('p3')];
    const client = fakeClient({
      getPayoutBatchItems: vi.fn(async () => ({
        batchId: 'BATCH1',
        status: 'DENIED',
        items: [item('p1', 'PENDING'), item('p2', null), item('p3', 'UNCLAIMED')],
        totalPages: 1,
      })),
    });
    const { value, alerts } = deps(client, { send: false });
    const summary = await runAffiliatePayPalPayouts(value);
    expect(mocks.fail.mock.calls.map((call) => call[1])).toEqual([
      { payoutId: 'p1', reason: 'paypal_denied', itemStatus: 'DENIED' },
      { payoutId: 'p2', reason: 'paypal_denied', itemStatus: 'DENIED' },
    ]);
    // PayPal may hold an unclaimed payment: it is never handed back on the batch's word
    expect(mocks.note.mock.calls.map((call) => [call[1].payoutId, call[1].itemStatus])).toEqual([['p3', 'UNCLAIMED']]);
    expect(alerts.map((alert) => alert.kind)).toEqual(['paypal_refused']);
    expect(summary).toMatchObject({ failed: 2, inFlight: 1 });
  });

  it('alerts when PayPal will not show a batch (another account, a 404), but stays quiet on a timeout', async () => {
    tables['affiliate_payouts'] = [payout('p1')];
    const lost = fakeClient({
      getPayoutBatchItems: vi.fn(async () => {
        throw new AffiliatePayPalError('not_found', { status: 404, code: 'INVALID_RESOURCE_ID' });
      }),
    });
    const first = deps(lost, { send: false });
    const summary = await runAffiliatePayPalPayouts(first.value);
    expect(summary.inFlight).toBe(1);
    expect(first.alerts).toEqual([
      expect.objectContaining({ kind: 'paypal_batch_unresolved', cause: 'unreadable', batchId: 'BATCH1', code: 'INVALID_RESOURCE_ID', payouts: 1 }),
    ]);
    expect(mocks.fail).not.toHaveBeenCalled();

    const slow = fakeClient({
      getPayoutBatchItems: vi.fn(async () => {
        throw new AffiliatePayPalError('unavailable', { status: 503 });
      }),
    });
    const second = deps(slow, { send: false });
    await runAffiliatePayPalPayouts(second.value);
    expect(second.alerts).toEqual([]);
  });

  it('notes SUCCESS without a transaction id (so the payout can never be released and paid again), and waits for it', async () => {
    tables['affiliate_payouts'] = [payout('p1')];
    const client = fakeClient({
      getPayoutBatchItems: vi.fn(async () => ({ batchId: 'BATCH1', status: 'SUCCESS', items: [item('p1', 'SUCCESS', { transactionId: null })], totalPages: 1 })),
      getPayoutItem: vi.fn(async () => item('p1', 'SUCCESS', { transactionId: null })),
    });
    const { value, alerts } = deps(client, { send: false });
    await runAffiliatePayPalPayouts(value);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.note.mock.calls.map((call) => call[1])).toEqual([{ payoutId: 'p1', itemId: 'I-p1', itemStatus: 'SUCCESS' }]);
    expect(alerts.map((alert) => alert.code)).toEqual(['SUCCESS_WITHOUT_TRANSACTION']);
  });

  it('reports, never resends, a batch first claimed past PayPal’s 30-day memory of its id', async () => {
    const old = new Date(NOW.getTime() - AFFILIATE_PAYPAL_RESEND_MAX_AGE_MS - 1000).toISOString();
    tables['affiliate_payouts'] = [payout('old', { paypal_batch_id: null, paypal_sender_batch_id: 'sb-old', created_at: old, last_attempt_at: old })];
    const client = fakeClient();
    const sending = deps(client, { gateways: [] });
    const summary = await runAffiliatePayPalPayouts(sending.value);
    expect(client.createPayoutBatch).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(summary.pendingRetry).toBe(1);
    expect(sending.alerts).toEqual([
      expect.objectContaining({ kind: 'paypal_batch_unresolved', cause: 'expired', senderBatchId: 'sb-old', code: 'RESEND_WINDOW_PASSED' }),
    ]);
    // "Check PayPal status now" (no sending) reports it too
    const checking = deps(client, { send: false });
    await runAffiliatePayPalPayouts(checking.value);
    expect(checking.alerts).toEqual([expect.objectContaining({ kind: 'paypal_batch_unresolved', cause: 'expired' })]);
  });
});

describe('sending new payouts', () => {
  function seedPartners() {
    tables['affiliate_profiles'] = [
      { id: 'a1', status: 'ACTIVE', first_published_at: NOW.toISOString(), payout_email: 'one@example.com', payout_email_kind: 'paypal', preferred_locale: 'en' },
      { id: 'a2', status: 'ACTIVE', first_published_at: NOW.toISOString(), payout_email: 'two@example.com', payout_email_kind: 'paypal', preferred_locale: 'fr' },
      // Interac: paid by hand, never by the run.
      { id: 'a3', status: 'ACTIVE', first_published_at: NOW.toISOString(), payout_email: 'three@example.com', payout_email_kind: 'interac', preferred_locale: 'en' },
      // An address PayPal cannot take as is.
      { id: 'a4', status: 'ACTIVE', first_published_at: NOW.toISOString(), payout_email: '=cmd@example.com', payout_email_kind: 'paypal', preferred_locale: 'en' },
      // Not approved yet.
      { id: 'a5', status: 'ACTIVE', first_published_at: null, payout_email: 'five@example.com', payout_email_kind: 'paypal', preferred_locale: 'en' },
    ];
    const commission = (id: string, affiliateId: string, cents: number, extra: Row = {}) => ({
      id,
      affiliate_id: affiliateId,
      status: 'CLEARED',
      livemode: true,
      payout_id: null,
      disputed_at: null,
      gateway: 'FREEMIUS',
      currency: 'USD',
      commission_amount_cents: cents,
      refunded_amount_cents: 0,
      ...extra,
    });
    tables['affiliate_commissions'] = [
      commission('c1', 'a1', 1500),
      commission('c2', 'a1', 1500),
      commission('c3', 'a2', 2500),
      commission('c4', 'a3', 9000),
      commission('c5', 'a4', 9000),
      commission('c6', 'a5', 9000),
      // Below the minimum on its own.
      commission('c7', 'a2', 500, { currency: 'CAD' }),
      // Another gateway (paid through Stripe): never claimed here.
      commission('c8', 'a1', 9000, { gateway: 'STRIPE', currency: 'EUR' }),
      // Test mode: not paid with live money.
      commission('c9', 'a2', 9000, { livemode: false, currency: 'GBP' }),
    ];
    mocks.claim.mockImplementation(async (_db: unknown, input: { affiliateId: string; currency: string }) => {
      const id = `new-${input.affiliateId}-${input.currency}`;
      tables['affiliate_payouts']?.push(
        payout(id, { affiliate_id: input.affiliateId, currency: input.currency, paypal_sender_batch_id: null, paypal_batch_id: null })
      );
      return { status: 'claimed', payoutId: id, amountCents: 3000, commissionCount: 2, receiver: 'x@example.com' };
    });
  }

  it('claims PayPal-ready partners in the live mode, saves the sender_batch_id first, then creates one batch per currency and language', async () => {
    seedPartners();
    const client = fakeClient();
    const { value } = deps(client);
    const summary = await runAffiliatePayPalPayouts(value);

    expect(mocks.claim.mock.calls.map((call) => call[1])).toEqual([
      { affiliateId: 'a1', currency: 'USD', minAmountCents: 2000, gateways: ['FREEMIUS'], livemode: true, trigger: 'cron' },
      { affiliateId: 'a2', currency: 'USD', minAmountCents: 2000, gateways: ['FREEMIUS'], livemode: true, trigger: 'cron' },
    ]);
    // Two batches (English and French), each: the sender id saved, then the create, then PayPal's batch id.
    expect(mocks.calls).toEqual(['record-sender:new-sb-1', 'create', 'record:NEWBATCH', 'record-sender:new-sb-2', 'create', 'record:NEWBATCH']);
    const firstBatch = (client.createPayoutBatch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(firstBatch).toMatchObject({ senderBatchId: 'new-sb-1', emailSubject: 'You have a payout from Acme Shop' });
    expect(firstBatch.items).toEqual([
      expect.objectContaining({ receiver: 'new-a1-USD@example.com', amountCents: 5000, currency: 'USD', senderItemId: 'new-a1-USD' }),
    ]);
    const secondBatch = (client.createPayoutBatch as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
    expect(secondBatch.emailSubject).toBe('Vous avez un versement de Acme Shop');
    expect(summary).toMatchObject({ claimed: 2, submitted: 2, skipped: null });
  });

  it('pays test-mode commissions only with the PayPal sandbox', async () => {
    seedPartners();
    const client = fakeClient();
    const { value } = deps(client, { environment: 'sandbox' });
    await runAffiliatePayPalPayouts(value);
    expect(mocks.claim.mock.calls.map((call) => [call[1].affiliateId, call[1].currency, call[1].livemode])).toEqual([['a2', 'GBP', false]]);
  });

  it('skips a partner whose last PayPal payout came back from the same address', async () => {
    seedPartners();
    tables['affiliate_payouts'] = [
      payout('old', { affiliate_id: 'a1', status: 'FAILED', failure_reason: 'paypal_returned', paypal_receiver: 'one@example.com' }),
    ];
    const client = fakeClient();
    const { value } = deps(client);
    await runAffiliatePayPalPayouts(value);
    expect(mocks.claim.mock.calls.map((call) => call[1].affiliateId)).toEqual(['a2']);
  });

  it('keeps the payouts in flight after an unknown outcome, and sends them again with the same sender_batch_id', async () => {
    seedPartners();
    const client = fakeClient({
      createPayoutBatch: vi.fn(async () => {
        throw new AffiliatePayPalError('unavailable', { status: 503 });
      }),
    });
    const first = await runAffiliatePayPalPayouts(deps(client).value);
    expect(first).toMatchObject({ claimed: 2, submitted: 0, pendingRetry: 2, failed: 0 });
    expect(mocks.fail).not.toHaveBeenCalled();

    mocks.claim.mockReset();
    const retryClient = fakeClient();
    const second = await runAffiliatePayPalPayouts(deps(retryClient).value);
    const resent = (retryClient.createPayoutBatch as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0].senderBatchId);
    expect(resent).toEqual(['new-sb-1', 'new-sb-2']);
    expect(second.submitted).toBe(2);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('never releases a resend PayPal refused before it could look at the first batch (credentials, Payouts access, balance)', async () => {
    const refusals: Array<[AffiliatePayPalError, 'credentials' | 'not_enabled' | 'insufficient_funds', number]> = [
      // the token request failed: the resend never reached the create call; the next batch is not tried
      [new AffiliatePayPalError('credentials', { status: 401, code: 'INVALID_CLIENT' }), 'credentials', 1],
      [new AffiliatePayPalError('not_enabled', { status: 403, code: 'NOT_AUTHORIZED' }), 'not_enabled', 1],
      [new AffiliatePayPalError('insufficient_funds', { status: 422, code: 'INSUFFICIENT_FUNDS' }), 'insufficient_funds', 2],
    ];
    for (const [refusal, cause, creates] of refusals) {
      tables['affiliate_payouts'] = [
        payout('p1', { paypal_batch_id: null, paypal_sender_batch_id: 'sb-1' }),
        payout('p2', { paypal_batch_id: null, paypal_sender_batch_id: 'sb-2' }),
      ];
      mocks.fail.mockClear();
      mocks.calls = [];
      const client = fakeClient({
        createPayoutBatch: vi.fn(async () => {
          mocks.calls.push('create');
          throw refusal;
        }),
      });
      const run = deps(client, { gateways: [] });
      const summary = await runAffiliatePayPalPayouts(run.value);
      // PayPal may hold and pay the first send: releasing could pay twice
      expect(mocks.fail, cause).not.toHaveBeenCalled();
      expect(summary, cause).toMatchObject({ failed: 0, pendingRetry: 2 });
      expect(client.createPayoutBatch, cause).toHaveBeenCalledTimes(creates);
      expect(run.alerts, cause).toEqual([
        expect.objectContaining({ kind: 'paypal_batch_unresolved', cause, senderBatchId: 'sb-1', currency: 'USD', payouts: creates === 2 ? 2 : 1 }),
      ]);
      // each resend stamped its send first (the CMS Release waits an hour after it)
      expect(mocks.calls.slice(0, 2), cause).toEqual(['record-sender:sb-1', 'create']);
      expect(tables['affiliate_payouts']?.every((row) => row['status'] === 'PROCESSING'), cause).toBe(true);
    }
  });

  it('stamps a resend before the create call and sends only the payouts that still carry the id (one released meanwhile is not sent)', async () => {
    tables['affiliate_payouts'] = [
      payout('p1', { paypal_batch_id: null, paypal_sender_batch_id: 'sb-x', last_attempt_at: new Date(NOW.getTime() - 7_200_000).toISOString() }),
      payout('p2', { paypal_batch_id: null, paypal_sender_batch_id: 'sb-x' }),
    ];
    const defaultRecord = mocks.record.getMockImplementation();
    mocks.record.mockImplementationOnce(async (db: unknown, input: { payoutIds: string[]; senderBatchId: string; payoutBatchId?: string | null }) => {
      // an admin released p2 while the run was starting
      const released = tables['affiliate_payouts']?.find((row) => row['id'] === 'p2');
      if (released) released['status'] = 'FAILED';
      return defaultRecord?.(db, input);
    });
    const client = fakeClient();
    const summary = await runAffiliatePayPalPayouts(deps(client, { gateways: [] }).value);
    const sent = (client.createPayoutBatch as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(sent).toHaveLength(1);
    expect(sent[0].senderBatchId).toBe('sb-x');
    expect(sent[0].items.map((entry: { senderItemId: string }) => entry.senderItemId)).toEqual(['p1']);
    expect(mocks.calls).toEqual(['record-sender:sb-x', 'create', 'record:NEWBATCH']);
    expect(tables['affiliate_payouts']?.find((row) => row['id'] === 'p1')?.['last_attempt_at']).toBe(NOW.toISOString());
    expect(summary.submitted).toBe(1);

    // No credentials for the payout's environment: nothing is sent, so no send is stamped.
    mocks.calls = [];
    mocks.record.mockClear();
    tables['affiliate_payouts'] = [payout('p3', { paypal_batch_id: null, paypal_sender_batch_id: 'sb-y' })];
    const none = await runAffiliatePayPalPayouts(deps(fakeClient(), { gateways: [], credentialsFor: async () => null }).value);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(none.pendingRetry).toBe(1);
  });

  it('keeps a batch PayPal answered with an unreadable body in flight and tells the admin', async () => {
    seedPartners();
    const client = fakeClient({
      createPayoutBatch: vi.fn(async () => {
        throw new AffiliatePayPalError('malformed', { status: 201 });
      }),
    });
    const run = deps(client);
    const summary = await runAffiliatePayPalPayouts(run.value);
    expect(summary).toMatchObject({ claimed: 2, pendingRetry: 2, failed: 0 });
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(run.alerts).toEqual([expect.objectContaining({ kind: 'paypal_batch_unresolved', cause: 'malformed', payouts: 2, code: 'MALFORMED_RESPONSE' })]);
  });

  it('tells the admin when PayPal accepted a batch some of whose payouts could not be linked to it', async () => {
    seedPartners();
    const defaultRecord = mocks.record.getMockImplementation();
    mocks.record.mockImplementation(async (db: unknown, input: { payoutIds: string[]; senderBatchId: string; payoutBatchId?: string | null }) => {
      if (input.payoutBatchId) {
        mocks.calls.push(`record:${input.payoutBatchId}`);
        return { status: 'recorded', count: 0 };
      }
      return defaultRecord?.(db, input);
    });
    const run = deps(fakeClient());
    await runAffiliatePayPalPayouts(run.value);
    expect(run.alerts).toEqual([
      expect.objectContaining({ kind: 'paypal_batch_unresolved', cause: 'not_recorded', batchId: 'NEWBATCH', code: 'BATCH_NOT_RECORDED', payouts: 2 }),
    ]);
  });

  it('claims only in a currency PayPal sends, whole units for HUF, JPY and TWD, and alerts once per currency otherwise', async () => {
    seedPartners();
    tables['affiliate_commissions']?.push(
      { id: 'k1', affiliate_id: 'a1', status: 'CLEARED', livemode: true, payout_id: null, disputed_at: null, gateway: 'FREEMIUS', currency: 'KRW', commission_amount_cents: 90000, refunded_amount_cents: 0 },
      { id: 'h1', affiliate_id: 'a1', status: 'CLEARED', livemode: true, payout_id: null, disputed_at: null, gateway: 'FREEMIUS', currency: 'HUF', commission_amount_cents: 123456, refunded_amount_cents: 0 },
      { id: 'h2', affiliate_id: 'a2', status: 'CLEARED', livemode: true, payout_id: null, disputed_at: null, gateway: 'FREEMIUS', currency: 'HUF', commission_amount_cents: 123400, refunded_amount_cents: 0 }
    );
    const run = deps(fakeClient());
    await runAffiliatePayPalPayouts(run.value);
    expect(mocks.claim.mock.calls.map((call) => `${call[1].affiliateId}|${call[1].currency}`).sort()).toEqual(['a1|USD', 'a2|HUF', 'a2|USD']);
    expect(run.alerts.filter((alert) => alert.kind === 'paypal_currency_unsupported').map((alert) => [alert.currency, alert.code]).sort()).toEqual([
      ['HUF', 'NOT_WHOLE_UNITS'],
      ['KRW', 'CURRENCY_NOT_SUPPORTED'],
    ]);
  });

  it('pays an address again once the partner saved it after PayPal returned a payout from it', async () => {
    seedPartners();
    const failedAt = new Date(NOW.getTime() - 2 * 86_400_000).toISOString();
    const returned = payout('old', {
      affiliate_id: 'a1',
      status: 'FAILED',
      failure_reason: 'paypal_returned',
      paypal_receiver: 'one@example.com',
      created_at: failedAt,
      updated_at: failedAt,
    });
    tables['affiliate_payouts'] = [returned];
    const a1 = tables['affiliate_profiles']?.find((row) => row['id'] === 'a1');
    if (a1) a1['payout_email_saved_at'] = new Date(NOW.getTime() - 86_400_000).toISOString();
    await runAffiliatePayPalPayouts(deps(fakeClient()).value);
    expect(mocks.claim.mock.calls.map((call) => call[1].affiliateId)).toEqual(['a1', 'a2']);

    tables['affiliate_payouts'] = [returned];
    // saved before the return: still blocked
    expect(
      await loadAffiliatePayPalBlockedReceivers(fakeDb() as never, [
        { affiliateId: 'a1', email: 'one@example.com', emailSavedAt: new Date(NOW.getTime() - 3 * 86_400_000).toISOString() },
      ])
    ).toEqual(new Set(['a1']));
    // never saved since 02037: blocked
    expect(await loadAffiliatePayPalBlockedReceivers(fakeDb() as never, [{ affiliateId: 'a1', email: 'one@example.com' }])).toEqual(new Set(['a1']));
  });

  it('adopts the original batch PayPal links for a reused sender_batch_id', async () => {
    seedPartners();
    const client = fakeClient({
      createPayoutBatch: vi.fn(async () => {
        throw new AffiliatePayPalError('duplicate_batch', { status: 400, batchId: 'ORIGINAL99' });
      }),
    });
    const summary = await runAffiliatePayPalPayouts(deps(client).value);
    expect(mocks.calls.filter((call) => call.startsWith('record:'))).toEqual(['record:ORIGINAL99', 'record:ORIGINAL99']);
    expect(summary.submitted).toBe(2);
  });

  it('hands the commissions back on a definitive refusal, alerts once, and stops on Payouts not enabled', async () => {
    seedPartners();
    const funds = fakeClient({
      createPayoutBatch: vi.fn(async () => {
        throw new AffiliatePayPalError('insufficient_funds', { status: 422, code: 'INSUFFICIENT_FUNDS' });
      }),
    });
    const run = deps(funds);
    const summary = await runAffiliatePayPalPayouts(run.value);
    expect(mocks.fail.mock.calls.map((call) => call[1].reason)).toEqual(['paypal_insufficient_funds', 'paypal_insufficient_funds']);
    expect(run.alerts).toEqual([expect.objectContaining({ kind: 'paypal_insufficient_funds', currency: 'USD', payouts: 2 })]);
    expect(summary.failed).toBe(2);

    tables['affiliate_payouts'] = [];
    mocks.fail.mockClear();
    const disabled = fakeClient({
      createPayoutBatch: vi.fn(async () => {
        throw new AffiliatePayPalError('not_enabled', { status: 403, code: 'NOT_AUTHORIZED' });
      }),
    });
    const second = deps(disabled);
    await runAffiliatePayPalPayouts(second.value);
    expect(disabled.createPayoutBatch).toHaveBeenCalledTimes(1);
    expect(second.alerts.map((alert) => alert.kind)).toEqual(['paypal_not_enabled']);
  });

  it('claims nothing while the token lacks the Payouts scope, or no credentials are configured', async () => {
    seedPartners();
    const noScope = fakeClient({ getToken: vi.fn(async () => ({ accessToken: 't', scopes: ['openid'], appId: null, expiresAt: Date.now() + 1000 })) });
    const run = deps(noScope);
    const summary = await runAffiliatePayPalPayouts(run.value);
    expect(summary.skipped).toBe('not_enabled');
    expect(run.alerts.map((alert) => alert.kind)).toEqual(['paypal_not_enabled']);
    expect(mocks.claim).not.toHaveBeenCalled();

    const none = deps(fakeClient(), { credentialsFor: async () => null });
    expect((await runAffiliatePayPalPayouts(none.value)).skipped).toBe('not_configured');
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});

describe('cancelAffiliatePayPalPayout', () => {
  it('cancels an item PayPal still lists as UNCLAIMED, then hands the commissions back', async () => {
    tables['affiliate_payouts'] = [payout('p1', { paypal_item_id: 'I-p1', paypal_item_status: 'UNCLAIMED' })];
    const client = fakeClient({
      getPayoutItem: vi.fn(async () => item('p1', 'UNCLAIMED')),
      cancelPayoutItem: vi.fn(async () => item('p1', 'RETURNED')),
    });
    const { value, events } = deps(client);
    expect(await cancelAffiliatePayPalPayout(value, 'p1')).toEqual({ status: 'cancelled', result: 'returned', recorded: true });
    expect(client.cancelPayoutItem).toHaveBeenCalledWith('I-p1');
    expect(mocks.fail.mock.calls[0]?.[1]).toEqual({ payoutId: 'p1', reason: 'paypal_cancelled', itemStatus: 'RETURNED' });
    expect(events).toEqual([expect.objectContaining({ type: 'PAYOUT_FAILED', cancelledByAdmin: true })]);
  });

  it('says so when PayPal cancelled the item but the ledger write failed (the next check settles it), never "nothing changed"', async () => {
    tables['affiliate_payouts'] = [payout('p1', { paypal_item_id: 'I-p1', paypal_item_status: 'UNCLAIMED' })];
    mocks.fail.mockRejectedValueOnce(new Error('connection reset'));
    const client = fakeClient({
      getPayoutItem: vi.fn(async () => item('p1', 'UNCLAIMED')),
      cancelPayoutItem: vi.fn(async () => item('p1', 'RETURNED')),
    });
    const { value, events } = deps(client);
    expect(await cancelAffiliatePayPalPayout(value, 'p1')).toEqual({ status: 'cancelled', result: 'returned', recorded: false });
    expect(events).toEqual([]);
  });

  it('names the PayPal error when PayPal refuses the cancel (the sandbox answers 500 INTERNAL_SERVICE_ERROR), and changes nothing', async () => {
    tables['affiliate_payouts'] = [payout('p1', { paypal_item_id: 'I-p1', paypal_item_status: 'UNCLAIMED' })];
    const client = fakeClient({
      getPayoutItem: vi.fn(async () => item('p1', 'UNCLAIMED')),
      cancelPayoutItem: vi.fn(async () => {
        throw new AffiliatePayPalError('unavailable', { status: 500, code: 'INTERNAL_SERVICE_ERROR', debugId: 'f818051c24f41' });
      }),
    });
    const { value, events } = deps(client);
    expect(await cancelAffiliatePayPalPayout(value, 'p1')).toEqual({ status: 'paypal_error', code: 'INTERNAL_SERVICE_ERROR', debugId: 'f818051c24f41' });
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('still says PayPal could not be reached when no answer came back', async () => {
    tables['affiliate_payouts'] = [payout('p1', { paypal_item_id: 'I-p1', paypal_item_status: 'UNCLAIMED' })];
    const client = fakeClient({
      getPayoutItem: vi.fn(async () => item('p1', 'UNCLAIMED')),
      cancelPayoutItem: vi.fn(async () => {
        throw new AffiliatePayPalError('unavailable');
      }),
    });
    const { value } = deps(client);
    expect(await cancelAffiliatePayPalPayout(value, 'p1')).toEqual({ status: 'unavailable' });
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it('records an item PayPal paid meanwhile instead of cancelling it', async () => {
    tables['affiliate_payouts'] = [payout('p1', { paypal_item_id: 'I-p1', paypal_item_status: 'UNCLAIMED' })];
    const client = fakeClient({ getPayoutItem: vi.fn(async () => item('p1', 'SUCCESS')) });
    const { value } = deps(client);
    expect(await cancelAffiliatePayPalPayout(value, 'p1')).toEqual({ status: 'completed' });
    expect(client.cancelPayoutItem).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it('does not cancel a pending item, and keeps the payout when PayPal does not confirm the cancel', async () => {
    tables['affiliate_payouts'] = [payout('p1', { paypal_item_id: 'I-p1' })];
    const pending = fakeClient({ getPayoutItem: vi.fn(async () => item('p1', 'PENDING')) });
    expect(await cancelAffiliatePayPalPayout(deps(pending).value, 'p1')).toEqual({ status: 'still_in_flight', itemStatus: 'PENDING' });
    expect(pending.cancelPayoutItem).not.toHaveBeenCalled();

    const unconfirmed = fakeClient({
      getPayoutItem: vi.fn(async () => item('p1', 'UNCLAIMED')),
      cancelPayoutItem: vi.fn(async () => item('p1', 'UNCLAIMED')),
    });
    expect(await cancelAffiliatePayPalPayout(deps(unconfirmed).value, 'p1')).toEqual({ status: 'still_in_flight', itemStatus: 'UNCLAIMED' });
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it('releases a payout PayPal never confirmed through the database rule (an hour after its last send), without calling PayPal', async () => {
    const recent = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
    const old = new Date(NOW.getTime() - AFFILIATE_PAYPAL_UNCONFIRMED_RELEASE_AFTER_MS - 1000).toISOString();
    tables['affiliate_payouts'] = [
      payout('recent', { paypal_batch_id: null, last_attempt_at: recent }),
      payout('old', { paypal_batch_id: null, last_attempt_at: old }),
    ];
    const client = fakeClient();
    const { value } = deps(client);
    // The database refuses it (release_paypal_affiliate_payout checks the last send under the payout lock).
    expect(await cancelAffiliatePayPalPayout(value, 'recent')).toEqual({ status: 'not_cancellable' });
    expect(await cancelAffiliatePayPalPayout(value, 'old')).toEqual({ status: 'released' });
    expect(mocks.release.mock.calls.map((call) => call[1])).toEqual([{ payoutId: 'recent' }, { payoutId: 'old' }]);
    // never the generic failure RPC, which has no such rule
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(client.getPayoutItem).not.toHaveBeenCalled();
    expect(await cancelAffiliatePayPalPayout(value, 'missing')).toEqual({ status: 'not_found' });
  });

  it('releases a payout PayPal accepted but never settled only through the database rule (a week on, no status PayPal holds)', async () => {
    const weekOld = new Date(NOW.getTime() - AFFILIATE_PAYPAL_ACKNOWLEDGED_RELEASE_AFTER_MS - 1000).toISOString();
    tables['affiliate_payouts'] = [
      // the item is missing from its batch: nothing to ask PayPal
      payout('missing-item', { paypal_item_id: null, last_attempt_at: weekOld }),
      payout('fresh', { paypal_item_id: null }),
      // PayPal reports a status this site does not know
      payout('mystery', { paypal_item_id: 'I-mystery', paypal_item_status: 'MYSTERY', last_attempt_at: weekOld }),
    ];
    const client = fakeClient({ getPayoutItem: vi.fn(async () => item('mystery', 'MYSTERY')) });
    const { value } = deps(client);
    expect(await cancelAffiliatePayPalPayout(value, 'fresh')).toEqual({ status: 'not_cancellable' });
    expect(await cancelAffiliatePayPalPayout(value, 'missing-item')).toEqual({ status: 'released' });
    expect(await cancelAffiliatePayPalPayout(value, 'mystery')).toEqual({ status: 'released' });
    expect(client.cancelPayoutItem).not.toHaveBeenCalled();

    // PayPal unreachable, or no credentials for the environment any more: only the database rule applies
    tables['affiliate_payouts'] = [payout('gone', { paypal_item_id: 'I-gone', paypal_item_status: 'PENDING', last_attempt_at: weekOld })];
    const none = deps(fakeClient(), { credentialsFor: async () => null });
    expect(await cancelAffiliatePayPalPayout(none.value, 'gone')).toEqual({ status: 'not_configured' });
    tables['affiliate_payouts'] = [payout('gone', { paypal_item_id: 'I-gone', paypal_item_status: null, last_attempt_at: weekOld })];
    expect(await cancelAffiliatePayPalPayout(none.value, 'gone')).toEqual({ status: 'released' });
  });
});

describe('affiliatePayPalReleaseKind', () => {
  it('offers Release an hour after the last send of a batch PayPal never confirmed, a week after one it accepted and does not hold', () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    expect(affiliatePayPalReleaseKind({ paypal_batch_id: null, paypal_item_status: null, last_attempt_at: at(10 * 60_000) }, NOW)).toBeNull();
    expect(
      affiliatePayPalReleaseKind({ paypal_batch_id: null, paypal_item_status: null, last_attempt_at: at(AFFILIATE_PAYPAL_UNCONFIRMED_RELEASE_AFTER_MS) }, NOW)
    ).toBe('unconfirmed');
    const weekOld = at(AFFILIATE_PAYPAL_ACKNOWLEDGED_RELEASE_AFTER_MS);
    expect(affiliatePayPalReleaseKind({ paypal_batch_id: 'B1', paypal_item_status: null, last_attempt_at: at(2 * 3_600_000) }, NOW)).toBeNull();
    expect(affiliatePayPalReleaseKind({ paypal_batch_id: 'B1', paypal_item_status: null, last_attempt_at: weekOld }, NOW)).toBe('acknowledged');
    expect(affiliatePayPalReleaseKind({ paypal_batch_id: 'B1', paypal_item_status: 'MYSTERY', last_attempt_at: weekOld }, NOW)).toBe('acknowledged');
    for (const status of ['SUCCESS', 'PENDING', 'ONHOLD', 'UNCLAIMED']) {
      expect(affiliatePayPalReleaseKind({ paypal_batch_id: 'B1', paypal_item_status: status, last_attempt_at: weekOld }, NOW), status).toBeNull();
    }
  });
});
