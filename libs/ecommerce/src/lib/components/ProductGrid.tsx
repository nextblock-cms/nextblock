'use client';

import { Product } from '../types';
import { ProductCard } from './ProductCard';
import { cn, useTranslations } from '@nextblock-cms/utils';

interface ProductGridProps {
  products: Product[];
  columns?: 2 | 3 | 4;
  className?: string;
  /** Signed partner-storefront token, handed to every card's "Add to cart" (NextBlock Affiliates). */
  affiliateRef?: string | null;
  /** Partner handle: every card's product links carry `?ref=<handle>`. */
  referralHandle?: string | null;
  /**
   * Load the first row's images eagerly (default true: a grid is usually near the top of its
   * page). A page with several grids passes false to every grid but the first, so images below
   * the fold do not compete with the first paint.
   */
  eagerFirstRow?: boolean;
}

export const ProductGrid = ({
  products,
  columns = 3,
  className,
  affiliateRef,
  referralHandle,
  eagerFirstRow = true,
}: ProductGridProps) => {
  const { t } = useTranslations();

  if (!products.length) {
    const emptyLabel = t('ecommerce.no_products_found');

    return (
      <div className="py-12 text-center text-muted-foreground">
        {emptyLabel === 'ecommerce.no_products_found' ? 'No products found.' : emptyLabel}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid gap-6 sm:grid-cols-2",
        columns === 3 && "lg:grid-cols-3",
        columns === 4 && "lg:grid-cols-4",
        className
      )}
    >
      {/* The first row is usually above the fold: loading it lazily delays the first paint. */}
      {products.map((product, index) => (
        <ProductCard
          key={product.id}
          product={product}
          priority={eagerFirstRow && index < columns}
          affiliateRef={affiliateRef}
          referralHandle={referralHandle}
        />
      ))}
    </div>
  );
};
