// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CartItem } from './types';
import {
  CART_AFFILIATE_REF_MAX_LENGTH,
  normalizeCartAffiliateRef,
  rememberStorefrontAffiliateRef,
  useCartStore,
} from './cart-store';

/**
 * The cart carries the partner-storefront token from "Add to cart" to checkout, across page
 * loads, so it is persisted with the items; it is opaque to the cart (the server verifies it)
 * but junk never gets stored or sent. It lives exactly as long as the cart it was carried for,
 * and a storefront product link hands it, in memory, to the next add.
 */

const TOKEN = 'v1.jane-doe.1793102400.0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

type NewCartItem = Omit<CartItem, 'quantity'> & { quantity?: number };

const SOAP = {
  id: 'soap',
  product_id: '44444444-4444-4444-8444-444444444444',
  title: 'Cedar soap',
  price: 1200,
  sku: 'SOAP-1',
  stock: 10,
  product_type: 'physical',
  provider: 'stripe',
} as unknown as NewCartItem;
const CANDLE = {
  id: 'candle',
  product_id: '66666666-6666-4666-8666-666666666666',
  title: 'Lavender candle',
  price: 1800,
  sku: 'CANDLE-1',
  stock: 10,
  product_type: 'physical',
  provider: 'stripe',
} as unknown as NewCartItem;
const LICENSE = {
  id: 'license',
  product_id: '55555555-5555-4555-8555-555555555555',
  title: 'Pro license',
  price: 9900,
  sku: 'PRO-1',
  product_type: 'digital',
  payment_provider: 'freemius',
  provider: 'freemius',
} as unknown as NewCartItem;

function persisted(): Record<string, unknown> {
  const raw = window.localStorage.getItem('cart-storage');
  return raw ? (JSON.parse(raw).state as Record<string, unknown>) : {};
}

/** A cart holding `lines` that a storefront add credited to TOKEN. */
function storefrontCart(...lines: NewCartItem[]) {
  for (const line of lines) {
    expect(useCartStore.getState().addItem(line).success).toBe(true);
  }
  useCartStore.getState().setAffiliateRef(TOKEN);
  expect(useCartStore.getState().affiliateRef).toBe(TOKEN);
}

beforeEach(() => {
  window.localStorage.clear();
  useCartStore.setState({ items: [], appliedCoupon: null, affiliateRef: null, pendingAffiliateRef: null, isOpen: false });
});

describe('cart affiliateRef', () => {
  it('starts empty', () => {
    expect(useCartStore.getState().affiliateRef).toBeNull();
  });

  it('stores the token and persists it with the cart, never the drawer state', () => {
    useCartStore.getState().setIsOpen(true);
    useCartStore.getState().setAffiliateRef(`  ${TOKEN} `);

    expect(useCartStore.getState().affiliateRef).toBe(TOKEN);
    expect(persisted()).toEqual({ items: [], appliedCoupon: null, affiliateRef: TOKEN });
  });

  it('lets a later storefront token replace an earlier one', () => {
    useCartStore.getState().setAffiliateRef(TOKEN);
    useCartStore.getState().setAffiliateRef('v1.marc-picks.1793102500.sig');

    expect(useCartStore.getState().affiliateRef).toBe('v1.marc-picks.1793102500.sig');
  });

  it.each([
    ['null', null],
    ['a blank string', '   '],
    ['an oversized string', 'x'.repeat(CART_AFFILIATE_REF_MAX_LENGTH + 1)],
    ['inner whitespace', 'v1.jane doe.1.sig'],
    ['a control character', 'v1.jane-doe.1.sig\u0000'],
    ['a non-string', { handle: 'jane-doe' }],
  ])('clears the token for %s', (_label, value) => {
    useCartStore.getState().setAffiliateRef(TOKEN);
    useCartStore.getState().setAffiliateRef(value as string | null);

    expect(useCartStore.getState().affiliateRef).toBeNull();
  });

  it('is cleared by clearCart together with the items, the coupon and a pending token', () => {
    useCartStore.setState({
      items: [{ id: 'p1', product_id: 'p1', title: 'Soap', quantity: 1 } as never],
      appliedCoupon: { code: 'SAVE10', couponId: 'c1' } as never,
    });
    useCartStore.getState().setAffiliateRef(TOKEN);
    rememberStorefrontAffiliateRef('v1.marc-picks.1793102500.sig');

    useCartStore.getState().clearCart();

    expect(useCartStore.getState()).toMatchObject({
      items: [],
      appliedCoupon: null,
      affiliateRef: null,
      pendingAffiliateRef: null,
    });
    expect(persisted()).toEqual({ items: [], appliedCoupon: null, affiliateRef: null });
  });

  it('rehydrates a cart persisted before the token existed with no token', async () => {
    window.localStorage.setItem('cart-storage', JSON.stringify({ state: { items: [], appliedCoupon: null }, version: 0 }));
    useCartStore.setState({ affiliateRef: TOKEN });

    await useCartStore.persist.rehydrate();

    // The persisted state has no key, so the in-memory value is kept; the default is null.
    expect(useCartStore.getState().affiliateRef).toBe(TOKEN);
    useCartStore.setState({ affiliateRef: null });
    await useCartStore.persist.rehydrate();
    expect(useCartStore.getState().affiliateRef).toBeNull();
  });

  it('rehydrates a stored token', async () => {
    window.localStorage.setItem(
      'cart-storage',
      JSON.stringify({ state: { items: [], appliedCoupon: null, affiliateRef: TOKEN }, version: 0 })
    );

    await useCartStore.persist.rehydrate();

    expect(useCartStore.getState().affiliateRef).toBe(TOKEN);
  });
});

