import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AffiliateCommissionRow, AffiliatePayoutRow } from '@nextblock-cms/affiliates';

import type { RetailerPayoutsData } from '../../../../../lib/affiliates/portal-data';
import { formatPortalMoney } from '../components/portal-format';

/**
 * The partner payouts page in the three ways a program can pay (02036, affiliates_settings.payoutMethods):
 * every commission through Stripe Connect (the page as it was), every commission sent by the store by
 * hand (the "How you get paid" card and the payout email form, no Connect card, no Stripe promise), and
 * both (one line per kind of order, both next-payout figures, the commissions table's Payout column).
 * The loader is stubbed (portal-data.test.ts covers it); the hint logic is the real one.
 */

const NBSP = ' ';

const mocks = vi.hoisted(() => ({
  data: null as unknown,
  locale: 'en',
  siteTitle: 'Maple Shop' as string | null,
  connectProps: [] as Array<Record<string, unknown>>,
  emailFormProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/cache', () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@nextblock-cms/db/server', () => ({ getSsgSupabaseClient: () => ({}) }));
vi.mock('@nextblock-cms/ecommerce', () => vi.importActual('../../../../../../../libs/ecommerce/src/lib/currency'));
vi.mock('@nextblock-cms/affiliates/server', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../../../../libs/affiliates/src/lib/repository')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../../../../libs/affiliates/src/lib/payouts/payout-config')),
}));
vi.mock('../../../../../lib/storage/provider', () => ({ resolveMediaBaseUrl: () => 'https://media.test' }));
vi.mock('../../../../../lib/affiliates/image-origins', () => ({ getStorefrontImageOrigins: () => ['https://media.test'] }));
vi.mock('../../../../../lib/affiliates/connect-service', () => ({
  isAffiliateConnectConfigured: async () => true,
  getAffiliateConnectCountryOptions: async () => ({ platformCountry: 'CA', countries: [{ code: 'CA', name: 'Canada' }] }),
}));
vi.mock('../../../../../lib/affiliates/settings', () => ({
  getAffiliatesSettings: async () => ({}),
  getPublicAffiliatesProgramSettings: async () => null,
}));
vi.mock('../../../../../lib/affiliates/request-locale', () => ({
  getRequestLocale: async () => mocks.locale,
  toAffiliatesLocale: (locale: string | null | undefined) => (typeof locale === 'string' && locale.startsWith('fr') ? 'fr' : 'en'),
}));
vi.mock('../../../../../lib/affiliates/retailer-actor', () => ({
  requireRetailerPage: async () => ({ supabase: {}, actor: { userId: 'user-1' } }),
}));
vi.mock('../../../../../lib/affiliates/portal-data', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../../../lib/affiliates/portal-data');
  return {
    ...actual,
    readRetailerPortalAccount: () => (mocks.data as RetailerPayoutsData | null)?.account ?? null,
    loadRetailerPayoutsData: async () => mocks.data,
  };
});
vi.mock('../../../../lib/site-settings', () => ({
  getSiteSettings: async () => ({ siteTitle: mocks.siteTitle, siteDescription: '', siteKeywords: '', socialImage: null }),
}));
// The real dictionaries and copy runtime (no operator overrides).
vi.mock('../components/portal-server-copy', async () => {
  const runtime = (await vi.importActual('../../../../../../../libs/affiliates/src/lib/i18n/copy-runtime')) as {
    createAffiliatesCopy: (options: { locale: string; dictionary: unknown }) => (key: string, values?: unknown) => string;
  };
  const { PORTAL_UI_COPY } = (await vi.importActual('../components/portal-copy')) as { PORTAL_UI_COPY: unknown };
  return {
    getPortalServerCopy: async (locale?: string | null) => runtime.createAffiliatesCopy({ locale: locale ?? 'en', dictionary: PORTAL_UI_COPY }),
  };
});
// The client islands: their props are what the page decides.
vi.mock('../components/ConnectCard', () => ({
  ConnectCard: (props: Record<string, unknown>) => {
    mocks.connectProps.push(props);
    return <div data-island="connect-card" />;
  },
}));
vi.mock('../components/PayoutEmailForm', () => ({
  PayoutEmailForm: (props: Record<string, unknown>) => {
    mocks.emailFormProps.push(props);
    return <div data-island="payout-email-form" />;
  },
}));

