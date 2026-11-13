import { describe, expect, it } from 'vitest';

import {
  affiliateGatewaysPaidByPayPal,
  affiliateGatewaysPaidByStripe,
  affiliateGatewaysPaidManually,
  affiliateGatewaysPaidOutsideStripe,
  affiliatePayoutMethodForGateway,
  defaultAffiliatePayoutMethods,
  isAffiliatePayPalPayoutReceiver,
  isAffiliatePayPalReceiverFailureReason,
  normalizeAffiliatePayoutEmail,
  normalizeAffiliatePayoutEmailKind,
  normalizeAffiliatePayoutMethods,
} from './payout-methods';
import {
  AFFILIATE_MANUAL_PAYOUT_CHANNELS,
  AFFILIATE_PAYOUT_EMAIL_KINDS,
  AFFILIATE_PAYOUT_METHODS,
  isAffiliateManualPayoutChannel,
  isAffiliatePayoutEmailKind,
  isAffiliatePayoutMethod,
} from './statuses';

describe('payout methods (affiliates_settings.payoutMethods)', () => {
  it('defaults both gateways to Stripe Connect, the behaviour before 02036', () => {
    expect(defaultAffiliatePayoutMethods()).toEqual({ stripeSales: 'stripe_connect', freemiusSales: 'stripe_connect' });
    // A fresh object every time (callers may mutate it).
    expect(defaultAffiliatePayoutMethods()).not.toBe(defaultAffiliatePayoutMethods());
  });

  it('reads unknown, missing or malformed choices as the default', () => {
    for (const value of [undefined, null, 'manual', 42, [], { stripeSales: 'PayPal', freemiusSales: 'MANUAL' }, { stripeSales: true }, { freemiusSales: 'venmo' }]) {
      expect(normalizeAffiliatePayoutMethods(value), JSON.stringify(value)).toEqual(defaultAffiliatePayoutMethods());
    }
    expect(normalizeAffiliatePayoutMethods({ stripeSales: 'stripe_connect', freemiusSales: 'manual', extra: 'dropped' })).toEqual({
      stripeSales: 'stripe_connect',
      freemiusSales: 'manual',
    });
    // 02037: PayPal is a choice of its own
    expect(normalizeAffiliatePayoutMethods({ stripeSales: 'stripe_connect', freemiusSales: 'paypal' })).toEqual({
      stripeSales: 'stripe_connect',
      freemiusSales: 'paypal',
    });
  });

  it('routes PayPal gateways to PayPal, never to Stripe or to the manual list (02037)', () => {
    const freemiusPayPal = { payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'paypal' } };
    expect(affiliateGatewaysPaidByPayPal(freemiusPayPal)).toEqual(['FREEMIUS']);
    expect(affiliateGatewaysPaidByStripe(freemiusPayPal)).toEqual(['STRIPE']);
    expect(affiliateGatewaysPaidManually(freemiusPayPal)).toEqual([]);
    expect(affiliateGatewaysPaidOutsideStripe(freemiusPayPal)).toEqual(['FREEMIUS']);
    expect(affiliatePayoutMethodForGateway(freemiusPayPal, 'FREEMIUS')).toBe('paypal');

    const mixed = { payoutMethods: { stripeSales: 'manual', freemiusSales: 'paypal' } };
    expect(affiliateGatewaysPaidOutsideStripe(mixed)).toEqual(['STRIPE', 'FREEMIUS']);
    expect(affiliateGatewaysPaidByPayPal(mixed)).toEqual(['FREEMIUS']);
    expect(affiliateGatewaysPaidManually(mixed)).toEqual(['STRIPE']);
    expect(affiliateGatewaysPaidByStripe(mixed)).toEqual([]);

    for (const settings of [null, undefined, {}, { payoutMethods: 'nope' }]) {
      expect(affiliateGatewaysPaidByPayPal(settings)).toEqual([]);
      expect(affiliateGatewaysPaidOutsideStripe(settings)).toEqual([]);
    }
  });

  it('pays a PayPal account automatically, and an Interac address, a long or a formula-first email never (02037)', () => {
    expect(isAffiliatePayPalPayoutReceiver('jane@example.com', 'paypal')).toBe(true);
    // the column default: a missing kind is a PayPal account
    expect(isAffiliatePayPalPayoutReceiver('jane@example.com', undefined)).toBe(true);
    expect(isAffiliatePayPalPayoutReceiver('jane@example.com', 'interac')).toBe(false);
    expect(isAffiliatePayPalPayoutReceiver('', 'paypal')).toBe(false);
    expect(isAffiliatePayPalPayoutReceiver(null, 'paypal')).toBe(false);
    // stored addresses are normalized: an unnormalized one is not paid automatically
    expect(isAffiliatePayPalPayoutReceiver('Jane@Example.com', 'paypal')).toBe(false);
    expect(isAffiliatePayPalPayoutReceiver('+jane@example.com', 'paypal')).toBe(false);
    // PayPal's receiver takes at most 127 characters
    const long = `${'a'.repeat(116)}@example.com`;
    expect(long.length).toBe(128);
    expect(isAffiliatePayPalPayoutReceiver(long, 'paypal')).toBe(false);
    expect(isAffiliatePayPalPayoutReceiver(long.slice(1), 'paypal')).toBe(true);
  });

  it('reads the payout email kind as the column does', () => {
    expect([...AFFILIATE_PAYOUT_EMAIL_KINDS]).toEqual(['paypal', 'interac']);
    expect(normalizeAffiliatePayoutEmailKind('interac')).toBe('interac');
    for (const value of ['paypal', undefined, null, 'INTERAC', 'venmo', 42]) expect(normalizeAffiliatePayoutEmailKind(value)).toBe('paypal');
    expect(isAffiliatePayoutEmailKind('paypal')).toBe(true);
    expect(isAffiliatePayoutEmailKind('PayPal')).toBe(false);
  });

  it('routes each gateway by its own choice, in AFFILIATE_GATEWAYS order', () => {
    const freemiusManual = { payoutMethods: { stripeSales: 'stripe_connect', freemiusSales: 'manual' } };
    expect(affiliateGatewaysPaidByStripe(freemiusManual)).toEqual(['STRIPE']);
    expect(affiliateGatewaysPaidManually(freemiusManual)).toEqual(['FREEMIUS']);
    expect(affiliatePayoutMethodForGateway(freemiusManual, 'FREEMIUS')).toBe('manual');
    expect(affiliatePayoutMethodForGateway(freemiusManual, 'STRIPE')).toBe('stripe_connect');

    const allManual = { payoutMethods: { stripeSales: 'manual', freemiusSales: 'manual' } };
    expect(affiliateGatewaysPaidByStripe(allManual)).toEqual([]);
    expect(affiliateGatewaysPaidManually(allManual)).toEqual(['STRIPE', 'FREEMIUS']);

    // Settings without the field (an older row, a test double) pay everything through Stripe.
    for (const settings of [null, undefined, {}, { payoutMethods: 'nope' }]) {
      expect(affiliateGatewaysPaidByStripe(settings)).toEqual(['STRIPE', 'FREEMIUS']);
      expect(affiliateGatewaysPaidManually(settings)).toEqual([]);
    }
  });

  it('lists the CHECK values of 02036 and 02037', () => {
    expect([...AFFILIATE_PAYOUT_METHODS]).toEqual(['stripe_connect', 'paypal', 'manual']);
    expect(isAffiliatePayoutMethod('paypal')).toBe(true);
    expect([...AFFILIATE_MANUAL_PAYOUT_CHANNELS]).toEqual(['paypal', 'interac', 'wise', 'bank_transfer', 'other']);
    expect(isAffiliatePayoutMethod('manual')).toBe(true);
    expect(isAffiliatePayoutMethod('Manual')).toBe(false);
    expect(isAffiliateManualPayoutChannel('interac')).toBe(true);
    expect(isAffiliateManualPayoutChannel('venmo')).toBe(false);
  });
});

