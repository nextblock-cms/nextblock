// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A draft the pre-0.23.4 edit page autosaved over a row snapshot ($49 stored as 4900 "dollars", the
 * stock of that day, no variants, gallery or description), opened after the live price moved to $59
 * and three units sold: the edit page's merge, the real ProductForm, one edit by the editor, and the
 * values the form's update action receives. Matching only the current live amounts, the old check
 * repaired the variants, gallery and description but showed the x100 price and the old stock, and
 * the next autosave stamped them as 0.23.4 values that publish then wrote.
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
  buildProductFormInitialData,
  buildProductFormValuesFromLiveProduct,
  completeProductDraftValues,
  findPoisonedProductDraftFields,
  mergeProductDraftMetaIntoFormInitialData,
} from './productFormData';

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';
const VARIANT_ID = '623e4567-e89b-12d3-a456-426614174000';
const TERM_RED = '323e4567-e89b-12d3-a456-426614174000';
const ATTR_COLOR = '423e4567-e89b-12d3-a456-426614174000';
const GROUP_ID = '523e4567-e89b-12d3-a456-426614174000';
const LANGUAGES = [{ id: 1, name: 'English', code: 'en', is_default: true }];
const USD: CurrencyRecord = { code: 'USD', symbol: '$', exchange_rate: 1, is_default: true, is_active: true };
const EDITED_TITLE = 'Pro plugin (edited after the upgrade)';
const RICH_DESCRIPTION = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rich description' }] }],
};

/** The live product as getProduct() returns it: $59 now (it was $49), stock 7 (it was 10). */
const LIVE = {
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
  description_json: RICH_DESCRIPTION,
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
  product_media: [{ media_id: 'aaaaaaaa-0001-4001-8001-000000000001', sort_order: 0, media: { file_path: 'a.webp' } }],
  product_variants: [
    {
      id: VARIANT_ID,
      sku: 'PRO-RED',
      upc: null,
      main_media_id: null,
      price: 5900,
      prices: { USD: 5900 },
      sale_price: null,
      sale_prices: null,
      sale_start_at: null,
      sale_end_at: null,
      stock_quantity: 7,
      variant_attribute_mapping: [
        {
          attribute_term_id: TERM_RED,
          product_attribute_terms: {
            id: TERM_RED,
            attribute_id: ATTR_COLOR,
            value: 'Red',
            slug: 'red',
            sort_order: 0,
            value_translations: {},
            product_attributes: { id: ATTR_COLOR, name: 'Color', slug: 'color', name_translations: {} },
          },
        },
      ],
    },
  ],
};

/** The old page's autosave over the snapshot taken at $49 (sanitized ProductFormValues, no marker). */
const OLD_AUTOSAVE = {
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
  sale_prices: {},
  stock: 10,
  meta_title: 'Pro plugin | Store',
  meta_description: 'The pro plugin.',
  custom_canonical: '',
  short_description: 'Short copy',
  description_json: { type: 'doc', content: [{ type: 'paragraph' }] },
  freemius_product_id: '',
  freemius_plan_id: '',
  trial_period_days: 0,
  trial_requires_payment_method: false,
  status: 'active',
  language_id: 1,
  translation_group_id: GROUP_ID,
  product_media: [],
  category_ids: [],
  variation_attributes: [],
  variants: [],
};

const GLOBAL_ATTRIBUTES = buildGlobalAttributesForForm([
  {
    id: ATTR_COLOR,
    name: 'Color',
    slug: 'color',
    name_translations: {},
    product_attribute_terms: [{ id: TERM_RED, attribute_id: ATTR_COLOR, value: 'Red', slug: 'red', sort_order: 0 }],
  },
]);

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

