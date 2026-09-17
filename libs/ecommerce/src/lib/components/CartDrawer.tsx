'use client';

import { 
  Sheet, 
  SheetContent, 
  SheetHeader, 
  SheetTitle,
  SheetDescription,
} from '@nextblock-cms/ui/sheet';
import { Badge } from '@nextblock-cms/ui/badge';
import { Button } from '@nextblock-cms/ui/button';
import Link from 'next/link';
import { useRef } from 'react';
import { Minus, Plus, Trash2 } from 'lucide-react';
import { getCartItemActivePrice, useCartSubtotal } from '../cart-store';
import { useCart } from '../use-cart';
import { useTranslations } from '@nextblock-cms/utils';
import { usePriceFormatter } from '../use-price-formatter';
import { isDigitalItem } from '../types';
import { useCurrency } from '../CurrencyProvider';
import { getTrialSummary } from '../trials';
import { CouponForm } from './CouponForm';



export const CartDrawer = () => {
  // Locale-aware: see use-price-formatter.ts.
  const formatPrice = usePriceFormatter();
  const store = useCart((state) => state);
  const subtotal = useCartSubtotal();
  const { t } = useTranslations();
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const label = (key: string, fallback: string, params?: Record<string, string | number>) => {
    const translated = t(key, params);
    return translated === key ? fallback : translated;
  };
  const { activeCurrencyCode, currencies } = useCurrency();

  if (!store) return null;

  const { isOpen, setIsOpen, items, updateQuantity, removeItem } = store;
  const getAllocatedSkuQuantity = (sku: string) =>
    items.reduce((accumulator, cartItem) => {
      if (isDigitalItem(cartItem) || cartItem.sku !== sku) {
        return accumulator;
      }

      return accumulator + cartItem.quantity;
    }, 0);

  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      <SheetContent
        className="flex w-full flex-col pr-0 sm:max-w-lg"
        // There is no SheetTrigger (the drawer opens from the cart icon or after an add to
        // cart), so Radix has nothing to give focus back to and dropped it on <body>.
        onOpenAutoFocus={() => {
          restoreFocusRef.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocusRef.current?.focus();
        }}
      >
        <SheetHeader className="px-1 text-left">
          <SheetTitle>{t('ecommerce.shopping_cart')} ({items.length})</SheetTitle>
          <SheetDescription className="sr-only">
            {t('ecommerce.shopping_cart')}
          </SheetDescription>
        </SheetHeader>
        
        {items.length > 0 ? (
           <div className="flex flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-1 pr-6 pt-4">
            {items.map((item) => {
              const allocatedSkuQuantity = getAllocatedSkuQuantity(item.sku);

              return (
                <div key={item.id} className="flex gap-4">
                  {(() => {
                    const activePrice = getCartItemActivePrice(item, {
                      currencyCode: activeCurrencyCode,
                      currencies,
                    });
                    const trialSummary = getTrialSummary(item, t);

                    return (
                      <>
                  {item.image_url ? (
                    <div className="relative aspect-square h-20 w-20 min-w-fit overflow-hidden rounded border bg-neutral-100">
                      {/* Decorative: the title is right beside it. */}
                      <img
                        src={item.image_url}
                        alt=""
                        width={80}
                        height={80}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    </div>
                  ) : (
                    <div className="flex h-20 w-20 items-center justify-center rounded bg-secondary">
                      <span className="text-xs text-muted-foreground">{t('ecommerce.no_image')}</span>
                    </div>
                  )}

                  <div className="flex min-w-0 flex-1 flex-col justify-between">
                    <div className="flex justify-between gap-2">
                      <div className="min-w-0">
                        <span className="line-clamp-2 text-sm font-medium leading-tight">
                          {item.title}
                        </span>
                        {item.variant_label && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {item.variant_label}
                          </div>
                        )}
                        {trialSummary && (
                          <div className="mt-1 text-xs font-medium text-emerald-700">
                            {trialSummary.label} - {trialSummary.paymentRequirementLabel}
                          </div>
                        )}
                      </div>
                      <span className="text-sm font-semibold tabular-nums">
                        {activePrice.sale_price && (
                          <>
                            <span className="sr-only">{label('ecommerce.regular_price', 'Regular price')} </span>
                            <s className="mr-1.5 text-xs font-normal text-muted-foreground">
                              {formatPrice(activePrice.price, activeCurrencyCode)}
                            </s>
                            <span className="sr-only">{label('ecommerce.sale_price', 'Sale price')} </span>
                          </>
                        )}
                        {formatPrice(activePrice.sale_price ?? activePrice.price, activeCurrencyCode)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-sm">
                      {isDigitalItem(item) ? (
                        <Badge variant="secondary" className="font-normal text-xs">
                          {label('ecommerce.license_count_one', '1 license', { count: 1 })}
                        </Badge>
                      ) : (
                        <div role="group" aria-label={`${label('ecommerce.quantity', 'Quantity')}: ${item.title}`} className="flex items-center rounded-md border text-xs">
                          <button
                            onClick={() => updateQuantity(item.id, item.quantity - 1)}
                            className="flex h-7 w-7 items-center justify-center rounded-l-md border-r focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                            type="button"
                            aria-label={label('ecommerce.decrease_quantity', 'Decrease quantity')}
                          >
                            <Minus className="h-3 w-3" />
                          </button>
                          <span aria-live="polite" aria-atomic="true" className="flex h-7 w-8 items-center justify-center tabular-nums">
                            {item.quantity}
                          </span>
                          <button
                            onClick={() => updateQuantity(item.id, item.quantity + 1)}
                            className="flex h-7 w-7 items-center justify-center rounded-r-md border-l focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                            type="button"
                            aria-label={label('ecommerce.increase_quantity', 'Increase quantity')}
                            disabled={
                              typeof item.stock === 'number' &&
                              allocatedSkuQuantity >= item.stock
                            }
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                        </div>
                      )}

                      {/* h-8 w-8: the bare 16px icon was under the 24px minimum touch target. */}
                      <button
                        onClick={() => removeItem(item.id)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        type="button"
                        aria-label={label('ecommerce.remove_item', `Remove ${item.title} from cart`, { item: item.title })}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                      </>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center space-y-2">
            <span className="text-muted-foreground">{t('ecommerce.cart_empty')}</span>
            <Button variant="outline" onClick={() => setIsOpen(false)}>
              {t('ecommerce.continue_shopping')}
            </Button>
          </div>
        )}

        {items.length > 0 && (
          <div className="border-t pr-6 pt-4">
             <div className="flex items-center justify-between text-base font-medium">
                <span>{t('ecommerce.subtotal')}</span>
                <span>{formatPrice(subtotal, activeCurrencyCode)}</span>
             </div>
             <p className="mb-4 mt-1 text-xs text-muted-foreground">
                {t('ecommerce.shipping_taxes_calculated')}
             </p>
             <div className="mb-4">
                <CouponForm items={items} currencyCode={activeCurrencyCode} compact />
             </div>
             {/* Links, not buttons with router.push: Ctrl/Cmd-click and "open in new tab" work. */}
             <Button asChild variant="outline" className="w-full mb-3">
                <Link href="/cart" onClick={() => setIsOpen(false)}>
                  {t('ecommerce.view_full_cart')}
                </Link>
             </Button>
             <Button asChild className="w-full">
                <Link href="/checkout" onClick={() => setIsOpen(false)}>
                  {t('ecommerce.ready_to_checkout')}
                </Link>
             </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
};

