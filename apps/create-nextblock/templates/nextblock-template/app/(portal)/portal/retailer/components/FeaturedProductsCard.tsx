'use client';

import { useId, useMemo, useState } from 'react';
import { Package, X } from 'lucide-react';
import { Button } from '@nextblock-cms/ui';
import { StorefrontProductPickerDialog } from '@nextblock-cms/affiliates/editor';
import type { StorefrontEditorProduct } from '@nextblock-cms/affiliates';

import { usePortalCopy } from './use-portal-copy';

/** Featured products per storefront in the studio (the picker's own per-pick limit). */
export const PORTAL_FEATURED_PRODUCTS_MAX = 12;

export interface FeaturedProductsCardProps {
  ids: readonly string[];
  products: ReadonlyMap<string, StorefrontEditorProduct>;
  disabled: boolean;
  searchProducts: (query: string) => Promise<StorefrontEditorProduct[]>;
  onChange: (ids: string[], products: StorefrontEditorProduct[]) => void;
}

/** The storefront's featured products: chosen with the catalog picker, saved with the draft. */
export function FeaturedProductsCard({ ids, products, disabled, searchProducts, onChange }: FeaturedProductsCardProps) {
  const { t } = usePortalCopy();
  const id = useId();
  const [open, setOpen] = useState(false);
  const known = useMemo(() => ids.map((productId) => products.get(productId)).filter((p): p is StorefrontEditorProduct => Boolean(p)), [ids, products]);

  const remove = (productId: string) => {
    onChange(
      ids.filter((entry) => entry !== productId),
      [],
    );
  };

  return (
    <section aria-labelledby={`${id}-heading`} className="rounded-lg border border-border bg-card p-6 text-card-foreground">
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        {t('affiliates.portal.featured_title')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('affiliates.portal.featured_description', { max: PORTAL_FEATURED_PRODUCTS_MAX })}
      </p>

      {ids.length === 0 ? (
        <p className="mt-4 rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t('affiliates.portal.featured_empty')}
        </p>
      ) : (
        <ol className="mt-4 space-y-2">
          {ids.map((productId) => {
            const product = products.get(productId);
            const name = product?.title ?? t('affiliates.portal.featured_unavailable');
            return (
              <li key={productId} className="flex items-center gap-3 rounded-md border border-border bg-background p-2">
                {product?.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- catalog image from the store's media host
                  <img
                    src={product.imageUrl}
                    alt=""
                    width={40}
                    height={40}
                    loading="lazy"
                    decoding="async"
                    className="h-10 w-10 shrink-0 rounded object-cover"
                  />
                ) : (
                  <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                    <Package className="h-4 w-4" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{name}</span>
                  {product?.priceLabel ? <span className="block text-xs text-muted-foreground">{product.priceLabel}</span> : null}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  disabled={disabled}
                  aria-label={t('affiliates.portal.featured_remove', { name })}
                  title={t('affiliates.portal.featured_remove', { name })}
                  onClick={() => remove(productId)}
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </Button>
              </li>
            );
          })}
        </ol>
      )}

      <Button type="button" variant="outline" className="mt-4" disabled={disabled} onClick={() => setOpen(true)}>
        {ids.length > 0 ? t('affiliates.portal.featured_edit') : t('affiliates.portal.featured_choose')}
      </Button>

      <StorefrontProductPickerDialog
        open={open}
        onOpenChange={setOpen}
        searchProducts={searchProducts}
        initialSelectedIds={ids}
        knownProducts={known}
        maxProducts={PORTAL_FEATURED_PRODUCTS_MAX}
        onConfirm={(nextIds, nextProducts) => onChange(nextIds, nextProducts)}
      />
    </section>
  );
}
