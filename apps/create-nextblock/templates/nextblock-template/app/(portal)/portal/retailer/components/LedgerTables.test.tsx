import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createAffiliatesCopy, type AffiliateLocale, type AffiliatePayoutRow, type AffiliatePayoutStatus } from '@nextblock-cms/affiliates';

import { CommissionsTable, PayoutsTable } from './LedgerTables';
import { PORTAL_UI_COPY } from './portal-copy';

/**
 * The partner's payout history: a failed payout is promised an automatic retry only when the daily
 * cycle really retries it (the loader passes those ids); any other failed payout waits for an admin.
 */

const AUTO = '11111111-1111-4111-8111-111111111111';
const REVIEW = '22222222-2222-4222-8222-222222222222';
const STAMP = '2026-11-03T06:00:00.000Z';

function payout(id: string, status: AffiliatePayoutStatus, overrides: Partial<AffiliatePayoutRow> = {}): AffiliatePayoutRow {
  return {
    id,
    affiliate_id: '33333333-3333-4333-8333-333333333333',
    amount_cents: 2900,
    currency: 'USD',
    stripe_destination_account: 'acct_1',
    stripe_transfer_id: null,
    livemode: true,
    status,
    attempt_count: 1,
    last_attempt_at: STAMP,
    failure_reason: status === 'FAILED' ? 'balance_insufficient' : null,
    trigger: 'cron',
    paid_at: null,
    created_at: STAMP,
    updated_at: STAMP,
    ...overrides,
  };
}

function render(locale: AffiliateLocale, autoRetry: readonly string[]) {
  const t = createAffiliatesCopy({ locale, dictionary: PORTAL_UI_COPY });
  return renderToStaticMarkup(
    <PayoutsTable
      rows={[payout(AUTO, 'FAILED'), payout(REVIEW, 'FAILED', { attempt_count: 5 })]}
      autoRetryPayoutIds={new Set(autoRetry)}
      t={t}
      locale={locale}
      caption="Payout history"
    />,
  );
}