import RetailerPayoutsPage from './page';

const A = '11111111-1111-4111-8111-111111111111';
const STAMP = '2026-11-03T06:00:00.000Z';
const STRIPE_SALE = 'c1000000-0000-4000-8000-000000000001';
const FREEMIUS_SALE = 'c1000000-0000-4000-8000-000000000002';

function commission(id: string, gateway: 'STRIPE' | 'FREEMIUS', amount: number): AffiliateCommissionRow {
  return {
    id,
    affiliate_id: A,
    order_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    gateway,
    order_currency: 'CAD',
    order_net_amount_minor: amount * 10,
    exchange_rate_snapshot: 1,
    net_order_amount_cents: amount * 10,
    commission_rate_snapshot: 10,
    commission_amount_cents: amount,
    refunded_amount_cents: 0,
    refund_pending_cents: 0,
    void_requested_at: null,
    disputed_at: null,
    livemode: true,
    currency: 'CAD',
    status: 'CLEARED',
    clears_at: STAMP,
    cleared_at: STAMP,
    paid_at: null,
    voided_at: null,
    void_reason: null,
    payout_id: null,
    stripe_transfer_id: null,
    notified_at: null,
    created_at: STAMP,
    updated_at: STAMP,
  };
}

function payout(id: string, overrides: Partial<AffiliatePayoutRow> = {}): AffiliatePayoutRow {
  return {
    id,
    affiliate_id: A,
    amount_cents: 2700,
    currency: 'CAD',
    stripe_destination_account: 'acct_1',
    stripe_transfer_id: 'tr_123',
    method: 'stripe_connect',
    manual_channel: null,
    external_reference: null,
    note: null,
    recorded_by: null,
    livemode: true,
    status: 'COMPLETED',
    attempt_count: 1,
    last_attempt_at: STAMP,
    failure_reason: null,
    trigger: 'cron',
    paid_at: STAMP,
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  };
}

const MANUAL_PAYOUT = payout('22222222-2222-4222-8222-222222222222', {
  stripe_destination_account: '',
  stripe_transfer_id: null,
  method: 'manual',
  manual_channel: 'paypal',
  external_reference: '5TY12345',
  note: 'Thanks for a great month!',
  trigger: 'admin',
});

const STRIPE_ONLY = { stripeSales: 'stripe_connect', freemiusSales: 'stripe_connect' } as const;
const ALL_MANUAL = { stripeSales: 'manual', freemiusSales: 'manual' } as const;
const MIXED = { stripeSales: 'stripe_connect', freemiusSales: 'manual' } as const;

