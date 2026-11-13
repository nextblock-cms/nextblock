'use client';

/**
 * The product picker of the `/promote` grid: a debounced catalog search and a checklist of up to
 * 12 products, kept in the order they were picked (and reorderable). Native checkboxes and
 * buttons, so it works with a keyboard and a screen reader out of the box. Returns the ids in
 * order through `onConfirm`; nothing is saved until then.
 */
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '@nextblock-cms/ui';
import { cn } from '@nextblock-cms/utils';
import { ArrowDown, ArrowUp, Loader2, Package, Search, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { AFFILIATES_EDITOR_COPY } from '../i18n/copy/editor';
import type { AffiliatesCopyTranslate } from '../i18n/types';
import { useAffiliatesCopy } from '../i18n/use-affiliates-copy';
import { STOREFRONT_LIMITS } from '../storefront/limits';
import { isStorefrontProductId } from '../storefront/sanitize';
import type { StorefrontEditorProduct } from '../storefront/types';
import { normalizeStorefrontEditorProduct, storefrontEditorProductImageSrc } from './product-store';

/** Delay between the last keystroke and the catalog search. */
export const STOREFRONT_PRODUCT_SEARCH_DEBOUNCE_MS = 250;

const MAX_QUERY_LENGTH = 100;
const MAX_RESULTS = 50;

export interface StorefrontProductPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Catalog search (active public products). Called with '' when the picker opens. */
  searchProducts: (query: string) => Promise<StorefrontEditorProduct[]>;
  /** The chosen ids in order, with the details the picker knows for them. */
  onConfirm: (ids: string[], products: StorefrontEditorProduct[]) => void;
  initialSelectedIds?: readonly string[];
  /** Details of products that are already selected (shown before a search returns them). */
  knownProducts?: readonly StorefrontEditorProduct[];
  /** Products per grid: 1 to 12 (default 12). */
  maxProducts?: number;
  /** Ids featured in the page's other grids (a page features at most 24 different products). */
  otherProductIds?: readonly string[];
}

type SearchStatus = 'loading' | 'ready' | 'error';

