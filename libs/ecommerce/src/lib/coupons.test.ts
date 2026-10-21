import { describe, expect, it } from 'vitest';

import { reconcileCouponContextItems } from './coupons';

// 2026-10-21: checkout quoted the coupon on the browser's "coupon context" lines and applied the
// result to the cart line, capped only at that line's total. A context quantity of 10 on a
// one-unit line made a 10 % coupon free the line; a quantity of 9 made it 90 % off.

const line = (product_id: string, quantity: number, variant_id?: string) => ({
  product_id,
  variant_id,
  quantity,
});

describe('reconcileCouponContextItems', () => {
  it('keeps the cart quantity for every line being paid for', () => {
    const cart = [line('expensive', 1)];
    const context = [line('expensive', 10), line('cheap', 1)];
    expect(reconcileCouponContextItems(cart, context)).toEqual([line('expensive', 1), line('cheap', 1)]);
  });

  it('matches lines per variant', () => {
    const cart = [line('shirt', 1, 'red')];
    const context = [line('shirt', 5, 'red'), line('shirt', 5, 'blue')];
    expect(reconcileCouponContextItems(cart, context)).toEqual([line('shirt', 1, 'red'), line('shirt', 5, 'blue')]);
  });

  it('adds back a cart line the context left out and drops duplicate context lines', () => {
    const cart = [line('a', 2), line('b', 1)];
    const context = [line('a', 7), line('a', 9), line('other', 1)];
    expect(reconcileCouponContextItems(cart, context)).toEqual([line('a', 2), line('other', 1), line('b', 1)]);
  });

  it('is the cart itself when the context is the cart', () => {
    const cart = [line('a', 2), line('b', 3)];
    expect(reconcileCouponContextItems(cart, cart)).toEqual(cart);
  });
});
