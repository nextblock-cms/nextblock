// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A CMS import in draft mode stores product values in major units, like the form's autosave, but
 * not the same way: it never writes `variation_attributes`, it writes an empty gallery, no variants
 * and no description (null) when the file has no media, variant or description columns (blanks are
 * kept only in live mode), its variants are the export's (their attribute terms only: no
 * combination key, options or label, on which the edit page's variations editor threw), and before
 * 0.23.4 it carried no marker. These run the import's drafts through the edit page's merge, the
 * old-draft check and the real ProductForm.
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
vi.mock('@nextblock-cms/ecommerce/pages/cms/products/actions', () => ({ triggerSingleProductSync: vi.fn() }));
vi.mock('@nextblock-cms/ecommerce/pages/cms/products/server-actions', () => ({ createCategoryAction: vi.fn() }));

import type { CurrencyRecord } from '@nextblock-cms/ecommerce/currency';
import { ProductForm } from '@nextblock-cms/ecommerce/pages/cms/products/components/ProductForm';
import {
  PRODUCT_DRAFT_FORM_MARKER_KEY,
  PRODUCT_DRAFT_FORM_MARKER_VALUE,
} from '../../../lib/visual-editing/product-draft-meta';
import {
  buildGlobalAttributesForForm,
  buildPoisonedProductDraftNotice,
  buildPoisonedProductDraftPublishError,
  buildProductFormInitialData,
  completeProductDraftValues,
  findPoisonedProductDraftFields,
  getProductDraftEditNotices,
  mergeProductDraftMetaIntoFormInitialData,
} from './productFormData';

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';
const GROUP_ID = '523e4567-e89b-12d3-a456-426614174000';
const ATTR = '423e4567-e89b-12d3-a456-426614174001';
const RED = '323e4567-e89b-12d3-a456-426614174001';
const BLUE = '323e4567-e89b-12d3-a456-426614174002';
const V_RED = '623e4567-e89b-12d3-a456-426614174001';
const V_BLUE = '623e4567-e89b-12d3-a456-426614174002';
const M1 = '723e4567-e89b-12d3-a456-426614174001';
const LANGUAGES = [{ id: 1, name: 'English', code: 'en', is_default: true }];
const USD: CurrencyRecord = { code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true };
const RICH = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rich description' }] }] };
const CREATED = '2026-11-12T00:00:00+00:00';
const MARKER = { [PRODUCT_DRAFT_FORM_MARKER_KEY]: PRODUCT_DRAFT_FORM_MARKER_VALUE };

/** getGlobalProductAttributes() rows: Color with Red and Blue. */
const RAW_ATTRIBUTES = [
  {
    id: ATTR,
    name: 'Color',
    slug: 'color',
    name_translations: { fr: 'Couleur' },
    product_attribute_terms: [
      { id: RED, attribute_id: ATTR, value: 'Red', slug: 'red', sort_order: 0, value_translations: { fr: 'Rouge' } },
      { id: BLUE, attribute_id: ATTR, value: 'Blue', slug: 'blue', sort_order: 1, value_translations: { fr: 'Bleu' } },
    ],
  },
];
const GLOBAL_ATTRIBUTES = buildGlobalAttributesForForm(RAW_ATTRIBUTES);

function mapping(termId: string, value: string, slug: string, sortOrder: number) {
  return {
    attribute_term_id: termId,
    product_attribute_terms: {
      id: termId,
      attribute_id: ATTR,
      value,
      slug,
      sort_order: sortOrder,
      value_translations: {},
      product_attributes: { id: ATTR, name: 'Color', slug: 'color', name_translations: {} },
    },
  };
}

function liveVariantRow(id: string, sku: string, price: number, stock: number, term: [string, string, string, number]) {
  return {
    id,
    sku,
    upc: null,
    main_media_id: null,
    price,
    prices: { USD: price },
    sale_price: null,
    sale_prices: null,
    sale_start_at: null,
    sale_end_at: null,
    scheduled_price: null,
    scheduled_prices: null,
    scheduled_price_at: null,
    stock_quantity: stock,
    media: null,
    variant_attribute_mapping: [mapping(...term)],
  };
}

