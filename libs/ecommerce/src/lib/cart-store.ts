import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { type CartItem, isDigitalItem } from './types';
import { useCurrency } from './CurrencyProvider';
import { resolveEffectivePriceForCurrency } from './currency';
import type { AppliedCouponState } from './coupons';

export interface AddItemResult {
  success: boolean;
  /** English text, kept for callers that only log it. */
  error?: string;
  /** Translation key for the same failure, so the UI can answer in the visitor's language. */
  errorKey?: string;
  errorParams?: Record<string, string | number>;
}

interface CartState {
  items: CartItem[];
  appliedCoupon: AppliedCouponState | null;
  /**
   * The signed partner-storefront token (NextBlock Affiliates) of the last storefront a product
   * was added from. Opaque here: checkout sends it back and the server verifies it. It belongs to
   * the current cart: every way of emptying the cart drops it (see `withCartItems`).
   */
  affiliateRef: string | null;
  /**
   * The token of a storefront product link the shopper followed ("Select options", a card's
   * title or image), waiting for the next successful add, which makes it `affiliateRef`. Memory
   * only, never persisted: a click that leads to no add stores nothing.
   */
  pendingAffiliateRef: string | null;
  isOpen: boolean;
  addItem: (item: Omit<CartItem, 'quantity'> & { quantity?: number }) => AddItemResult;
  removeItem: (itemId: string) => void;
  updateQuantity: (itemId: string, quantity: number) => void;
  setAppliedCoupon: (coupon: AppliedCouponState | null) => void;
  removeCoupon: () => void;
  setAffiliateRef: (affiliateRef: string | null) => void;
  setPendingAffiliateRef: (affiliateRef: string | null) => void;
  clearCart: () => void;
  toggleCart: () => void;
  setIsOpen: (isOpen: boolean) => void;
  setItems: (items: CartItem[]) => void;
}

/** Longest storefront token the cart keeps; the app's tokens are about 95 characters. */
export const CART_AFFILIATE_REF_MAX_LENGTH = 256;

/**
 * A storefront token as the cart stores and sends it, or null: anything that is not a short
 * run of printable ASCII (a tampered localStorage value, an object, blanks) is dropped here,
 * and the server still verifies the signature of whatever arrives.
 */
export function normalizeCartAffiliateRef(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed || trimmed.length > CART_AFFILIATE_REF_MAX_LENGTH || !/^[\x21-\x7e]+$/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

/**
 * The state update that sets the cart's lines. An empty cart also drops the storefront token:
 * the token was carried for lines that are gone, so the paid checkout that removes the last line
 * (the success page's `setItems`), a cart emptied by hand and `clearCart` all end it, and the
 * next cart falls back to the referral cookie. While lines remain (the second provider step of
 * a mixed cart) it stays.
 */
function withCartItems(items: CartItem[]): Pick<CartState, 'items'> & Partial<Pick<CartState, 'affiliateRef'>> {
  return items.length === 0 ? { items, affiliateRef: null } : { items };
}

/** On a successful add: a pending storefront token (a followed storefront link) becomes the cart's. */
function promotePendingAffiliateRef(
  pendingAffiliateRef: string | null
): Partial<Pick<CartState, 'affiliateRef' | 'pendingAffiliateRef'>> {
  return pendingAffiliateRef ? { affiliateRef: pendingAffiliateRef, pendingAffiliateRef: null } : {};
}

function getAllocatedSkuQuantity(
  items: CartItem[],
  sku: string,
  excludedItemId?: string
) {
  return items.reduce((accumulator, item) => {
    if (
      isDigitalItem(item) ||
      item.sku !== sku ||
      (excludedItemId && item.id === excludedItemId)
    ) {
      return accumulator;
    }

    return accumulator + item.quantity;
  }, 0);
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      appliedCoupon: null,
      affiliateRef: null,
      pendingAffiliateRef: null,
      isOpen: false,
      addItem: (newItem) => {
        const { items, pendingAffiliateRef } = get();
        const quantityToAdd = newItem.quantity ?? 1;
        const availableStock = typeof newItem.stock === 'number' ? newItem.stock : null;
        const allocatedSkuQuantity =
          availableStock !== null ? getAllocatedSkuQuantity(items, newItem.sku) : 0;

        // --- Digital product middleware ---
        if (isDigitalItem(newItem)) {
          // Cardinality rule: no duplicate Freemius software instances
          const duplicate = items.find(
            (item) => item.product_id === newItem.product_id && isDigitalItem(item)
          );
          if (duplicate) {
            return {
              success: false,
              error: 'This software license is already in your cart.',
              errorKey: 'ecommerce.cart_error_license_in_cart',
            };
          }

          // Digital items are always qty 1, bypass stock checks
          set({
            items: [...items, { ...newItem, quantity: 1 }],
            isOpen: true,
            ...promotePendingAffiliateRef(pendingAffiliateRef),
          });
          return { success: true };
        }

        // --- Standard physical product logic ---
        const existingItem = items.find((item) => item.id === newItem.id);

        if (availableStock !== null && availableStock <= 0) {
          return {
            success: false,
            error: 'This item is out of stock.',
            errorKey: 'ecommerce.cart_error_out_of_stock',
          };
        }

        if (availableStock !== null && allocatedSkuQuantity + quantityToAdd > availableStock) {
          return {
            success: false,
            error: `Only ${availableStock} available for this SKU.`,
            errorKey: 'ecommerce.cart_error_stock_limit',
            errorParams: { count: availableStock },
          };
        }

        if (existingItem) {
          set({
            items: items.map((item) =>
              item.id === newItem.id
                ? {
                    ...item,
                    ...newItem,
                    quantity: item.quantity + quantityToAdd,
                  }
                : item
            ),
            isOpen: true,
            ...promotePendingAffiliateRef(pendingAffiliateRef),
          });
        } else {
          set({
            items: [...items, { ...newItem, quantity: quantityToAdd }],
            isOpen: true,
            ...promotePendingAffiliateRef(pendingAffiliateRef),
          });
        }
        return { success: true };
      },
      removeItem: (itemId) => {
        const { items } = get();
        set(withCartItems(items.filter((item) => item.id !== itemId)));
      },
      updateQuantity: (itemId, quantity) => {
        const { items } = get();
        const targetItem = items.find((item) => item.id === itemId);

        // Guard: digital items are locked at qty 1
        if (targetItem && isDigitalItem(targetItem)) {
          return;
        }

        if (
          targetItem &&
          typeof targetItem.stock === 'number' &&
          quantity +
            getAllocatedSkuQuantity(items, targetItem.sku, itemId) >
            targetItem.stock
        ) {
          quantity = Math.max(
            targetItem.stock - getAllocatedSkuQuantity(items, targetItem.sku, itemId),
            0
          );
        }

        if (quantity <= 0) {
          set(withCartItems(items.filter((item) => item.id !== itemId)));
        } else {
          set({
            items: items.map((item) =>
              item.id === itemId ? { ...item, quantity } : item
            ),
          });
        }
      },
      setAppliedCoupon: (coupon) => {
        const currentCoupon = get().appliedCoupon;

        if (
          currentCoupon?.code === coupon?.code &&
          currentCoupon?.couponId === coupon?.couponId
        ) {
          return;
        }

        set({ appliedCoupon: coupon });
      },
      removeCoupon: () => {
        if (!get().appliedCoupon) {
          return;
        }

        set({ appliedCoupon: null });
      },
      setAffiliateRef: (affiliateRef) => {
        const nextAffiliateRef = normalizeCartAffiliateRef(affiliateRef);

        if (get().affiliateRef === nextAffiliateRef) {
          return;
        }

        set({ affiliateRef: nextAffiliateRef });
      },
      setPendingAffiliateRef: (affiliateRef) => {
        const nextPendingAffiliateRef = normalizeCartAffiliateRef(affiliateRef);

        if (get().pendingAffiliateRef === nextPendingAffiliateRef) {
          return;
        }

        set({ pendingAffiliateRef: nextPendingAffiliateRef });
      },
      clearCart: () =>
        set({ items: [], appliedCoupon: null, affiliateRef: null, pendingAffiliateRef: null }),
      toggleCart: () => set((state) => ({ isOpen: !state.isOpen })),
      setIsOpen: (isOpen) => set({ isOpen }),
      setItems: (items) => set(withCartItems(items)),
    }),
    {
      name: 'cart-storage',
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      // Persist the cart, not the UI. `isOpen` used to be stored too, so a visitor who left
      // with the drawer open got it thrown open again (stealing focus) on the next page load
      // and in every new tab. The storefront token is part of the cart: it has to survive the
      // page loads between "add to cart" and checkout. The pending token is not: it only bridges
      // a storefront link click to the next add in this tab.
      partialize: (state) => ({
        items: state.items,
        appliedCoupon: state.appliedCoupon,
        affiliateRef: state.affiliateRef,
      }),
    }
  )
);

