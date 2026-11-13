import { resolveMediaUrl } from '@nextblock-cms/utils/media-url';

import type { CouponProductOption } from './ProductScopePicker';

type JoinedLanguage =
  | {
      code?: string | null;
      name?: string | null;
    }
  | Array<{
      code?: string | null;
      name?: string | null;
    }>
  | null
  | undefined;

function normalizeJoinedLanguage(language: JoinedLanguage) {
  if (Array.isArray(language)) {
    return language[0] ?? null;
  }

  return language ?? null;
}

function resolveProductThumbnail(product: any) {
  const productMedia = Array.isArray(product.product_media)
    ? [...product.product_media].sort(
        (left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0)
      )
    : [];
  const mediaPath =
    productMedia[0]?.media?.file_path ||
    productMedia[0]?.media?.object_key ||
    null;

  return resolveMediaUrl(mediaPath);
}

export function normalizeCouponProductOptions(products?: any[] | null): CouponProductOption[] {
  return (products || []).map((product) => ({
    id: product.id,
    title: product.title,
    sku: product.sku ?? null,
    payment_provider: product.payment_provider || 'stripe',
    freemius_product_id: product.freemius_product_id ?? null,
    thumbnailUrl: resolveProductThumbnail(product),
    language: normalizeJoinedLanguage(product.language),
  }));
}