/** The live product (getProduct()): $59, Red $59 x3, Blue $64 x4, a gallery, a rich description. */
function liveProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: PRODUCT_ID,
    title: 'Pro plugin',
    slug: 'pro-plugin',
    sku: 'PRO',
    upc: null,
    price: 5900,
    prices: { USD: 5900 },
    sale_price: null,
    sale_prices: null,
    sale_start_at: null,
    sale_end_at: null,
    stock: 7,
    is_taxable: true,
    product_type: 'physical',
    payment_provider: 'stripe',
    status: 'active',
    short_description: 'Short copy',
    description_json: RICH,
    meta_title: 'Pro plugin | Store',
    meta_description: 'The pro plugin.',
    custom_canonical: null,
    freemius_product_id: null,
    freemius_plan_id: null,
    trial_period_days: 0,
    trial_requires_payment_method: false,
    language_id: 1,
    translation_group_id: GROUP_ID,
    updated_at: '2026-09-01T10:00:00+00:00',
    languages: { code: 'en' },
    product_media: [{ media_id: M1, sort_order: 0, media: { id: M1, file_path: 'a.webp', object_key: 'a.webp' } }],
    product_variants: [
      liveVariantRow(V_RED, 'PRO-RED', 5900, 3, [RED, 'Red', 'red', 0]),
      liveVariantRow(V_BLUE, 'PRO-BLUE', 6400, 4, [BLUE, 'Blue', 'blue', 1]),
    ],
    ...overrides,
  };
}

/** A variant as the import stores it (BackupProductVariantRecord: its terms only). */
function importedVariant(id: string | undefined, sku: string, price: number, stock: number, termIds: string[]) {
  return {
    ...(id ? { id } : {}),
    sku,
    upc: null,
    price,
    prices: { USD: price },
    sale_price: null,
    sale_prices: {},
    stock_quantity: stock,
    main_media_id: null,
    main_media_object_key: null,
    attribute_term_ids: termIds,
  };
}

/** A 0.23.4 import in draft mode of an exported product with variants (stamped, no variation_attributes). */
function importDraft(overrides: Record<string, unknown> = {}) {
  return {
    language_id: 1,
    translation_group_id: GROUP_ID,
    product_type: 'physical',
    payment_provider: 'stripe',
    title: 'Pro plugin (imported)',
    slug: 'pro-plugin',
    sku: 'PRO',
    upc: null,
    status: 'active',
    price: 59,
    prices: { USD: 59 },
    sale_price: null,
    sale_prices: {},
    stock: 7,
    is_taxable: true,
    meta_title: 'Pro plugin | Store',
    meta_description: 'The pro plugin.',
    short_description: 'Short copy',
    description_json: RICH,
    freemius_product_id: null,
    freemius_plan_id: null,
    trial_period_days: 0,
    trial_requires_payment_method: false,
    product_media: [{ media_id: M1 }],
    category_ids: [],
    variants: [importedVariant(V_RED, 'PRO-RED', 59, 3, [RED]), importedVariant(V_BLUE, 'PRO-BLUE', 64, 4, [BLUE])],
    ...MARKER,
    ...overrides,
  };
}

/**
 * What a pre-0.23.4 import in draft mode stored for a price and stock CSV row with no media, variant
 * or description columns: an empty gallery, no variants and a null description (blanks were never
 * preserved in draft mode), major units, no marker and no variation_attributes.
 */
function oldImportDraft(overrides: Record<string, unknown> = {}) {
  return {
    language_id: 1,
    translation_group_id: GROUP_ID,
    product_type: 'physical',
    payment_provider: 'stripe',
    title: 'Pro plugin',
    slug: 'pro-plugin',
    sku: 'PRO',
    upc: null,
    status: 'active',
    price: 55,
    prices: { USD: 55 },
    sale_price: null,
    sale_prices: {},
    stock: 20,
    is_taxable: true,
    meta_title: 'Pro plugin | Store',
    meta_description: 'The pro plugin.',
    short_description: 'Short copy',
    description_json: null,
    freemius_product_id: null,
    freemius_plan_id: null,
    trial_period_days: 0,
    trial_requires_payment_method: false,
    product_media: [],
    category_ids: [],
    variants: [],
    ...overrides,
  };
}

function editPage(
  live: Record<string, any>,
  meta: Record<string, any>,
  globalAttributes?: typeof GLOBAL_ATTRIBUTES,
  languages: Array<{ id: number; code: string; is_default?: boolean }> = LANGUAGES
) {
  const liveInitialData = { ...buildProductFormInitialData(live, languages), category_ids: [] };
  return mergeProductDraftMetaIntoFormInitialData(liveInitialData, meta, {
    productId: PRODUCT_ID,
    liveProduct: live,
    draftCreatedAt: CREATED,
    globalAttributes,
  });
}