describe('isAffiliatePayPalReceiverFailureReason (02037)', () => {
  it('names the PayPal failures caused by the address, which stop PayPal there until the partner saves their payout email again', () => {
    for (const reason of [
      'paypal_returned',
      'paypal_returned:receiver_unregistered',
      'paypal_blocked',
      'paypal_refunded',
      'paypal_reversed',
      'paypal_cancelled',
      'paypal_canceled',
      'paypal_failed:receiver_unregistered',
      'paypal_failed:receiver_account_locked',
      'paypal_failed:self_pay',
      ' PAYPAL_RETURNED ',
    ]) {
      expect(isAffiliatePayPalReceiverFailureReason(reason), reason).toBe(true);
    }
    // the operator's side, a refused batch, an admin release, a Stripe reason: the next run pays the address again
    for (const reason of [
      'paypal_failed',
      'paypal_failed:insufficient_funds',
      'paypal_denied',
      'paypal_insufficient_funds',
      'paypal_refused:validation_error',
      'paypal_released_by_admin',
      'released',
      '',
      null,
      42,
    ]) {
      expect(isAffiliatePayPalReceiverFailureReason(reason), String(reason)).toBe(false);
    }
  });
});

describe('normalizeAffiliatePayoutEmail', () => {
  it('trims and lowercases a deliverable-looking address; blank clears it', () => {
    expect(normalizeAffiliatePayoutEmail('  Jane.Doe+PayPal@Example.COM ')).toBe('jane.doe+paypal@example.com');
    expect(normalizeAffiliatePayoutEmail('')).toBe('');
    expect(normalizeAffiliatePayoutEmail('   ')).toBe('');
    expect(normalizeAffiliatePayoutEmail(null)).toBe('');
    expect(normalizeAffiliatePayoutEmail(undefined)).toBe('');
  });

  it('refuses anything a mail header, a CSV cell or a PayPal recipient field should not hold', () => {
    for (const value of [
      'no-at-sign',
      'two@@example.com',
      'a@b@example.com',
      'jane doe@example.com',
      'jane@example',
      '"jane"@example.com',
      'jane,doe@example.com',
      '<jane@example.com>',
      'jane@example.com\r\nBcc: x@y.z',
      'jane@exa_mple.com',
      `${'a'.repeat(250)}@example.com`,
      42,
      {},
    ]) {
      expect(normalizeAffiliatePayoutEmail(value), String(value)).toBeNull();
    }
  });

  it('refuses a first character a spreadsheet reads as a formula (the PayPal file would have to rewrite the recipient)', () => {
    // '+x@' and '-x@' are valid local parts elsewhere; an apostrophe in front would make PayPal pay a different address.
    for (const value of ['+x@example.com', '-x@example.com', ' -Sales@Example.COM ', '=x@example.com', '@x@example.com', '+1-555@example.com']) {
      expect(normalizeAffiliatePayoutEmail(value), value).toBeNull();
    }
    // the same characters are fine further in
    expect(normalizeAffiliatePayoutEmail('x+paypal@example.com')).toBe('x+paypal@example.com');
    expect(normalizeAffiliatePayoutEmail('jean-luc@example.com')).toBe('jean-luc@example.com');
  });
});
