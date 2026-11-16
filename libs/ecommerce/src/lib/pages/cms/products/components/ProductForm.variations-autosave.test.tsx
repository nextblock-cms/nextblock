// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Opening the product editor must not save anything by itself. Through 0.23.4's review the variations
 * editor emitted its variants when it mounted (its initial ones, then the ones it regenerated from the
 * selected terms), and ProductForm set them with shouldDirty, so the autosave fired 400 ms later with
 * no input for every product with variants: every visit created a draft, a block-edit or legacy draft
 * turned into product values, and an old draft got the 0.23.4 marker before anyone read the edit
 * page's note. The regeneration also rebuilt every combination of the selected terms (a product
 * without all of them gained the missing ones) and gave a variant without a sale price the product's.
 * Now the editor opens on the variants the form holds and regenerates only when a term is toggled,
 * ProductForm repairs the loaded variants a save would refuse in its initial values, ignores an
 * emission equal to the form on everything a save writes, shows a refused autosave, and a reset to
 * new initial data remounts the editor; every real edit still autosaves.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => <span role="img" aria-label={alt} data-src={src} />,
}));
// Server actions the form's children import; none runs here.
vi.mock('../actions', () => ({ triggerSingleProductSync: vi.fn() }));
vi.mock('../server-actions', () => ({ createCategoryAction: vi.fn() }));

import type { CurrencyRecord } from '../../../../currency';
import type { ProductAttribute } from '../../../../types';
import { mapRawVariantRelations } from '../../../../variation-utils';
import { ProductForm } from './ProductForm';

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';
const GROUP_ID = '523e4567-e89b-12d3-a456-426614174000';
const MEDIA_ID = '723e4567-e89b-12d3-a456-426614174000';

const ATTR_COLOR = '423e4567-e89b-12d3-a456-426614174001';
const TERM_RED = '323e4567-e89b-12d3-a456-426614174001';
const TERM_BLUE = '323e4567-e89b-12d3-a456-426614174002';
const TERM_GREEN = '323e4567-e89b-12d3-a456-426614174003';
const VARIANT_RED = '623e4567-e89b-12d3-a456-426614174001';
const VARIANT_BLUE = '623e4567-e89b-12d3-a456-426614174002';

const ATTR_LENGTH = '423e4567-e89b-12d3-a456-426614174011';
const ATTR_WIDTH = '423e4567-e89b-12d3-a456-426614174012';
const TERM_SHORT = '323e4567-e89b-12d3-a456-426614174011';
const TERM_LONG = '323e4567-e89b-12d3-a456-426614174012';
const TERM_NARROW = '323e4567-e89b-12d3-a456-426614174013';

const ATTR_SIZE = '423e4567-e89b-12d3-a456-426614174021';
const TERM_S = '323e4567-e89b-12d3-a456-426614174021';
const TERM_M = '323e4567-e89b-12d3-a456-426614174022';
const NEW_VARIANT_RED = '623e4567-e89b-12d3-a456-426614174091';
const NEW_VARIANT_BLUE = '623e4567-e89b-12d3-a456-426614174092';

const ENGLISH = { id: 1, name: 'English', code: 'en', is_default: true };
const FRENCH = { id: 2, name: 'Français', code: 'fr', is_default: false };
const LANGUAGES = [ENGLISH, FRENCH];

const USD: CurrencyRecord = { code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true };
/** A store-managed currency: its product amounts derive from USD at the current rate. */
const EUR: CurrencyRecord = {
  code: 'EUR',
  symbol: '€',
  exchange_rate: 0.9,
  is_default: false,
  is_active: true,
  auto_sync_product_prices: true,
};
/** A currency the operator prices by hand. */
const CAD: CurrencyRecord = {
  code: 'CAD',
  symbol: '$',
  exchange_rate: 1.4,
  is_default: false,
  is_active: true,
  auto_sync_product_prices: false,
};
const USD_ONLY = [USD];
const USD_AND_CAD = [USD, CAD];

/** A product sale scheduled for later. */
const SALE_START = '2027-11-27T00:00:00+00:00';
const SALE_END = '2027-11-30T00:00:00+00:00';

const COLOR_TERMS = [
  { id: TERM_RED, attribute_id: ATTR_COLOR, value: 'Red', slug: 'red', sort_order: 0, value_translations: {} },
  { id: TERM_BLUE, attribute_id: ATTR_COLOR, value: 'Blue', slug: 'blue', sort_order: 1, value_translations: {} },
  { id: TERM_GREEN, attribute_id: ATTR_COLOR, value: 'Green', slug: 'green', sort_order: 2, value_translations: {} },
];

/** The global attribute list as the edit pages pass it (getGlobalProductAttributes: by name, terms by sort order). */
const COLOR_ATTRIBUTES: ProductAttribute[] = [
  { id: ATTR_COLOR, name: 'Color', slug: 'color', name_translations: {}, terms: COLOR_TERMS },
];

const SIZE_ATTRIBUTES: ProductAttribute[] = [
  {
    id: ATTR_LENGTH,
    name: 'Length',
    slug: 'length',
    name_translations: { fr: 'Longueur' },
    terms: [
      { id: TERM_SHORT, attribute_id: ATTR_LENGTH, value: 'Short', slug: 'short', sort_order: 0, value_translations: { fr: 'Court' } },
      { id: TERM_LONG, attribute_id: ATTR_LENGTH, value: 'Long', slug: 'long', sort_order: 1, value_translations: { fr: 'Long' } },
    ],
  },
  {
    id: ATTR_WIDTH,
    name: 'Width',
    slug: 'width',
    name_translations: { fr: 'Largeur' },
    terms: [
      { id: TERM_NARROW, attribute_id: ATTR_WIDTH, value: 'Narrow', slug: 'narrow', sort_order: 0, value_translations: { fr: 'Étroit' } },
    ],
  },
];

const SIZE_TERMS = [
  { id: TERM_S, attribute_id: ATTR_SIZE, value: 'S', slug: 's', sort_order: 0, value_translations: {} },
  { id: TERM_M, attribute_id: ATTR_SIZE, value: 'M', slug: 'm', sort_order: 1, value_translations: {} },
];

const TEE_ATTRIBUTES: ProductAttribute[] = [
  COLOR_ATTRIBUTES[0],
  { id: ATTR_SIZE, name: 'Size', slug: 'size', name_translations: {}, terms: SIZE_TERMS },
];

type Row = Record<string, any>;

/** buildCombinationKey (variation-utils.ts). */
function combinationKey(...termIds: string[]) {
  return [...termIds].sort().join('__');
}

function teeMapping(termId: string) {
  const attribute = TEE_ATTRIBUTES.find((candidate) => candidate.terms.some((term) => term.id === termId));
  const term = attribute?.terms.find((candidate) => candidate.id === termId);
  if (!attribute || !term) throw new Error(`no tee term ${termId}`);
  return {
    attribute_term_id: termId,
    product_attribute_terms: {
      ...term,
      product_attributes: { id: attribute.id, name: attribute.name, slug: attribute.slug, name_translations: {} },
    },
  };
}