describe('PayoutsTable failed payout notes', () => {
  it('promises an automatic retry only for the payouts the cycle retries', () => {
    const html = render('en', [AUTO]);
    expect(html.match(/We&#x27;ll try again automatically\./g)).toHaveLength(1);
    expect(html.match(/We&#x27;ll look into it and send it again\./g)).toHaveLength(1);
  });

  it('says every failed payout waits for review when none is retried automatically', () => {
    const html = render('en', []);
    expect(html).not.toContain('try again automatically');
    expect(html.match(/We&#x27;ll look into it and send it again\./g)).toHaveLength(2);
  });

  it('reads in French', () => {
    const html = render('fr', [AUTO]);
    expect(html).toContain('Nous réessaierons automatiquement.');
    expect(html).toContain('Nous allons vérifier la situation et vous le renvoyer.');
  });
});

describe('PayoutsTable PayPal rows (02037)', () => {
  const paypal = (id: string, status: AffiliatePayoutStatus, overrides: Partial<AffiliatePayoutRow> = {}) =>
    payout(id, status, {
      stripe_destination_account: '',
      method: 'paypal',
      paypal_receiver: 'jane@paypal.example',
      paypal_fee_cents: 25,
      failure_reason: null,
      ...overrides,
    });

  function renderRows(rows: AffiliatePayoutRow[], locale: AffiliateLocale = 'en', autoRetry: readonly string[] = []) {
    const t = createAffiliatesCopy({ locale, dictionary: PORTAL_UI_COPY });
    return renderToStaticMarkup(
      <PayoutsTable rows={rows} autoRetryPayoutIds={new Set(autoRetry)} t={t} locale={locale} caption="Payout history" />,
    ).replace(/&#x27;/g, "'");
  }

  it('reads each state as "PayPal · {status}", with the transaction id once paid and where to claim it while PayPal waits', () => {
    const html = renderRows([
      paypal('a0000000-0000-4000-8000-000000000001', 'COMPLETED', {
        paid_at: STAMP,
        paypal_item_status: 'SUCCESS',
        paypal_transaction_id: '5TY12345AB678901C',
      }),
      paypal('a0000000-0000-4000-8000-000000000002', 'PROCESSING', { paypal_item_status: null }),
      paypal('a0000000-0000-4000-8000-000000000003', 'PROCESSING', { paypal_item_status: 'ONHOLD' }),
      paypal('a0000000-0000-4000-8000-000000000004', 'PROCESSING', { paypal_item_status: 'UNCLAIMED' }),
    ]);
    expect(html).toContain('PayPal · Paid');
    expect(html).toContain('Transaction 5TY12345AB678901C');
    expect(html.match(/PayPal · Sent/g)).toHaveLength(2);
    expect(html).toContain('PayPal · Waiting for you to claim it');
    expect(html).toContain('Claim it in PayPal: check the email PayPal sent to jane@paypal.example.');
    expect(html).not.toContain('Being sent to your bank.');
    expect(html).not.toContain('Ref. ');
  });

  it('says a payout PayPal did not pay went back to the balance: returned when the money came back, else not sent, never a Stripe retry promise', () => {
    const RETURNED = 'b0000000-0000-4000-8000-000000000001';
    const html = renderRows(
      [
        paypal(RETURNED, 'FAILED', { paypal_item_status: 'RETURNED', failure_reason: 'paypal_returned' }),
        paypal('b0000000-0000-4000-8000-000000000002', 'FAILED', { paypal_item_status: 'RETURNED', failure_reason: 'paypal_cancelled' }),
        paypal('b0000000-0000-4000-8000-000000000003', 'FAILED', { paypal_item_status: null, failure_reason: 'paypal_insufficient_funds' }),
        paypal('b0000000-0000-4000-8000-000000000004', 'FAILED', { paypal_item_status: 'BLOCKED', failure_reason: 'paypal_blocked' }),
      ],
      'en',
      // even if a caller listed one as retried by the daily Stripe cycle
      [RETURNED],
    );
    expect(html.match(/PayPal · Returned/g)).toHaveLength(2);
    expect(html.match(/PayPal · Not sent/g)).toHaveLength(2);
    expect(html.match(/The amount went back to your balance\./g)).toHaveLength(4);
    expect(html).not.toContain('The transfer failed');
    expect(html).not.toContain('try again automatically');
  });

  it('never shows the store’s PayPal fee', () => {
    const html = renderRows([paypal('c0000000-0000-4000-8000-000000000001', 'COMPLETED', { paid_at: STAMP, paypal_transaction_id: 'TX1', paypal_fee_cents: 1234 })]);
    expect(html).not.toContain('12.34');
  });

  it('reads in French', () => {
    const html = renderRows(
      [
        paypal('d0000000-0000-4000-8000-000000000001', 'COMPLETED', { paid_at: STAMP, paypal_transaction_id: '5TY12345AB678901C' }),
        paypal('d0000000-0000-4000-8000-000000000002', 'FAILED', { paypal_item_status: 'RETURNED', failure_reason: 'paypal_returned' }),
      ],
      'fr',
    );
    expect(html).toContain('PayPal · Payé');
    expect(html).toContain('PayPal · Retourné');
    expect(html).toContain('Le montant est retourné dans votre solde.');
  });
});

describe('CommissionsTable Payout column', () => {
  it('names PayPal for a commission PayPal pays (02037), Stripe and direct payouts as before', () => {
    const t = createAffiliatesCopy({ locale: 'en', dictionary: PORTAL_UI_COPY });
    const commission = (id: string) => ({
      id,
      affiliate_id: '33333333-3333-4333-8333-333333333333',
      order_id: null,
      gateway: 'FREEMIUS' as const,
      order_currency: 'USD',
      order_net_amount_minor: 10000,
      exchange_rate_snapshot: 1,
      net_order_amount_cents: 10000,
      commission_rate_snapshot: 10,
      commission_amount_cents: 1000,
      refunded_amount_cents: 0,
      refund_pending_cents: 0,
      void_requested_at: null,
      disputed_at: null,
      livemode: true,
      currency: 'USD',
      status: 'CLEARED' as const,
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
    });
    const html = renderToStaticMarkup(
      <CommissionsTable
        rows={[commission('e1'), commission('e2'), commission('e3')]}
        t={t}
        locale="en"
        caption="Commissions"
        payoutMethods={{ e1: 'paypal', e2: 'stripe_connect', e3: 'manual' }}
      />,
    );
    expect(html).toContain('>PayPal</td>');
    expect(html).toContain('>Stripe transfer</td>');
    expect(html).toContain('>Sent directly</td>');
  });
});