/**
 * Called by a partner storefront's product links ("Select options", a card's title and image) on
 * click: keeps the storefront token in memory until the next successful add, which stores it on
 * the cart. A product with variants, or one the shopper opens before adding it, is then still
 * credited to the storefront without cookies (a client-side click on a `?ref=` link sets no
 * referral cookie). Junk is ignored, and a click that leads to no add persists nothing.
 */
export function rememberStorefrontAffiliateRef(affiliateRef: unknown): void {
  const token = normalizeCartAffiliateRef(affiliateRef);

  if (!token) {
    return;
  }

  // Every store write also writes the persisted cart. A click that lands before the page's cart
  // hook has loaded the stored cart would replace it with the empty in-memory one, so load it
  // first (localStorage is synchronous: the cart is in memory when this returns).
  const persistApi = useCartStore.persist;
  if (typeof window !== 'undefined' && persistApi && !persistApi.hasHydrated()) {
    void persistApi.rehydrate();
  }

  useCartStore.getState().setPendingAffiliateRef(token);
}

// Selectors
export const useCartTotalItems = () => {
  const items = useCartStore((state) => state.items);
  return items.reduce((acc, item) => acc + item.quantity, 0);
};

export function getCartItemActivePrice(item: CartItem, params: {
  currencyCode: string;
  currencies: ReturnType<typeof useCurrency>['currencies'];
}) {
  return resolveEffectivePriceForCurrency({
    prices: item.prices,
    salePrices: item.sale_prices,
    fallbackPrice: item.price,
    fallbackSalePrice: item.sale_price,
    saleStartAt: item.sale_start_at,
    saleEndAt: item.sale_end_at,
    scheduledPrice: item.scheduled_price,
    scheduledPrices: item.scheduled_prices,
    scheduledPriceAt: item.scheduled_price_at,
    currencyCode: params.currencyCode,
    currencies: params.currencies,
  });
}

export const useCartSubtotal = () => {
  const items = useCartStore((state) => state.items);
  const { activeCurrencyCode, currencies } = useCurrency();

  return items.reduce((accumulator, item) => {
    const { price, sale_price } = getCartItemActivePrice(item, {
      currencyCode: activeCurrencyCode,
      currencies,
    });

    return accumulator + (sale_price ?? price) * item.quantity;
  }, 0);
};
