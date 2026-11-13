'use client';

/**
 * The React node view of the `/promote` product grid: product chips, "Choose products" (the
 * picker dialog the surrounding `StorefrontEditor` owns), the optional title, the column count
 * and removal. Inputs keep a local value so typing never jumps the caret while the change goes
 * through the editor transaction.
 */
import { Button } from '@nextblock-cms/ui';
import { cn } from '@nextblock-cms/utils';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import type { NodeViewRenderer } from '@tiptap/core';
import { GripVertical, Package, ShoppingBag, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';

import { AFFILIATES_EDITOR_COPY } from '../i18n/copy/editor';
import { useAffiliatesCopy } from '../i18n/use-affiliates-copy';
import { STOREFRONT_LIMITS } from '../storefront/limits';
import type { StorefrontProductGridColumns } from '../storefront/types';
import { useStorefrontEditorContext } from './editor-context';
import { readStorefrontGridColumns, readStorefrontGridProductIds, readStorefrontGridTitle } from './extensions/product-grid';
import { storefrontEditorProductImageSrc } from './product-store';

const COLUMN_OPTIONS: readonly StorefrontProductGridColumns[] = [2, 3, 4];

/** Literal column classes for the chip preview (no class names built at runtime). */
const CHIP_GRID_CLASSES: Readonly<Record<StorefrontProductGridColumns, string>> = {
  2: 'grid gap-2 sm:grid-cols-2',
  3: 'grid gap-2 sm:grid-cols-3',
  4: 'grid gap-2 sm:grid-cols-2 lg:grid-cols-4',
};

const noopSubscribe = () => () => undefined;
const zeroVersion = () => 0;

export function AffiliateProductGridView({ node, updateAttributes, deleteNode, selected, editor, getPos }: NodeViewProps) {
  const context = useStorefrontEditorContext();
  const { t } = useAffiliatesCopy(AFFILIATES_EDITOR_COPY);
  const baseId = useId();

  const ids = readStorefrontGridProductIds(node.attrs['productIds']);
  const storedTitle = typeof node.attrs['title'] === 'string' ? node.attrs['title'] : '';
  const columns = readStorefrontGridColumns(node.attrs['columns']);
  const max = context?.maxProductsPerGrid ?? STOREFRONT_LIMITS.maxProductsPerGrid;
  const editable = context ? context.editable : editor.isEditable;
  const store = context?.productStore ?? null;

  useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getVersion ?? zeroVersion, store?.getVersion ?? zeroVersion);

  const idsKey = ids.join(',');
  useEffect(() => {
    store?.ensure(idsKey === '' ? [] : idsKey.split(','));
  }, [store, idsKey]);

  // Local input values, synced from the document unless the partner is typing in them.
  const [titleDraft, setTitleDraft] = useState(storedTitle);
  const titleFocused = useRef(false);
  useEffect(() => {
    if (!titleFocused.current) setTitleDraft(storedTitle);
  }, [storedTitle]);
  const [columnsDraft, setColumnsDraft] = useState<StorefrontProductGridColumns>(columns);
  useEffect(() => {
    setColumnsDraft(columns);
  }, [columns]);

  const openPicker = () => {
    const pos = getPos();
    if (typeof pos === 'number') context?.openProductPicker(pos);
  };

  const titleId = `${baseId}-title`;
  const columnsId = `${baseId}-columns`;
  const headingId = `${baseId}-heading`;

  return (
    <NodeViewWrapper
      data-storefront-product-grid=""
      className={cn(
        'my-6 rounded-lg border bg-card text-card-foreground shadow-sm',
        selected ? 'border-ring ring-2 ring-ring' : 'border-border'
      )}
    >
      <section aria-labelledby={headingId} contentEditable={false} className="space-y-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          {editable ? (
            <span
              data-drag-handle=""
              draggable="true"
              aria-hidden="true"
              title={t('affiliates.editor.grid_drag_handle')}
              className="flex h-8 w-6 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted active:cursor-grabbing"
            >
              <GripVertical className="h-4 w-4" />
            </span>
          ) : null}
          <ShoppingBag aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          <h3 id={headingId} className="text-sm font-semibold">
            {t('affiliates.editor.grid_label')}
          </h3>
          <span className="text-xs text-muted-foreground">
            {t('affiliates.editor.grid_count', { count: ids.length, max })}
          </span>
        </div>

        {editable ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1">
              <label htmlFor={titleId} className="text-xs font-medium text-muted-foreground">
                {t('affiliates.editor.grid_title_label')}
              </label>
              <input
                id={titleId}
                type="text"
                value={titleDraft}
                maxLength={STOREFRONT_LIMITS.maxGridTitleLength}
                placeholder={t('affiliates.editor.grid_title_placeholder')}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background"
                onFocus={() => {
                  titleFocused.current = true;
                }}
                onBlur={() => {
                  titleFocused.current = false;
                  setTitleDraft(storedTitle);
                }}
                onChange={(event) => {
                  setTitleDraft(event.target.value);
                  updateAttributes({ title: readStorefrontGridTitle(event.target.value) });
                }}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor={columnsId} className="text-xs font-medium text-muted-foreground">
                {t('affiliates.editor.grid_columns_label')}
              </label>
              <select
                id={columnsId}
                value={String(columnsDraft)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background sm:w-36"
                onChange={(event) => {
                  const next = readStorefrontGridColumns(event.target.value);
                  setColumnsDraft(next);
                  updateAttributes({ columns: next });
                }}
              >
                {COLUMN_OPTIONS.map((option) => (
                  <option key={option} value={String(option)}>
                    {t('affiliates.editor.grid_columns_option', { count: option })}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : storedTitle.trim() !== '' ? (
          <p className="text-base font-semibold">{storedTitle}</p>
        ) : null}

        {ids.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-4 text-sm text-muted-foreground">
            {t('affiliates.editor.grid_empty', { max })}
          </p>
        ) : (
          <ul className={CHIP_GRID_CLASSES[columns]}>
            {ids.map((id) => {
              const product = store?.get(id);
              const name =
                product?.title ??
                (product === null ? t('affiliates.editor.product_unavailable') : t('affiliates.editor.product_fallback'));
              const src = storefrontEditorProductImageSrc(product?.imageUrl);
              return (
                <li
                  key={id}
                  className={cn(
                    'flex min-w-0 items-center gap-2 rounded-md border bg-background p-2',
                    product === null ? 'border-dashed border-border opacity-70' : 'border-border'
                  )}
                >
                  {src ? (
                    <img
                      src={src}
                      alt=""
                      width={40}
                      height={40}
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                      className="h-10 w-10 shrink-0 rounded bg-muted object-cover"
                    />
                  ) : (
                    <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                      <Package className="h-4 w-4" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {product === undefined && store ? t('affiliates.editor.product_loading') : name}
                    </span>
                    {product?.priceLabel ? (
                      <span className="block truncate text-xs text-muted-foreground">{product.priceLabel}</span>
                    ) : null}
                  </span>
                  {editable ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      aria-label={t('affiliates.editor.remove_product', { name })}
                      title={t('affiliates.editor.remove_product', { name })}
                      onClick={() => updateAttributes({ productIds: ids.filter((entry) => entry !== id) })}
                    >
                      <X aria-hidden="true" className="h-4 w-4" />
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {editable ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" className="h-9" onClick={openPicker} disabled={!context}>
              <ShoppingBag aria-hidden="true" className="mr-2 h-4 w-4" />
              {ids.length === 0 ? t('affiliates.editor.grid_choose_products') : t('affiliates.editor.grid_edit_products')}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-9 text-muted-foreground" onClick={() => deleteNode()}>
              <Trash2 aria-hidden="true" className="mr-2 h-4 w-4" />
              {t('affiliates.editor.grid_remove')}
            </Button>
          </div>
        ) : null}
      </section>
    </NodeViewWrapper>
  );
}

/** The node view renderer `createStorefrontEditorExtensions({ productGridNodeView })` takes. */
export function createAffiliateProductGridNodeView(): NodeViewRenderer {
  return ReactNodeViewRenderer(AffiliateProductGridView);
}
