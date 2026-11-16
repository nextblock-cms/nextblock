import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The product edit page derives on the server whether the caller may publish the product's draft (an
 * ADMIN past the second factor: currentUserCanPublishProductDrafts, the check publish itself opens
 * with) and hands it to the editor shell, whose draft bar disables Publish for anyone else, and to
 * the visibility control, which disables every visibility action for anyone else (only an ADMIN may
 * update a products row, so a WRITER's Publish, Schedule, Unpublish or Archive always failed). The
 * draft merge gets the global attributes the page gives ProductForm: a CMS draft import's variants
 * carry their attribute terms only, and the merge names them from those attributes. The shell and the
 * control share one draft flag (ProductDraftFlagProvider, seeded with the server's): the form's
 * autosave creates a draft without revalidating the page, and the visibility dialog then never offered
 * to publish it. The page is called directly and the element it returns inspected: nothing renders.
 */

const mocks = vi.hoisted(() => ({
  canPublish: vi.fn(),
  product: {} as Record<string, unknown>,
  draft: null as Record<string, unknown> | null,
  /** getGlobalProductAttributes()'s rows. */
  attributes: [] as unknown[],
}));

function Stub({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

/** The PostgREST builder the page awaits (currencies, the draft, live blocks). */
function makeSupabase() {
  return {
    from: (table: string) => {
      const answer = () => (table === 'product_drafts' ? { data: mocks.draft, error: null } : { data: [], error: null });
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'order', 'in']) chain[method] = () => chain;
      chain.maybeSingle = async () => answer();
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(answer()).then(resolve, reject);
      return chain;
    },
  };
}

vi.mock('@nextblock-cms/db/server', () => ({
  verifyPackageOnline: async () => true,
  getActiveLanguagesServerSide: async () => [{ id: 1, code: 'en', name: 'English', is_default: true }],
  createClient: () => makeSupabase(),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/link', () => ({ default: Stub }));
vi.mock('@nextblock-cms/ui', () => ({
  Badge: Stub,
  Button: Stub,
  DropdownMenu: Stub,
  DropdownMenuContent: Stub,
  DropdownMenuItem: Stub,
  DropdownMenuLabel: Stub,
  DropdownMenuSeparator: Stub,
  DropdownMenuButtonTrigger: Stub,
}));
vi.mock('@nextblock-cms/ecommerce/server', () => ({
  getCmsProduct: async () => mocks.product,
  getEnabledPaymentProviders: async () => ['stripe'],
  getGlobalProductAttributes: async () => mocks.attributes,
  getProductTranslations: async () => [],
  getStoreConfigStatus: async () => ({}),
  getStoreReadiness: async () => ({}),
  normalizeCurrencyRecord: (currency: unknown) => currency,
  updateProductAction: async () => ({ success: true }),
  getCategoriesWithCount: async () => [],
  getProductCategories: async () => [],
}));
vi.mock('../../ProductFormClientShell', () => ({ default: function ProductFormClientShell() { return null; } }));
// The real merge, watched for the options the page passes.
vi.mock('../../productFormData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../productFormData')>();
  return { ...actual, mergeProductDraftMetaIntoFormInitialData: vi.fn(actual.mergeProductDraftMetaIntoFormInitialData) };
});
vi.mock('../../../../../lib/visual-editing/product-drafts', () => ({
  currentUserCanPublishProductDrafts: mocks.canPublish,
}));
vi.mock('../../../components/CortexAiPageContext', () => ({ CortexAiPageContextRegistrar: Stub }));
vi.mock('../../../blocks/components/BlockEditorArea', () => ({ default: Stub }));
vi.mock('../../../components/VisibilityControl', () => ({ default: function VisibilityControl() { return null; } }));
vi.mock('../../../revisions/RevisionHistoryButton', () => ({ default: Stub }));
vi.mock('../../../../../lib/publishing/viewUrl', () => ({ buildViewUrl: () => '/product/pro-plugin' }));
vi.mock('../../../../../lib/seo/page-audit-context', () => ({ PageSeoProvider: Stub }));
vi.mock('../../../../../components/seo/PageSeoAuditSection', () => ({ PageSeoAuditSection: Stub }));

import EditProductPage from './page';
import ProductFormClientShell from '../../ProductFormClientShell';
import { ProductDraftFlagProvider } from '../../ProductDraftFlagProvider';
import VisibilityControl from '../../../components/VisibilityControl';
import { mergeProductDraftMetaIntoFormInitialData } from '../../productFormData';

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';

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

/** The props the page hands the first element of `type`. */
async function propsOf(type: unknown, name: string) {
  const tree = await EditProductPage({
    params: Promise.resolve({ id: PRODUCT_ID }),
    searchParams: Promise.resolve({}),
  });
  const element = findElement(tree, type);
  if (!element) throw new Error(`no ${name} in the page`);
  return element.props;
}

const shellProps = () => propsOf(ProductFormClientShell, 'ProductFormClientShell');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attributes = [];
  mocks.draft = { id: 7, product_id: PRODUCT_ID, meta: {}, blocks: [], created_at: '2026-11-01T00:00:00+00:00' };
  mocks.product = {
    id: PRODUCT_ID,
    title: 'Pro plugin',
    slug: 'pro-plugin',
    status: 'active',
    payment_provider: 'stripe',
    product_type: 'physical',
    language_id: 1,
    translation_group_id: null,
    meta_title: null,
    meta_description: null,
    price: 4900,
    prices: { USD: 4900 },
    sale_prices: {},
    product_variants: [],
    product_media: [],
    updated_at: '2026-10-01T00:00:00+00:00',
  };
});

describe('/cms/products/[id]/edit and who may publish the draft', () => {
  it.each([
    [true, 'an ADMIN past the second factor'],
    [false, 'anyone else (a WRITER)'],
  ])('hands the editor canPublishProduct=%s for %s, as the server decided it', async (canPublish) => {
    mocks.canPublish.mockResolvedValue(canPublish);

    const props = await shellProps();

    expect(mocks.canPublish).toHaveBeenCalledTimes(1);
    expect(props.canPublishProduct).toBe(canPublish);
    expect(props).toMatchObject({ productId: PRODUCT_ID, serverHasDraft: true });
  });

  it.each([
    [true, 'an ADMIN past the second factor'],
    [false, 'anyone else (a WRITER)'],
  ])('hands the visibility control canPublishProduct=%s for %s, from the same check', async (canPublish) => {
    mocks.canPublish.mockResolvedValue(canPublish);

    const props = await propsOf(VisibilityControl, 'VisibilityControl');

    expect(mocks.canPublish).toHaveBeenCalledTimes(1);
    expect(props).toMatchObject({ type: 'product', id: PRODUCT_ID, hasDraft: true, canPublishProduct: canPublish });
  });
});

describe('/cms/products/[id]/edit and its one draft flag', () => {
  it.each([
    [true, 'a draft'],
    [false, 'no draft'],
  ])('wraps the editor shell and the visibility control in one provider seeded with hasDraft=%s (%s)', async (hasDraft) => {
    mocks.canPublish.mockResolvedValue(true);
    if (!hasDraft) mocks.draft = null;

    const tree = await EditProductPage({
      params: Promise.resolve({ id: PRODUCT_ID }),
      searchParams: Promise.resolve({}),
    });

    const provider = findElement(tree, ProductDraftFlagProvider);
    expect(provider?.props.serverHasDraft).toBe(hasDraft);
    const inside = provider?.props.children as ReactNode;
    expect(findElement(inside, VisibilityControl)?.props).toMatchObject({ hasDraft });
    expect(findElement(inside, ProductFormClientShell)?.props).toMatchObject({ serverHasDraft: hasDraft });
  });
});

describe('/cms/products/[id]/edit and the draft merge', () => {
  it('hands mergeProductDraftMetaIntoFormInitialData the global attributes it gives ProductForm', async () => {
    mocks.canPublish.mockResolvedValue(true);
    mocks.attributes = [
      {
        id: 'attr-color',
        name: 'Color',
        slug: 'color',
        name_translations: { fr: 'Couleur' },
        product_attribute_terms: [{ id: 'term-red', value: 'Red', slug: 'red', value_translations: { fr: 'Rouge' } }],
      },
    ];
    // A CMS draft import: variants with their attribute terms only.
    mocks.draft = {
      ...mocks.draft,
      meta: { sku: 'PRO', price: 59, variants: [{ sku: 'PRO-RED', price: 59, stock_quantity: 3, attribute_term_ids: ['term-red'] }] },
    };

    const shell = await shellProps();

    expect(mergeProductDraftMetaIntoFormInitialData).toHaveBeenCalledTimes(1);
    const [, meta, options] = vi.mocked(mergeProductDraftMetaIntoFormInitialData).mock.calls[0];
    expect(meta).toBe(mocks.draft.meta);
    expect(options.globalAttributes).toBe(shell.globalAttributesProp);
    expect(options.globalAttributes).toEqual([
      expect.objectContaining({ id: 'attr-color', terms: [expect.objectContaining({ id: 'term-red', value: 'Red' })] }),
    ]);
  });
});