describe('a pre-0.23.4 CMS draft import keeps its prices and stock', () => {
  const liveSimple = liveProduct({ product_variants: [], stock: 4, price: 4900, prices: { USD: 4900 } });

  it('is flagged for the gallery and the description it left out: the edit page shows them live beside its $55 and 20 in stock, and the note and the refusal say what the import did', () => {
    const draft = oldImportDraft();

    const fields = findPoisonedProductDraftFields(draft, liveSimple);
    expect(fields).toEqual(['product_media', 'description_json']);
    const merged = editPage(liveSimple, draft);
    expect([merged.price, merged.prices, merged.stock]).toEqual([5500, { USD: 55 }, 20]);
    expect(merged.product_media).toEqual(liveSimple.product_media);
    expect(merged.description_json).toEqual(RICH);

    // No copy warning: the import's other fields are the file's.
    const notices = getProductDraftEditNotices(draft, liveSimple, CREATED);
    expect(notices).toEqual([
      'This draft was saved by a CMS import in an earlier version of NextBlock. An import in draft mode, this version’s included, writes an empty gallery, no variants and no description when the file has no such columns; so does a live overwrite import unless “Ignore blank fields” is ticked. Affected in this draft: gallery and description. The form shows the live values for the affected fields: check them, save a change (or discard the draft), then publish (or ask an administrator to).',
    ]);
    expect(notices).toEqual([buildPoisonedProductDraftNotice(fields, { savedOverRowSnapshot: false })]);
    expect(buildPoisonedProductDraftPublishError(fields, { meta: draft })).toBe(
      'Not published. This draft was saved by a CMS import in an earlier version of NextBlock. An import in draft mode, this version’s included, writes an empty gallery, no variants and no description when the file has no such columns; so does a live overwrite import unless “Ignore blank fields” is ticked. Affected in this draft: gallery and description. Open the product in the CMS editor, check those fields, save a change (or discard the draft), then publish.'
    );

    // With the gallery and the description the file kept, nothing is flagged and publish writes the file's values.
    const complete = { ...draft, product_media: [{ media_id: M1 }], description_json: RICH };
    expect(findPoisonedProductDraftFields(complete, liveSimple)).toEqual([]);
    expect(completeProductDraftValues(complete, liveSimple)).toMatchObject({ price: 55, stock: 20 });
  });

  it('flags the description its file left out (stored as null) over a live one, and shows the live one', () => {
    const draft = oldImportDraft({ product_media: [{ media_id: M1 }] });

    expect(findPoisonedProductDraftFields(draft, liveSimple)).toEqual(['description_json']);
    expect(editPage(liveSimple, draft).description_json).toEqual(RICH);
    expect(buildPoisonedProductDraftPublishError(['description_json'], { meta: draft })).toContain(
      'Affected in this draft: description.'
    );

    // Nothing to lose without a live description; and a draft without the key publishes the live one.
    expect(findPoisonedProductDraftFields(draft, { ...liveSimple, description_json: null })).toEqual([]);
    const { description_json: _leftOut, ...withoutDescription } = draft;
    expect(findPoisonedProductDraftFields(withoutDescription, liveSimple)).toEqual([]);

    // Nor over a live description that is only the editor's empty doc.
    const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
    expect(findPoisonedProductDraftFields(draft, { ...liveSimple, description_json: emptyDoc })).toEqual([]);
  });

  it('flags the description a digital (Freemius) import left out too, and shows the live one', () => {
    const liveDigital = liveProduct({
      product_type: 'digital',
      payment_provider: 'freemius',
      product_variants: [],
      product_media: [],
    });
    const draft = oldImportDraft({ product_type: 'digital', payment_provider: 'freemius' });

    expect(findPoisonedProductDraftFields(draft, liveDigital)).toEqual(['description_json']);
    expect(editPage(liveDigital, draft).description_json).toEqual(RICH);
  });

  it('is not flagged for a gallery the file replaced: only an emptied one counts', () => {
    const draft = oldImportDraft({ product_media: [{ media_id: 'media-from-the-file' }], description_json: RICH });

    expect(findPoisonedProductDraftFields(draft, liveSimple)).toEqual([]);
  });

  it('is flagged for the variants it emptied on a physical product that has some; the form shows them with their stock', () => {
    const live = liveProduct({ price: 4900, prices: { USD: 4900 } });

    expect(findPoisonedProductDraftFields(oldImportDraft(), live)).toEqual(['variants', 'product_media', 'description_json']);
    const merged = editPage(live, oldImportDraft());
    expect([merged.price, merged.prices]).toEqual([5500, { USD: 55 }]);
    expect(merged.variants.map((variant: any) => [variant.id, variant.stock_quantity])).toEqual([
      [V_RED, 3],
      [V_BLUE, 4],
    ]);
    // The stock ProductForm shows read-only beside the live variants is theirs.
    expect(merged.stock).toBe(7);
  });

  it('gets no amount rule, an amount equal to the live cents included', () => {
    expect(
      findPoisonedProductDraftFields(
        oldImportDraft({ price: 4900, prices: { USD: 4900 }, product_media: [{ media_id: M1 }], description_json: RICH }),
        liveSimple
      )
    ).toEqual([]);
    // An empty description doc over a live one is flagged for an import too.
    expect(
      findPoisonedProductDraftFields(
        oldImportDraft({ product_media: [{ media_id: M1 }], description_json: { type: 'doc', content: [{ type: 'paragraph' }] } }),
        liveSimple
      )
    ).toEqual(['description_json']);
  });
});