function colorMapping(termId: string) {
  const term = COLOR_TERMS.find((candidate) => candidate.id === termId);
  if (!term) throw new Error(`no color term ${termId}`);
  return {
    attribute_term_id: termId,
    product_attribute_terms: {
      ...term,
      product_attributes: { id: ATTR_COLOR, name: 'Color', slug: 'color', name_translations: {} },
    },
  };
}

function sizeMapping(termId: string) {
  const attribute = SIZE_ATTRIBUTES.find((candidate) => candidate.terms.some((term) => term.id === termId));
  const term = attribute?.terms.find((candidate) => candidate.id === termId);
  if (!attribute || !term) throw new Error(`no size term ${termId}`);
  return {
    attribute_term_id: termId,
    product_attribute_terms: {
      ...term,
      product_attributes: {
        id: attribute.id,
        name: attribute.name,
        slug: attribute.slug,
        name_translations: attribute.name_translations,
      },
    },
  };
}

/** A `product_variants` row as getProduct() returns it (minor units, attribute mappings joined). */
function variantRow(overrides: Row): Row {
  return {
    upc: null,
    main_media_id: null,
    sale_price: null,
    sale_prices: null,
    sale_start_at: null,
    sale_end_at: null,
    scheduled_price: null,
    scheduled_prices: null,
    scheduled_price_at: null,
    media: null,
    ...overrides,
  };
}

/** The live red and blue variants. Their rows come back blue first, the reverse of the editor's term order. */
function colorVariantRows(): Row[] {
  return [
    variantRow({
      id: VARIANT_BLUE,
      sku: 'PRO-BLUE',
      price: 5400,
      prices: { USD: 5400 },
      stock_quantity: 3,
      variant_attribute_mapping: [colorMapping(TERM_BLUE)],
    }),
    variantRow({
      id: VARIANT_RED,
      sku: 'PRO-RED',
      upc: '0123456789012',
      main_media_id: MEDIA_ID,
      media: { id: MEDIA_ID, file_path: '/images/products/red.avif', object_key: null, description: null },
      price: 4900,
      prices: { USD: 4900 },
      sale_price: 3900,
      sale_prices: { USD: 3900 },
      sale_start_at: '2026-12-01T00:00:00+00:00',
      sale_end_at: '2026-12-31T00:00:00+00:00',
      // A pending price change the promotions import scheduled. The editor never emits these columns.
      scheduled_price: 4500,
      scheduled_prices: { USD: 4500 },
      scheduled_price_at: '2027-01-15T00:00:00+00:00',
      stock_quantity: 7,
      variant_attribute_mapping: [colorMapping(TERM_RED)],
    }),
  ];
}

/**
 * Two of the four Color x Size combinations, Red/S and Blue/M (Cortex's manage_product_variants and a
 * CMS import store whatever set they are given; the storefront supports one).
 */
function partialTeeVariantRows(): Row[] {
  return [
    variantRow({
      id: VARIANT_RED,
      sku: 'TEE-RED-S',
      price: 4900,
      prices: { USD: 4900 },
      stock_quantity: 4,
      variant_attribute_mapping: [teeMapping(TERM_RED), teeMapping(TERM_S)],
    }),
    variantRow({
      id: VARIANT_BLUE,
      sku: 'TEE-BLUE-M',
      price: 5400,
      prices: { USD: 5400 },
      stock_quantity: 1,
      variant_attribute_mapping: [teeMapping(TERM_BLUE), teeMapping(TERM_M)],
    }),
  ];
}

/** The color variants, also priced by hand in CAD. */
function colorVariantRowsWithCad(): Row[] {
  return colorVariantRows().map((row) => ({
    ...row,
    prices: { ...row.prices, CAD: row.price === 5400 ? 7600 : 6900 },
    sale_prices: row.sale_prices ? { ...row.sale_prices, CAD: 5500 } : null,
  }));
}

function toMajorAmounts(amounts: unknown) {
  return Object.entries((amounts ?? {}) as Record<string, unknown>).reduce<Record<string, number>>(
    (accumulator, [currencyCode, amount]) => {
      if (typeof amount === 'number') {
        accumulator[currencyCode] = amount / 100;
      }
      return accumulator;
    },
    {}
  );
}

/**
 * The edit page's initial data for a live product: the products row (minor units at the top level,
 * price maps in major units) with its variants mapped the way the app's buildProductFormInitialData
 * and the lib's EditProductPage both map them (`...variant` keeps every mapRawVariantRelations key).
 */
function editPageInitialData(product: Row, languageCode: string) {
  const { attributes, variants } = mapRawVariantRelations(product.product_variants ?? [], languageCode);

  return {
    ...product,
    prices: toMajorAmounts(product.prices),
    sale_prices: toMajorAmounts(product.sale_prices),
    category_ids: [],
    variation_attributes: attributes.map((attribute) => ({
      attribute_id: attribute.id,
      term_ids: attribute.terms.map((term) => term.id),
    })),
    variants: variants.map((variant) => ({
      ...variant,
      upc: variant.upc ?? null,
      price: variant.price / 100,
      prices: toMajorAmounts(variant.prices),
      sale_price: typeof variant.sale_price === 'number' ? variant.sale_price / 100 : null,
      sale_prices: toMajorAmounts(variant.sale_prices),
      main_media_id: variant.main_media_id ?? null,
      main_image_url: variant.image_url ?? null,
    })),
  } as any;
}

function physicalProduct(overrides: Row = {}): Row {
  return {
    id: PRODUCT_ID,
    product_type: 'physical',
    payment_provider: 'stripe',
    title: 'Pro plugin',
    slug: 'pro-plugin',
    sku: 'PRO',
    upc: null,
    is_taxable: true,
    price: 4900,
    prices: { USD: 4900 },
    sale_price: null,
    sale_prices: null,
    sale_start_at: null,
    sale_end_at: null,
    stock: 10,
    status: 'active',
    short_description: 'Short copy',
    description_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rich' }] }] },
    meta_title: 'Pro plugin | Store',
    meta_description: 'The pro plugin.',
    custom_canonical: null,
    freemius_product_id: null,
    freemius_plan_id: null,
    trial_period_days: 0,
    trial_requires_payment_method: false,
    language_id: 1,
    translation_group_id: GROUP_ID,
    product_media: [],
    product_variants: colorVariantRows(),
    ...overrides,
  };
}

type UpdateAction = (values: Record<string, unknown>) => Promise<{ success: boolean }>;

let mounted: { root: Root; container: HTMLElement } | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mounted) {
    const { root, container } = mounted;
    act(() => root.unmount());
    container.remove();
    mounted = null;
  }
});

const ENABLED_PROVIDERS = { stripe: true, freemius: true };
const CONFIG_STATUS = { stripe: { hasKeys: true, missing: [] }, freemius: { hasKeys: true, missing: [] } };

