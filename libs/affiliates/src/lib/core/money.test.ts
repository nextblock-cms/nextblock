import { formatPrice } from '@nextblock-cms/utils';
import { describe, expect, it } from 'vitest';

import {
  affiliateCommissionNetMinor,
  computeAffiliateCommissionMinor,
  convertAffiliateAmountToBaseMinor,
  formatAffiliateMoney,
} from './money';

/** Exact reference: round-half-up of net × basisPoints / 10000, in BigInt. */
function exactCommission(netMinor: number, ratePercent: number): number {
  const basisPoints = BigInt(Math.round(ratePercent * 100));
  return Number((BigInt(netMinor) * basisPoints + 5000n) / 10000n);
}

describe('computeAffiliateCommissionMinor', () => {
  it('applies the tier rate to the base-currency net', () => {
    expect(computeAffiliateCommissionMinor({ netMinor: 10000, ratePercent: 50 })).toBe(5000);
    expect(computeAffiliateCommissionMinor({ netMinor: 999, ratePercent: 33.33 })).toBe(333);
    expect(computeAffiliateCommissionMinor({ netMinor: 12345, ratePercent: 10 })).toBe(1235);
  });

  it('rounds halves up like Postgres round() on a non-negative numeric', () => {
    expect(computeAffiliateCommissionMinor({ netMinor: 1, ratePercent: 50 })).toBe(1);
    expect(computeAffiliateCommissionMinor({ netMinor: 3, ratePercent: 50 })).toBe(2);
    expect(computeAffiliateCommissionMinor({ netMinor: 1005, ratePercent: 35.5 })).toBe(357);
  });

  it('matches exact arithmetic across many amounts and two-decimal rates', () => {
    for (let net = 0; net <= 50_000; net += 97) {
      for (const rate of [0.01, 0.7, 1.1, 9.99, 10, 12.5, 20, 33.33, 35, 49.99, 50, 66.67, 99.99, 100]) {
        expect(computeAffiliateCommissionMinor({ netMinor: net, ratePercent: rate }), `${net} @ ${rate}%`).toBe(
          exactCommission(net, rate)
        );
      }
    }
  });

  it('is zero for nonsense inputs and caps the rate at 100%', () => {
    expect(computeAffiliateCommissionMinor({ netMinor: 0, ratePercent: 50 })).toBe(0);
    expect(computeAffiliateCommissionMinor({ netMinor: -500, ratePercent: 50 })).toBe(0);
    expect(computeAffiliateCommissionMinor({ netMinor: 500, ratePercent: -5 })).toBe(0);
    expect(computeAffiliateCommissionMinor({ netMinor: Number.NaN, ratePercent: 50 })).toBe(0);
    expect(computeAffiliateCommissionMinor({ netMinor: 500, ratePercent: 150 })).toBe(500);
  });
});

describe('convertAffiliateAmountToBaseMinor (the SQL formula)', () => {
  it('keeps same-currency amounts as they are', () => {
    expect(convertAffiliateAmountToBaseMinor({ amountMinor: 4321, fromCurrency: 'usd', toCurrency: 'USD', exchangeRate: 1.37 })).toBe(4321);
  });

  it('divides by the purchase rate (order currency per base unit) across minor-unit factors', () => {
    // €90.00 at 0.9 EUR per USD = $100.00
    expect(convertAffiliateAmountToBaseMinor({ amountMinor: 9000, fromCurrency: 'EUR', toCurrency: 'USD', exchangeRate: 0.9 })).toBe(10000);
    // ¥15,000 at 150 JPY per USD = $100.00 (JPY has no minor unit)
    expect(convertAffiliateAmountToBaseMinor({ amountMinor: 15000, fromCurrency: 'JPY', toCurrency: 'USD', exchangeRate: 150 })).toBe(10000);
    // $100.00 order in a JPY store: 1/150 USD per JPY
    expect(convertAffiliateAmountToBaseMinor({ amountMinor: 10000, fromCurrency: 'USD', toCurrency: 'JPY', exchangeRate: 1 / 150 })).toBe(15000);
    // CA$13.70 at 1.37 CAD per USD = $10.00
    expect(convertAffiliateAmountToBaseMinor({ amountMinor: 1370, fromCurrency: 'CAD', toCurrency: 'USD', exchangeRate: 1.37 })).toBe(1000);
  });

  it('is zero for an empty amount and refuses an impossible rate', () => {
    expect(convertAffiliateAmountToBaseMinor({ amountMinor: 0, fromCurrency: 'EUR', toCurrency: 'USD', exchangeRate: 0 })).toBe(0);
    expect(convertAffiliateAmountToBaseMinor({ amountMinor: -10, fromCurrency: 'EUR', toCurrency: 'USD', exchangeRate: 0.9 })).toBe(0);
    expect(() => convertAffiliateAmountToBaseMinor({ amountMinor: 100, fromCurrency: 'EUR', toCurrency: 'USD', exchangeRate: 0 })).toThrow(RangeError);
    expect(() =>
      convertAffiliateAmountToBaseMinor({ amountMinor: 100, fromCurrency: 'EUR', toCurrency: 'USD', exchangeRate: Number.NaN })
    ).toThrow(RangeError);
  });
});

describe('affiliateCommissionNetMinor', () => {
  it('subtracts partial refunds and never goes negative', () => {
    expect(affiliateCommissionNetMinor({ commission_amount_cents: 5000, refunded_amount_cents: 1250 })).toBe(3750);
    expect(affiliateCommissionNetMinor({ commission_amount_cents: 5000, refunded_amount_cents: 0 })).toBe(5000);
    expect(affiliateCommissionNetMinor({ commission_amount_cents: 1000, refunded_amount_cents: 5000 })).toBe(0);
  });
});

describe('formatAffiliateMoney', () => {
  it('formats French as fr-CA and everything else as en-US', () => {
    expect(formatAffiliateMoney(123456, 'USD', 'en')).toBe('$1,234.56');
    expect(formatAffiliateMoney(123456, 'USD', 'es')).toBe('$1,234.56');
    expect(formatAffiliateMoney(123456, 'CAD', 'fr')).toBe(formatPrice(123456, 'CAD', 'fr-CA'));
    expect(formatAffiliateMoney(123456, 'CAD', 'fr-CA')).toBe(formatPrice(123456, 'CAD', 'fr-CA'));
    expect(formatAffiliateMoney(1500, 'JPY', 'en')).toBe('¥1,500');
  });
});
