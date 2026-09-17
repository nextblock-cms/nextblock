'use client';

import { Button } from '@nextblock-cms/ui/button';
import { Mail, ShoppingCart } from 'lucide-react';
import { toast } from 'sonner';
import Link from 'next/link';

import { useCart } from '../use-cart';
import { useTranslations } from '@nextblock-cms/utils';

import { getProductPaymentProvider, isDigitalProduct, Product } from '../types';
import { useCurrency } from '../CurrencyProvider';
import { useCanPurchase } from '../PaymentReadinessProvider';

interface AddToCartButtonProps {
  product: Product;
  className?: string;
  quantity?: number;
}

export const AddToCartButton = ({ product, className, quantity }: AddToCartButtonProps) => {
  // Use useCart to get safe hydration version of addItem, 
  // or use store directly since this action is client-side interaction anyway.
  const store = useCart((state) => state);
  const { t } = useTranslations();
  const { activeCurrencyCode } = useCurrency();
  const canPurchase = useCanPurchase(product);
  const isDigital = isDigitalProduct(product);
  const requiresVariantSelection =
    Boolean(product.has_variants) && !product.variant_id && !isDigital;
  // Digital products have no inventory, and a null/undefined stock means the
  // product is not inventory-tracked — mirrors the cart store's stock guard.
  const isOutOfStock =
    !isDigital && typeof product.stock === 'number' && product.stock <= 0;

  // The store cannot charge through this product's payment provider, so there is no
  // cart to add to. Send the shopper to the enquiry form on the detail page rather than
  // letting them reach a checkout that will refuse them. Checked FIRST: an unbuyable
  // product's stock or variant state is irrelevant.
  if (!canPurchase) {
    const contactLabel = t('ecommerce.contact_seller');

    return (
      <Button asChild variant="outline" className={className}>
        <Link href={`/product/${product.slug}#contact-seller`}>
          <Mail className="mr-2 h-4 w-4" />
          {contactLabel === 'ecommerce.contact_seller' ? 'Contact the seller' : contactLabel}
        </Link>
      </Button>
    );
  }

  if (requiresVariantSelection) {
    return (
      <Button asChild className={className}>
        <Link href={`/product/${product.slug}`}>
          {t('ecommerce.select_options') === 'ecommerce.select_options'
            ? 'Select options'
            : t('ecommerce.select_options')}
        </Link>
      </Button>
    );
  }

  if (isOutOfStock) {
    const outOfStockLabel = t('ecommerce.out_of_stock');

    return (
      <Button disabled className={className}>
        <ShoppingCart className="mr-2 h-4 w-4" />
        {outOfStockLabel === 'ecommerce.out_of_stock'
          ? 'Out of stock'
          : outOfStockLabel}
      </Button>
    );
  }

  if (!store) {
    return (
      <Button disabled className={className}>
        <ShoppingCart className="mr-2 h-4 w-4" />
        {t('ecommerce.add_to_cart')}
      </Button>
    );
  }

  const { addItem } = store;

  const handleAddToCart = () => {
    const provider = getProductPaymentProvider(product) ?? 'stripe';

    const { success, error, errorKey, errorParams } = addItem({
      id: product.variant_id || product.id,
      product_id: product.id,
      title: product.title,
      price: product.price,
      prices: product.prices,
      sale_price: product.sale_price,
      sale_prices: product.sale_prices,
      // The sale window and the scheduled price travel with the line. The cart prices a line
      // with `resolveEffectivePriceForCurrency`, where a missing window means "always on":
      // without these an expired or not-yet-started sale showed the regular price on the
      // product page and the sale price in the cart, the drawer and the subtotal.
      sale_start_at: product.sale_start_at,
      sale_end_at: product.sale_end_at,
      scheduled_price: product.scheduled_price,
      scheduled_prices: product.scheduled_prices,
      scheduled_price_at: product.scheduled_price_at,
      is_taxable: product.is_taxable,
      image_url: product.image_url,
      slug: product.slug,
      sku: product.sku,
      stock: product.stock,
      language_id: product.language_id,
      translation_group_id: product.translation_group_id,
      product_type: product.product_type,
      payment_provider: product.payment_provider ?? provider,
      provider,
      freemius_product_id: product.freemius_product_id, // include just in case it wasn't intercepted
      freemius_plan_id: product.freemius_plan_id,
      trial_period_days: product.trial_period_days ?? 0,
      trial_requires_payment_method: product.trial_requires_payment_method ?? false,
      has_variants: product.has_variants,
      variant_id: product.variant_id,
      variant_label: product.variant_label,
      selected_options: product.selected_options,
      currency_code: activeCurrencyCode,
      quantity,
    });

    if (success) {
      toast.success(t('ecommerce.added_to_cart_success', { item: product.title }));
    } else {
      const translatedError = errorKey ? t(errorKey, errorParams) : null;
      toast.error(
        translatedError && translatedError !== errorKey
          ? translatedError
          : error || t('ecommerce.added_to_cart_error')
      );
    }
  };

  return (
    <Button onClick={handleAddToCart} className={className}>
      <ShoppingCart className="mr-2 h-4 w-4" />
      {t('ecommerce.add_to_cart')}
    </Button>
  );
};
