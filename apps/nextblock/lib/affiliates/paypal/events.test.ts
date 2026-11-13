import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The partner side of PayPal Payouts (02037): every PayPal payout event of the run, "Check PayPal
 * status now" and the CMS Cancel comes through `dispatchAffiliatePayPalPayoutEvent`, which schedules
 * the notifications. PAYOUT_SENT mails the partner (the PayPal variant), PAYOUT_FAILED mails the admins
 * (their wording of the reason) and the partner (PAYPAL_PAYOUT_FAILED with the run's code, worded per
 * locale by the template), PAYPAL_UNCLAIMED mails the partner with the address PayPal emailed. It
 * never throws: a notification never changes a money outcome.
 */

const mocks = vi.hoisted(() => ({
  notify: vi.fn(async () => undefined),
  schedule: vi.fn((task: () => unknown) => {
    void task();
  }),
}));

vi.mock('../notify', () => ({
  notifyAffiliateLifecycle: mocks.notify,
  scheduleAffiliateNotification: mocks.schedule,
}));

import type { AffiliatePayPalAlert, AffiliatePayPalEventPayout } from './engine';
import { describeAffiliatePayPalAlert, dispatchAffiliatePayPalPayoutEvent } from './events';

const PAYOUT: AffiliatePayPalEventPayout = {
  payoutId: '11111111-1111-4111-8111-111111111111',
  affiliateId: '22222222-2222-4222-8222-222222222222',
  amountCents: 4500,
  currency: 'USD',
  receiver: 'jane@paypal.example',
  environment: 'live',
};

beforeEach(() => {
  mocks.notify.mockClear();
  mocks.schedule.mockClear();
});

