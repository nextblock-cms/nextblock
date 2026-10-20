import { describe, expect, it } from 'vitest';

import {
  MAX_CHECKOUT_LINE_QUANTITY,
  isValidCheckoutQuantity,
  normalizeCheckoutItems,
} from './checkout-items';

const PRODUCT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRODUCT_B = 'aaaaaaaa-0000-0000-0000-000000000002';
const VARIANT_1 = 'bbbbbbbb-0000-0000-0000-000000000001';

function line(overrides: Record<string, unknown>) {
  return { id: PRODUCT_A, product_id: PRODUCT_A, title: 'Live Product', quantity: 1, ...overrides };
}

describe('isValidCheckoutQuantity', () => {
  it('accepts positive integers up to the ceiling', () => {
    expect(isValidCheckoutQuantity(1)).toBe(true);
    expect(isValidCheckoutQuantity(MAX_CHECKOUT_LINE_QUANTITY)).toBe(true);
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 1.5],
    ['above the ceiling', MAX_CHECKOUT_LINE_QUANTITY + 1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '2'],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isValidCheckoutQuantity(value)).toBe(false);
  });
});

describe('normalizeCheckoutItems', () => {
  it('rejects the negative-quantity repro before any line is priced', () => {
    const result = normalizeCheckoutItems([line({ quantity: 1 }), line({ quantity: -5 })]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        errorKey: 'ecommerce.checkout_invalid_items',
        errorStatus: 400,
      });
    }
  });

  it.each([
    ['an empty cart', []],
    ['a non-array', { product_id: PRODUCT_A, quantity: 1 }],
    ['a null line', [null]],
    ['a line without product_id', [line({ product_id: undefined })]],
    ['a blank product_id', [line({ product_id: '   ' })]],
    ['a non-string variant_id', [line({ variant_id: 42 })]],
    ['a zero quantity', [line({ quantity: 0 })]],
    ['a fractional quantity', [line({ quantity: 2.5 })]],
    ['a string quantity', [line({ quantity: '3' })]],
    ['an absurd quantity', [line({ quantity: 1_000_000 })]],
  ])('rejects %s', (_label, items) => {
    expect(normalizeCheckoutItems(items).ok).toBe(false);
  });

  it('merges duplicate product lines into one, summing the quantity', () => {
    const result = normalizeCheckoutItems([
      line({ quantity: 1, title: 'first' }),
      line({ product_id: PRODUCT_B, quantity: 4 }),
      line({ quantity: 2, title: 'second' }),
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(2);
      // The first occurrence's fields survive; only the quantity is combined.
      expect(result.items[0]).toMatchObject({ product_id: PRODUCT_A, quantity: 3, title: 'first' });
      expect(result.items[1]).toMatchObject({ product_id: PRODUCT_B, quantity: 4 });
    }
  });

  it('keeps variant lines of the same product apart', () => {
    const result = normalizeCheckoutItems([
      line({ quantity: 1 }),
      line({ quantity: 2, variant_id: VARIANT_1 }),
      line({ quantity: 3, variant_id: '' }),
      line({ quantity: 4, variant_id: null }),
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // '', null and undefined all mean "base product" (getCartLineCouponKey).
      expect(result.items.map((item) => [item.variant_id || null, item.quantity])).toEqual([
        [null, 8],
        [VARIANT_1, 2],
      ]);
    }
  });

  it('applies the ceiling to the merged quantity, not only to each line', () => {
    const half = MAX_CHECKOUT_LINE_QUANTITY / 2;
    expect(normalizeCheckoutItems([line({ quantity: half }), line({ quantity: half })]).ok).toBe(true);
    expect(
      normalizeCheckoutItems([line({ quantity: half }), line({ quantity: half + 1 })]).ok
    ).toBe(false);
  });

  it('does not mutate the submitted lines', () => {
    const submitted = [line({ quantity: 1 }), line({ quantity: 2 })];
    normalizeCheckoutItems(submitted);
    expect(submitted.map((item) => item.quantity)).toEqual([1, 2]);
  });
});
