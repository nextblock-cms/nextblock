'use client';

import { Product } from '../types';
import { ProductCard } from './ProductCard';
import { cn, useTranslations } from '@nextblock-cms/utils';

interface ProductGridProps {
  products: Product[];
  columns?: 2 | 3 | 4;
  className?: string;
}

export const ProductGrid = ({ products, columns = 3, className }: ProductGridProps) => {
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
        <ProductCard key={product.id} product={product} priority={index < columns} />
      ))}
    </div>
  );
};
