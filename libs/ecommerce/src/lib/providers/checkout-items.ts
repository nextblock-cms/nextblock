import { getCartLineCouponKey } from '../coupons';
import type { CheckoutErrorPayload } from '../inventory-settings';
import type { CartItem } from '../types';

/**
 * Upper bound for one cart line after duplicates are merged. Inventory tracking bounds the
 * quantity by stock when it is on; when it is off this is the only ceiling, and it keeps
 * `unit_amount * quantity` far from both Stripe's per-line maximum and integer overflow.
 * `apps/nextblock/app/api/checkout/route.ts` mirrors the value in its request schema.
 */
export const MAX_CHECKOUT_LINE_QUANTITY = 10_000;

export function isValidCheckoutQuantity(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_CHECKOUT_LINE_QUANTITY
  );
}

export function createInvalidCheckoutItemsError(): CheckoutErrorPayload {
  return {
    error: 'Your checkout items could not be processed.',
    errorKey: 'ecommerce.checkout_invalid_items',
    errorStatus: 400,
  };
}

export type CheckoutItemsNormalization =
  | { ok: true; items: CartItem[] }
  | { ok: false; error: CheckoutErrorPayload };

/**
 * Validates and merges the cart lines a checkout submitted.
 *
 * Every quantity must be a positive integer no greater than MAX_CHECKOUT_LINE_QUANTITY: the
 * providers multiply it into the subtotal, store it on `order_items`, and the paid-order
 * inventory deduction subtracts the SUM of a product's lines from stock, so a negative line
 * used to deflate the stored total below the Stripe charge and ADD phantom stock on payment.
 *
 * Lines for the same product + variant are merged into one (quantities summed) so a product
 * is priced, discounted and recorded exactly once, whatever shape the request arrived in.
 */
export function normalizeCheckoutItems(items: unknown): CheckoutItemsNormalization {
  const invalid: CheckoutItemsNormalization = {
    ok: false,
    error: createInvalidCheckoutItemsError(),
  };

  if (!Array.isArray(items) || items.length === 0) {
    return invalid;
  }

  const merged = new Map<string, CartItem>();

  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return invalid;
    }

    const item = raw as CartItem;

    if (typeof item.product_id !== 'string' || !item.product_id.trim()) {
      return invalid;
    }

    if (
      item.variant_id !== undefined &&
      item.variant_id !== null &&
      typeof item.variant_id !== 'string'
    ) {
      return invalid;
    }

    if (!isValidCheckoutQuantity(item.quantity)) {
      return invalid;
    }

    const key = getCartLineCouponKey(item);
    const existing = merged.get(key);

    if (existing) {
      const quantity = existing.quantity + item.quantity;

      if (!isValidCheckoutQuantity(quantity)) {
        return invalid;
      }

      merged.set(key, { ...existing, quantity });
      continue;
    }

    merged.set(key, { ...item });
  }

  return { ok: true, items: [...merged.values()] };
}