function clampMax(value: number | undefined): number {
  const max = STOREFRONT_LIMITS.maxProductsPerGrid;
  if (typeof value !== 'number' || !Number.isFinite(value)) return max;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

function normalizeIds(ids: readonly string[] | undefined, max: number): string[] {
  const result: string[] = [];
  for (const id of ids ?? []) {
    if (!isStorefrontProductId(id)) continue;
    const lower = id.toLowerCase();
    if (!result.includes(lower)) result.push(lower);
    if (result.length >= max) break;
  }
  return result;
}

function ProductThumb({ product, small }: { product: StorefrontEditorProduct | null | undefined; small?: boolean }) {
  const src = storefrontEditorProductImageSrc(product?.imageUrl);
  const box = small ? 'h-8 w-8' : 'h-12 w-12';
  if (!src) {
    return (
      <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground', box)}>
        <Package className="h-4 w-4" />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      width={small ? 32 : 48}
      height={small ? 32 : 48}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className={cn('shrink-0 rounded-md bg-muted object-cover', box)}
    />
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
  buttonRef,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  buttonRef?: (element: HTMLButtonElement | null) => void;
}) {
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="ghost"
      size="icon"
      className="h-8 w-8 shrink-0"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

interface PickerBodyProps extends Omit<StorefrontProductPickerDialogProps, 'open'> {
  t: AffiliatesCopyTranslate;
}

function PickerBody({
  t,
  onOpenChange,
  searchProducts,
  onConfirm,
  initialSelectedIds,
  knownProducts,
  maxProducts,
  otherProductIds,
}: PickerBodyProps) {
  const baseId = useId();
  const perGridMax = clampMax(maxProducts);
  const pageMax = STOREFRONT_LIMITS.maxFeaturedProducts;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StorefrontEditorProduct[]>([]);
  const [status, setStatus] = useState<SearchStatus>('loading');
  const [selected, setSelected] = useState<string[]>(() => normalizeIds(initialSelectedIds, perGridMax));
  const [details, setDetails] = useState<ReadonlyMap<string, StorefrontEditorProduct>>(() => {
    const map = new Map<string, StorefrontEditorProduct>();
    for (const product of knownProducts ?? []) {
      const normalized = normalizeStorefrontEditorProduct(product);
      if (normalized) map.set(normalized.id, normalized);
    }
    return map;
  });

  const searchRef = useRef(searchProducts);
  searchRef.current = searchProducts;
  const requestRef = useRef(0);
  const firstSearchRef = useRef(true);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const removeButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterRemovalRef = useRef<string | null>(null);

  const otherIds = useMemo(
    () => new Set((otherProductIds ?? []).filter(isStorefrontProductId).map((id) => id.toLowerCase())),
    [otherProductIds]
  );

  const runSearch = useCallback(async (value: string) => {
    const request = ++requestRef.current;
    setStatus('loading');
    try {
      const found = await searchRef.current(value.trim().slice(0, MAX_QUERY_LENGTH));
      if (request !== requestRef.current) return;
      const normalized: StorefrontEditorProduct[] = [];
      for (const product of Array.isArray(found) ? found : []) {
        const item = normalizeStorefrontEditorProduct(product);
        if (item && !normalized.some((entry) => entry.id === item.id)) normalized.push(item);
        if (normalized.length >= MAX_RESULTS) break;
      }
      setResults(normalized);
      setDetails((current) => {
        const next = new Map(current);
        for (const item of normalized) next.set(item.id, item);
        return next;
      });
      setStatus('ready');
    } catch {
      if (request !== requestRef.current) return;
      setResults([]);
      setStatus('error');
    }
  }, []);

  // The first search runs at once (the picker opens on the store's first products); later ones
  // wait for a 250 ms pause in typing.
  useEffect(() => {
    const delay = firstSearchRef.current ? 0 : STOREFRONT_PRODUCT_SEARCH_DEBOUNCE_MS;
    firstSearchRef.current = false;
    const handle = setTimeout(() => {
      void runSearch(query);
    }, delay);
    return () => clearTimeout(handle);
  }, [query, runSearch]);

  // Responses that arrive after the picker closed are ignored.
  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    []
  );

  useEffect(() => {
    const target = focusAfterRemovalRef.current;
    if (target === null) return;
    focusAfterRemovalRef.current = null;
    const button = target === '' ? null : removeButtonsRef.current.get(target);
    (button ?? searchInputRef.current)?.focus();
  }, [selected]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const blockReason = (id: string): 'limit' | 'page_limit' | null => {
    if (selected.length >= perGridMax) return 'limit';
    if (!otherIds.has(id)) {
      const distinct = new Set(otherIds);
      for (const entry of selected) distinct.add(entry);
      if (distinct.size >= pageMax) return 'page_limit';
    }
    return null;
  };

  const toggle = (product: StorefrontEditorProduct) => {
    setSelected((current) => {
      if (current.includes(product.id)) return current.filter((id) => id !== product.id);
      if (current.length >= perGridMax) return current;
      if (!otherIds.has(product.id)) {
        const distinct = new Set(otherIds);
        for (const entry of current) distinct.add(entry);
        if (distinct.size >= pageMax) return current;
      }
      return [...current, product.id];
    });
  };

  const move = (index: number, offset: -1 | 1) => {
    setSelected((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      if (item !== undefined) next.splice(target, 0, item);
      return next;
    });
  };

  const remove = (id: string) => {
    const index = selected.indexOf(id);
    const neighbour = selected[index + 1] ?? selected[index - 1] ?? '';
    focusAfterRemovalRef.current = neighbour;
    setSelected((current) => current.filter((entry) => entry !== id));
  };

  const onSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void runSearch(query);
  };

  const confirm = () => {
    const products = selected.map((id) => details.get(id)).filter((product): product is StorefrontEditorProduct => Boolean(product));
    onConfirm([...selected], products);
    onOpenChange(false);
  };

  const atGridLimit = selected.length >= perGridMax;
  const atPageLimit = !atGridLimit && (() => {
    const distinct = new Set(otherIds);
    for (const entry of selected) distinct.add(entry);
    return distinct.size >= pageMax;
  })();

  let statusText = '';
  if (status === 'loading') statusText = t('affiliates.editor.picker_searching');
  else if (status === 'error') statusText = t('affiliates.editor.picker_error');
  else if (results.length === 0) statusText = t('affiliates.editor.picker_no_results');
  else if (results.length === 1) statusText = t('affiliates.editor.picker_result_count_one');
  else statusText = t('affiliates.editor.picker_result_count_other', { count: results.length });

  const searchId = `${baseId}-search`;
  const selectedHeadingId = `${baseId}-selected`;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('affiliates.editor.picker_title')}</DialogTitle>
        <DialogDescription>{t('affiliates.editor.picker_description', { max: perGridMax })}</DialogDescription>
      </DialogHeader>

      <form role="search" className="space-y-1.5" onSubmit={onSearchSubmit}>
        <Label htmlFor={searchId}>{t('affiliates.editor.picker_search_label')}</Label>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            id={searchId}
            type="search"
            value={query}
            maxLength={MAX_QUERY_LENGTH}
            autoComplete="off"
            placeholder={t('affiliates.editor.picker_search_placeholder')}
            className="pl-9"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </form>

      <p role="status" aria-live="polite" className="flex min-h-5 items-center gap-2 text-sm text-muted-foreground">
        {status === 'loading' ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
        <span>{statusText}</span>
        {status === 'error' ? (
          <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => void runSearch(query)}>
            {t('affiliates.editor.picker_retry')}
          </Button>
        ) : null}
      </p>

      {results.length > 0 ? (
        <ul
          aria-label={t('affiliates.editor.picker_results_label')}
          className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border"
        >
          {results.map((product) => {
            const checked = selectedSet.has(product.id);
            const disabled = !checked && blockReason(product.id) !== null;
            const inputId = `${baseId}-product-${product.id}`;
            return (
              <li key={product.id}>
                <label
                  htmlFor={inputId}
                  className={cn(
                    'flex min-h-14 items-center gap-3 px-3 py-2 focus-within:bg-accent/60',
                    disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-accent/60',
                    checked ? 'bg-accent/40' : ''
                  )}
                >
                  <input
                    id={inputId}
                    type="checkbox"
                    className="h-5 w-5 shrink-0 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggle(product)}
                  />
                  <ProductThumb product={product} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{product.title}</span>
                    {product.priceLabel ? (
                      <span className="block text-xs text-muted-foreground">{product.priceLabel}</span>
                    ) : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}

      <section aria-labelledby={selectedHeadingId} className="space-y-2">
        <h3 id={selectedHeadingId} className="text-sm font-semibold text-foreground">
          {t('affiliates.editor.picker_selected_label', { count: selected.length, max: perGridMax })}
        </h3>
        {atGridLimit || atPageLimit ? (
          <p className="text-xs text-muted-foreground">
            {atGridLimit
              ? t('affiliates.editor.picker_limit_reached', { max: perGridMax })
              : t('affiliates.editor.picker_page_limit_reached', { max: pageMax })}
          </p>
        ) : null}
        {selected.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('affiliates.editor.picker_selected_empty')}</p>
        ) : (
          <ol className="space-y-1">
            {selected.map((id, index) => {
              const product = details.get(id);
              const name = product?.title ?? t('affiliates.editor.product_fallback');
              return (
                <li key={id} className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1">
                  <span aria-hidden="true" className="w-5 text-center text-xs tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                  <ProductThumb product={product} small />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{name}</span>
                  <IconButton
                    label={t('affiliates.editor.picker_move_up', { name })}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp aria-hidden="true" className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    label={t('affiliates.editor.picker_move_down', { name })}
                    disabled={index === selected.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown aria-hidden="true" className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    label={t('affiliates.editor.remove_product', { name })}
                    onClick={() => remove(id)}
                    buttonRef={(element) => {
                      if (element) removeButtonsRef.current.set(id, element);
                      else removeButtonsRef.current.delete(id);
                    }}
                  >
                    <X aria-hidden="true" className="h-4 w-4" />
                  </IconButton>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {t('affiliates.editor.cancel')}
        </Button>
        <Button type="button" onClick={confirm}>
          {t('affiliates.editor.picker_confirm')}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * The product picker dialog. The dialog content (and with it the picker state) mounts when the
 * dialog opens and unmounts when it closes, so every opening starts from `initialSelectedIds`.
 */
export function StorefrontProductPickerDialog(props: StorefrontProductPickerDialogProps) {
  const { open, onOpenChange, ...rest } = props;
  const { t } = useAffiliatesCopy(AFFILIATES_EDITOR_COPY);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl space-y-4">
        <PickerBody {...rest} onOpenChange={onOpenChange} t={t} />
      </DialogContent>
    </Dialog>
  );
}
