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
  isOpen: boolean;
  addItem: (item: Omit<CartItem, 'quantity'> & { quantity?: number }) => AddItemResult;
  removeItem: (itemId: string) => void;
  updateQuantity: (itemId: string, quantity: number) => void;
  setAppliedCoupon: (coupon: AppliedCouponState | null) => void;
  removeCoupon: () => void;
  clearCart: () => void;
  toggleCart: () => void;
  setIsOpen: (isOpen: boolean) => void;
  setItems: (items: CartItem[]) => void;
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
      isOpen: false,
      addItem: (newItem) => {
        const { items } = get();
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
          });
        } else {
          set({
            items: [...items, { ...newItem, quantity: quantityToAdd }],
            isOpen: true,
          });
        }
        return { success: true };
      },
      removeItem: (itemId) => {
        const { items } = get();
        set({
          items: items.filter((item) => item.id !== itemId),
        });
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
          set({
            items: items.filter((item) => item.id !== itemId),
          });
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
      clearCart: () => set({ items: [], appliedCoupon: null }),
      toggleCart: () => set((state) => ({ isOpen: !state.isOpen })),
      setIsOpen: (isOpen) => set({ isOpen }),
      setItems: (items) => set({ items }),
    }),
    {
      name: 'cart-storage',
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      // Persist the cart, not the UI. `isOpen` used to be stored too, so a visitor who left
      // with the drawer open got it thrown open again (stealing focus) on the next page load
      // and in every new tab.
      partialize: (state) => ({ items: state.items, appliedCoupon: state.appliedCoupon }),
    }
  )
);

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