async function openEditor(
  initialData: Row,
  options: { currencies?: CurrencyRecord[]; globalAttributes?: ProductAttribute[] } = {}
) {
  const updateAction = vi.fn<UpdateAction>(async () => ({ success: true }));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { root, container };

  // The page's other props keep their identity across a re-render, as the edit page's do.
  const render = (data: Row) =>
    root.render(
      <ProductForm
        initialData={data as any}
        isEdit
        availableLanguagesProp={LANGUAGES}
        globalAttributesProp={options.globalAttributes ?? COLOR_ATTRIBUTES}
        currenciesProp={options.currencies ?? USD_ONLY}
        enabledProviders={ENABLED_PROVIDERS}
        configStatus={CONFIG_STATUS}
        updateAction={updateAction}
      />
    );

  await act(async () => {
    render(initialData);
  });

  /** The page renders again with new initial data (router.refresh after a publish or a discard). */
  async function rerender(nextInitialData: Row) {
    await act(async () => {
      render(nextInitialData);
    });
  }

  return { container, updateAction, rerender };
}

/** Longer than the 400 ms autosave debounce, with no input. */
async function waitPastTheDebounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });
}

/** Waits for the autosave numbered `count` (the debounce is 400 ms) and returns what it sent. */
async function autosave(updateAction: ReturnType<typeof vi.fn<UpdateAction>>, count: number) {
  await act(async () => {
    await vi.waitFor(() => expect(updateAction).toHaveBeenCalledTimes(count), { timeout: 3000, interval: 50 });
  });
  return updateAction.mock.calls[count - 1][0] as Row;
}

function input(id: string) {
  const element = document.getElementById(id);
  expect(element, `#${id}`).toBeInstanceOf(HTMLInputElement);
  return element as HTMLInputElement;
}

function button(container: HTMLElement, text: string) {
  const element = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text);
  expect(element, `button "${text}"`).toBeDefined();
  return element as HTMLButtonElement;
}

