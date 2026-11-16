import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The product_details block's description blocks. In draft mode the storefront previews the
 * product's draft, whose block list is what Publish writes: an empty list deletes every live
 * description block (publishProductVisualEditingDraft), so the preview shows none. It fell back
 * to the live blocks whenever the draft's list was empty, the one surface that did not show what
 * Publish writes (the CMS edit page shows the draft's empty list). The live blocks are the
 * fallback only when there is no draft. The component is called directly and the element it
 * returns inspected: nothing renders.
 */

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';
const LIVE_BLOCK = { id: 5, product_id: PRODUCT_ID, language_id: 1, block_type: 'text', content: { html_content: '<p>Live</p>' }, order: 0 };
const DRAFT_BLOCK = { id: 11, product_id: PRODUCT_ID, language_id: 1, block_type: 'text', content: { html_content: '<p>Draft</p>' }, order: 0 };

const mocks = vi.hoisted(() => ({
  draft: null as null | { id: number; blocks: unknown },
  liveBlocks: [] as unknown[],
  tablesRead: [] as string[],
}));

/** The cookie client: a PostgREST builder per table, awaited or ended with maybeSingle(). */
function makeSupabase() {
  return {
    from: (table: string) => {
      mocks.tablesRead.push(table);
      const answer = () => {
        if (table === 'products') return { data: { slug: 'pro-plugin', payment_provider: 'stripe' }, error: null };
        if (table === 'product_drafts') return { data: mocks.draft, error: null };
        if (table === 'blocks') return { data: mocks.liveBlocks, error: null };
        return { data: null, error: null };
      };
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'order']) chain[method] = () => chain;
      chain.maybeSingle = async () => answer();
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(answer()).then(resolve, reject);
      return chain;
    },
  };
}

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@nextblock-cms/db/server', () => ({ createClient: () => makeSupabase() }));
vi.mock('@nextblock-cms/ecommerce/pages/cms/payments/queries', () => ({
  getProviderReadiness: async () => ({ ready: true }),
}));
vi.mock('../../BlockRenderer', () => ({ default: function BlockRenderer() { return null; } }));
vi.mock('../../commerce/LazyCommerceClients', () => ({
  LazyContactSellerSection: function LazyContactSellerSection() { return null; },
  LazyProductDetailsLayout: function LazyProductDetailsLayout() { return null; },
  LazyProductReviewsSection: function LazyProductReviewsSection() { return null; },
}));
vi.mock('../../commerce/PaymentReadinessBoundary', () => ({
  default: function PaymentReadinessBoundary({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  },
}));

import ProductDetailsBlockRenderer from './ProductDetailsBlockRenderer';
import BlockRenderer from '../../BlockRenderer';
import { LazyProductDetailsLayout } from '../../commerce/LazyCommerceClients';

/** The first element of `type` in a returned tree (children arrays and fragments included). */
function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === type) return element;
  return findElement(element.props.children as ReactNode, type);
}

/** The description the layout is handed: the BlockRenderer element's props, or undefined for none. */
async function descriptionFor(productVisualEditingEnabled: boolean) {
  const tree = await ProductDetailsBlockRenderer({
    excludeProductId: PRODUCT_ID,
    languageId: 1,
    productVisualEditingEnabled,
  });
  const layout = findElement(tree, LazyProductDetailsLayout);
  if (!layout) throw new Error('no product details layout');
  const description = layout.props.descriptionNode as ReactElement<Record<string, unknown>> | undefined;
  if (description !== undefined) expect(description.type).toBe(BlockRenderer);
  return description?.props;
}

beforeEach(() => {
  mocks.draft = null;
  mocks.liveBlocks = [LIVE_BLOCK];
  mocks.tablesRead = [];
});

describe('ProductDetailsBlockRenderer: the description blocks a draft preview shows', () => {
  it('shows none for a draft whose block list is empty, and never reads the live blocks Publish would delete', async () => {
    mocks.draft = { id: 7, blocks: [] };

    await expect(descriptionFor(true)).resolves.toBeUndefined();
    expect(mocks.tablesRead).toContain('product_drafts');
    expect(mocks.tablesRead).not.toContain('blocks');
  });

  it("shows the draft's blocks, with the draft's id for the in-page editor", async () => {
    mocks.draft = { id: 7, blocks: [DRAFT_BLOCK] };

    const description = await descriptionFor(true);

    expect(description?.blocks).toEqual([DRAFT_BLOCK]);
    expect(description?.visualEditing).toMatchObject({ documentType: 'product', documentId: PRODUCT_ID, draftId: 7 });
    expect(mocks.tablesRead).not.toContain('blocks');
  });

  it('shows the live blocks when the product has no draft', async () => {
    const description = await descriptionFor(true);

    expect(description?.blocks).toEqual([LIVE_BLOCK]);
    expect(description?.visualEditing).toMatchObject({ draftId: null });
  });

  it('shows the live blocks outside draft mode, without reading any draft', async () => {
    mocks.draft = { id: 7, blocks: [] };

    const description = await descriptionFor(false);

    expect(description?.blocks).toEqual([LIVE_BLOCK]);
    expect(mocks.tablesRead).not.toContain('product_drafts');
  });
});