describe('the token lives as long as the cart it was carried for', () => {
  it('is dropped when the success page removes the last purchased line (setItems([]))', () => {
    storefrontCart(SOAP);
    useCartStore.getState().setAppliedCoupon({ code: 'SAVE10', couponId: 'c1' } as never);

    // What /checkout/success does after a fully paid checkout.
    useCartStore.getState().setItems([]);
    useCartStore.getState().removeCoupon();

    expect(useCartStore.getState()).toMatchObject({ items: [], appliedCoupon: null, affiliateRef: null });
    expect(persisted()).toEqual({ items: [], appliedCoupon: null, affiliateRef: null });
  });

  it('is dropped when the shopper removes the last line', () => {
    storefrontCart(SOAP);

    useCartStore.getState().removeItem(SOAP.id);

    expect(useCartStore.getState().affiliateRef).toBeNull();
    expect(persisted()['affiliateRef']).toBeNull();
  });

  it('is dropped when the last line goes to quantity 0', () => {
    storefrontCart(SOAP);

    useCartStore.getState().updateQuantity(SOAP.id, 0);

    expect(useCartStore.getState().items).toEqual([]);
    expect(useCartStore.getState().affiliateRef).toBeNull();
  });

  it('stays while lines remain (the second provider step of a mixed cart)', () => {
    storefrontCart(SOAP, CANDLE);

    useCartStore.getState().setItems([useCartStore.getState().items[1]]);
    expect(useCartStore.getState().affiliateRef).toBe(TOKEN);

    useCartStore.getState().removeItem('missing-line');
    useCartStore.getState().updateQuantity(CANDLE.id, 2);
    expect(useCartStore.getState().affiliateRef).toBe(TOKEN);
    expect(persisted()['affiliateRef']).toBe(TOKEN);
  });

  it('leaves a later plain add without a token once the cart has emptied, so the referral cookie decides', () => {
    storefrontCart(SOAP);
    useCartStore.getState().setItems([]);

    expect(useCartStore.getState().addItem(CANDLE).success).toBe(true);

    expect(useCartStore.getState().affiliateRef).toBeNull();
    expect(persisted()['affiliateRef']).toBeNull();
  });
});