async function typeInto(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function variantByKey(values: Row, combinationKey: string) {
  return (values.variants as Row[]).find((variant) => variant.combination_key === combinationKey);
}

/** The save status line when it reports an error, else null. */
function saveErrorText(container: HTMLElement) {
  const span = [...container.querySelectorAll('span')].find((candidate) =>
    candidate.textContent?.startsWith('Error saving settings')
  );
  return span?.textContent ?? null;
}

/** Waits for the autosave to be refused (the debounce is 400 ms) and returns the status line. */
async function refusedAutosave(container: HTMLElement) {
  // React renders what an act() scope sets when the scope ends, so this polls between scopes.
  for (let waited = 0; waited < 3000 && saveErrorText(container) === null; waited += 50) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
  return saveErrorText(container);
}

describe('opening the product editor saves nothing by itself', () => {
  it('for a product with variants (rows in another order than the editor, a scheduled price, a variant image)', async () => {
    const { updateAction } = await openEditor(editPageInitialData(physicalProduct(), 'en'));
    await waitPastTheDebounce();

    // The variations editor mounted and regenerated both variants...
    expect(input(`variant-sku-${TERM_RED}`).value).toBe('PRO-RED');
    expect(input(`variant-sku-${TERM_BLUE}`).value).toBe('PRO-BLUE');
    // ...and nothing was saved.
    expect(updateAction).not.toHaveBeenCalled();
  });

  it('for a French product whose options sort one way by translated name and the other in the attribute list', async () => {
    const product = physicalProduct({
      language_id: FRENCH.id,
      product_variants: [
        variantRow({
          id: VARIANT_RED,
          sku: 'PRO-COURT-ETROIT',
          price: 4900,
          prices: { USD: 4900 },
          stock_quantity: 2,
          variant_attribute_mapping: [sizeMapping(TERM_SHORT), sizeMapping(TERM_NARROW)],
        }),
        variantRow({
          id: VARIANT_BLUE,
          sku: 'PRO-LONG-ETROIT',
          price: 5900,
          prices: { USD: 5900 },
          stock_quantity: 4,
          variant_attribute_mapping: [sizeMapping(TERM_LONG), sizeMapping(TERM_NARROW)],
        }),
      ],
    });
    const initialData = editPageInitialData(product, 'fr');
    // mapRawVariantRelations sorts the options by translated name (Largeur before Longueur); the editor
    // builds them in the attribute list's order (Length, then Width).
    expect(initialData.variants[0].label).toBe('Étroit / Court');

    const { updateAction } = await openEditor(initialData, { globalAttributes: SIZE_ATTRIBUTES });
    await waitPastTheDebounce();

    expect(input(`variant-sku-${[TERM_SHORT, TERM_NARROW].sort().join('__')}`).value).toBe('PRO-COURT-ETROIT');
    expect(updateAction).not.toHaveBeenCalled();
  });

  it('for an older draft whose variants predate the variant sale window (keys the editor fills with null)', async () => {
    const live = editPageInitialData(physicalProduct(), 'en');
    // A product-values draft as an earlier release saved it: no sale window keys on its variants (the
    // editor emits them as null), and none of the columns productSchema strips.
    const absentKeys = ['sale_start_at', 'sale_end_at', 'scheduled_price', 'scheduled_prices', 'scheduled_price_at', 'image_url'];
    const olderDraftVariants = (live.variants as Row[]).map((variant) =>
      Object.fromEntries(Object.entries(variant).filter(([key]) => !absentKeys.includes(key)))
    );
    const { updateAction } = await openEditor({ ...live, variants: olderDraftVariants });
    await waitPastTheDebounce();

    expect(updateAction).not.toHaveBeenCalled();
  });

  it('for a product whose variants store an amount for a store-managed currency (the form never holds those)', async () => {
    const product = physicalProduct({
      prices: { USD: 4900, EUR: 4000 },
      product_variants: colorVariantRows().map((row) => ({ ...row, prices: { ...row.prices, EUR: 4000 } })),
    });
    const { updateAction } = await openEditor(editPageInitialData(product, 'en'), { currencies: [USD, EUR] });
    await waitPastTheDebounce();

    // The editor shows the amount derived from USD at today's rate, not the stored 40.00...
    expect(input(`variant-${TERM_RED}-price-EUR`).value).not.toBe('40.00');
    // ...and that recomputation is no change to save.
    expect(updateAction).not.toHaveBeenCalled();
  });

  it('for a product without variants, as before', async () => {
    const { updateAction } = await openEditor(editPageInitialData(physicalProduct({ product_variants: [] }), 'en'));
    await waitPastTheDebounce();

    expect(updateAction).not.toHaveBeenCalled();
  });

  it('nor closing and reopening the variations panel, which keeps the variant edits made before', async () => {
    const { container, updateAction } = await openEditor(editPageInitialData(physicalProduct(), 'en'));

    await click(button(container, 'Hide'));
    await click(button(container, 'Manage'));
    await waitPastTheDebounce();
    expect(updateAction).not.toHaveBeenCalled();

    await typeInto(input(`variant-${TERM_BLUE}-price-USD`), '59');
    expect(variantByKey(await autosave(updateAction, 1), TERM_BLUE)).toMatchObject({ price: 59 });

    // The editor remounts from the form, not from the variants the page loaded.
    await click(button(container, 'Hide'));
    await click(button(container, 'Manage'));
    await waitPastTheDebounce();
    expect(input(`variant-${TERM_BLUE}-price-USD`).value).toBe('59.00');
    expect(updateAction).toHaveBeenCalledTimes(1);
  });

  it('for a digital product, as before', async () => {
    const { updateAction } = await openEditor(
      editPageInitialData(
        physicalProduct({
          product_type: 'digital',
          payment_provider: 'freemius',
          sku: 'FM-28609-47122',
          price: 25000,
          prices: { USD: 25000 },
          freemius_product_id: '28609',
          freemius_plan_id: '47122',
          trial_period_days: 14,
          product_variants: [],
        }),
        'en'
      )
    );
    await waitPastTheDebounce();

    expect(updateAction).not.toHaveBeenCalled();
  });

  it('for a product whose variants are not every combination of their terms, listing exactly those', async () => {
    const { container, updateAction } = await openEditor(
      editPageInitialData(physicalProduct({ sku: 'TEE', product_variants: partialTeeVariantRows() }), 'en'),
      { globalAttributes: TEE_ATTRIBUTES }
    );
    await waitPastTheDebounce();

    // Regenerated on open, the list gained Red/M and Blue/S at the product's price with stock 0.
    expect(updateAction).not.toHaveBeenCalled();
    expect(container.textContent).toContain('2 variants');
    expect(input(`variant-sku-${combinationKey(TERM_RED, TERM_S)}`).value).toBe('TEE-RED-S');
    expect(input(`variant-sku-${combinationKey(TERM_BLUE, TERM_M)}`).value).toBe('TEE-BLUE-M');
    expect(document.getElementById(`variant-sku-${combinationKey(TERM_RED, TERM_M)}`)).toBeNull();
    expect(document.getElementById(`variant-sku-${combinationKey(TERM_BLUE, TERM_S)}`)).toBeNull();
  });

  it('for such a product whose prices lack the default currency (the form fills it in once it opens)', async () => {
    const product = physicalProduct({ sku: 'TEE', prices: { CAD: 6900 }, product_variants: partialTeeVariantRows() });
    const { container, updateAction } = await openEditor(editPageInitialData(product, 'en'), {
      currencies: USD_AND_CAD,
      globalAttributes: TEE_ATTRIBUTES,
    });
    await waitPastTheDebounce();

    expect(updateAction).not.toHaveBeenCalled();
    expect(container.textContent).toContain('2 variants');
  });

  it('for a product with a sale price whose variant has none, which a save keeps without one', async () => {
    const product = physicalProduct({
      sale_price: 3900,
      sale_prices: { USD: 3900 },
      sale_start_at: SALE_START,
      sale_end_at: SALE_END,
    });
    const { updateAction } = await openEditor(editPageInitialData(product, 'en'));
    await waitPastTheDebounce();

    // The blue variant has no sale of its own. Regenerated on open, it took the product's sale price
    // without the product's window: published, it was on sale at once and for good.
    expect(updateAction).not.toHaveBeenCalled();
    expect(input(`variant-${TERM_BLUE}-sale-price-USD`).value).toBe('');

    await typeInto(input('title'), 'Pro plugin (edited)');
    const blue = variantByKey(await autosave(updateAction, 1), TERM_BLUE);
    expect(blue).toMatchObject({ price: 54, sale_price: null, sale_start_at: null, sale_end_at: null });
    expect(blue?.sale_prices).toEqual({});
  });

  it('for a draft saved before its terms were renamed (or translated)', async () => {
    // The draft's variants carry the names of the day ("Color: Red"); in French the attribute list
    // now reads "Couleur: Rouge vif". Only the term ids are saved.
    const renamed: ProductAttribute[] = [
      {
        ...COLOR_ATTRIBUTES[0],
        name_translations: { fr: 'Couleur' },
        terms: COLOR_TERMS.map((term) =>
          term.id === TERM_RED ? { ...term, value_translations: { fr: 'Rouge vif' } } : term
        ),
      },
    ];
    const { container, updateAction } = await openEditor(
      editPageInitialData(physicalProduct({ language_id: FRENCH.id }), 'fr'),
      { globalAttributes: renamed }
    );
    await waitPastTheDebounce();

    expect(updateAction).not.toHaveBeenCalled();
    expect(button(container, 'Rouge vif')).toBeDefined();
    expect(container.textContent).toContain('Color: Red');
  });

  it('for variants without their options or label, which it lists, names and saves with the next edit', async () => {
    const live = editPageInitialData(physicalProduct(), 'en');
    const variants = (live.variants as Row[]).map((variant) => {
      const withoutDisplay = { ...variant };
      delete withoutDisplay.selected_options;
      delete withoutDisplay.label;
      return withoutDisplay;
    });
    const { container, updateAction } = await openEditor({ ...live, variants });
    await waitPastTheDebounce();

    expect(input(`variant-sku-${TERM_RED}`).value).toBe('PRO-RED');
    expect(input(`variant-sku-${TERM_BLUE}`).value).toBe('PRO-BLUE');
    expect(container.textContent).toContain('Color: Red');
    expect(updateAction).not.toHaveBeenCalled();

    // productSchema requires both keys: with them missing, no edit saved and nothing said so.
    await typeInto(input('title'), 'Pro plugin (edited)');
    const values = await autosave(updateAction, 1);
    expect(values.title).toBe('Pro plugin (edited)');
    expect(variantByKey(values, TERM_RED)).toMatchObject({
      sku: 'PRO-RED',
      label: 'Red',
      selected_options: [{ attribute_id: ATTR_COLOR, term_id: TERM_RED, term_value: 'Red' }],
    });
    expect(variantByKey(values, TERM_BLUE)).toMatchObject({ sku: 'PRO-BLUE', label: 'Blue' });
  });

  it.each([
    ['no selected terms (the editor takes them from the variants)', []],
    [
      'an attribute without a selected term',
      [
        { attribute_id: ATTR_COLOR, term_ids: [TERM_BLUE, TERM_RED] },
        { attribute_id: ATTR_LENGTH, term_ids: [] },
      ],
    ],
  ])('for variants that come with %s, nor reopening the panel', async (_label, variationAttributes) => {
    const { container, updateAction } = await openEditor({
      ...editPageInitialData(physicalProduct(), 'en'),
      variation_attributes: variationAttributes,
    });
    // Mounted with the form, the editor's first emission is undone by the form's reset on mount; a
    // panel opened later emits into the form as it is.
    await click(button(container, 'Hide'));
    await click(button(container, 'Manage'));
    await waitPastTheDebounce();

    expect(updateAction).not.toHaveBeenCalled();
    // The term buttons show the selection the editor took from the variants.
    expect(button(container, 'Red').className).toContain('bg-primary/10');
    expect(button(container, 'Green').className).not.toContain('bg-primary/10');
  });
});

describe('loaded variants a save would refuse, and a refused autosave', () => {
  // Until the editor stopped regenerating on open, that regeneration repaired these (with an
  // autosave on open); after it, each of them blocked every save, and nothing said so.
  it('leaves out a variant whose only term was deleted, and the next edit saves the others', async () => {
    const rows = colorVariantRows();
    // Blue's term was deleted in Attribute Management: its variant_attribute_mapping rows cascade.
    rows[0] = { ...rows[0], variant_attribute_mapping: [] };
    const { container, updateAction } = await openEditor(
      editPageInitialData(physicalProduct({ product_variants: rows }), 'en')
    );
    await waitPastTheDebounce();

    expect(updateAction).not.toHaveBeenCalled();
    expect(container.textContent).toContain('1 variants');

    await typeInto(input('title'), 'Pro plugin (edited)');
    const values = await autosave(updateAction, 1);
    expect(values.title).toBe('Pro plugin (edited)');
    expect((values.variants as Row[]).map((variant) => [variant.combination_key, variant.sku, variant.id])).toEqual([
      [TERM_RED, 'PRO-RED', VARIANT_RED],
    ]);
  });

  it('leaves out every variant of a deleted attribute, as 0.23.3 did when it opened', async () => {
    const rows = colorVariantRows().map((row) => ({ ...row, variant_attribute_mapping: [] }));
    const { updateAction } = await openEditor(
      editPageInitialData(physicalProduct({ product_variants: rows }), 'en'),
      { globalAttributes: [] }
    );
    await waitPastTheDebounce();
    expect(updateAction).not.toHaveBeenCalled();

    await typeInto(input('title'), 'Pro plugin (edited)');
    expect(await autosave(updateAction, 1)).toMatchObject({ title: 'Pro plugin (edited)', variants: [] });
  });

  it('keeps only the first of variants an attribute deletion left with the same terms, and an edit changes only it', async () => {
    // A Color x Size tee whose Size attribute was deleted: each variant kept only its Color mapping
    // (the cascade), so Red/S and Red/M are both Red now. The storefront only ever sells the first.
    const rows = [
      variantRow({
        id: VARIANT_RED,
        sku: 'TEE-RED-S',
        price: 4900,
        prices: { USD: 4900 },
        stock_quantity: 4,
        variant_attribute_mapping: [colorMapping(TERM_RED)],
      }),
      variantRow({
        id: NEW_VARIANT_RED,
        sku: 'TEE-RED-M',
        price: 4900,
        prices: { USD: 4900 },
        stock_quantity: 6,
        variant_attribute_mapping: [colorMapping(TERM_RED)],
      }),
      variantRow({
        id: VARIANT_BLUE,
        sku: 'TEE-BLUE-S',
        price: 5400,
        prices: { USD: 5400 },
        stock_quantity: 3,
        variant_attribute_mapping: [colorMapping(TERM_BLUE)],
      }),
    ];
    const { container, updateAction } = await openEditor(
      editPageInitialData(physicalProduct({ sku: 'TEE', product_variants: rows }), 'en')
    );
    await waitPastTheDebounce();
    expect(updateAction).not.toHaveBeenCalled();
    expect(container.textContent).toContain('2 variants');

    // Kept, the pair made the form and the editor disagree: reopening the panel saved them unchanged.
    await click(button(container, 'Hide'));
    await click(button(container, 'Manage'));
    await waitPastTheDebounce();
    expect(updateAction).not.toHaveBeenCalled();

    // Kept, an edit in one Red row was written into both (the rows are keyed by their terms).
    await typeInto(input(`variant-stock-${TERM_RED}`), '9');
    const values = await autosave(updateAction, 1);
    expect(values.variants).toHaveLength(2);
    expect(variantByKey(values, TERM_RED)).toMatchObject({ id: VARIANT_RED, sku: 'TEE-RED-S', stock_quantity: 9 });
    expect(variantByKey(values, TERM_BLUE)).toMatchObject({ id: VARIANT_BLUE, sku: 'TEE-BLUE-S', stock_quantity: 3 });
  });

  it('gives a variant stored with an empty SKU the one a new variant gets, and the next edit saves it', async () => {
    const rows = colorVariantRows();
    rows[0] = { ...rows[0], sku: '' };
    const { updateAction } = await openEditor(
      editPageInitialData(physicalProduct({ product_variants: rows }), 'en')
    );
    await waitPastTheDebounce();

    expect(updateAction).not.toHaveBeenCalled();
    expect(input(`variant-sku-${TERM_BLUE}`).value).toBe('PRO-BLUE');

    await typeInto(input('title'), 'Pro plugin (edited)');
    const values = await autosave(updateAction, 1);
    expect(variantByKey(values, TERM_BLUE)).toMatchObject({ id: VARIANT_BLUE, sku: 'PRO-BLUE', price: 54, stock_quantity: 3 });
    expect(variantByKey(values, TERM_RED)).toMatchObject({ id: VARIANT_RED, sku: 'PRO-RED' });
  });

  it('shows a refused autosave with the first refused field, and saves once it is fixed', async () => {
    const { container, updateAction } = await openEditor(editPageInitialData(physicalProduct(), 'en'));

    await typeInto(input(`variant-sku-${TERM_RED}`), '');
    expect(await refusedAutosave(container)).toBe(
      'Error saving settings: Variant 2 (Red), sku: Variant SKU is required'
    );
    expect(updateAction).not.toHaveBeenCalled();

    await typeInto(input(`variant-sku-${TERM_RED}`), 'PRO-RED-2');
    expect(variantByKey(await autosave(updateAction, 1), TERM_RED)).toMatchObject({ sku: 'PRO-RED-2' });
    expect(saveErrorText(container)).toBeNull();
  });

  it('keeps variants naming terms this store lacks through a product SKU edit, and shows why none saves', async () => {
    // A CMS draft import from another install: its variants name terms this store does not have, so
    // the edit page's merge gives them no options and no label, and the selection resolves to nothing.
    const live = editPageInitialData(physicalProduct(), 'en');
    const variants = (live.variants as Row[]).map((variant, index) => {
      const termId = `999e4567-e89b-12d3-a456-42661417400${index + 1}`;
      return { ...variant, combination_key: termId, attribute_term_ids: [termId], selected_options: [], label: '' };
    });
    const { container, updateAction } = await openEditor({ ...live, variation_attributes: [], variants });
    await waitPastTheDebounce();
    expect(updateAction).not.toHaveBeenCalled();

    // Regenerated on the SKU change, the list was emptied and saved: a publish deletes every variant.
    await typeInto(input('sku'), 'PRO2');
    const refusal = await refusedAutosave(container);
    expect(updateAction).not.toHaveBeenCalled();
    expect(refusal ?? '').toMatch(/^Error saving settings: Variant 1 \(PRO-BLUE\), selected_options: /);
    expect(container.textContent).toContain('2 variants');
  });
});

describe('a reset to new initial data (after a publish, a discard or a page refresh)', () => {
  it('saves nothing when the published variants come back with new ids, and the next edit saves those', async () => {
    const { updateAction, rerender } = await openEditor(editPageInitialData(physicalProduct(), 'en'));
    await waitPastTheDebounce();

    // The product RPC re-creates every variant on publish: the same values under new ids.
    const republished = colorVariantRows().map((row) => ({
      ...row,
      id: row.id === VARIANT_RED ? NEW_VARIANT_RED : NEW_VARIANT_BLUE,
    }));
    await rerender(editPageInitialData(physicalProduct({ product_variants: republished }), 'en'));
    await waitPastTheDebounce();
    expect(updateAction).not.toHaveBeenCalled();

    await typeInto(input(`variant-stock-${TERM_RED}`), '12');
    const values = await autosave(updateAction, 1);
    expect(variantByKey(values, TERM_RED)).toMatchObject({ id: NEW_VARIANT_RED, stock_quantity: 12 });
    expect(variantByKey(values, TERM_BLUE)).toMatchObject({ id: NEW_VARIANT_BLUE });
  });

  it("clears a refused autosave's message when the page renders the form again", async () => {
    const { container, updateAction, rerender } = await openEditor(editPageInitialData(physicalProduct(), 'en'));
    await typeInto(input(`variant-sku-${TERM_RED}`), '');
    expect(await refusedAutosave(container)).toContain('Variant 2 (Red), sku');

    // A description-block save, a publish or a discard renders the page again (router.refresh).
    await rerender(editPageInitialData(physicalProduct(), 'en'));
    await waitPastTheDebounce();

    expect(input(`variant-sku-${TERM_RED}`).value).toBe('PRO-RED');
    expect(saveErrorText(container)).toBeNull();
    expect(updateAction).not.toHaveBeenCalled();
  });

  it('saves nothing after a discard reloads the live variants, and the next edit keeps them', async () => {
    const live = editPageInitialData(physicalProduct(), 'en');
    // The open draft priced the blue variant at 64.
    const draft = {
      ...live,
      variants: (live.variants as Row[]).map((variant) =>
        variant.combination_key === TERM_BLUE ? { ...variant, price: 64, prices: { USD: 64 } } : variant
      ),
    };
    const { updateAction, rerender } = await openEditor(draft);
    await waitPastTheDebounce();
    expect(input(`variant-${TERM_BLUE}-price-USD`).value).toBe('64.00');

    // DraftStatusActions deleted the draft; the page renders the live product again.
    await rerender(editPageInitialData(physicalProduct(), 'en'));
    await waitPastTheDebounce();
    expect(updateAction).not.toHaveBeenCalled();
    expect(input(`variant-${TERM_BLUE}-price-USD`).value).toBe('54.00');

    await typeInto(input(`variant-stock-${TERM_RED}`), '12');
    const values = await autosave(updateAction, 1);
    expect(variantByKey(values, TERM_RED)).toMatchObject({ stock_quantity: 12 });
    expect(variantByKey(values, TERM_BLUE)).toMatchObject({ price: 54, prices: { USD: 54 } });
  });
});

describe('every real edit still autosaves', () => {
  it("a variant's price", async () => {
    const { updateAction } = await openEditor(editPageInitialData(physicalProduct(), 'en'));

    await typeInto(input(`variant-${TERM_BLUE}-price-USD`), '59');
    const values = await autosave(updateAction, 1);

    expect(variantByKey(values, TERM_BLUE)).toMatchObject({ price: 59, prices: { USD: 59 } });
    expect(variantByKey(values, TERM_RED)).toMatchObject({ price: 49, prices: { USD: 49 }, sale_price: 39, stock_quantity: 7 });
  });

  it.each([
    ['stock', `variant-stock-${TERM_RED}`, '12', { stock_quantity: 12 }],
    ['SKU', `variant-sku-${TERM_RED}`, 'PRO-RED-2', { sku: 'PRO-RED-2' }],
  ])("a variant's %s", async (_label, id, value, expected) => {
    const { updateAction } = await openEditor(editPageInitialData(physicalProduct(), 'en'));

    await typeInto(input(id), value);
    const values = await autosave(updateAction, 1);

    expect(variantByKey(values, TERM_RED)).toMatchObject(expected);
  });

  it('a toggled term, whose new variant takes the base price', async () => {
    const { container, updateAction } = await openEditor(editPageInitialData(physicalProduct(), 'en'));

    await click(button(container, 'Green'));
    const values = await autosave(updateAction, 1);

    expect(values.variants).toHaveLength(3);
    expect(variantByKey(values, TERM_GREEN)).toMatchObject({ sku: 'PRO-GREEN', price: 49, prices: { USD: 49 } });
    expect(values.variation_attributes).toEqual([
      { attribute_id: ATTR_COLOR, term_ids: expect.arrayContaining([TERM_RED, TERM_BLUE, TERM_GREEN]) },
    ]);
  });

  it('a variant generated after a base price change takes the new base price', async () => {
    const { container, updateAction } = await openEditor(editPageInitialData(physicalProduct({ product_variants: [] }), 'en'));

    await typeInto(input('product-price-USD'), '59');
    expect(await autosave(updateAction, 1)).toMatchObject({ price: 59, variants: [] });

    await click(button(container, 'Manage'));
    await click(button(container, 'Red'));
    const values = await autosave(updateAction, 2);

    expect(values.variants).toEqual([expect.objectContaining({ combination_key: TERM_RED, price: 59, prices: { USD: 59 } })]);
  });

  it('the title, saving the loaded variants without the columns the form never writes', async () => {
    const { updateAction } = await openEditor(editPageInitialData(physicalProduct(), 'en'));

    await typeInto(input('title'), 'Pro plugin (edited)');
    const values = await autosave(updateAction, 1);

    expect(values.title).toBe('Pro plugin (edited)');
    const red = variantByKey(values, TERM_RED) ?? {};
    expect(red).toMatchObject({
      id: VARIANT_RED,
      sku: 'PRO-RED',
      upc: '0123456789012',
      price: 49,
      prices: { USD: 49 },
      sale_price: 39,
      sale_prices: { USD: 39 },
      sale_start_at: '2026-12-01T00:00:00+00:00',
      sale_end_at: '2026-12-31T00:00:00+00:00',
      stock_quantity: 7,
      main_media_id: MEDIA_ID,
      main_image_url: '/images/products/red.avif',
      attribute_term_ids: [TERM_RED],
    });
    // productSchema strips what the editor never emits; the product RPC would not write it anyway.
    for (const key of ['scheduled_price', 'scheduled_prices', 'scheduled_price_at', 'image_url']) {
      expect(red).not.toHaveProperty(key);
    }
    expect(variantByKey(values, TERM_BLUE)).toMatchObject({ id: VARIANT_BLUE, price: 54, stock_quantity: 3 });
  });

  it('the title of a product without variants, as before', async () => {
    const { updateAction } = await openEditor(editPageInitialData(physicalProduct({ product_variants: [] }), 'en'));

    await typeInto(input('title'), 'Pro plugin (edited)');
    expect(await autosave(updateAction, 1)).toMatchObject({ title: 'Pro plugin (edited)', variants: [] });
  });

  it('the title of a digital product, as before', async () => {
    const { updateAction } = await openEditor(
      editPageInitialData(
        physicalProduct({
          product_type: 'digital',
          payment_provider: 'freemius',
          sku: 'FM-28609-47122',
          price: 25000,
          prices: { USD: 25000 },
          freemius_product_id: '28609',
          freemius_plan_id: '47122',
          trial_period_days: 14,
          product_variants: [],
        }),
        'en'
      )
    );

    await typeInto(input('title'), 'Cortex AI - Pro (edited)');
    expect(await autosave(updateAction, 1)).toMatchObject({
      title: 'Cortex AI - Pro (edited)',
      payment_provider: 'freemius',
      freemius_product_id: '28609',
      trial_period_days: 14,
      variants: [],
    });
  });

  it('an edit undone after its autosave, which the draft would otherwise keep', async () => {
    const { updateAction } = await openEditor(editPageInitialData(physicalProduct(), 'en'));

    await typeInto(input('title'), 'Pro plugin (edited)');
    expect(await autosave(updateAction, 1)).toMatchObject({ title: 'Pro plugin (edited)' });

    await typeInto(input('title'), 'Pro plugin');
    expect(await autosave(updateAction, 2)).toMatchObject({ title: 'Pro plugin' });
  });

  it.each([
    ['UPC', `variant-upc-${TERM_BLUE}`, '0123456789099', { upc: '0123456789099' }],
    ['price in a hand-priced currency', `variant-${TERM_BLUE}-price-CAD`, '79', { price: 54, prices: { USD: 54, CAD: 79 } }],
    ['sale price', `variant-${TERM_BLUE}-sale-price-USD`, '45', { sale_price: 45, sale_prices: { USD: 45 } }],
    ['sale price in a hand-priced currency', `variant-${TERM_BLUE}-sale-price-CAD`, '60', { sale_prices: { CAD: 60 } }],
  ])("a variant's %s", async (_label, id, value, expected) => {
    const { updateAction } = await openEditor(
      editPageInitialData(physicalProduct({ prices: { USD: 4900, CAD: 6900 }, product_variants: colorVariantRowsWithCad() }), 'en'),
      { currencies: USD_AND_CAD }
    );

    await typeInto(input(id), value);
    const values = await autosave(updateAction, 1);

    expect(variantByKey(values, TERM_BLUE)).toMatchObject(expected);
  });

  it("a variant's sale window", async () => {
    const { updateAction } = await openEditor(editPageInitialData(physicalProduct(), 'en'));

    await typeInto(input(`variant-${TERM_RED}-sale-start-at`), '2026-12-05T09:00');
    const values = await autosave(updateAction, 1);

    expect(variantByKey(values, TERM_RED)).toMatchObject({
      sale_start_at: new Date('2026-12-05T09:00').toISOString(),
      sale_end_at: '2026-12-31T00:00:00+00:00',
    });
  });

  it("a variant's sale end alone", async () => {
    const { updateAction } = await openEditor(editPageInitialData(physicalProduct(), 'en'));

    await typeInto(input(`variant-${TERM_RED}-sale-end-at`), '2027-01-10T18:00');
    const values = await autosave(updateAction, 1);

    expect(variantByKey(values, TERM_RED)).toMatchObject({
      sale_start_at: '2026-12-01T00:00:00+00:00',
      sale_end_at: new Date('2027-01-10T18:00').toISOString(),
    });
  });

  it("a variant's image", async () => {
    const { container, updateAction } = await openEditor(
      editPageInitialData(
        physicalProduct({
          product_media: [
            { media_id: MEDIA_ID, sort_order: 0, media: { id: MEDIA_ID, file_path: '/images/products/red.avif', object_key: null } },
          ],
        }),
        'en'
      )
    );
    // The blue variant's picker: it uses the parent image.
    const picker = [...container.querySelectorAll('select')].find(
      (select) => select.value === '' && [...select.options].some((option) => option.value === MEDIA_ID)
    );
    expect(picker, 'the blue variant image picker').toBeDefined();

    await choose(picker as HTMLSelectElement, MEDIA_ID);
    const values = await autosave(updateAction, 1);

    expect(variantByKey(values, TERM_BLUE)).toMatchObject({ main_media_id: MEDIA_ID });
  });

  it('a term toggled off', async () => {
    const { container, updateAction } = await openEditor(editPageInitialData(physicalProduct(), 'en'));

    await click(button(container, 'Blue'));
    const values = await autosave(updateAction, 1);

    expect((values.variants as Row[]).map((variant) => variant.combination_key)).toEqual([TERM_RED]);
    expect(values.variation_attributes).toEqual([{ attribute_id: ATTR_COLOR, term_ids: [TERM_RED] }]);
  });

  it("a variant's price edited back to its loaded value after its autosave", async () => {
    const { updateAction } = await openEditor(editPageInitialData(physicalProduct(), 'en'));

    await typeInto(input(`variant-${TERM_BLUE}-price-USD`), '59');
    expect(variantByKey(await autosave(updateAction, 1), TERM_BLUE)).toMatchObject({ price: 59 });

    await typeInto(input(`variant-${TERM_BLUE}-price-USD`), '54');
    expect(variantByKey(await autosave(updateAction, 2), TERM_BLUE)).toMatchObject({ price: 54 });
  });
});

describe('the variations editor regenerates its variants only when a term is toggled', () => {
  it('a toggled term regenerates every combination of the selected terms, keeping the stored ones', async () => {
    const { container, updateAction } = await openEditor(
      editPageInitialData(physicalProduct({ sku: 'TEE', product_variants: partialTeeVariantRows() }), 'en'),
      { globalAttributes: TEE_ATTRIBUTES }
    );

    // Size M off: Blue/M goes, and Blue/S (both still selected) is generated from the product.
    await click(button(container, 'M'));
    const values = await autosave(updateAction, 1);

    expect((values.variants as Row[]).map((variant) => variant.combination_key).sort()).toEqual(
      [combinationKey(TERM_RED, TERM_S), combinationKey(TERM_BLUE, TERM_S)].sort()
    );
    expect(variantByKey(values, combinationKey(TERM_RED, TERM_S))).toMatchObject({
      id: VARIANT_RED,
      sku: 'TEE-RED-S',
      price: 49,
      stock_quantity: 4,
    });
    expect(variantByKey(values, combinationKey(TERM_BLUE, TERM_S))).toMatchObject({
      sku: 'TEE-BLUE-S',
      price: 49,
      prices: { USD: 49 },
      stock_quantity: 0,
    });
  });

  it("a toggled term keeps each variant's own sale, none included, and gives the new one the product's with its window", async () => {
    const product = physicalProduct({
      sale_price: 3900,
      sale_prices: { USD: 3900 },
      sale_start_at: SALE_START,
      sale_end_at: SALE_END,
    });
    const { container, updateAction } = await openEditor(editPageInitialData(product, 'en'));

    await click(button(container, 'Green'));
    const values = await autosave(updateAction, 1);

    const blue = variantByKey(values, TERM_BLUE);
    expect(blue).toMatchObject({ id: VARIANT_BLUE, price: 54, sale_price: null, sale_start_at: null, sale_end_at: null });
    expect(blue?.sale_prices).toEqual({});
    expect(variantByKey(values, TERM_RED)).toMatchObject({
      sale_price: 39,
      sale_start_at: '2026-12-01T00:00:00+00:00',
      sale_end_at: '2026-12-31T00:00:00+00:00',
    });
    expect(variantByKey(values, TERM_GREEN)).toMatchObject({
      sku: 'PRO-GREEN',
      price: 49,
      sale_price: 39,
      sale_prices: { USD: 39 },
      sale_start_at: SALE_START,
      sale_end_at: SALE_END,
      stock_quantity: 0,
    });
  });

  it('a base price changed after the editor opened prices the variant a term then generates, exactly', async () => {
    const { container, updateAction } = await openEditor(
      editPageInitialData(physicalProduct({ product_variants: [] }), 'en')
    );

    await click(button(container, 'Manage'));
    await typeInto(input('product-price-USD'), '59.95');
    expect(await autosave(updateAction, 1)).toMatchObject({ price: 59.95, variants: [] });

    await click(button(container, 'Red'));
    const values = await autosave(updateAction, 2);

    expect(values.variants).toEqual([
      expect.objectContaining({ combination_key: TERM_RED, price: 59.95, prices: { USD: 59.95 } }),
    ]);
  });

  it('a term toggled on then off keeps the other variants as they were, UPC and image included', async () => {
    const { container, updateAction } = await openEditor(editPageInitialData(physicalProduct(), 'en'));

    await click(button(container, 'Green'));
    expect((await autosave(updateAction, 1)).variants).toHaveLength(3);

    await click(button(container, 'Green'));
    const values = await autosave(updateAction, 2);
    expect((values.variants as Row[]).map((variant) => variant.combination_key).sort()).toEqual(
      [TERM_BLUE, TERM_RED].sort()
    );
    expect(variantByKey(values, TERM_RED)).toMatchObject({
      id: VARIANT_RED,
      sku: 'PRO-RED',
      upc: '0123456789012',
      main_media_id: MEDIA_ID,
      main_image_url: '/images/products/red.avif',
      price: 49,
      sale_price: 39,
      stock_quantity: 7,
    });
    expect(variantByKey(values, TERM_BLUE)).toMatchObject({
      id: VARIANT_BLUE,
      sku: 'PRO-BLUE',
      price: 54,
      sale_price: null,
      stock_quantity: 3,
    });
  });

  it.each([
    ['price', 'product-price-USD', '59.95', { price: 59.95 }],
    ['SKU', 'sku', 'TEE', { sku: 'TEE' }],
  ])('a base %s change creates no variant, not even for a selected term without one', async (_label, id, value, product) => {
    // The base prices can be edited only while the form holds no variants: here a term is selected
    // and its variant does not exist. Regenerating on a base change created it.
    const { container, updateAction } = await openEditor({
      ...editPageInitialData(physicalProduct({ product_variants: [] }), 'en'),
      variation_attributes: [{ attribute_id: ATTR_COLOR, term_ids: [TERM_RED] }],
    });
    await click(button(container, 'Manage'));
    await waitPastTheDebounce();
    expect(container.textContent).toContain('0 variants');
    expect(updateAction).not.toHaveBeenCalled();

    await typeInto(input(id), value);
    const values = await autosave(updateAction, 1);

    expect(values).toMatchObject({ ...product, variants: [] });
    expect(container.textContent).toContain('0 variants');
  });

  it.each([
    {
      label: 'every combination of their terms',
      product: () => physicalProduct(),
      attributes: COLOR_ATTRIBUTES,
      stored: [
        [TERM_BLUE, 'PRO-BLUE', VARIANT_BLUE, 54, 3],
        [TERM_RED, 'PRO-RED', VARIANT_RED, 49, 7],
      ],
    },
    {
      label: 'two of the four combinations',
      product: () => physicalProduct({ sku: 'TEE', product_variants: partialTeeVariantRows() }),
      attributes: TEE_ATTRIBUTES,
      stored: [
        [combinationKey(TERM_RED, TERM_S), 'TEE-RED-S', VARIANT_RED, 49, 4],
        [combinationKey(TERM_BLUE, TERM_M), 'TEE-BLUE-M', VARIANT_BLUE, 54, 1],
      ],
    },
  ])('a product SKU edit saves the new SKU and exactly the stored variants ($label)', async ({ product, attributes, stored }) => {
    const { container, updateAction } = await openEditor(editPageInitialData(product(), 'en'), {
      globalAttributes: attributes,
    });

    // Regenerated on the SKU change, the partial set gained NEW-RED-M and NEW-BLUE-S at the product's
    // price with stock 0, and they stayed when the SKU was typed back.
    await typeInto(input('sku'), 'NEW');
    const values = await autosave(updateAction, 1);

    expect(values.sku).toBe('NEW');
    expect(
      (values.variants as Row[])
        .map((variant) => [variant.combination_key, variant.sku, variant.id, variant.price, variant.stock_quantity])
        .sort()
    ).toEqual([...stored].sort());
    expect(container.textContent).toContain(`${stored.length} variants`);
  });

  it('a term toggled after a product SKU edit names the variant it adds from the new SKU', async () => {
    const { container, updateAction } = await openEditor(editPageInitialData(physicalProduct(), 'en'));

    await typeInto(input('sku'), 'PRO2');
    expect(await autosave(updateAction, 1)).toMatchObject({ sku: 'PRO2' });

    await click(button(container, 'Green'));
    const values = await autosave(updateAction, 2);
    expect(variantByKey(values, TERM_GREEN)).toMatchObject({ sku: 'PRO2-GREEN', price: 49, stock_quantity: 0 });
    expect(variantByKey(values, TERM_RED)).toMatchObject({ id: VARIANT_RED, sku: 'PRO-RED' });
    expect(variantByKey(values, TERM_BLUE)).toMatchObject({ id: VARIANT_BLUE, sku: 'PRO-BLUE' });
  });

  it.each([
    ['an attribute list without their attribute', SIZE_ATTRIBUTES],
    ['no attribute list at all', []],
  ])('a product SKU edit keeps variants whose terms resolve to nothing (%s)', async (_label, attributes) => {
    const { updateAction } = await openEditor(editPageInitialData(physicalProduct(), 'en'), {
      globalAttributes: attributes,
    });
    await waitPastTheDebounce();
    expect(updateAction).not.toHaveBeenCalled();

    // Regenerated on the SKU change from a selection that resolves to nothing, the list was emptied
    // and saved: a publish deletes every variant.
    await typeInto(input('sku'), 'PRO2');
    const values = await autosave(updateAction, 1);

    expect(values.sku).toBe('PRO2');
    expect(
      (values.variants as Row[]).map((variant) => [variant.combination_key, variant.sku, variant.id]).sort()
    ).toEqual(
      [
        [TERM_BLUE, 'PRO-BLUE', VARIANT_BLUE],
        [TERM_RED, 'PRO-RED', VARIANT_RED],
      ].sort()
    );
  });
});
