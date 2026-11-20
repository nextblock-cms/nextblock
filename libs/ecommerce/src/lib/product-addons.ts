/**
 * Add-on licenses in the store: a product whose Freemius product is a NextBlock package that needs
 * others (`requires` in the package registry: Affiliates & Creator Storefronts needs Commerce Pro).
 * The product card, the product page, the cart and the checkout say so, so nobody buys the add-on
 * taking it for a standalone product. Only a store carrying NextBlock's own license products has
 * these Freemius ids (nextblock.dev, and the public sandbox, whose reset imports them): every other
 * store finds no add-on and shows nothing.
 *
 * Client-safe: the registry module has no imports (a deep subpath, never the utils barrel).
 */
import { getRequiredPackagesForFreemiusProduct, shortPackageName } from '@nextblock-cms/utils/nextblock-packages';

export interface ProductAddonBase {
  /** The required package's Freemius product id: the store product a buyer also needs. */
  freemiusProductId: string;
  /** "NextBlock™ Commerce Pro" */
  name: string;
  /** "Commerce Pro" */
  shortName: string;
}

/** The packages a product needs beside it when it sells an add-on license, else []. */
export function getProductAddonBases(product: { freemius_product_id?: string | null } | null | undefined): ProductAddonBase[] {
  return getRequiredPackagesForFreemiusProduct(product?.freemius_product_id).map((base) => ({
    freemiusProductId: base.fm_product_id.trim(),
    name: base.name,
    shortName: shortPackageName(base.name),
  }));
}

export interface CartAddonGap {
  /** The add-on's cart line. */
  addon: { id: string; title: string };
  base: ProductAddonBase;
}

/**
 * Each add-on line whose required package is not in the cart as well, in cart order. A buyer who
 * already owns that package may carry on: the notice informs, it never blocks the checkout.
 */
export function findCartAddonGaps(
  items: ReadonlyArray<{ id: string; title: string; freemius_product_id?: string | null }>,
): CartAddonGap[] {
  const inCart = new Set(
    items.map((item) => (typeof item.freemius_product_id === 'string' ? item.freemius_product_id.trim() : '')).filter(Boolean),
  );
  const gaps: CartAddonGap[] = [];
  for (const item of items) {
    for (const base of getProductAddonBases(item)) {
      if (!inCart.has(base.freemiusProductId)) gaps.push({ addon: { id: item.id, title: item.title }, base });
    }
  }
  return gaps;
}

/** The store product that sells `base`, among those the page loaded (`addonBaseProducts`). */
export function findAddonBaseProduct<T extends { freemius_product_id?: string | null }>(
  base: ProductAddonBase,
  products: readonly T[] | null | undefined,
): T | undefined {
  return (products ?? []).find(
    (product) => typeof product.freemius_product_id === 'string' && product.freemius_product_id.trim() === base.freemiusProductId,
  );
}
