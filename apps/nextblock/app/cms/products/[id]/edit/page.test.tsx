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
  /** getProductCategories()'s rows: the categories assigned live. */
  categories: [] as unknown[],
  /** The product_stock_publishes read's answer (migration 02047): no row by default. */
  stockPublish: { data: null, error: null } as { data: unknown; error: unknown },
  /** The reads in the order the page awaited them: a table name, or 'getCmsProduct'. */
  reads: [] as string[],
}));

function Stub({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

/** The PostgREST builder the page awaits (the product's last publish, currencies, the draft, live blocks). */
function makeSupabase() {
  return {
    from: (table: string) => {
      const answer = () => {
        mocks.reads.push(table);
        if (table === 'product_drafts') return { data: mocks.draft, error: null };
        if (table === 'product_stock_publishes') return mocks.stockPublish;
        return { data: [], error: null };
      };
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
  getCmsProduct: async () => {
    mocks.reads.push('getCmsProduct');
    return mocks.product;
  },
  getEnabledPaymentProviders: async () => ['stripe'],
  getGlobalProductAttributes: async () => mocks.attributes,
  getProductTranslations: async () => [],
  getStoreConfigStatus: async () => ({}),
  getStoreReadiness: async () => ({}),
  normalizeCurrencyRecord: (currency: unknown) => currency,
  updateProductAction: async () => ({ success: true }),
  getCategoriesWithCount: async () => [],
  getProductCategories: async () => mocks.categories,
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
import { PRODUCT_DRAFT_FORM_MARKER_KEY, PRODUCT_DRAFT_FORM_MARKER_VALUE } from '../../../../../lib/visual-editing/product-draft-meta';

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

/** A live variant as getProduct() embeds it: PRO-RED, red, 4 in stock. */
const LIVE_RED_VARIANT = {
  id: 'variant-1',
  sku: 'PRO-RED',
  price: 4900,
  prices: { USD: 4900 },
  stock_quantity: 4,
  variant_attribute_mapping: [
    {
      attribute_term_id: 'term-red',
      product_attribute_terms: {
        id: 'term-red',
        attribute_id: 'attr-color',
        value: 'Red',
        slug: 'red',
        sort_order: 0,
        value_translations: {},
        product_attributes: { id: 'attr-color', name: 'Color', slug: 'color', name_translations: {} },
      },
    },
  ],
};

/** A second live variant: PRO-BLUE, blue, 9 in stock. */
const LIVE_BLUE_VARIANT = {
  ...LIVE_RED_VARIANT,
  id: 'variant-2',
  sku: 'PRO-BLUE',
  stock_quantity: 9,
  variant_attribute_mapping: [
    {
      attribute_term_id: 'term-blue',
      product_attribute_terms: {
        ...LIVE_RED_VARIANT.variant_attribute_mapping[0].product_attribute_terms,
        id: 'term-blue',
        value: 'Blue',
        slug: 'blue',
        sort_order: 1,
      },
    },
  ],
};

/** The texts of the page's notices above the form (`role="alert"`). */
function findNotices(node: ReactNode, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child) => findNotices(child, found));
    return found;
  }
  if (!isValidElement(node)) return found;
  const props = (node as ReactElement<Record<string, unknown>>).props;
  if (props.role === 'alert') {
    const texts: string[] = [];
    const collect = (child: ReactNode) => {
      if (typeof child === 'string') texts.push(child);
      else if (Array.isArray(child)) child.forEach(collect);
      else if (isValidElement(child)) collect((child.props as { children?: ReactNode }).children);
    };
    collect(props.children as ReactNode);
    found.push(texts.join(''));
    return found;
  }
  return findNotices(props.children as ReactNode, found);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attributes = [];
  mocks.categories = [];
  mocks.stockPublish = { data: null, error: null };
  mocks.reads = [];
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

describe('/cms/products/[id]/edit and the stock the form loads', () => {
  it('hands ProductForm the live stock per SKU as its stock_baseline, and with a draft open the stock the merge decided', async () => {
    mocks.canPublish.mockResolvedValue(true);
    mocks.product = { ...mocks.product, sku: 'PRO', stock: 6 };
    mocks.draft = null;

    expect((await shellProps()).initialData).toMatchObject({ stock: 6, stock_baseline: { PRO: 6 } });

    // A form autosave that loaded 8 and left the stock alone: sold down to 6 since, so 6 shows and
    // becomes the baseline (publishing then leaves the stock as it is).
    mocks.draft = {
      id: 7,
      product_id: PRODUCT_ID,
      meta: { [PRODUCT_DRAFT_FORM_MARKER_KEY]: PRODUCT_DRAFT_FORM_MARKER_VALUE, sku: 'PRO', price: 49, stock: 8, variants: [], stock_baseline: { PRO: 8 } },
      blocks: [],
      created_at: '2026-11-01T00:00:00+00:00',
    };

    expect((await shellProps()).initialData).toMatchObject({ stock: 6, stock_baseline: { PRO: 6 } });
  });

  // Review 2026-11-18: the merge shows each SKU as publishing the draft would write it, over the live stock
  // as the baseline, and the next autosave stores that baseline, after which a publish sees neither case
  // below and nothing told the editor. The page names them, with the figures it hands ProductForm.
  describe('names above the form each SKU it shows already live, or applied to a stock that moved', () => {
    const ALREADY_LIVE_NOTE =
      "The stock already holds this draft's figure, so publishing leaves it as it is: PRO-BLUE stays at 9 (the draft changed 10 to 9). If the change was meant to come on top of what moved the stock (a damaged unit taken out after a sale, for example), enter the figure the stock should have.";
    const MOVED_NOTE =
      "The stock has moved since this draft's stock change started (after a sale or another stock update, for example), so the form shows the change applied to the current stock, as publishing would write it: PRO-RED shows 14 (the draft changed 5 to 15, and the stock is now 4). If the draft's figure already counted that, enter the figure the stock should have.";

    /** The page for live RED and BLUE stocks and a form autosave of the given quantities and baseline. */
    async function renderWith(live: { red?: number; blue?: number }, draft: { red?: number; blue?: number }, baseline?: Record<string, number>) {
      mocks.canPublish.mockResolvedValue(true);
      mocks.product = {
        ...mocks.product,
        sku: 'PRO',
        product_variants: [
          ...(live.red === undefined ? [] : [{ ...LIVE_RED_VARIANT, stock_quantity: live.red }]),
          ...(live.blue === undefined ? [] : [{ ...LIVE_BLUE_VARIANT, stock_quantity: live.blue }]),
        ],
      };
      mocks.draft = {
        ...mocks.draft,
        meta: {
          [PRODUCT_DRAFT_FORM_MARKER_KEY]: PRODUCT_DRAFT_FORM_MARKER_VALUE,
          sku: 'PRO',
          price: 49,
          variants: [
            ...(draft.red === undefined ? [] : [{ sku: 'PRO-RED', price: 49, stock_quantity: draft.red, attribute_term_ids: ['term-red'] }]),
            ...(draft.blue === undefined ? [] : [{ sku: 'PRO-BLUE', price: 49, stock_quantity: draft.blue, attribute_term_ids: ['term-blue'] }]),
          ],
          ...(baseline ? { stock_baseline: baseline } : {}),
        },
      };

      const tree = await EditProductPage({ params: Promise.resolve({ id: PRODUCT_ID }), searchParams: Promise.resolve({}) });
      const initialData = findElement(tree, ProductFormClientShell)?.props.initialData as Record<string, any>;
      return {
        shown: (initialData.variants as Array<{ sku: string; stock_quantity: unknown }>).map((variant) => [variant.sku, variant.stock_quantity]),
        notices: findNotices(tree),
      };
    }

    it('already live: loaded 10, 9 typed for a damaged unit, one sold meanwhile (publishing leaves 9)', async () => {
      await expect(renderWith({ blue: 9 }, { blue: 9 }, { 'PRO-BLUE': 10 })).resolves.toEqual({
        shown: [['PRO-BLUE', 9]],
        notices: [ALREADY_LIVE_NOTE],
      });
    });

    it('moved: loaded 5, 15 typed, one sold meanwhile (the form shows 14, which publishing writes)', async () => {
      await expect(renderWith({ red: 4 }, { red: 15 }, { 'PRO-RED': 5 })).resolves.toEqual({
        shown: [['PRO-RED', 14]],
        notices: [MOVED_NOTE],
      });
    });

    it('both kinds in one draft: one note each', async () => {
      await expect(renderWith({ red: 4, blue: 9 }, { red: 15, blue: 9 }, { 'PRO-RED': 5, 'PRO-BLUE': 10 })).resolves.toEqual({
        shown: [
          ['PRO-RED', 14],
          ['PRO-BLUE', 9],
        ],
        notices: [MOVED_NOTE, ALREADY_LIVE_NOTE],
      });
    });

    it('none for a quantity left as loaded, or a draft without a baseline', async () => {
      // Loaded 6, left alone, two sold: the live 4 shows. An earlier version's draft: its 9 shows.
      await expect(renderWith({ red: 4 }, { red: 6 }, { 'PRO-RED': 6 })).resolves.toEqual({ shown: [['PRO-RED', 4]], notices: [] });
      await expect(renderWith({ red: 4 }, { red: 9 })).resolves.toEqual({ shown: [['PRO-RED', 9]], notices: [] });
    });

    // Review 2026-11-18 (round 4): the publish warning names the function's `stock_adjusted` entries, which
    // it answers in SKU order (`sku COLLATE "C"`, 02044); the notes named the first five in variant order.
    it('names the first five SKUs of a kind in the order the publish warning names them', async () => {
      const skus = ['ZED', 'ALPHA', 'MIKE', 'BRAVO', 'YANKEE', 'CHARLIE'];
      const terms = LIVE_RED_VARIANT.variant_attribute_mapping[0].product_attribute_terms;
      mocks.canPublish.mockResolvedValue(true);
      mocks.product = {
        ...mocks.product,
        sku: 'PRO',
        product_variants: skus.map((sku, index) => ({
          ...LIVE_RED_VARIANT,
          id: `variant-${index}`,
          sku,
          stock_quantity: 4,
          variant_attribute_mapping: [
            { attribute_term_id: `term-${index}`, product_attribute_terms: { ...terms, id: `term-${index}`, value: sku, slug: sku.toLowerCase() } },
          ],
        })),
      };
      // Each loaded 5, 15 typed, one sold meanwhile: the form shows 14 for each.
      mocks.draft = {
        ...mocks.draft,
        meta: {
          [PRODUCT_DRAFT_FORM_MARKER_KEY]: PRODUCT_DRAFT_FORM_MARKER_VALUE,
          sku: 'PRO',
          price: 49,
          variants: skus.map((sku, index) => ({ sku, price: 49, stock_quantity: 15, attribute_term_ids: [`term-${index}`] })),
          stock_baseline: Object.fromEntries(skus.map((sku) => [sku, 5])),
        },
      };

      const tree = await EditProductPage({ params: Promise.resolve({ id: PRODUCT_ID }), searchParams: Promise.resolve({}) });
      const notices = findNotices(tree);

      expect(notices).toHaveLength(1);
      expect([...notices[0].matchAll(/(?:: |; )(\S+) shows 14 /g)].map((match) => match[1])).toEqual([
        'ALPHA',
        'BRAVO',
        'CHARLIE',
        'MIKE',
        'YANKEE',
      ]);
      expect(notices[0]).toContain('; and 1 more.');
    });
  });

  it('names a stock publish cannot read above the form, and hands ProductForm the live stock in its place', async () => {
    mocks.canPublish.mockResolvedValue(true);
    mocks.product = { ...mocks.product, sku: 'PRO', stock: 4, product_variants: [LIVE_RED_VARIANT] };
    // A hand-written draft (any WRITER over PostgREST): text publish cannot read as a quantity.
    mocks.draft = {
      ...mocks.draft,
      meta: {
        [PRODUCT_DRAFT_FORM_MARKER_KEY]: PRODUCT_DRAFT_FORM_MARKER_VALUE,
        sku: 'PRO',
        price: 49,
        variants: [{ sku: 'PRO-RED', price: 49, stock_quantity: 'NaN', attribute_term_ids: ['term-red'] }],
        stock_baseline: { 'PRO-RED': 4 },
      },
    };

    const tree = await EditProductPage({ params: Promise.resolve({ id: PRODUCT_ID }), searchParams: Promise.resolve({}) });

    const initialData = findElement(tree, ProductFormClientShell)?.props.initialData as Record<string, any>;
    expect(initialData.variants[0]).toMatchObject({ sku: 'PRO-RED', stock_quantity: 4 });
    expect(initialData).toMatchObject({ stock: 4, stock_baseline: { 'PRO-RED': 4 } });
    expect(findNotices(tree)).toEqual([
      expect.stringMatching(/^Publishing cannot read the stock of PRO-RED in this draft .* The form shows the live stock in place of a stock it cannot read/),
    ]);
  });
});

/**
 * The CMS create sends the editor here when it created the product but a step after it was not saved
 * (createProductAction, ProductCreatedIncompleteError): the page says so above the form, in its own words.
 */
describe('/cms/products/[id]/edit after a create that could not finish', () => {
  it('names the steps that were not saved, above any draft notice', async () => {
    mocks.draft = null;
    const tree = await EditProductPage({
      params: Promise.resolve({ id: PRODUCT_ID }),
      searchParams: Promise.resolve({ created_incomplete: 'stock,categories' }),
    });
    expect(findNotices(tree)).toEqual([
      'This product was created, but its stock, categories could not be saved. Set the stock on the Inventory screen; check the rest below, then save.',
    ]);
  });

  it('shows nothing for a value that names no step (nothing else from the URL reaches the page)', async () => {
    mocks.draft = null;
    const tree = await EditProductPage({
      params: Promise.resolve({ id: PRODUCT_ID }),
      searchParams: Promise.resolve({ created_incomplete: '<img src=x onerror=alert(1)>' }),
    });
    expect(findNotices(tree)).toEqual([]);
  });
});

describe('/cms/products/[id]/edit and a draft whose list fields are not lists', () => {
  it.each([
    ['objects', {}],
    ['strings', 'x'],
  ])('hands ProductForm the live variants, attributes and categories for a draft holding %s there, as publish keeps them', async (_label, value) => {
    mocks.canPublish.mockResolvedValue(true);
    mocks.product = { ...mocks.product, sku: 'PRO', stock: 4, product_variants: [LIVE_RED_VARIANT] };
    mocks.categories = [{ id: 'category-1', name: 'Plugins', slug: 'plugins' }];
    mocks.draft = {
      ...mocks.draft,
      meta: {
        [PRODUCT_DRAFT_FORM_MARKER_KEY]: PRODUCT_DRAFT_FORM_MARKER_VALUE,
        sku: 'PRO',
        price: 59,
        variants: value,
        variation_attributes: value,
        category_ids: value,
        product_media: value,
      },
    };

    const initialData = (await shellProps()).initialData as Record<string, any>;

    expect(initialData.variants).toEqual([expect.objectContaining({ id: 'variant-1', sku: 'PRO-RED', stock_quantity: 4 })]);
    expect(initialData.variation_attributes).toEqual([{ attribute_id: 'attr-color', term_ids: ['term-red'] }]);
    expect(initialData.category_ids).toEqual(['category-1']);
    expect(initialData.product_media).toEqual([]);
    expect(initialData).toMatchObject({ price: 5900, stock: 4 });
  });

  // Review 2026-11-18: beside the draft's own variants, variation attributes that are a list keep the
  // draft's entries, and the variations editor threw when the form mounted in the browser, for a null entry
  // or term ids that were an object or a number (the client shell renders the form only after mount, and
  // /cms has no error boundary: the page went down for every reader).
  it("hands ProductForm a draft's variation attributes only as the variations editor can read them", async () => {
    mocks.canPublish.mockResolvedValue(true);
    mocks.product = { ...mocks.product, sku: 'PRO', stock: 4, product_variants: [LIVE_RED_VARIANT] };
    mocks.draft = {
      ...mocks.draft,
      meta: {
        [PRODUCT_DRAFT_FORM_MARKER_KEY]: PRODUCT_DRAFT_FORM_MARKER_VALUE,
        sku: 'PRO',
        price: 49,
        variants: [{ sku: 'PRO-RED', price: 49, stock_quantity: 4, attribute_term_ids: ['term-red'] }],
        variation_attributes: [
          null,
          { attribute_id: 'attr-color', term_ids: {} },
          { attribute_id: 'attr-color', term_ids: 5 },
          { attribute_id: 7, term_ids: ['term-red'] },
          { attribute_id: 'attr-color', term_ids: ['term-red', null] },
        ],
      },
    };

    const initialData = (await shellProps()).initialData as Record<string, any>;

    expect(initialData.variation_attributes).toEqual([
      { attribute_id: 'attr-color', term_ids: [] },
      { attribute_id: 'attr-color', term_ids: [] },
      { attribute_id: 'attr-color', term_ids: ['term-red'] },
    ]);
    expect(initialData.variants).toEqual([expect.objectContaining({ sku: 'PRO-RED', stock_quantity: 4 })]);
  });

  // Review 2026-11-18 (round 4): a draft variant's own options reached ProductForm as they were, and the
  // attributes derived from them named no term for `[{}]`: the variations editor opened with none of the
  // variant's terms selected, every autosave was refused, and for a term the store no longer has beside an
  // empty SKU, the SKU fill threw when the form mounted in the browser (ProductForm.list-fields.test.tsx).
  it.each([
    ['{}', [{}]],
    ['null, a number and a string beside a readable option', [null, 5, 'x', { attribute_id: 'attr-color', attribute_name: 'Color', term_id: 'term-red', term_value: 'Red' }]],
  ])("hands ProductForm the live variant's options for a draft variant whose own options hold %s, and attributes naming its term", async (_label, selectedOptions) => {
    mocks.canPublish.mockResolvedValue(true);
    mocks.product = { ...mocks.product, sku: 'PRO', stock: 4, product_variants: [LIVE_RED_VARIANT] };
    mocks.draft = {
      ...mocks.draft,
      meta: {
        [PRODUCT_DRAFT_FORM_MARKER_KEY]: PRODUCT_DRAFT_FORM_MARKER_VALUE,
        sku: 'PRO',
        price: 49,
        variants: [
          { sku: 'PRO-RED', price: 49, stock_quantity: 4, combination_key: 'term-red', attribute_term_ids: ['term-red'], label: 'Red', selected_options: selectedOptions },
        ],
      },
    };

    const initialData = (await shellProps()).initialData as Record<string, any>;

    expect(initialData.variants).toEqual([
      expect.objectContaining({
        sku: 'PRO-RED',
        selected_options: [{ attribute_id: 'attr-color', attribute_name: 'Color', term_id: 'term-red', term_value: 'Red', term_slug: 'red' }],
      }),
    ]);
    expect(initialData.variation_attributes).toEqual([{ attribute_id: 'attr-color', term_ids: ['term-red'] }]);
  });
});

// Migration 02047: the page reads the product's last product-values publish (product_stock_publishes)
// BEFORE the product, so a publish landing between the two reads makes its baseline look older, never
// newer; hands ProductForm its count beside the baseline; and decides a draft's stock, and the notes
// about it, from the same row as publish does.
describe("/cms/products/[id]/edit and the product's last publish", () => {
  const draftOf = (meta: Record<string, unknown>) => ({
    id: 7,
    product_id: PRODUCT_ID,
    meta: { [PRODUCT_DRAFT_FORM_MARKER_KEY]: PRODUCT_DRAFT_FORM_MARKER_VALUE, sku: 'PRO', price: 49, variants: [], ...meta },
    blocks: [],
    created_at: '2026-11-01T00:00:00+00:00',
  });

  it("reads it before the product and hands ProductForm its count beside the baseline", async () => {
    mocks.canPublish.mockResolvedValue(true);
    mocks.product = { ...mocks.product, sku: 'PRO', stock: 6 };
    mocks.draft = null;
    mocks.stockPublish = { data: { publish_count: 3, stock: { PRO: { loaded: 4, entered: 6 } } }, error: null };

    expect((await shellProps()).initialData).toMatchObject({ stock: 6, stock_baseline: { PRO: 6 }, stock_baseline_publish_count: 3 });
    expect(mocks.reads.indexOf('product_stock_publishes')).toBeGreaterThan(-1);
    expect(mocks.reads.indexOf('product_stock_publishes')).toBeLessThan(mocks.reads.indexOf('getCmsProduct'));
  });

  it('shows a draft started again after that publish as publish writes it, names the SKU, and records the count it read', async () => {
    mocks.canPublish.mockResolvedValue(true);
    // Loaded 5 before the publish (count 0), typed 10 and published; one sold since: 9 live.
    mocks.product = { ...mocks.product, sku: 'PRO', stock: 9 };
    mocks.stockPublish = { data: { publish_count: 1, stock: { PRO: { loaded: 5, entered: 10 } } }, error: null };
    mocks.draft = draftOf({ stock: 10, stock_baseline: { PRO: 5 }, stock_baseline_publish_count: 0 });

    const tree = await EditProductPage({ params: Promise.resolve({ id: PRODUCT_ID }), searchParams: Promise.resolve({}) });
    const initialData = findElement(tree, ProductFormClientShell)?.props.initialData as Record<string, any>;

    // 9, not 14: the form shows the stock as it is, and records this page load's stock and count.
    expect(initialData).toMatchObject({ stock: 9, stock_baseline: { PRO: 9 }, stock_baseline_publish_count: 1 });
    expect(findNotices(tree)).toContain(
      "This draft was started on a page loaded before the product's last publish, which already entered this draft's stock figure, so publishing leaves the stock as it is, with what sold or changed since: PRO stays at 9 (the last publish entered 10). If the figure was meant to replace the stock as it now is, enter the figure the stock should have."
    );
    const [, , options] = vi.mocked(mergeProductDraftMetaIntoFormInitialData).mock.calls[0];
    expect(options.stockPublish?.count).toBe(1);
    expect(Object.fromEntries(options.stockPublish?.entries ?? [])).toEqual({ PRO: { loaded: 5, entered: 10 } });
  });

  it('records no publish on a database without the table (02047 not applied), and fails on any other error rather than show a stock it could not check', async () => {
    mocks.canPublish.mockResolvedValue(true);
    mocks.product = { ...mocks.product, sku: 'PRO', stock: 9 };
    mocks.draft = draftOf({ stock: 10, stock_baseline: { PRO: 5 }, stock_baseline_publish_count: 0 });

    mocks.stockPublish = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.product_stock_publishes'" } };
    // As 02044 publishes it: the change from 5 applied to 9.
    expect((await shellProps()).initialData).toMatchObject({ stock: 14, stock_baseline: { PRO: 9 }, stock_baseline_publish_count: 0 });

    mocks.stockPublish = { data: null, error: { code: '42501', message: 'permission denied for table product_stock_publishes' } };
    await expect(shellProps()).rejects.toThrow("The product's last publish could not be read: permission denied");
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
