import type { CartItem, EcommercePaymentProvider } from './types';

export type CouponProviderScope = 'all' | EcommercePaymentProvider;
export type CouponDiscountType = 'percent' | 'fixed';
export type CouponSyncStatus =
  | 'not_synced'
  | 'pending'
  | 'synced'
  | 'failed'
  | 'deleted'
  | 'not_required';

export interface AppliedCouponState {
  code: string;
  couponId?: string | null;
}

export interface CouponLineQuote {
  key: string;
  product_id: string;
  variant_id?: string | null;
  provider: EcommercePaymentProvider;
  title: string;
  quantity: number;
  subtotal: number;
  discount: number;
}

export interface CouponQuote {
  couponId: string;
  code: string;
  name: string;
  discountType: CouponDiscountType;
  discountAmount: number;
  providerScope: CouponProviderScope;
  eligibleSubtotal: number;
  discountTotal: number;
  providerDiscounts: Record<EcommercePaymentProvider, number>;
  lineDiscounts: CouponLineQuote[];
}

export type CouponQuoteResult =
  | {
      success: true;
      quote: CouponQuote;
    }
  | {
      success: false;
      error: string;
      errorKey?: string;
    };

/**
 * The one message a shopper sees for every coupon the store will not honour: unknown code,
 * inactive, not started, expired, exhausted, or not matching the cart. One key for all of them
 * so the public validation action cannot be used to confirm which codes exist.
 *
 * Seed EN + FR for this key in a forward migration (`02015` is the model); until then the
 * client falls back to the English `error` text.
 */
export const COUPON_INVALID_ERROR_KEY = 'ecommerce.coupon_invalid';
export const COUPON_INVALID_ERROR_MESSAGE =
  "This coupon code is invalid or can't be applied to your cart.";

/** Returned by the public validation action once a client has used up its attempts. */
export const COUPON_THROTTLED_ERROR_KEY = 'ecommerce.coupon_validation_failed';
export const COUPON_THROTTLED_ERROR_MESSAGE =
  'Too many coupon attempts. Wait a moment and try again.';

export function normalizeCouponCode(code?: string | null) {
  return (code || '').trim().replace(/\s+/g, '').toUpperCase();
}

export function getCartLineCouponKey(item: Pick<CartItem, 'product_id' | 'variant_id'>) {
  return `${item.product_id}:${item.variant_id || 'base'}`;
}

/**
 * The lines a coupon is quoted on at checkout. The browser sends a "coupon context" (the whole
 * cart, both providers) so a cart-wide coupon is priced on the whole cart, but it never decides
 * the quantity of a line that is being paid for here: every line of `cartItems` replaces its
 * context twin, and a cart line the context left out is added back. Context lines for other
 * products are kept (the other provider's half of the cart). 2026-10-21: a context quantity of
 * 10 on a one-unit cart line made a 10 % coupon take 100 % off that line.
 */
export function reconcileCouponContextItems<T extends Pick<CartItem, 'product_id' | 'variant_id'>>(
  cartItems: T[],
  contextItems: T[]
): T[] {
  const cartByKey = new Map(cartItems.map((item) => [getCartLineCouponKey(item), item] as const));
  const seen = new Set<string>();
  const reconciled: T[] = [];

  for (const item of contextItems) {
    const key = getCartLineCouponKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    reconciled.push(cartByKey.get(key) ?? item);
  }
  for (const [key, item] of cartByKey) {
    if (!seen.has(key)) reconciled.push(item);
  }

  return reconciled;
}

export function emptyProviderDiscounts(): Record<EcommercePaymentProvider, number> {
  return {
    stripe: 0,
    freemius: 0,
  };
}