describe('the edit page completes the variants an import stores', () => {
  it('gives the export-shaped variants their key, options and label from the live variants, and the draft its attributes', () => {
    const draft = importDraft({
      variants: [importedVariant(V_RED, 'PRO-RED', 70, 9, [RED]), importedVariant(V_BLUE, 'PRO-BLUE', 64, 4, [BLUE])],
    });
    const merged = editPage(liveProduct(), draft);

    expect(findPoisonedProductDraftFields(draft, liveProduct())).toEqual([]);
    expect(merged.variants).toEqual([
      {
        ...draft.variants[0],
        combination_key: RED,
        selected_options: [{ attribute_id: ATTR, attribute_name: 'Color', term_id: RED, term_value: 'Red', term_slug: 'red' }],
        label: 'Red',
      },
      {
        ...draft.variants[1],
        combination_key: BLUE,
        selected_options: [{ attribute_id: ATTR, attribute_name: 'Color', term_id: BLUE, term_value: 'Blue', term_slug: 'blue' }],
        label: 'Blue',
      },
    ]);
    // The prices and the stock stay the draft's.
    expect(merged.variants.map((variant: any) => [variant.price, variant.stock_quantity])).toEqual([
      [70, 9],
      [64, 4],
    ]);
    expect(merged.variation_attributes).toEqual([{ attribute_id: ATTR, term_ids: [RED, BLUE] }]);
  });

  it('names a term no live variant has from the global attributes, in the product language', () => {
    const languages = [...LANGUAGES, { id: 2, name: 'Français', code: 'fr', is_default: false }];
    const live = liveProduct({
      language_id: 2,
      languages: { code: 'fr' },
      product_variants: [liveVariantRow(V_RED, 'PRO-RED', 5900, 3, [RED, 'Red', 'red', 0])],
    });
    const draft = importDraft({
      language_id: 2,
      variants: [importedVariant(V_RED, 'PRO-RED', 59, 3, [RED]), importedVariant(undefined, 'PRO-BLUE', 64, 4, [BLUE])],
    });

    const merged = editPage(live, draft, GLOBAL_ATTRIBUTES, languages);
    expect(merged.variants[1]).toMatchObject({
      combination_key: BLUE,
      selected_options: [{ attribute_id: ATTR, attribute_name: 'Couleur', term_id: BLUE, term_value: 'Bleu', term_slug: 'blue' }],
      label: 'Bleu',
      price: 64,
      stock_quantity: 4,
    });
    expect(merged.variation_attributes).toEqual([{ attribute_id: ATTR, term_ids: [RED, BLUE] }]);

    // Without the global attributes such a term gets no option (the page passes them).
    expect(editPage(live, draft, undefined, languages).variants[1]).toMatchObject({
      combination_key: BLUE,
      selected_options: [],
      label: '',
    });
  });

  it('takes the terms of the live variant with the same id for a variant that names none', () => {
    const draft = importDraft({ variants: [importedVariant(V_BLUE, 'PRO-BLUE', 64, 4, [])] });

    expect(editPage(liveProduct(), draft).variants[0]).toMatchObject({
      id: V_BLUE,
      attribute_term_ids: [BLUE],
      combination_key: BLUE,
      label: 'Blue',
      stock_quantity: 4,
    });
  });

  it('keeps the terms a variant names over the live variant with its id: a Red variant id with the Blue term is Blue', () => {
    // Blue is no live variant's term here: the global attributes name it.
    const live = liveProduct({ product_variants: [liveVariantRow(V_RED, 'PRO-RED', 5900, 3, [RED, 'Red', 'red', 0])] });
    const draft = importDraft({ variants: [importedVariant(V_RED, 'PRO-X', 60, 1, [BLUE])] });

    const merged = editPage(live, draft, GLOBAL_ATTRIBUTES);
    expect(merged.variants[0]).toMatchObject({
      id: V_RED,
      attribute_term_ids: [BLUE],
      combination_key: BLUE,
      selected_options: [{ attribute_id: ATTR, attribute_name: 'Color', term_id: BLUE, term_value: 'Blue', term_slug: 'blue' }],
      label: 'Blue',
      price: 60,
      stock_quantity: 1,
    });
    expect(merged.variation_attributes).toEqual([{ attribute_id: ATTR, term_ids: [BLUE] }]);
  });

  it("leaves the form's own variants as they are", () => {
    const formVariant = {
      ...importedVariant(V_RED, 'PRO-RED', 59, 3, [RED]),
      combination_key: RED,
      selected_options: [{ attribute_id: ATTR, attribute_name: 'Color', term_id: RED, term_value: 'Red', term_slug: 'red' }],
      label: 'Red',
    };
    const attributes = [{ attribute_id: ATTR, term_ids: [RED] }];
    const merged = editPage(liveProduct(), importDraft({ variants: [formVariant], variation_attributes: attributes }));

    expect(merged.variants[0]).toBe(formVariant);
    expect(merged.variation_attributes).toBe(attributes);
  });
});

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