function payoutsData(overrides: Partial<RetailerPayoutsData> = {}): RetailerPayoutsData {
  const payoutMethods = overrides.payoutMethods ?? STRIPE_ONLY;
  return {
    account: {
      profile: {
        id: A,
        status: 'ACTIVE',
        stripe_connect_details_submitted: true,
        payout_email: overrides.payoutEmail ?? null,
      },
      page: null,
    } as unknown as RetailerPayoutsData['account'],
    tier: null,
    settings: {
      notificationEmails: [],
      minPayoutCents: 5000,
      autoPayoutsEnabled: true,
      termsUrlEn: '',
      termsUrlFr: '',
      payoutMethods,
    },
    balances: {
      primary: {
        currency: 'CAD',
        pendingCents: 1800,
        clearedCents: 7200,
        processingCents: 0,
        paidCents: 2700,
        voidedCents: 0,
        nextClearsAt: '2026-11-20T00:00:00.000Z',
      },
      byCurrency: [],
    },
    baseCurrency: 'CAD',
    commissions: { rows: [commission(STRIPE_SALE, 'STRIPE', 1200), commission(FREEMIUS_SALE, 'FREEMIUS', 6000)], count: 2 },
    payouts: { rows: [payout('33333333-3333-4333-8333-333333333333')], count: 1 },
    failedPayouts: { autoRetryCents: 0, awaitingReviewCents: 0, autoRetryPayoutIds: [] },
    nextPayout: { kind: 'scheduled', date: '2026-11-12' },
    connect: 'ready',
    isSandbox: false,
    ledgerError: false,
    payoutMode: 'stripe',
    payoutMethods,
    payoutEmail: null,
    payoutEmailKind: 'paypal',
    paypalGateways: [],
    paypalReturnedTo: null,
    payoutRoutes: { stripe: true, paypal: false, manual: false },
    clearedByMethod: { stripeCents: 7200, paypalCents: 0, manualCents: 0 },
    manualPayout: null,
    manualSendingCents: 0,
    paypalPayout: null,
    paypalSendingCents: 0,
    paypalUnclaimed: null,
    commissionPayoutMethods: {},
    ...overrides,
  };
}