describe('rememberStorefrontAffiliateRef (a storefront product link hands the token to the next add)', () => {
  it('keeps the token in memory only until the next successful add makes it the cart token', () => {
    rememberStorefrontAffiliateRef(` ${TOKEN} `);

    expect(useCartStore.getState()).toMatchObject({ pendingAffiliateRef: TOKEN, affiliateRef: null });
    expect(persisted()).toEqual({ items: [], appliedCoupon: null, affiliateRef: null });

    // A failed add (out of stock) leaves it pending.
    expect(useCartStore.getState().addItem({ ...SOAP, stock: 0 }).success).toBe(false);
    expect(useCartStore.getState()).toMatchObject({ pendingAffiliateRef: TOKEN, affiliateRef: null });

    expect(useCartStore.getState().addItem(SOAP).success).toBe(true);

    expect(useCartStore.getState()).toMatchObject({ pendingAffiliateRef: null, affiliateRef: TOKEN });
    expect(persisted()).toEqual({ items: [expect.objectContaining({ id: SOAP.id })], appliedCoupon: null, affiliateRef: TOKEN });
  });

  it.each([
    ['a new line', () => undefined],
    ['a merge into an existing line', () => useCartStore.getState().addItem(SOAP)],
  ])('promotes the pending token on %s', (_label, arrange) => {
    arrange();
    rememberStorefrontAffiliateRef(TOKEN);

    expect(useCartStore.getState().addItem(SOAP).success).toBe(true);

    expect(useCartStore.getState()).toMatchObject({ pendingAffiliateRef: null, affiliateRef: TOKEN });
  });

  it('promotes the pending token on a digital add, and not on a refused duplicate license', () => {
    expect(useCartStore.getState().addItem(LICENSE).success).toBe(true);
    rememberStorefrontAffiliateRef(TOKEN);

    expect(useCartStore.getState().addItem(LICENSE).success).toBe(false);
    expect(useCartStore.getState()).toMatchObject({ pendingAffiliateRef: TOKEN, affiliateRef: null });

    useCartStore.getState().setItems([]);
    expect(useCartStore.getState().addItem(LICENSE).success).toBe(true);
    expect(useCartStore.getState()).toMatchObject({ pendingAffiliateRef: null, affiliateRef: TOKEN });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a blank string', '   '],
    ['an oversized string', 'x'.repeat(CART_AFFILIATE_REF_MAX_LENGTH + 1)],
    ['a non-string', { handle: 'jane-doe' }],
  ])('ignores %s', (_label, value) => {
    rememberStorefrontAffiliateRef(value);

    expect(useCartStore.getState().pendingAffiliateRef).toBeNull();
    useCartStore.getState().addItem(SOAP);
    expect(useCartStore.getState().affiliateRef).toBeNull();
  });

  it('lets the latest storefront link win and survives a rehydration of the persisted cart', async () => {
    rememberStorefrontAffiliateRef('v1.marc-picks.1793102500.sig');
    rememberStorefrontAffiliateRef(TOKEN);

    await useCartStore.persist.rehydrate();

    expect(useCartStore.getState().pendingAffiliateRef).toBe(TOKEN);
  });

  it('does not overwrite a stored cart when the click lands before the cart was loaded', async () => {
    window.localStorage.setItem(
      'cart-storage',
      JSON.stringify({
        state: { items: [{ ...CANDLE, quantity: 2 }], appliedCoupon: null, affiliateRef: null },
        version: 0,
      })
    );
    // A fresh store, as on a page load: nothing has read localStorage yet.
    vi.resetModules();
    const fresh = await import('./cart-store');
    expect(fresh.useCartStore.persist.hasHydrated()).toBe(false);

    fresh.rememberStorefrontAffiliateRef(TOKEN);

    expect(fresh.useCartStore.getState()).toMatchObject({
      items: [expect.objectContaining({ id: CANDLE.id, quantity: 2 })],
      pendingAffiliateRef: TOKEN,
    });
    expect(persisted()).toEqual({
      items: [expect.objectContaining({ id: CANDLE.id, quantity: 2 })],
      appliedCoupon: null,
      affiliateRef: null,
    });
  });
});

describe('normalizeCartAffiliateRef', () => {
  it('trims a printable token and refuses anything else', () => {
    expect(normalizeCartAffiliateRef(` ${TOKEN}\n`)).toBe(TOKEN);
    expect(normalizeCartAffiliateRef('')).toBeNull();
    expect(normalizeCartAffiliateRef(undefined)).toBeNull();
    expect(normalizeCartAffiliateRef(42)).toBeNull();
    expect(normalizeCartAffiliateRef('a'.repeat(CART_AFFILIATE_REF_MAX_LENGTH))).toHaveLength(CART_AFFILIATE_REF_MAX_LENGTH);
    expect(normalizeCartAffiliateRef('é-token')).toBeNull();
  });
});