describe('dispatchAffiliatePayPalPayoutEvent', () => {
  it('mails the partner a payout PayPal paid, with PayPal’s transaction id', () => {
    dispatchAffiliatePayPalPayoutEvent({ type: 'PAYOUT_SENT', payout: PAYOUT, transactionId: '5TY12345AB678901C', feeCents: 25 });
    expect(mocks.notify.mock.calls).toEqual([
      [
        'PAYOUT_SENT',
        {
          affiliateId: PAYOUT.affiliateId,
          payout: { payoutId: PAYOUT.payoutId, amountCents: 4500, currency: 'USD', transferId: '5TY12345AB678901C', method: 'paypal' },
        },
      ],
    ]);
    // after the response, never on the run's own path
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
  });

  it('tells the admins and the partner about a payout PayPal would not pay, each in their own words', () => {
    dispatchAffiliatePayPalPayoutEvent({
      type: 'PAYOUT_FAILED',
      payout: PAYOUT,
      reason: 'paypal_failed:receiver_unregistered',
      itemStatus: 'FAILED',
      cancelledByAdmin: false,
    });
    expect(mocks.schedule).toHaveBeenCalledTimes(2);
    const [admin, partner] = mocks.notify.mock.calls as unknown as Array<[string, { payout: Record<string, unknown> }]>;
    expect(admin?.[0]).toBe('PAYOUT_FAILED');
    expect(admin?.[1].payout).toMatchObject({ method: 'paypal', reason: 'PayPal could not pay it (RECEIVER_UNREGISTERED).' });
    expect(partner?.[0]).toBe('PAYPAL_PAYOUT_FAILED');
    expect(partner?.[1]).toEqual({
      affiliateId: PAYOUT.affiliateId,
      payout: { payoutId: PAYOUT.payoutId, amountCents: 4500, currency: 'USD', reason: 'paypal_failed:receiver_unregistered', method: 'paypal' },
    });
  });

  it('tells only the partner when an admin stopped their unclaimed payout: no admin alert or email for the admin’s own action', () => {
    dispatchAffiliatePayPalPayoutEvent({ type: 'PAYOUT_FAILED', payout: PAYOUT, reason: 'paypal_cancelled', itemStatus: 'RETURNED', cancelledByAdmin: true });
    expect(mocks.notify.mock.calls.map(([event]) => event)).toEqual(['PAYPAL_PAYOUT_FAILED']);
    expect((mocks.notify.mock.calls[0] as unknown as [string, { payout: { reason: string } }])[1].payout.reason).toBe('paypal_cancelled');
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
  });

  it('mails the partner a payout waiting to be claimed, with the address PayPal emailed', () => {
    dispatchAffiliatePayPalPayoutEvent({ type: 'PAYPAL_UNCLAIMED', payout: PAYOUT });
    expect(mocks.notify.mock.calls).toEqual([
      [
        'PAYPAL_UNCLAIMED',
        {
          affiliateId: PAYOUT.affiliateId,
          payout: { payoutId: PAYOUT.payoutId, amountCents: 4500, currency: 'USD', method: 'paypal', receiver: 'jane@paypal.example' },
        },
      ],
    ]);
  });

  it('words each unresolved batch by its cause, and never says a resend PayPal refused was released', () => {
    const base: AffiliatePayPalAlert = { kind: 'paypal_batch_unresolved', environment: 'live', payouts: 2, senderBatchId: 'sb-1', currency: 'USD', amountCents: 9000 };
    const funds = describeAffiliatePayPalAlert({ ...base, cause: 'insufficient_funds', code: 'INSUFFICIENT_FUNDS' });
    expect(funds).toContain('PayPal could not send the live batch sb-1 again (INSUFFICIENT_FUNDS)');
    expect(funds).toContain('stay in flight so nothing is paid twice');
    expect(funds).toContain('Add USD to your PayPal balance');
    expect(funds).not.toContain('went back to what is owed');
    const credentials = describeAffiliatePayPalAlert({ ...base, cause: 'credentials', code: 'INVALID_CLIENT' });
    expect(credentials).toContain('could not be sent again');
    expect(credentials).not.toContain('nothing was sent or checked');
    expect(describeAffiliatePayPalAlert({ ...base, cause: 'not_enabled', code: 'NOT_AUTHORIZED' })).toContain('Request access at https://www.paypal.com/');
    const expired = describeAffiliatePayPalAlert({ ...base, cause: 'expired', code: 'RESEND_WINDOW_PASSED' });
    expect(expired).toContain('first sent over 25 days ago, so it is not sent again');
    expect(expired).toContain('if PayPal paid it, do not release them');
    expect(describeAffiliatePayPalAlert({ ...base, cause: 'unreadable', batchId: 'BATCH9', code: 'INVALID_RESOURCE_ID' })).toContain(
      'PayPal would not show the live batch BATCH9 (INVALID_RESOURCE_ID)'
    );
    expect(describeAffiliatePayPalAlert({ ...base, cause: 'not_recorded', batchId: 'BATCH9' })).toContain('PayPal may pay them');
    expect(describeAffiliatePayPalAlert({ ...base, cause: 'malformed' })).toContain('its answer could not be read');
    expect(describeAffiliatePayPalAlert({ ...base, kind: 'paypal_currency_unsupported', currency: 'KRW', code: 'CURRENCY_NOT_SUPPORTED' })).toContain(
      'PayPal Payouts does not send KRW'
    );
    expect(describeAffiliatePayPalAlert({ ...base, kind: 'paypal_currency_unsupported', currency: 'HUF', code: 'NOT_WHOLE_UNITS' })).toContain(
      'PayPal sends HUF in whole units only'
    );
  });

  it('never throws, whatever the scheduler does', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.schedule.mockImplementationOnce(() => {
      throw new Error('after() outside a request');
    });
    expect(() => dispatchAffiliatePayPalPayoutEvent({ type: 'PAYPAL_UNCLAIMED', payout: PAYOUT })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    // the warning names the event type, never the partner's address
    expect(JSON.stringify(warn.mock.calls)).not.toContain('jane@paypal.example');
    warn.mockRestore();
  });
});