async function render(data: RetailerPayoutsData, search: Record<string, string> = {}): Promise<string> {
  mocks.data = data;
  const element = await RetailerPayoutsPage({ searchParams: Promise.resolve(search) });
  return renderToStaticMarkup(element).replace(/&#x27;/g, "'");
}

const min = (locale: 'en' | 'fr' = 'en') => formatPortalMoney(5000, 'CAD', locale);
const money = (amount: number, locale: 'en' | 'fr' = 'en') => formatPortalMoney(amount, 'CAD', locale);

beforeEach(() => {
  mocks.locale = 'en';
  mocks.siteTitle = 'Maple Shop';
  mocks.connectProps = [];
  mocks.emailFormProps = [];
});

describe('the payouts page while every commission goes through Stripe (the default)', () => {
  it('stays the Stripe page: the Connect card, the automated figure and the Stripe wording, no manual card', async () => {
    const html = await render(payoutsData());

    expect(html).toContain('Your commissions clear after the refund window, then go to your bank automatically through Stripe.');
    expect(mocks.connectProps).toHaveLength(1);
    expect(mocks.connectProps[0]).toMatchObject({ state: 'ready', partial: false, refreshOnMount: false });
    expect(mocks.emailFormProps).toHaveLength(0);
    expect(html).not.toContain('How you get paid');
    expect(html).toContain('Next automated payout');
    expect(html).not.toContain('Next payout from');
    expect(html).toContain(`Paid automatically once it reaches ${min()}.`);
    expect(html).toContain(`Once your cleared balance reaches ${min()}, it is sent automatically to your bank account through Stripe`);
    expect(html).toContain('lg:grid-cols-4');
    // No Payout column in the commissions table.
    expect(html).not.toContain('>Payout</th>');
    expect(html).toContain('Ref. tr_123');
  });
});

describe('the payouts page while every commission is sent by the store by hand', () => {
  const manualData = (overrides: Partial<RetailerPayoutsData> = {}) =>
    payoutsData({
      payoutMode: 'manual',
      payoutMethods: ALL_MANUAL,
      payoutRoutes: { stripe: false, paypal: false, manual: true },
      nextPayout: null,
      manualPayout: { kind: 'ready' },
      payoutEmail: 'jane@paypal.example',
      clearedByMethod: { stripeCents: 0, paypalCents: 0, manualCents: 7200 },
      payouts: { rows: [MANUAL_PAYOUT, payout('33333333-3333-4333-8333-333333333333')], count: 2 },
      ...overrides,
    });

  it('explains who pays, takes the payout email, and drops the Connect card and every Stripe promise', async () => {
    const html = await render(manualData());

    expect(html).toContain(
      'Your commissions clear after the refund window, then Maple Shop sends them to you directly, by PayPal or Interac e-Transfer.',
    );
    expect(html).toContain('>How you get paid</h2>');
    expect(html).toContain('Maple Shop sends your commissions to you directly, by PayPal or Interac e-Transfer.');
    expect(mocks.emailFormProps).toEqual([
      { initialEmail: 'jane@paypal.example', initialKind: 'paypal', sandbox: false, suspended: false, siteName: 'Maple Shop', paypalPayouts: false, paypalReturned: false },
    ]);
    expect(mocks.connectProps).toHaveLength(0);
    expect(html).not.toContain('Next automated payout');
    expect(html).toContain('Next payout from Maple Shop');
    expect(html).toContain('Paid by Maple Shop');
    expect(html).toContain('Maple Shop sends your cleared balance to jane@paypal.example by PayPal or Interac e-Transfer.');
    expect(html).toContain(`Paid by Maple Shop once it reaches ${min()}.`);
    expect(html).toContain(`Once your cleared balance reaches ${min()}, Maple Shop sends it to you directly, by PayPal or Interac e-Transfer.`);
    expect(html).not.toContain('through Stripe');
    expect(html).not.toContain('Paid automatically');
    expect(html).not.toContain('>Payout</th>');
  });

  it('shows a recorded payout as "{channel} · Ref. {reference}" with the note, and a Stripe one as before', async () => {
    const html = await render(manualData());
    expect(html).toContain('PayPal · Ref. 5TY12345');
    expect(html).toContain('Note: Thanks for a great month!');
    expect(html).toContain('Ref. tr_123');
  });

  it('asks for the payout email until there is one, and says when it is paid without a date', async () => {
    const missing = await render(manualData({ payoutEmail: null, manualPayout: { kind: 'email_required' } }));
    expect(missing).toContain('Add your payout email');
    expect(missing).toContain('Maple Shop needs it to send your payouts.');
    expect(mocks.emailFormProps.at(-1)).toMatchObject({ initialEmail: null });

    const clearing = await render(manualData({ manualPayout: { kind: 'clearing' } }));
    expect(clearing).toContain(`Sent to jane@paypal.example by PayPal or Interac e-Transfer once your cleared balance reaches ${min()}.`);

    const below = await render(manualData({ manualPayout: { kind: 'below_minimum', remainingCents: 2500 } }));
    expect(below).toContain('Below the minimum');
    expect(below).toContain(`${money(2500)} to go`);

    const none = await render(manualData({ manualPayout: { kind: 'no_balance' } }));
    expect(none).toContain('Nothing to pay out yet');
  });

  it('says a payout the store prepared is on its way, without a channel or reference yet (02036)', async () => {
    const preparedPayout = payout('44444444-4444-4444-8444-444444444444', {
      stripe_destination_account: '',
      stripe_transfer_id: null,
      method: 'manual',
      status: 'PROCESSING',
      paid_at: null,
      trigger: 'admin',
    });
    const html = await render(
      manualData({
        manualPayout: { kind: 'sending', amountCents: 6000 },
        manualSendingCents: 6000,
        payouts: { rows: [preparedPayout], count: 1 },
        balances: {
          primary: { currency: 'CAD', pendingCents: 0, clearedCents: 0, processingCents: 6000, paidCents: 0, voidedCents: 0, nextClearsAt: null },
          byCurrency: [],
        },
      })
    );
    expect(html).toContain(`Maple Shop is sending you ${money(6000)}.`);
    expect(html).toContain(`We're sending you ${money(6000)} directly.`);
    expect(html).toContain('Being sent to you directly.');
    // no bank transfer promise, and no "Other method" for a payout whose channel is not known yet
    expect(html).not.toContain('is on its way to your bank');
    expect(html).not.toContain('Other method');
  });

  it('names the site default when no title is set, and keeps the form read-only on the sandbox and while suspended', async () => {
    mocks.siteTitle = '  ';
    const untitled = await render(manualData());
    expect(untitled).toContain('NextBlock™ CMS sends your commissions to you directly');

    await render(manualData({ isSandbox: true }));
    expect(mocks.emailFormProps.at(-1)).toMatchObject({ sandbox: true, suspended: false });
    const suspended = manualData();
    (suspended.account.profile as { status: string }).status = 'SUSPENDED';
    await render(suspended);
    expect(mocks.emailFormProps.at(-1)).toMatchObject({ sandbox: false, suspended: true });
  });
});

describe('the payouts page while Stripe orders go through Stripe and the others are sent by hand', () => {
  const mixedData = (overrides: Partial<RetailerPayoutsData> = {}) =>
    payoutsData({
      payoutMode: 'mixed',
      payoutMethods: MIXED,
      payoutRoutes: { stripe: true, paypal: false, manual: true },
      nextPayout: { kind: 'below_minimum', remainingCents: 2900 },
      manualPayout: { kind: 'ready' },
      payoutEmail: 'jane@paypal.example',
      clearedByMethod: { stripeCents: 1200, paypalCents: 0, manualCents: 6000 },
      commissionPayoutMethods: { [STRIPE_SALE]: 'stripe_connect', [FREEMIUS_SALE]: 'manual' },
      payouts: { rows: [MANUAL_PAYOUT], count: 1 },
      ...overrides,
    });

  it('says per kind of order how commissions are paid, with both figures and the scoped Connect card', async () => {
    const html = await render(mixedData());

    expect(html).toContain('Depending on the order, they then go to your bank through Stripe, or Maple Shop sends them to you directly.');
    expect(html).toContain('How a commission is paid depends on how the order was paid.');
    expect(html).toMatch(/<dt[^>]*>Orders paid through Stripe<\/dt><dd[^>]*>Your commissions are transferred to your Stripe account\.<\/dd>/);
    expect(html).toMatch(
      /<dt[^>]*>Orders paid through Freemius<\/dt><dd[^>]*>Your commissions are sent to you directly by Maple Shop, by PayPal or Interac e-Transfer\.<\/dd>/,
    );
    expect(mocks.emailFormProps).toHaveLength(1);
    expect(mocks.connectProps).toHaveLength(1);
    expect(mocks.connectProps[0]).toMatchObject({ partial: true });
    expect(html).toContain('Next automated payout');
    expect(html).toContain('Next payout from Maple Shop');
    expect(html).toContain('lg:grid-cols-3');
    expect(html).toContain(`${money(1200)} goes by Stripe transfer and ${money(6000)} is paid by Maple Shop, each once it reaches ${min()}.`);
    // Direction-neutral: the card above says which kind of order goes through Stripe.
    expect(html).toContain('It depends on the order: “How you get paid” above says which commissions go through Stripe.');
  });

  it('adds a Payout column to the commissions table', async () => {
    const html = await render(mixedData());
    expect(html).toContain('>Payout</th>');
    expect(html).toContain('>Stripe transfer</td>');
    expect(html).toContain('>Sent directly</td>');
  });

  it('reads in Québec French', async () => {
    mocks.locale = 'fr';
    const html = await render(mixedData());
    expect(html).toContain('>Comment vous êtes payé</h2>');
    expect(html).toContain('Commandes payées par Freemius');
    expect(html).toContain('Versé par Maple Shop');
    expect(html).toContain('PayPal · Réf. 5TY12345');
    expect(html).toContain(`Note${NBSP}: Thanks for a great month!`);
    expect(html).toContain('>Envoi direct</td>');
    expect(html).not.toContain('How you get paid');
  });
});

describe('the payouts page while PayPal pays commissions automatically (02037)', () => {
  const ALL_PAYPAL = { stripeSales: 'paypal', freemiusSales: 'paypal' } as const;
  const STRIPE_AND_PAYPAL = { stripeSales: 'stripe_connect', freemiusSales: 'paypal' } as const;

  const paypalPayout = (id: string, overrides: Partial<AffiliatePayoutRow>) =>
    payout(id, {
      stripe_destination_account: '',
      stripe_transfer_id: null,
      method: 'paypal',
      paypal_receiver: 'jane@paypal.example',
      paypal_fee_cents: 25,
      ...overrides,
    });
  const PAID = paypalPayout('55555555-5555-4555-8555-555555555555', {
    status: 'COMPLETED',
    paypal_item_status: 'SUCCESS',
    paypal_transaction_id: '5TY12345AB678901C',
  });

  /** Every kind of order paid with PayPal, to a partner whose payout email is a PayPal account. */
  const paypalData = (overrides: Partial<RetailerPayoutsData> = {}) =>
    payoutsData({
      payoutMode: 'manual',
      payoutMethods: ALL_PAYPAL,
      paypalGateways: ['STRIPE', 'FREEMIUS'],
      payoutRoutes: { stripe: false, paypal: true, manual: false },
      nextPayout: null,
      paypalPayout: { kind: 'scheduled', date: '2026-11-12' },
      payoutEmail: 'jane@paypal.example',
      clearedByMethod: { stripeCents: 0, paypalCents: 7200, manualCents: 0 },
      payouts: { rows: [PAID], count: 1 },
      ...overrides,
    });

  it('says PayPal pays automatically, offers PayPal or Interac e-Transfer, and shows the next PayPal payout, never Stripe', async () => {
    const html = await render(paypalData());

    expect(html).toContain(
      'Your commissions clear after the refund window, then go to your PayPal account automatically, or by Interac e-Transfer if you choose it.',
    );
    expect(html).toContain('>How you get paid</h2>');
    expect(html).toMatch(/<p[^>]*>Your commissions are sent to your PayPal account automatically, or by Interac e-Transfer if you choose it\.<\/p>/);
    expect(mocks.emailFormProps).toEqual([
      { initialEmail: 'jane@paypal.example', initialKind: 'paypal', sandbox: false, suspended: false, siteName: 'Maple Shop', paypalPayouts: true, paypalReturned: false },
    ]);
    expect(mocks.connectProps).toHaveLength(0);
    expect(html).toContain('Next PayPal payout');
    expect(html).toContain('Estimate. Payouts run automatically once a day.');
    expect(html).not.toContain('Next automated payout');
    expect(html).not.toContain('Next payout from');
    expect(html).toContain(`Sent by PayPal once it reaches ${min()}.`);
    expect(html).toContain(`Once your cleared balance reaches ${min()}, the next daily payout run sends it to your PayPal account.`);
    expect(html).not.toMatch(/Stripe/);
    expect(html).toContain('lg:grid-cols-4');
    // One way to be paid: no Payout column.
    expect(html).not.toContain('>Payout</th>');
  });

  it('says when PayPal sends it: once the partner reaches the minimum, in the next daily run', async () => {
    const none = await render(paypalData({ paypalPayout: { kind: 'no_balance' } }));
    expect(none).toContain('Nothing to pay out yet');
    expect(none).toContain(`Sent by PayPal on the next daily run once you reach ${min()}.`);

    const below = await render(paypalData({ paypalPayout: { kind: 'below_minimum', remainingCents: 2500 } }));
    expect(below).toContain('Below the minimum');
    expect(below).toContain(`${money(2500)} to go`);

    const paused = await render(paypalData({ paypalPayout: { kind: 'paused' } }));
    expect(paused).toContain('Automated payouts are paused for now. Your balance is safe.');
    expect(paused).not.toContain('Connect your bank account');
  });

  it('reads PayPal payouts in the history as "PayPal · {status}", with the transaction id once paid and never a Stripe note', async () => {
    const rows = [
      PAID,
      paypalPayout('66666666-6666-4666-8666-666666666661', { status: 'PROCESSING', paid_at: null, paypal_item_status: 'PENDING' }),
      paypalPayout('66666666-6666-4666-8666-666666666662', { status: 'PROCESSING', paid_at: null, paypal_item_status: 'UNCLAIMED' }),
      paypalPayout('66666666-6666-4666-8666-666666666663', {
        status: 'FAILED',
        paid_at: null,
        paypal_item_status: 'RETURNED',
        failure_reason: 'paypal_returned',
      }),
      paypalPayout('66666666-6666-4666-8666-666666666664', {
        status: 'FAILED',
        paid_at: null,
        paypal_item_status: null,
        failure_reason: 'paypal_insufficient_funds',
      }),
    ];
    const html = await render(paypalData({ payouts: { rows, count: rows.length } }));

    expect(html).toContain('PayPal · Paid');
    expect(html).toContain('Transaction 5TY12345AB678901C');
    expect(html).toContain('PayPal · Sent');
    expect(html).toContain('PayPal · Waiting for you to claim it');
    expect(html).toContain('Claim it in PayPal: check the email PayPal sent to jane@paypal.example.');
    expect(html).toContain('PayPal · Returned');
    expect(html).toContain('PayPal · Not sent');
    expect(html.match(/The amount went back to your balance\./g)).toHaveLength(2);
    expect(html).not.toContain('Being sent to your bank.');
    expect(html).not.toContain('The transfer failed');
    // The store's PayPal fee is the store's: the partner never reads it.
    expect(html).not.toContain(money(25));
  });

  it('says a PayPal payout waiting to be claimed is in PayPal, and where to claim it; one on its way is on its way', async () => {
    const waiting = await render(
      paypalData({
        paypalPayout: { kind: 'unclaimed', amountCents: 4500, email: 'jane@paypal.example' },
        paypalSendingCents: 4500,
        paypalUnclaimed: { amountCents: 4500, email: 'jane@paypal.example' },
        balances: {
          primary: { currency: 'CAD', pendingCents: 0, clearedCents: 0, processingCents: 4500, paidCents: 0, voidedCents: 0, nextClearsAt: null },
          byCurrency: [],
        },
      }),
    );
    expect(waiting).toContain('Waiting for you to claim it');
    expect(waiting).toContain('Claim it in PayPal: check the email PayPal sent to jane@paypal.example.');
    expect(waiting).toContain(`${money(4500)} is waiting for you to claim it in PayPal.`);
    expect(waiting).not.toContain('is on its way to your bank');

    const sending = await render(
      paypalData({
        paypalPayout: { kind: 'sending', amountCents: 4500 },
        paypalSendingCents: 4500,
        balances: {
          primary: { currency: 'CAD', pendingCents: 0, clearedCents: 0, processingCents: 4500, paidCents: 0, voidedCents: 0, nextClearsAt: null },
          byCurrency: [],
        },
      }),
    );
    expect(sending).toContain('On its way');
    expect(sending.match(new RegExp(`${money(4500).replace(/[$.]/g, '\\$&')} is on its way to your PayPal account\\.`, 'g'))).toHaveLength(2);
    expect(sending).not.toContain('is on its way to your bank');
  });

  it('pays Stripe orders through Stripe and Freemius orders with PayPal: both lines, both figures, both amounts and the Payout column', async () => {
    const html = await render(
      paypalData({
        payoutMode: 'mixed',
        payoutMethods: STRIPE_AND_PAYPAL,
        paypalGateways: ['FREEMIUS'],
        payoutRoutes: { stripe: true, paypal: true, manual: false },
        nextPayout: { kind: 'below_minimum', remainingCents: 2900 },
        paypalPayout: { kind: 'scheduled', date: '2026-11-12' },
        clearedByMethod: { stripeCents: 1200, paypalCents: 6000, manualCents: 0 },
        commissionPayoutMethods: { [STRIPE_SALE]: 'stripe_connect', [FREEMIUS_SALE]: 'paypal' },
      }),
    );
    expect(html).toMatch(/<dt[^>]*>Orders paid through Stripe<\/dt><dd[^>]*>Your commissions are transferred to your Stripe account\.<\/dd>/);
    expect(html).toMatch(
      /<dt[^>]*>Orders paid through Freemius<\/dt><dd[^>]*>Your commissions are sent to your PayPal account automatically, or by Interac e-Transfer if you choose it\.<\/dd>/,
    );
    expect(mocks.connectProps).toHaveLength(1);
    expect(mocks.connectProps[0]).toMatchObject({ partial: true });
    expect(html).toContain('Next automated payout');
    expect(html).toContain('Next PayPal payout');
    expect(html).not.toContain('Next payout from');
    expect(html).toContain('lg:grid-cols-3');
    expect(html).toContain(`${money(1200)} goes by Stripe transfer and ${money(6000)} by PayPal, each once it reaches ${min()}.`);
    expect(html).toContain('>Payout</th>');
    expect(html).toContain('>Stripe transfer</td>');
    expect(html).toContain('>PayPal</td>');
  });

  it('pays a partner who chose Interac e-Transfer by hand, and tells one whose PayPal payout came back to check the address', async () => {
    const interac = await render(
      paypalData({
        payoutEmail: 'jane@bank.example',
        payoutEmailKind: 'interac',
        payoutRoutes: { stripe: false, paypal: false, manual: true },
        paypalPayout: null,
        manualPayout: { kind: 'ready' },
        clearedByMethod: { stripeCents: 0, paypalCents: 0, manualCents: 7200 },
      }),
    );
    expect(mocks.emailFormProps.at(-1)).toMatchObject({ initialEmail: 'jane@bank.example', initialKind: 'interac', paypalPayouts: true });
    expect(interac).toContain('Next payout from Maple Shop');
    expect(interac).not.toContain('Next PayPal payout');
    expect(interac).toContain(`Paid by Maple Shop once it reaches ${min()}.`);
    expect(interac).not.toContain('PayPal returned');

    const returned = await render(
      paypalData({
        paypalReturnedTo: 'jane@paypal.example',
        payoutRoutes: { stripe: false, paypal: false, manual: true },
        paypalPayout: null,
        manualPayout: { kind: 'ready' },
      }),
    );
    expect(returned).toContain(
      'PayPal returned the last payout sent to jane@paypal.example. Check that it is the email of your PayPal account (or open and confirm a PayPal account with it), then save it again below, or choose Interac e-Transfer. Until you do, Maple Shop pays you by hand.',
    );
    // the form offers to save the same address again ("I checked it: try PayPal again")
    expect(mocks.emailFormProps.at(-1)).toMatchObject({ paypalReturned: true });
  });

  it('reads in Québec French', async () => {
    mocks.locale = 'fr';
    const rows = [PAID, paypalPayout('77777777-7777-4777-8777-777777777777', { status: 'PROCESSING', paid_at: null, paypal_item_status: 'UNCLAIMED' })];
    const html = await render(paypalData({ paypalPayout: { kind: 'no_balance' }, payouts: { rows, count: rows.length } }));
    expect(html).toContain('Prochain versement PayPal');
    expect(html).toContain(`Envoyé par PayPal au prochain versement quotidien, une fois le minimum de ${min('fr')} atteint.`);
    expect(html).toContain('PayPal · Payé');
    expect(html).toContain('Transaction 5TY12345AB678901C');
    expect(html).toContain('PayPal · En attente que vous le réclamiez');
    expect(html).toContain(`Réclamez-le dans PayPal${NBSP}: consultez le courriel que PayPal a envoyé à jane@paypal.example.`);
    expect(html).toContain('Vos commissions sont envoyées automatiquement dans votre compte PayPal, ou par virement Interac si vous le choisissez.');
    expect(html).not.toContain('Next PayPal payout');
  });
});