describe('the real ProductForm opens a draft-mode CMS import with variants', () => {
  it('shows both variants with their prices and stock, saves nothing on open, and autosaves them after one edit', async () => {
    const live = liveProduct();
    const initialData = editPage(live, importDraft(), GLOBAL_ATTRIBUTES);

    const updateAction = vi.fn<UpdateAction>(async () => ({ success: true }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { root, container };

    await act(async () => {
      root.render(
        <ProductForm
          initialData={initialData as any}
          isEdit
          availableLanguagesProp={LANGUAGES}
          globalAttributesProp={GLOBAL_ATTRIBUTES}
          currenciesProp={[USD]}
          enabledProviders={{ stripe: true, freemius: true }}
          configStatus={{ stripe: { hasKeys: true, missing: [] }, freemius: { hasKeys: true, missing: [] } }}
          updateAction={updateAction}
        />
      );
    });

    // The autosave debounce is 400 ms: nothing is saved without an edit.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    expect(updateAction).not.toHaveBeenCalled();

    const input = (id: string) => container.querySelector<HTMLInputElement>(`[id="${id}"]`);
    expect(input(`variant-sku-${RED}`)?.value).toBe('PRO-RED');
    expect(input(`variant-stock-${RED}`)?.value).toBe('3');
    expect(input(`variant-sku-${BLUE}`)?.value).toBe('PRO-BLUE');
    expect(input(`variant-stock-${BLUE}`)?.value).toBe('4');
    expect(container.textContent).toContain('Reg: $59.00');
    expect(container.textContent).toContain('Reg: $64.00');

    // One explicit edit: the SEO title.
    const metaTitle = input('meta_title');
    expect(metaTitle).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(metaTitle, 'Edited SEO title');
      metaTitle?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await vi.waitFor(
      () => expect(updateAction.mock.calls.some(([values]) => values.meta_title === 'Edited SEO title')).toBe(true),
      { timeout: 4000, interval: 50 }
    );

    const saved: Record<string, any> = updateAction.mock.calls.find(([values]) => values.meta_title === 'Edited SEO title')?.[0] ?? {};
    expect(saved.variants).toHaveLength(2);
    expect(saved.variants[0]).toMatchObject({ id: V_RED, price: 59, prices: { USD: 59 }, stock_quantity: 3, attribute_term_ids: [RED] });
    expect(saved.variants[1]).toMatchObject({ id: V_BLUE, price: 64, prices: { USD: 64 }, stock_quantity: 4, attribute_term_ids: [BLUE] });
    expect(saved.variation_attributes).toEqual([{ attribute_id: ATTR, term_ids: [RED, BLUE] }]);
  });
});
