'use client';

import React from 'react';
import { ProductGrid } from '@nextblock-cms/ecommerce/components/ProductGrid';
import type { Product } from '@nextblock-cms/ecommerce/types';
import { cn } from '@nextblock-cms/utils';

import { fetchProductGridPage } from '../../app/actions/productGridActions';
import { usePageParam } from '../../hooks/usePageParam';
import { useLabel } from '../../lib/i18n/use-label';
import type { ProductGridQuery } from '../../lib/blocks/product-grid-data';
import GridPagination from './GridPagination';

interface ProductGridClientProps {
  initialProducts: Product[];
  /** The page the server rendered: 1, or the `?page=N` the visitor asked for. */
  initialPage: number;
  totalCount: number;
  /** The block's resolved query, replayed by the server action for later pages. */
  query: ProductGridQuery;
  showPagination: boolean;
}

export default function ProductGridClient({
  initialProducts,
  initialPage,
  totalCount,
  query,
  showPagination,
}: ProductGridClientProps) {
  const [products, setProducts] = React.useState(initialProducts);
  const [currentPage, setCurrentPage] = React.useState(initialPage);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const label = useLabel();

  // Re-sync when the server sends a new first page (e.g. a live draft edit).
  React.useEffect(() => {
    setProducts(initialProducts);
    setCurrentPage(initialPage);
  }, [initialProducts, initialPage]);

  const perPage = query.limit > 0 ? query.limit : products.length || 1;
  const totalPages = showPagination ? Math.max(1, Math.ceil(totalCount / perPage)) : 1;

  const goToPage = async (nextPage: number, { recordInUrl = true } = {}) => {
    if (isLoading || nextPage < 1 || nextPage > totalPages || nextPage === currentPage) return;

    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchProductGridPage({ ...query, page: nextPage });
      if (result.error) {
        setError(result.error);
      } else {
        setProducts(result.products);
        setCurrentPage(nextPage);
        if (recordInUrl) pushPage(nextPage);
        // Keep the top of the grid in view rather than leaving the reader
        // stranded at the bottom of the previous page.
        // An explicit `behavior` beats the global reduced-motion stylesheet rule, so check here.
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        gridRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      }
    } catch {
      setError(label('product_grid.error', 'Failed to load products.', 'Impossible de charger les produits.'));
    } finally {
      setIsLoading(false);
    }
  };

  // `?page=N` in the address bar, and Back/Forward, restore a page without a new history entry.
  const pushPage = usePageParam((page) => void goToPage(page, { recordInUrl: false }));

  return (
    <div ref={gridRef} className="scroll-mt-24">
      <div
        aria-busy={isLoading}
        className={cn('transition-opacity duration-200', isLoading && 'pointer-events-none opacity-50')}
      >
        <ProductGrid products={products} />
      </div>

      {error && (
        <p role="alert" className="mt-6 text-center text-sm text-destructive">
          {error}
        </p>
      )}

      {showPagination && totalPages > 1 && (
        <GridPagination
          className="mt-10"
          size="sm"
          currentPage={currentPage}
          totalPages={totalPages}
          isLoading={isLoading}
          onNavigate={(page) => void goToPage(page)}
        />
      )}
    </div>
  );
}
