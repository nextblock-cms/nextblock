import { ProductGrid } from '@nextblock-cms/ecommerce';
import type { Product } from '@nextblock-cms/ecommerce/types';
import { hasStorefrontVisibleText, type StorefrontDoc, type StorefrontProductGridColumns } from '@nextblock-cms/affiliates';

/**
 * One product section of a storefront (a document grid or the featured products): a heading, then
 * the shop's own `ProductGrid` (client) with the partner's signed attribution token, so "Add to
 * cart" stores it on the cart and checkout can credit the partner even when cookies are blocked
 * (ADDENDUM B9), and every product link carries `?ref=<handle>`.
 *
 * Every section gets an h2: the grid title when the partner gave one, else a visually hidden
 * generic one, so the product cards' h3 titles never follow the h1 directly (no skipped level).
 */
export interface StorefrontProductSectionProps {
  /** Shown as the section heading; null uses the visually hidden `fallbackTitle`. */
  title: string | null;
  fallbackTitle: string;
  products: Product[];
  columns: StorefrontProductGridColumns;
  /** `mintAffiliateStorefrontToken(handle)`; null when no key is configured (the cookie still attributes). */
  affiliateRef: string | null;
  referralHandle: string;
  /** True only for the page's first rendered grid: its first row loads eagerly, every other image lazily. */
  eagerFirstRow: boolean;
  /**
   * The visitor's language, set only when this section sits inside the partner's text in another
   * language (WCAG 3.1.2): the generic heading and the product cards (the shop catalog, loaded in the
   * visitor's language) are marked with it, while a title the partner wrote keeps the partner's.
   */
  lang?: string;
}

export function StorefrontProductSection({
  title,
  fallbackTitle,
  products,
  columns,
  affiliateRef,
  referralHandle,
  eagerFirstRow,
  lang,
}: StorefrontProductSectionProps) {
  if (products.length === 0) return null;
  const grid = (
    <ProductGrid
      products={products}
      columns={columns}
      affiliateRef={affiliateRef}
      referralHandle={referralHandle}
      eagerFirstRow={eagerFirstRow}
    />
  );
  return (
    <section className="my-10">
      {title ? (
        <h2 className="mb-6 text-2xl font-bold tracking-tight text-foreground md:text-3xl">{title}</h2>
      ) : (
        <h2 lang={lang} className="sr-only">
          {fallbackTitle}
        </h2>
      )}
      {lang ? <div lang={lang}>{grid}</div> : grid}
    </section>
  );
}

/**
 * The index, among the document's product grids (the renderer's `index`), of the first grid that
 * renders, or -1 when none does (then the featured products are the page's first grid). Only that
 * grid loads its first row eagerly: a storefront can hold several grids, and the later ones sit
 * below the fold. `gridRenders` is the same predicate the heading outline uses. Pure.
 */
export function firstRenderedStorefrontGridIndex(
  doc: StorefrontDoc,
  gridRenders: (productIds: readonly string[]) => boolean,
): number {
  let index = 0;
  for (const block of doc.content) {
    if (block.type !== 'affiliateProductGrid') continue;
    if (gridRenders(block.attrs.productIds)) return index;
    index += 1;
  }
  return -1;
}

/**
 * The document as the page renders it, with a heading outline that never skips a level under the
 * page's h1 (the display name): an h3 that comes before any h2 is shown as an h2. A product grid that
 * renders counts as an h2 (its section always has one); a grid with no available products renders
 * nothing and does not, nor does a heading without visible text (the renderer skips it). Pure;
 * returns the same document when nothing changes.
 */
export function normalizeStorefrontHeadingOutline(
  doc: StorefrontDoc,
  gridRenders: (productIds: readonly string[]) => boolean,
): StorefrontDoc {
  let seenLevelTwo = false;
  let changed = false;
  const content = doc.content.map((block) => {
    if (block.type === 'affiliateProductGrid') {
      if (gridRenders(block.attrs.productIds)) seenLevelTwo = true;
      return block;
    }
    // A heading without visible text renders nothing (StorefrontRenderer): it is neither the
    // page's h2 nor the h3 to promote.
    if (block.type !== 'heading' || !hasStorefrontVisibleText(block.content ?? [])) return block;
    if (block.attrs.level === 2) {
      seenLevelTwo = true;
      return block;
    }
    if (seenLevelTwo) return block;
    seenLevelTwo = true;
    changed = true;
    return { ...block, attrs: { ...block.attrs, level: 2 as const } };
  });
  return changed ? { ...doc, content } : doc;
}

/** The products for a list of ids, in that order, each product (and each translation group) once. */
export function pickStorefrontProducts(
  productIds: readonly string[],
  catalog: ReadonlyMap<string, Product>,
): Product[] {
  const picked: Product[] = [];
  const seen = new Set<string>();
  for (const id of productIds) {
    const product = catalog.get(id.toLowerCase());
    if (!product) continue;
    const key = product.translation_group_id || product.id;
    if (seen.has(key) || seen.has(product.id)) continue;
    seen.add(key);
    seen.add(product.id);
    picked.push(product);
  }
  return picked;
}
