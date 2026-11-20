'use client';

import Link from 'next/link';
import { Puzzle } from 'lucide-react';
import { useTranslations } from '@nextblock-cms/utils/translations-context';

import type { Product } from '../types';
import { AddToCartButton } from './AddToCartButton';
import { findAddonBaseProduct, findCartAddonGaps, getProductAddonBases } from '../product-addons';

/**
 * Notices for add-on licenses (../product-addons.ts): the product page says what the add-on needs,
 * and the cart and the checkout name each add-on whose required package is not in the cart, with a
 * button that adds it. They inform and never block: a buyer who owns Commerce Pro already buys the
 * Affiliates add-on alone.
 */

const NOTICE_CLASS =
  'rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm leading-relaxed text-amber-950 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-50';

/** `t(key, params)`, or the English fallback with the same `{name}` params filled in. */
function useAddonCopy() {
  const { t } = useTranslations();
  return (key: string, fallback: string, params: Record<string, string>) => {
    const translated = t(key, params);
    if (translated !== key) return translated;
    return Object.entries(params).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), fallback);
  };
}

interface ProductAddonNoticeProps {
  product: { freemius_product_id?: string | null };
  /** The store products that sell the required packages (loaded by the page; may be empty). */
  baseProducts?: readonly Product[];
}

/** On the product page, above the purchase controls of an add-on license; nothing for any other product. */
export function ProductAddonNotice({ product, baseProducts }: ProductAddonNoticeProps) {
  const copy = useAddonCopy();
  const bases = getProductAddonBases(product);
  if (bases.length === 0) return null;

  return (
    <div className={NOTICE_CLASS} role="note">
      {bases.map((base) => {
        const baseProduct = findAddonBaseProduct(base, baseProducts);
        return (
          <div key={base.freemiusProductId} className="space-y-1">
            <p className="flex items-center gap-2 font-semibold">
              <Puzzle aria-hidden="true" className="h-4 w-4 shrink-0" />
              {copy('ecommerce.addon_for', 'Add-on for {base}', { base: base.name })}
            </p>
            <p>
              {copy('ecommerce.addon_requires_license', 'It needs an active {base} license on the same site, sold separately.', {
                base: base.shortName,
              })}
            </p>
            {baseProduct ? (
              <Link className="inline-block font-medium underline underline-offset-2" href={`/product/${baseProduct.slug}`}>
                {copy('ecommerce.addon_view_base', 'View {base}', { base: base.shortName })}
              </Link>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface CartAddonNoticesProps {
  items: ReadonlyArray<{ id: string; title: string; freemius_product_id?: string | null }>;
  /** The store products that sell the required packages: each gets an add button and a link. */
  baseProducts?: readonly Product[];
}

/** In the cart and the checkout: one notice per add-on whose required package is not in the cart. */
export function CartAddonNotices({ items, baseProducts }: CartAddonNoticesProps) {
  const copy = useAddonCopy();
  const gaps = findCartAddonGaps(items);
  if (gaps.length === 0) return null;

  return (
    <div className="space-y-3">
      {gaps.map(({ addon, base }) => {
        const baseProduct = findAddonBaseProduct(base, baseProducts);
        return (
          <div key={`${addon.id}:${base.freemiusProductId}`} className={`${NOTICE_CLASS} space-y-2`} role="note">
            <p className="flex items-start gap-2 font-semibold">
              <Puzzle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              {copy('ecommerce.addon_cart_title', '{addon} is an add-on for {base}', { addon: addon.title, base: base.name })}
            </p>
            <p>
              {copy(
                'ecommerce.addon_cart_body',
                'It needs an active {base} license on the same site. Already have one? You can carry on. If not, add {base} to your cart too.',
                { base: base.shortName },
              )}
            </p>
            {baseProduct ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <AddToCartButton
                  className="h-9"
                  label={copy('ecommerce.addon_add_base', 'Add {base} to cart', { base: base.shortName })}
                  product={baseProduct}
                />
                <Link className="font-medium underline underline-offset-2" href={`/product/${baseProduct.slug}`}>
                  {copy('ecommerce.addon_view_base', 'View {base}', { base: base.shortName })}
                </Link>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The Freemius checkout window's title for an add-on license, or null for any other product. */
export function useAddonCheckoutWindowTitle() {
  const copy = useAddonCopy();
  return (item: { title: string; freemius_product_id?: string | null }): string | null => {
    const [base] = getProductAddonBases(item);
    return base
      ? copy('ecommerce.addon_checkout_window_title', '{product} ({base} add-on)', { product: item.title, base: base.shortName })
      : null;
  };
}