describe('the edit page repairs an old draft whose live price moved, through the real ProductForm', () => {
  it('autosaves the live price, stock and variants after one edit, and publish completes them from live', async () => {
    expect(findPoisonedProductDraftFields(OLD_AUTOSAVE, LIVE)).toEqual([
      'prices',
      'sale_prices',
      'variants',
      'stock',
      'product_media',
      'description_json',
    ]);

    // What the edit page hands the form (app/cms/products/[id]/edit/page.tsx).
    const liveInitialData = { ...buildProductFormInitialData(LIVE, LANGUAGES), category_ids: [] };
    const initialData = mergeProductDraftMetaIntoFormInitialData(liveInitialData, OLD_AUTOSAVE, {
      productId: PRODUCT_ID,
      liveProduct: LIVE,
      draftCreatedAt: '2026-06-02T09:00:00+00:00',
    });

    const updateAction = vi.fn<UpdateAction>(async () => ({ success: true }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { root, container };

    await act(async () => {
      root.render(
        <ProductForm
          initialData={initialData}
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

    // One explicit edit: the title.
    const title = container.querySelector<HTMLInputElement>('#title');
    expect(title).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(title, EDITED_TITLE);
      title?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // The autosave debounce is 400 ms.
    await vi.waitFor(
      () => expect(updateAction.mock.calls.some(([values]) => values.title === EDITED_TITLE)).toBe(true),
      { timeout: 4000, interval: 50 }
    );

    // No save, before or after the edit, carries the x100 price or the old stock.
    for (const [values] of updateAction.mock.calls) {
      expect(values).toMatchObject({ price: 59, prices: { USD: 59 }, stock: 7 });
    }

    const savedCall = updateAction.mock.calls.find(([saved]) => saved.title === EDITED_TITLE);
    expect(savedCall).toBeDefined();
    const values: Record<string, unknown> = savedCall?.[0] ?? {};
    expect(values).toMatchObject({
      title: EDITED_TITLE,
      price: 59,
      prices: { USD: 59 },
      stock: 7,
      product_media: [{ media_id: 'aaaaaaaa-0001-4001-8001-000000000001' }],
      description_json: RICH_DESCRIPTION,
    });
    expect(values.variants).toHaveLength(1);
    expect((values.variants as unknown[])[0]).toMatchObject({
      id: VARIANT_ID,
      sku: 'PRO-RED',
      price: 59,
      prices: { USD: 59 },
      stock_quantity: 7,
    });

    // What saveProductDraftMeta stores: the form values and the marker. Publish takes it as it is.
    const stored = { ...values, [PRODUCT_DRAFT_FORM_MARKER_KEY]: PRODUCT_DRAFT_FORM_MARKER_VALUE };
    expect(findPoisonedProductDraftFields(stored, LIVE)).toEqual([]);

    const published = completeProductDraftValues(stored, LIVE);
    const liveValues = buildProductFormValuesFromLiveProduct(LIVE, 'en');
    expect(published.price).toBe(liveValues.price);
    expect(published.prices).toEqual(liveValues.prices);
    expect(published.stock).toBe(liveValues.stock);
    expect(published.variants).toHaveLength(1);
    expect(published.variants[0]).toMatchObject({
      price: liveValues.variants[0].price,
      prices: liveValues.variants[0].prices,
      stock_quantity: liveValues.variants[0].stock_quantity,
    });
    expect([published.price, published.stock, published.variants[0].price]).toEqual([59, 7, 59]);
  });

  it('shows the live stock in the read-only stock box beside variants it repaired from ones rebuilt with no stock', async () => {
    // The editor re-selected the term on the old page: the variant came from the x100 base price, with no stock.
    const rebuilt = {
      combination_key: TERM_RED,
      sku: 'PRO-RED',
      upc: null,
      price: 4900,
      prices: { USD: 4900 },
      sale_price: null,
      sale_prices: {},
      sale_start_at: null,
      sale_end_at: null,
      stock_quantity: 0,
      main_media_id: null,
      main_image_url: null,
      attribute_term_ids: [TERM_RED],
      selected_options: [{ attribute_id: ATTR_COLOR, attribute_name: 'Color', term_id: TERM_RED, term_value: 'Red', term_slug: 'red' }],
      label: 'Red',
    };
    const old = {
      ...OLD_AUTOSAVE,
      stock: 0,
      variation_attributes: [{ attribute_id: ATTR_COLOR, term_ids: [TERM_RED] }],
      variants: [rebuilt],
      product_media: [{ media_id: 'aaaaaaaa-0001-4001-8001-000000000001' }],
      description_json: RICH_DESCRIPTION,
    };
    expect(findPoisonedProductDraftFields(old, LIVE)).toEqual(['prices', 'sale_prices', 'variants']);

    const liveInitialData = { ...buildProductFormInitialData(LIVE, LANGUAGES), category_ids: [] };
    const initialData = mergeProductDraftMetaIntoFormInitialData(liveInitialData, old, {
      productId: PRODUCT_ID,
      liveProduct: LIVE,
      draftCreatedAt: '2026-06-02T09:00:00+00:00',
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { root, container };
    await act(async () => {
      root.render(
        <ProductForm
          initialData={initialData}
          isEdit
          availableLanguagesProp={LANGUAGES}
          globalAttributesProp={GLOBAL_ATTRIBUTES}
          currenciesProp={[USD]}
          enabledProviders={{ stripe: true, freemius: true }}
          configStatus={{ stripe: { hasKeys: true, missing: [] }, freemius: { hasKeys: true, missing: [] } }}
          updateAction={vi.fn<UpdateAction>(async () => ({ success: true }))}
        />
      );
    });

    // The snapshot's 0 used to show here beside the live variant's 7.
    expect(container.querySelector<HTMLInputElement>('#stock')?.value).toBe('7');
    expect(container.querySelector<HTMLInputElement>(`[id="variant-stock-${TERM_RED}"]`)?.value).toBe('7');
  });
});
