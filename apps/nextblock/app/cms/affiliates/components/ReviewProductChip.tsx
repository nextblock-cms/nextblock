import { ImageOff } from 'lucide-react';
import type { AffiliateReviewProduct, AffiliateReviewProductStatus } from '../../../../lib/affiliates/admin-data';

const STATUS_NOTE: Readonly<Record<Exclude<AffiliateReviewProductStatus, 'active'>, string>> = {
  draft: 'Draft: hidden on the storefront',
  archived: 'Archived: hidden on the storefront',
  missing: 'Not found: hidden on the storefront',
};

/**
 * A product of a storefront grid as a compact chip (title, first image, visibility). The public
 * storefront re-checks every product and shows active ones only; the chip says so for the others.
 */
export function ReviewProductChip({ product }: { product: AffiliateReviewProduct }) {
  const note = product.status === 'active' ? null : STATUS_NOTE[product.status];

  return (
    <span
      className={
        note
          ? 'inline-flex max-w-xs items-center gap-2 rounded-full border border-dashed border-amber-400 bg-amber-50 py-1 pl-1 pr-3 text-xs text-amber-900 dark:border-amber-600 dark:bg-amber-900/20 dark:text-amber-200'
          : 'inline-flex max-w-xs items-center gap-2 rounded-full border border-border bg-background py-1 pl-1 pr-3 text-xs text-foreground'
      }
      title={product.id}
    >
      {product.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={product.imageUrl}
          alt=""
          width={24}
          height={24}
          loading="lazy"
          decoding="async"
          className="h-6 w-6 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden="true">
          <ImageOff className="h-3.5 w-3.5" />
        </span>
      )}
      <span className="truncate">{product.title ?? 'Unknown product'}</span>
      {note ? <span className="shrink-0 font-medium">({note})</span> : null}
    </span>
  );
}
