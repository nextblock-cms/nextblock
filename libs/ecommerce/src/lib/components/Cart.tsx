'use client';

import { useMemo } from 'react';
import { Badge } from '@nextblock-cms/ui/badge';
import { Button } from '@nextblock-cms/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nextblock-cms/ui/table';
import { Minus, Plus, Trash2 } from 'lucide-react';
import { getCartItemActivePrice, useCartSubtotal } from '../cart-store';
import { useCart } from '../use-cart';
import { isDigitalItem } from '../types';
import Link from 'next/link';
import { useTranslations } from '@nextblock-cms/utils';
import { usePriceFormatter } from '../use-price-formatter';
import { ShippingEstimator } from './ShippingEstimator';
import { useCurrency } from '../CurrencyProvider';
import { getTrialSummary } from '../trials';
import { CouponForm } from './CouponForm';

export const Cart = () => {
  // Locale-aware: see use-price-formatter.ts.
  const formatPrice = usePriceFormatter();
  const store = useCart((state) => state);
  const subtotal = useCartSubtotal();
  const { t } = useTranslations();
  const label = (key: string, fallback: string, params?: Record<string, string | number>) => {
    const translated = t(key, params);
    return translated === key ? fallback : translated;
  };
  // `/shop` for every language, on purpose. The page itself sends a visitor to its
  // translation when one exists (`/boutique` on the seeded site, see PageClientContent) and
  // stays put when it does not. Linking to a translated slug from here would be a 404 on
  // every install whose French shop page has another slug, or none.
  const shopHref = '/shop';
  const { activeCurrencyCode, currencies } = useCurrency();
  const items = store?.items ?? [];

  const physicalSubtotal = useMemo(
    () =>
      items.reduce((sum, item) => {
        if (isDigitalItem(item)) {
          return sum;
        }

        const activePrice = getCartItemActivePrice(item, {
          currencyCode: activeCurrencyCode,
          currencies,
        });

        return sum + (activePrice.sale_price ?? activePrice.price) * item.quantity;
      }, 0),
    [activeCurrencyCode, currencies, items]
  );

  // Same reason as Checkout: the cart is only known after the store hydrates in the browser.
  if (!store) {
    return (
      <div role="status" aria-busy="true" className="container mx-auto py-12">
        <span className="sr-only">{t('loading') === 'loading' ? 'Loading…' : t('loading')}</span>
        <div className="mb-8 h-9 w-56 rounded-md bg-muted" />
        <div className="grid gap-12 lg:grid-cols-12 lg:items-start">
          <div className="h-64 rounded-lg border bg-muted/40 lg:col-span-8" />
          <div className="h-64 rounded-lg border bg-muted/40 lg:col-span-4" />
        </div>
      </div>
    );
  }

  const { updateQuantity, removeItem } = store;
  const getAllocatedSkuQuantity = (sku: string) =>
    items.reduce((accumulator, cartItem) => {
      if (isDigitalItem(cartItem) || cartItem.sku !== sku) {
        return accumulator;
      }

      return accumulator + cartItem.quantity;
    }, 0);

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 py-12">
        {/* h1: with an empty cart this is the only heading on the page. */}
        <h1 className="text-2xl font-bold">{t('ecommerce.cart_empty')}</h1>
        <p className="text-muted-foreground">{t('ecommerce.cart_empty_description')}</p>
        <Button asChild>
          <Link href={shopHref}>{t('ecommerce.continue_shopping')}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-12">
      <h1 className="mb-8 text-3xl font-bold">{t('ecommerce.shopping_cart')}</h1>

      <div className="grid gap-12 lg:grid-cols-12 lg:items-start">
        <div className="lg:col-span-8">
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('ecommerce.product')}</TableHead>
                  <TableHead>{t('ecommerce.quantity')}</TableHead>
                  <TableHead className="text-right">{t('ecommerce.price')}</TableHead>
                  <TableHead className="text-right">{t('ecommerce.total')}</TableHead>
                  <TableHead className="w-[50px]">
                    <span className="sr-only">{label('ecommerce.actions', 'Actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const allocatedSkuQuantity = getAllocatedSkuQuantity(item.sku);
                  const activePrice = getCartItemActivePrice(item, {
                    currencyCode: activeCurrencyCode,
                    currencies,
                  });
                  const trialSummary = getTrialSummary(item, t);

                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="flex items-center gap-4">
                          {item.image_url ? (
                            <div className="h-16 w-16 overflow-hidden rounded border bg-neutral-100">
                              <img
                                src={item.image_url}
                                alt={item.title}
                                className="h-full w-full object-cover"
                              />
                            </div>
                          ) : (
                            <div className="flex h-16 w-16 items-center justify-center rounded bg-secondary">
                              <span className="text-[10px] text-muted-foreground">
                                {t('ecommerce.no_image')}
                              </span>
                            </div>
                          )}
                          <div className="min-w-0 break-words">
                            <div className="font-medium">{item.title}</div>
                            {item.variant_label && (
                              <div className="mt-1 text-xs text-muted-foreground">
                                {item.variant_label}
                              </div>
                            )}
                            {isDigitalItem(item) && item.billing_cycle && (
                              <div className="mt-1 text-xs text-muted-foreground">
                                {label(
                                  `ecommerce.checkout_billing_cycle_${item.billing_cycle}`,
                                  `${item.billing_cycle} subscription`
                                )}
                              </div>
                            )}
                            {trialSummary && (
                              <div className="mt-1 text-xs font-medium text-emerald-700">
                                {trialSummary.label} - {trialSummary.paymentRequirementLabel}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {isDigitalItem(item) ? (
                          <Badge variant="secondary" className="font-normal text-xs">
                            {label('ecommerce.license_count_one', '1 license', { count: 1 })}
                          </Badge>
                        ) : (
                          <div
                            role="group"
                            aria-label={`${label('ecommerce.quantity', 'Quantity')}: ${item.title}`}
                            className="flex items-center gap-2"
                          >
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-8 w-8"
                              aria-label={label('ecommerce.decrease_quantity', 'Decrease quantity')}
                              onClick={() => updateQuantity(item.id, item.quantity - 1)}
                            >
                              <Minus className="h-4 w-4" />
                            </Button>
                            <span aria-live="polite" aria-atomic="true" className="w-8 text-center tabular-nums">
                              {item.quantity}
                            </span>
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-8 w-8"
                              aria-label={label('ecommerce.increase_quantity', 'Increase quantity')}
                              onClick={() => updateQuantity(item.id, item.quantity + 1)}
                              disabled={
                                typeof item.stock === 'number' &&
                                allocatedSkuQuantity >= item.stock
                              }
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-col items-end tabular-nums">
                          <span className="font-medium">
                            {activePrice.sale_price && (
                              <span className="sr-only">{label('ecommerce.sale_price', 'Sale price')} </span>
                            )}
                            {formatPrice(activePrice.sale_price ?? activePrice.price, activeCurrencyCode)}
                          </span>
                          {activePrice.sale_price && (
                            <span className="text-xs text-muted-foreground">
                              <span className="sr-only">{label('ecommerce.regular_price', 'Regular price')} </span>
                              <s>{formatPrice(activePrice.price, activeCurrencyCode)}</s>
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatPrice(
                          (activePrice.sale_price ?? activePrice.price) * item.quantity,
                          activeCurrencyCode
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeItem(item.id)}
                          aria-label={label('ecommerce.remove_item', `Remove ${item.title} from cart`, { item: item.title })}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>

        <div className="lg:col-span-4">
            <div className="rounded-lg border bg-card p-6 shadow-sm">
                <h2 className="mb-4 text-lg font-semibold">{t('ecommerce.order_summary')}</h2>
                <div className="flex justify-between border-b pb-4">
                    <span>{t('ecommerce.subtotal')}</span>
                    <span className="font-medium tabular-nums">{formatPrice(subtotal, activeCurrencyCode)}</span>
                </div>
                 <div className="mt-4 flex flex-col gap-4">
                    <p className="text-sm text-muted-foreground">
                        {t('ecommerce.shipping_taxes_calculated')}
                    </p>
                    
                    {items.some(item => !isDigitalItem(item)) && (
                        <ShippingEstimator physicalSubtotal={physicalSubtotal} />
                    )}

                    <CouponForm
                      items={items}
                      currencyCode={activeCurrencyCode}
                      compact
                    />

                    {/* A link, not a button with router.push: it can be opened in a new tab. */}
                    <Button asChild className="w-full mt-4" size="lg">
                        <Link href="/checkout">{t('ecommerce.proceed_to_checkout')}</Link>
                    </Button>
                 </div>
            </div>
        </div>
      </div>
    </div>
  );
};
