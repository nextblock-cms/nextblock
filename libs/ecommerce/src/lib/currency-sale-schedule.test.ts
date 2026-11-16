import { describe, expect, it } from 'vitest';

import {
  isSaleWindowActive,
  isScheduledPriceDue,
  resolveEffectivePriceForCurrency,
  type CurrencyRecord,
} from './currency';

const currencies: CurrencyRecord[] = [
  { code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true },
];

const START = '2026-06-01T00:00:00.000Z';
const END = '2026-06-10T00:00:00.000Z';
const WITHIN = new Date('2026-06-05T00:00:00.000Z');
const BEFORE = new Date('2026-05-01T00:00:00.000Z');
const AFTER = new Date('2026-06-20T00:00:00.000Z');

describe('isSaleWindowActive', () => {
  it('is always active when both bounds are null (legacy static sales)', () => {
    expect(isSaleWindowActive({ now: WITHIN })).toBe(true);
    expect(isSaleWindowActive({ saleStartAt: null, saleEndAt: null, now: WITHIN })).toBe(true);
  });

  it('respects the closed window', () => {
    expect(isSaleWindowActive({ saleStartAt: START, saleEndAt: END, now: BEFORE })).toBe(false);
    expect(isSaleWindowActive({ saleStartAt: START, saleEndAt: END, now: WITHIN })).toBe(true);
    expect(isSaleWindowActive({ saleStartAt: START, saleEndAt: END, now: AFTER })).toBe(false);
  });

  it('treats the end bound as exclusive and the start as inclusive', () => {
    expect(isSaleWindowActive({ saleStartAt: START, now: new Date(START) })).toBe(true);
    expect(isSaleWindowActive({ saleEndAt: END, now: new Date(END) })).toBe(false);
  });

  it('supports open-ended windows', () => {
    expect(isSaleWindowActive({ saleStartAt: START, now: AFTER })).toBe(true);
    expect(isSaleWindowActive({ saleEndAt: END, now: BEFORE })).toBe(true);
  });
});

describe('isScheduledPriceDue', () => {
  it('is not due without a timestamp', () => {
    expect(isScheduledPriceDue({ now: WITHIN })).toBe(false);
    expect(isScheduledPriceDue({ scheduledPriceAt: null, now: WITHIN })).toBe(false);
  });

  it('is due only once the effective time has passed', () => {
    expect(isScheduledPriceDue({ scheduledPriceAt: END, now: BEFORE })).toBe(false);
    expect(isScheduledPriceDue({ scheduledPriceAt: START, now: AFTER })).toBe(true);
  });
});

describe('resolveEffectivePriceForCurrency', () => {
  it('returns the sale price only while the window is active', () => {
    const active = resolveEffectivePriceForCurrency({
      prices: { USD: 10000 },
      salePrices: { USD: 8000 },
      fallbackPrice: 10000,
      fallbackSalePrice: 8000,
      saleStartAt: START,
      saleEndAt: END,
      currencyCode: 'USD',
      currencies,
      now: WITHIN,
    });
    expect(active.price).toBe(10000);
    expect(active.sale_price).toBe(8000);

    const inactive = resolveEffectivePriceForCurrency({
      prices: { USD: 10000 },
      salePrices: { USD: 8000 },
      fallbackPrice: 10000,
      fallbackSalePrice: 8000,
      saleStartAt: START,
      saleEndAt: END,
      currencyCode: 'USD',
      currencies,
      now: AFTER,
    });
    expect(inactive.price).toBe(10000);
    expect(inactive.sale_price).toBeNull();
  });

  it('applies a scheduled regular-price change once due', () => {
    const beforeChange = resolveEffectivePriceForCurrency({
      prices: { USD: 10000 },
      fallbackPrice: 10000,
      scheduledPrice: 12000,
      scheduledPrices: { USD: 12000 },
      scheduledPriceAt: END,
      currencyCode: 'USD',
      currencies,
      now: WITHIN,
    });
    expect(beforeChange.price).toBe(10000);

    const afterChange = resolveEffectivePriceForCurrency({
      prices: { USD: 10000 },
      fallbackPrice: 10000,
      scheduledPrice: 12000,
      scheduledPrices: { USD: 12000 },
      scheduledPriceAt: START,
      currencyCode: 'USD',
      currencies,
      now: AFTER,
    });
    expect(afterChange.price).toBe(12000);
  });

  it('suppresses a sale price that exceeds the regular price (fail-safe)', () => {
    const resolved = resolveEffectivePriceForCurrency({
      prices: { USD: 10000 },
      salePrices: { USD: 12000 },
      fallbackPrice: 10000,
      fallbackSalePrice: 12000,
      saleStartAt: START,
      saleEndAt: END,
      currencyCode: 'USD',
      currencies,
      now: WITHIN,
    });
    expect(resolved.sale_price).toBeNull();
  });
});
