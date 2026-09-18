import ProductGridClient from '../../components/blocks/ProductGridClient';

import {
  PRODUCT_GRID_UNLIMITED,
  resolveProductGridCategoryIds,
  resolveProductGridLimit,
  resolveProductGridProductIds,
  resolveProductGridShowPagination,
  type ProductGridBlockContent,
} from './ecommerce-block-schemas';
import { loadProductGridPage, type ProductGridQuery } from './product-grid-data';
import { getRequestedPage } from './requested-page';

interface ProductGridBlockProps {
  content: ProductGridBlockContent;
  languageId?: number;
  excludeProductId?: string;
  excludeTranslationGroupId?: string | null;
}

// Component (Server Component)
export const ProductGridBlock = async ({
  content,
  languageId,
  excludeProductId,
  excludeTranslationGroupId,
}: ProductGridBlockProps) => {
  const isManual = content.type === 'manual';
  const handPickedIds = isManual ? resolveProductGridProductIds(content) : [];

  // A hand-picked grid with nothing picked has nothing to say — render nothing
  // rather than silently falling back to unrelated products.
  if (isManual && handPickedIds.length === 0) {
    return null;
  }

  const paginate = resolveProductGridShowPagination(content);
  // A hand-picked list is already exactly what the author asked for, so `limit`
  // acts purely as a page size there — never as a cap.
  const limit = isManual && !paginate ? PRODUCT_GRID_UNLIMITED : resolveProductGridLimit(content);

  const query: ProductGridQuery = {
    type: content.type ?? 'latest',
    // With no category selected this resolves to an empty filter, i.e. latest products.
    categoryIds: content.type === 'category' ? resolveProductGridCategoryIds(content) : undefined,
    productIds: isManual ? handPickedIds : undefined,
    limit,
    page: 1,
    languageId,
    excludeProductId,
    excludeTranslationGroupId,
  };

  // `?page=N` renders that page on the server, so later pages work without JavaScript and
  // have a URL of their own. A page past the end falls back to the first one.
  let initialPage = paginate ? getRequestedPage() : 1;
  let { products, totalCount } = await loadProductGridPage({ ...query, page: initialPage });

  if (initialPage > 1 && products.length === 0) {
    initialPage = 1;
    ({ products, totalCount } = await loadProductGridPage(query));
  }

  if (products.length === 0) {
    return null; // Silent fail if no products
  }

  const showPagination = paginate && totalCount > limit;

  return (
    <section className="py-12">
      {content.title && (
        <div className="container mb-8">
          <h2 className="text-3xl font-bold tracking-tight">{content.title}</h2>
        </div>
      )}
      <div className="container">
        <ProductGridClient
          initialProducts={products}
          initialPage={initialPage}
          totalCount={totalCount}
          query={query}
          showPagination={showPagination}
        />
      </div>
    </section>
  );
};
