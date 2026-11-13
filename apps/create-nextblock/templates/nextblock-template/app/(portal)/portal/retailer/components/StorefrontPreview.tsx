'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Package } from 'lucide-react';
import { Button } from '@nextblock-cms/ui';
import { cn } from '@nextblock-cms/utils';
import {
  collectStorefrontProductIds,
  StorefrontRenderer,
  type StorefrontDoc,
  type StorefrontEditorProduct,
  type StorefrontProductGridColumns,
} from '@nextblock-cms/affiliates';

import { usePortalCopy } from './use-portal-copy';

const GRID_COLUMN_CLASSES: Readonly<Record<StorefrontProductGridColumns, string>> = {
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-2 lg:grid-cols-4',
};

function PreviewProductCard({ product, placeholder }: { product: StorefrontEditorProduct | undefined; placeholder: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
      {product?.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- catalog image from the store's media host
        <img src={product.imageUrl} alt="" loading="lazy" decoding="async" className="aspect-square w-full bg-muted object-cover" />
      ) : (
        <span aria-hidden="true" className="flex aspect-square w-full items-center justify-center bg-muted text-muted-foreground">
          <Package className="h-6 w-6" />
        </span>
      )}
      <div className="space-y-1 p-3">
        <p className="text-sm font-medium text-foreground">{product?.title ?? placeholder}</p>
        {product?.priceLabel ? <p className="text-sm text-muted-foreground">{product.priceLabel}</p> : null}
      </div>
    </div>
  );
}

function PreviewProductGrid({
  ids,
  title,
  columns,
  products,
  placeholderFor,
}: {
  ids: readonly string[];
  title: string | null;
  columns: StorefrontProductGridColumns;
  products: ReadonlyMap<string, StorefrontEditorProduct>;
  placeholderFor: (productId: string) => string;
}) {
  if (ids.length === 0) return null;
  return (
    <div className="my-8 space-y-3">
      {title ? <p className="text-lg font-semibold text-foreground">{title}</p> : null}
      <div className={cn('grid gap-4', GRID_COLUMN_CLASSES[columns])}>
        {ids.map((productId) => (
          <PreviewProductCard key={productId} product={products.get(productId)} placeholder={placeholderFor(productId)} />
        ))}
      </div>
    </div>
  );
}

export interface StorefrontPreviewProps {
  doc: StorefrontDoc;
  title: string;
  displayName: string;
  bio: string;
  avatarUrl: string | null;
  featuredIds: readonly string[];
  knownProducts: ReadonlyMap<string, StorefrontEditorProduct>;
  allowedImageOrigins: readonly string[];
  siteOrigin: string;
  resolveProducts: (ids: string[]) => Promise<StorefrontEditorProduct[]>;
}

/**
 * The draft as visitors will see it once approved: the same allowlist renderer as the public
 * storefront (`StorefrontRenderer`), fed the sanitized editor document. Product cards are simple
 * previews resolved through the catalog (inactive products show as unavailable).
 */
export function StorefrontPreview(props: StorefrontPreviewProps) {
  const { t } = usePortalCopy();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<ReadonlyMap<string, StorefrontEditorProduct>>(() => new Map());
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  const resolveRef = useRef(props.resolveProducts);
  resolveRef.current = props.resolveProducts;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const products = useMemo(() => {
    const merged = new Map(resolved);
    for (const [productId, product] of props.knownProducts) merged.set(productId, product);
    return merged;
  }, [resolved, props.knownProducts]);

  const neededIds = useMemo(
    () => [...new Set<string>([...collectStorefrontProductIds(props.doc), ...props.featuredIds])],
    [props.doc, props.featuredIds],
  );

  useEffect(() => {
    if (!open) return;
    const missing = neededIds
      .filter((productId) => !products.has(productId) && !settled.has(productId) && !inFlight.current.has(productId))
      .slice(0, 48);
    if (missing.length === 0) return;
    for (const productId of missing) inFlight.current.add(productId);
    resolveRef
      .current(missing)
      .then((found) => {
        if (!mounted.current) return;
        setResolved((current) => {
          const next = new Map(current);
          for (const product of found) next.set(product.id, product);
          return next;
        });
        setSettled((current) => new Set([...current, ...missing]));
      })
      .catch(() => undefined)
      .finally(() => {
        for (const productId of missing) inFlight.current.delete(productId);
      });
  }, [open, neededIds, products, settled]);

  const placeholderFor = (productId: string) =>
    settled.has(productId) ? t('affiliates.portal.featured_unavailable') : t('affiliates.common.loading');
  const regionId = `${id}-region`;
  // As on the public storefront: featured picks follow the page, minus those already in a grid.
  const gridIds = useMemo(() => new Set(collectStorefrontProductIds(props.doc)), [props.doc]);
  const featuredAfterPage = props.featuredIds.filter((productId) => !gridIds.has(productId));

  return (
    <section aria-labelledby={`${id}-heading`} className="rounded-lg border border-border bg-card p-6 text-card-foreground">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${id}-heading`} className="text-lg font-semibold">
          {t('affiliates.portal.preview_title')}
        </h2>
        <Button type="button" variant="outline" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen((value) => !value)}>
          {open ? t('affiliates.portal.preview_hide') : t('affiliates.portal.preview_show')}
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t('affiliates.portal.preview_description')}</p>

      <div id={regionId} hidden={!open} className="mt-5 rounded-lg border border-border bg-background p-4 text-foreground sm:p-6">
        {open ? (
          <>
            <div className="flex items-start gap-4">
              {props.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- storage-hosted partner avatar
                <img
                  src={props.avatarUrl}
                  alt=""
                  width={56}
                  height={56}
                  className="h-14 w-14 shrink-0 rounded-full border border-border object-cover"
                />
              ) : null}
              <div className="min-w-0 space-y-1">
                <p className="text-lg font-semibold">{props.displayName}</p>
                {props.bio ? <p className="whitespace-pre-line text-sm text-muted-foreground">{props.bio}</p> : null}
              </div>
            </div>
            <p className="mt-6 text-3xl font-bold tracking-tight">{props.title || t('affiliates.portal.preview_untitled')}</p>
            <StorefrontRenderer
              doc={props.doc}
              allowedImageOrigins={props.allowedImageOrigins}
              siteOrigin={props.siteOrigin}
              labels={{
                photoCredit: (photographer, provider) => t('affiliates.portal.preview_photo_credit', { photographer, provider }),
              }}
              renderProductGrid={({ productIds, title, columns, index }) => (
                <PreviewProductGrid
                  key={`grid-${index}`}
                  ids={productIds}
                  title={title}
                  columns={columns}
                  products={products}
                  placeholderFor={placeholderFor}
                />
              )}
            />
            <PreviewProductGrid
              ids={featuredAfterPage}
              title={t('affiliates.portal.preview_featured_heading')}
              columns={3}
              products={products}
              placeholderFor={placeholderFor}
            />
          </>
        ) : null}
      </div>
    </section>
  );
}
