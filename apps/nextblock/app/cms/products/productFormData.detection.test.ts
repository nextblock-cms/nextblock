import { describe, expect, it } from 'vitest';

/**
 * The rules findPoisonedProductDraftFields reads a pre-0.23.4 product form autosave by, one case per
 * rule: each case below fails when its rule is removed or loosened. The drafts are unmarked
 * ProductFormValues (major units) the old edit page autosaved, either over the live data (clean) or
 * over a legacy row snapshot (cents saved as dollars, the stock of that day, no variants, gallery or
 * description). productFormData.test.ts covers the merge and publish around them.
 */

import { computeFreemiusSaleDiscountPercent } from '@nextblock-cms/ecommerce/freemius-pricing';
import {
  buildPoisonedProductDraftPublishError,
  buildProductFormInitialData,
  findPoisonedProductDraftFields,
  getProductDraftEditNotices,
  mergeProductDraftMetaIntoFormInitialData,
} from './productFormData';

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174000';
const TERM_RED = '323e4567-e89b-12d3-a456-426614174000';
const TERM_BLUE = '333e4567-e89b-12d3-a456-426614174000';
const ATTR_COLOR = '423e4567-e89b-12d3-a456-426614174000';
const GROUP_ID = '523e4567-e89b-12d3-a456-426614174000';
const LANGUAGES = [{ id: 1, code: 'en', is_default: true }];
const CREATED = '2026-06-02T09:00:00+00:00';
const RICH = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rich description' }] }] };
const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

function mapping(termId: string, value: string) {
  return [
    {
      attribute_term_id: termId,
      product_attribute_terms: {
        id: termId,
        attribute_id: ATTR_COLOR,
        value,
        slug: value.toLowerCase(),
        sort_order: 0,
        value_translations: {},
        product_attributes: { id: ATTR_COLOR, name: 'Color', slug: 'color', name_translations: {} },
      },
    },
  ];
}

/** A getProduct() variant row (minor units). */
function liveVariant(overrides: Record<string, unknown> = {}, termId = TERM_RED, value = 'Red') {
  return {
    id: 'variant-1',
    sku: 'PRO-RED',
    upc: null,
    main_media_id: null,
    price: 4900,
    prices: { USD: 4900 },
    sale_price: null,
    sale_prices: null,
    sale_start_at: null,
    sale_end_at: null,
    scheduled_price: null,
    scheduled_prices: null,
    scheduled_price_at: null,
    stock_quantity: 4,
    variant_attribute_mapping: mapping(termId, value),
    ...overrides,
  };
}

/** A physical product with one variant, a gallery and a rich description, as getProduct() returns it. */
function liveProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: PRODUCT_ID,
    title: 'Pro plugin',
    slug: 'pro-plugin',
    sku: 'PRO',
    upc: null,
    price: 4900,
    prices: { USD: 4900 },
    sale_price: null,
    sale_prices: null,
    sale_start_at: null,
    sale_end_at: null,
    stock: 4,
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
    product_media: [{ media_id: 'media-1', sort_order: 0, media: { file_path: 'a.webp' } }],
    product_variants: [liveVariant()],
    ...overrides,
  };
}

/** A digital (Freemius) product with no variants, gallery or description. */
function liveDigital(cents: number, overrides: Record<string, unknown> = {}) {
  return liveProduct({
    product_type: 'digital',
    payment_provider: 'freemius',
    price: cents,
    prices: { USD: cents },
    product_variants: [],
    product_media: [],
    description_json: null,
    ...overrides,
  });
}

/** A variant as the old form autosaved it (major units). */
function draftVariant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'variant-1',
    combination_key: TERM_RED,
    sku: 'PRO-RED',
    upc: null,
    price: 49,
    prices: { USD: 49 },
    sale_price: null,
    sale_prices: {},
    sale_start_at: null,
    sale_end_at: null,
    stock_quantity: 4,
    main_media_id: null,
    main_image_url: null,
    attribute_term_ids: [TERM_RED],
    selected_options: [
      { attribute_id: ATTR_COLOR, attribute_name: 'Color', term_id: TERM_RED, term_value: 'Red', term_slug: 'red' },
    ],
    label: 'Red',
    ...overrides,
  };
}

/** The old form's autosave over the live data of liveProduct() (no marker; variation_attributes as every autosave). */
function cleanOldDraft(overrides: Record<string, unknown> = {}) {
  return {
    product_type: 'physical',
    payment_provider: 'stripe',
    title: 'Pro plugin',
    slug: 'pro-plugin',
    sku: 'PRO',
    upc: '',
    is_taxable: true,
    price: 49,
    prices: { USD: 49 },
    sale_price: null,
    sale_prices: {},
    stock: 4,
    meta_title: 'Pro plugin | Store',
    meta_description: 'The pro plugin.',
    custom_canonical: '',
    short_description: 'Short copy',
    description_json: RICH,
    freemius_product_id: '',
    freemius_plan_id: '',
    trial_period_days: 0,
    trial_requires_payment_method: false,
    status: 'active',
    language_id: 1,
    translation_group_id: GROUP_ID,
    product_media: [{ media_id: 'media-1' }],
    category_ids: [],
    variation_attributes: [{ attribute_id: ATTR_COLOR, term_ids: [TERM_RED] }],
    variants: [draftVariant()],
    ...overrides,
  };
}

/** The old page's autosave over a snapshot taken at $49 (x100 amounts, the snapshot's stock, nothing else). */
function poisoned(overrides: Record<string, unknown> = {}) {
  return cleanOldDraft({
    price: 4900,
    prices: { USD: 4900 },
    stock: 10,
    variants: [],
    variation_attributes: [],
    product_media: [],
    description_json: EMPTY_DOC,
    ...overrides,
  });
}

function editPage(live: Record<string, any>, meta: Record<string, any>) {
  const liveInitialData = { ...buildProductFormInitialData(live, LANGUAGES), category_ids: [] };
  return mergeProductDraftMetaIntoFormInitialData(liveInitialData, meta, {
    productId: PRODUCT_ID,
    liveProduct: live,
    draftCreatedAt: CREATED,
  });
}

const cleanDigital = cleanOldDraft({
  product_type: 'digital',
  payment_provider: 'freemius',
  variants: [],
  variation_attributes: [],
  product_media: [],
  description_json: null,
});

describe('the top-level amounts: equal to the live cents, or 20 times the live amount', () => {
  it('flags an old autosave after the live price rose 4.9-fold, and leaves a clean one alone after it fell to 6%', () => {
    expect(findPoisonedProductDraftFields({ ...cleanDigital, price: 4900, prices: { USD: 4900 } }, liveDigital(24010))).toEqual([
      'prices',
      'sale_prices',
    ]);
    expect(findPoisonedProductDraftFields(cleanDigital, liveDigital(294))).toEqual([]);
  });

  it('flags a clean old autosave once the live price fell to a twentieth or less (a limit: the editor enters its changes again)', () => {
    // A clean autosave from when the product sold at $49, with a variant stock edit (9); the live
    // price is $1.99 now.
    const live = liveProduct({
      price: 199,
      prices: { USD: 199 },
      product_variants: [liveVariant({ price: 199, prices: { USD: 199 } })],
    });
    const draft = cleanOldDraft({ variants: [draftVariant({ stock_quantity: 9 })] });

    expect(findPoisonedProductDraftFields(draft, live)).toEqual(['prices', 'sale_prices', 'variants']);
    expect(editPage(live, draft).variants[0].stock_quantity).toBe(4);
  });

  it('flags a Freemius autosave by its sale price alone when a sync moved the regular price 10-fold', () => {
    const live = liveDigital(9900, { sale_price: 799, sale_prices: { USD: 799 }, stock: 999 });
    const draft = poisoned({
      product_type: 'digital',
      payment_provider: 'freemius',
      price: 999,
      prices: { USD: 999 },
      sale_price: 799,
      sale_prices: { USD: 799 },
      stock: 999,
    });

    expect(findPoisonedProductDraftFields(draft, live)).toEqual(['prices', 'sale_prices']);
    const merged = editPage(live, draft);
    expect([merged.price, merged.sale_price]).toEqual([9900, 799]);
    expect(computeFreemiusSaleDiscountPercent(merged.price, merged.sale_price)).toBe(
      computeFreemiusSaleDiscountPercent(live.price, live.sale_price)
    );

    // The top-level sale price alone (no sale map), and the sale map alone (its EUR entry still in
    // cents after the editor corrected the dollars), each show it.
    expect(findPoisonedProductDraftFields({ ...draft, sale_prices: {} }, live)).toEqual(['prices', 'sale_prices']);
    const liveEur = { ...live, sale_prices: { USD: 799, EUR: 720 } };
    expect(findPoisonedProductDraftFields({ ...draft, sale_price: 7.99, sale_prices: { USD: 7.99, EUR: 720 } }, liveEur)).toEqual([
      'prices',
      'sale_prices',
    ]);
  });

  it('repairs the sale prices when only the sale price map differs from live', () => {
    const live = liveProduct({
      prices: { USD: 4900, EUR: 4500 },
      sale_price: 3900,
      sale_prices: { USD: 3900, EUR: 3500 },
      product_variants: [],
    });
    const draft = cleanOldDraft({
      prices: { USD: 49, EUR: 45 },
      sale_price: 39,
      sale_prices: { USD: 39, EUR: 3500 },
      variation_attributes: [],
      variants: [],
    });

    expect(findPoisonedProductDraftFields(draft, live)).toEqual(['prices', 'sale_prices']);
    expect(editPage(live, draft).sale_prices).toEqual({ USD: 39, EUR: 35 });
  });
});

describe('the price maps', () => {
  it('flags a moved secondary entry by the 20-fold rule alone on a store whose default currency has no cents', () => {
    const live = liveDigital(7000, { prices: { JPY: 7000, USD: 5900 } });
    const draft = { ...cleanDigital, price: 7000, prices: { JPY: 7000, USD: 4900 } };

    expect(findPoisonedProductDraftFields(draft, live)).toEqual(['prices', 'sale_prices']);
  });

  it('reads the default currency as one without cents from a variant row, or from a sale price, alone', () => {
    // The parent has no price of its own; its variants are priced in yen. The form shows yen unscaled
    // and takes each top-level amount from the yen entry: a clean draft holds the live amounts.
    const liveFromVariant = liveProduct({
      price: 0,
      prices: { JPY: 0 },
      product_variants: [liveVariant({ price: 7000, prices: { JPY: 7000 } })],
    });
    const cleanFromVariant = cleanOldDraft({
      price: 0,
      prices: { JPY: 0 },
      variants: [draftVariant({ price: 7000, prices: { JPY: 7000 } })],
    });
    expect(findPoisonedProductDraftFields(cleanFromVariant, liveFromVariant)).toEqual([]);

    const liveFromSale = liveDigital(0, { prices: { JPY: 0 }, sale_price: 5000, sale_prices: { JPY: 5000 } });
    const cleanFromSale = { ...cleanDigital, price: 0, prices: { JPY: 0 }, sale_price: 5000, sale_prices: { JPY: 5000 } };
    expect(findPoisonedProductDraftFields(cleanFromSale, liveFromSale)).toEqual([]);
  });
});

describe('the structural signs, when the amounts no longer show a snapshot', () => {
  it('flags a physical product with variants whose live price rose 6-fold by its emptied variants alone', () => {
    const live = liveProduct({
      price: 29400,
      prices: { USD: 29400 },
      product_variants: [liveVariant({ price: 29400, prices: { USD: 29400 } })],
      product_media: [],
      description_json: null,
    });

    expect(findPoisonedProductDraftFields(poisoned({ stock: 4 }), live)).toEqual(['prices', 'sale_prices', 'variants']);
  });

  it('flags a digital product with a gallery whose live price rose 6-fold by its emptied gallery alone', () => {
    const live = liveDigital(29400, { product_media: liveProduct().product_media });
    const draft = poisoned({ product_type: 'digital', payment_provider: 'freemius', stock: 4 });

    expect(findPoisonedProductDraftFields(draft, live)).toEqual(['prices', 'sale_prices', 'product_media']);
  });
});

describe("the variant amounts: against the live variant, else the parent by equality and the draft's own amounts in cents", () => {
  it('leaves alone a new variant priced 24 times the base price, and keeps it in the form', () => {
    const live = liveProduct({
      price: 500,
      prices: { USD: 500 },
      product_variants: [liveVariant({ price: 500, prices: { USD: 500 } })],
    });
    const blue = draftVariant({
      id: undefined,
      combination_key: TERM_BLUE,
      sku: 'PRO-BLUE',
      price: 120,
      prices: { USD: 120 },
      stock_quantity: 10,
      attribute_term_ids: [TERM_BLUE],
      selected_options: [
        { attribute_id: ATTR_COLOR, attribute_name: 'Color', term_id: TERM_BLUE, term_value: 'Blue', term_slug: 'blue' },
      ],
      label: 'Blue',
    });
    const draft = cleanOldDraft({
      price: 5,
      prices: { USD: 5 },
      variation_attributes: [{ attribute_id: ATTR_COLOR, term_ids: [TERM_RED, TERM_BLUE] }],
      variants: [draftVariant({ price: 5, prices: { USD: 5 } }), blue],
    });

    expect(findPoisonedProductDraftFields(draft, live)).toEqual([]);
    expect(editPage(live, draft).variants.map((variant: any) => variant.sku)).toEqual(['PRO-RED', 'PRO-BLUE']);
  });

  it('never compares a variant sale price with the parent when its live variant has none', () => {
    // The parent is on a $8 sale; the XL variant ($200 live, no sale) gets a $180 sale in the draft.
    const live = liveProduct({
      price: 1000,
      prices: { USD: 1000 },
      sale_price: 800,
      sale_prices: { USD: 800 },
      product_variants: [liveVariant({ price: 20000, prices: { USD: 20000 } })],
    });
    const draft = cleanOldDraft({
      price: 10,
      prices: { USD: 10 },
      sale_price: 8,
      sale_prices: { USD: 8 },
      variants: [draftVariant({ price: 200, prices: { USD: 200 }, sale_price: 180, sale_prices: { USD: 180 } })],
    });

    expect(findPoisonedProductDraftFields(draft, live)).toEqual([]);
  });

  it('flags a variant with no live row that holds the parent cents, where the editor corrected the base price', () => {
    // No live variants; the editor picked a term on the old page (the variant took the x100 base
    // price) and then corrected the base price.
    const live = liveProduct({ product_variants: [] });
    const rebuilt = draftVariant({ id: undefined, price: 4900, prices: { USD: 4900 }, stock_quantity: 0 });
    const draft = cleanOldDraft({ variants: [rebuilt] });

    expect(findPoisonedProductDraftFields(draft, live)).toEqual(['variants']);
    expect(editPage(live, draft).variants).toEqual([]);
    // Or set another price there: only the live parent's cents show it then.
    expect(findPoisonedProductDraftFields(cleanOldDraft({ price: 59, prices: { USD: 59 }, variants: [rebuilt] }), live)).toEqual([
      'prices',
      'sale_prices',
      'variants',
    ]);
  });

  it("flags a variant with no live row that holds the draft's own price in cents after the live price moved", () => {
    // The same variant, the editor's corrected base price (49) times 100; the live price is $49.50 now.
    const live = liveProduct({ price: 4950, prices: { USD: 4950 }, product_variants: [] });
    const rebuilt = draftVariant({ id: undefined, price: 4900, prices: { USD: 4900 }, stock_quantity: 0 });
    const draft = cleanOldDraft({ variants: [rebuilt] });

    expect(findPoisonedProductDraftFields(draft, live)).toEqual(['prices', 'sale_prices', 'variants']);
    const merged = editPage(live, draft);
    expect([merged.price, merged.variants]).toEqual([4950, []]);

    // Each amount alone shows it too (the editor corrected the rest): the price, the sale price (19.99
    // * 100 is 1998.9999999999998 in floating point, the variant 1999), a price-map entry, a sale-map entry.
    const newVariant = { id: undefined, prices: {}, stock_quantity: 0 };
    const variantsAlone = [
      cleanOldDraft({ variants: [draftVariant({ ...newVariant, price: 4900 })] }),
      cleanOldDraft({ sale_price: 19.99, variants: [draftVariant({ ...newVariant, sale_price: 1999 })] }),
      cleanOldDraft({ prices: { USD: 49, EUR: 45 }, variants: [draftVariant({ ...newVariant, prices: { USD: 49, EUR: 4500 } })] }),
      cleanOldDraft({
        sale_price: 39,
        sale_prices: { USD: 39 },
        variants: [draftVariant({ ...newVariant, sale_price: 39, sale_prices: { USD: 3900 } })],
      }),
    ];
    for (const alone of variantsAlone) {
      expect(findPoisonedProductDraftFields(alone, live)).toEqual(['prices', 'sale_prices', 'variants']);
    }
  });

  it('leaves alone a variant at 100 times the base price that has a live row of its own, is priced in a currency without cents, or is free, and a new one at 120 times it', () => {
    // A $500 bundle of a $5 product whose stock the editor changed: compared with its own live row only.
    const live = liveProduct({
      price: 500,
      prices: { USD: 500 },
      product_variants: [liveVariant({ price: 50000, prices: { USD: 50000 } })],
    });
    const bundle = cleanOldDraft({
      price: 5,
      prices: { USD: 5 },
      variants: [draftVariant({ price: 500, prices: { USD: 500 }, stock_quantity: 9 })],
    });
    expect(findPoisonedProductDraftFields(bundle, live)).toEqual([]);

    // A 50-cent sample's new $60 pack: only exactly 100 times the draft's amount counts.
    const liveSample = liveProduct({ price: 50, prices: { USD: 50 }, product_variants: [] });
    const sample = cleanOldDraft({
      price: 0.5,
      prices: { USD: 0.5 },
      variants: [draftVariant({ id: undefined, price: 60, prices: { USD: 60 } })],
    });
    expect(findPoisonedProductDraftFields(sample, liveSample)).toEqual([]);

    // A store whose default currency has no cents: the old page showed yen unscaled, a snapshot's too.
    const liveYen = liveProduct({ price: 70, prices: { JPY: 70 }, product_variants: [] });
    const yen = cleanOldDraft({
      price: 70,
      prices: { JPY: 70 },
      variants: [draftVariant({ id: undefined, price: 7000, prices: { JPY: 7000 } })],
    });
    expect(findPoisonedProductDraftFields(yen, liveYen)).toEqual([]);

    // A free product's free new variant.
    const liveFree = liveProduct({ price: 0, prices: { USD: 0 }, product_variants: [] });
    const free = cleanOldDraft({ price: 0, prices: { USD: 0 }, variants: [draftVariant({ id: undefined, price: 0, prices: { USD: 0 } })] });
    expect(findPoisonedProductDraftFields(free, liveFree)).toEqual([]);
  });

  it('matches a variant with no combination key or terms to its live row by id', () => {
    const live = liveProduct({
      price: 5900,
      prices: { USD: 5900 },
      product_variants: [liveVariant({ price: 6400, prices: { USD: 6400 } })],
    });
    const byIdOnly = draftVariant({ combination_key: undefined, attribute_term_ids: [], price: 6400, prices: { USD: 6400 } });
    const draft = cleanOldDraft({ price: 59, prices: { USD: 59 }, variants: [byIdOnly] });

    expect(findPoisonedProductDraftFields(draft, live)).toEqual(['variants']);
  });

  it('reads the cents in a variant price map entry alone, or in a variant sale price alone', () => {
    const live = liveProduct({
      prices: { USD: 4900, EUR: 4500 },
      product_variants: [liveVariant({ prices: { USD: 4900, EUR: 4500 }, sale_price: 3999, sale_prices: null })],
    });
    const base = { prices: { USD: 49, EUR: 45 } };

    // The editor corrected the dollars; the euro entry still holds the cents.
    const mapOnly = cleanOldDraft({ ...base, variants: [draftVariant({ prices: { USD: 49, EUR: 4500 }, sale_price: 39.99 })] });
    expect(findPoisonedProductDraftFields(mapOnly, live)).toEqual(['variants']);

    // A variant sale price with no sale map, still in cents.
    const saleOnly = cleanOldDraft({ ...base, variants: [draftVariant({ prices: { USD: 49, EUR: 45 }, sale_price: 3999, sale_prices: {} })] });
    expect(findPoisonedProductDraftFields(saleOnly, live)).toEqual(['variants']);

    // Control: the same variant with every amount clean.
    const clean = cleanOldDraft({ ...base, variants: [draftVariant({ prices: { USD: 49, EUR: 45 }, sale_price: 39.99 })] });
    expect(findPoisonedProductDraftFields(clean, live)).toEqual([]);
  });
});

describe('the variants group: any value the product RPC writes per variant', () => {
  const liveRow = liveVariant({
    upc: '0123456789029',
    main_media_id: 'media-1',
    sale_start_at: '2026-11-21T00:00:00+00:00',
    sale_end_at: '2026-11-30T00:00:00+00:00',
  });
  const live = liveProduct({ product_variants: [liveRow] });
  const sameAsLive = draftVariant({
    upc: '0123456789029',
    main_media_id: 'media-1',
    sale_start_at: '2026-11-21T00:00:00+00:00',
    sale_end_at: '2026-11-30T00:00:00+00:00',
  });

  it.each([
    ['no UPC', { upc: null }],
    ['no image', { main_media_id: null }],
    ['no sale start', { sale_start_at: null }],
    ['no sale end', { sale_end_at: null }],
    ['another SKU', { sku: 'PRO-RED-2' }],
  ])('flags a variant with the live amounts and stock but %s', (_label, change) => {
    const draft = cleanOldDraft({ price: 4900, prices: { USD: 4900 }, variants: [{ ...sameAsLive, ...change }] });

    expect(findPoisonedProductDraftFields(draft, live)).toEqual(['prices', 'sale_prices', 'variants']);
  });

  it('leaves the variants alone when every value is the live one (control)', () => {
    const draft = cleanOldDraft({ price: 4900, prices: { USD: 4900 }, variants: [sameAsLive] });

    expect(findPoisonedProductDraftFields(draft, live)).toEqual(['prices', 'sale_prices']);
  });

  it('flags two draft variants that stand for the same live variant', () => {
    const twoLive = liveProduct({
      product_variants: [liveVariant(), liveVariant({ id: 'variant-2', sku: 'PRO-BLUE' }, TERM_BLUE, 'Blue')],
    });
    const draft = cleanOldDraft({
      price: 4900,
      prices: { USD: 4900 },
      variation_attributes: [{ attribute_id: ATTR_COLOR, term_ids: [TERM_RED, TERM_BLUE] }],
      variants: [draftVariant(), draftVariant()],
    });

    expect(findPoisonedProductDraftFields(draft, twoLive)).toEqual(['prices', 'sale_prices', 'variants']);
  });
});

describe('Freemius plan prices: a snapshot whose price a sync moved by any factor', () => {
  /** One plan with a pricing row per license tier (the sync upserts one per license quota). */
  const plans = (...pricingRows: Record<string, unknown>[]) => [
    {
      id: 'plan-1',
      name: 'pro',
      title: 'Pro',
      freemius_pricing: pricingRows.map((pricing, index) => ({
        id: `pricing-${index + 1}`,
        license_quota: index + 1,
        api_monthly_price: null,
        api_annual_price: null,
        api_lifetime_price: null,
        override_monthly_price: null,
        override_annual_price: null,
        override_lifetime_price: null,
        is_active: true,
        ...pricing,
      })),
    },
  ];
  const freemiusDraft = (cents: number) =>
    poisoned({
      product_type: 'digital',
      payment_provider: 'freemius',
      freemius_product_id: '12345',
      freemius_plan_id: '67890',
      price: cents,
      prices: { USD: cents },
      sale_price: null,
      sale_prices: {},
      stock: 999,
    });

  it('flags a monthly-only plan that gained an annual price ($19.99 a month, then $199 a year): the price moved 9.95-fold', () => {
    const live = liveDigital(19900, {
      stock: 999,
      freemius_product_id: '12345',
      freemius_plan_id: '67890',
      freemius_plans: plans({ api_monthly_price: 19.99, api_annual_price: 199 }),
    });
    // 19.99 * 100 is 1998.9999999999998 in floating point: the sync rounds it to 1999 cents.
    const draft = freemiusDraft(1999);

    const fields = findPoisonedProductDraftFields(draft, live);
    expect(fields).toEqual(['prices', 'sale_prices']);
    expect(buildPoisonedProductDraftPublishError(fields)).toContain('Affected in this draft: prices and sale prices.');
    expect(editPage(live, draft).price).toBe(19900);

    // A clean autosave of the same product holds dollars: no plan price in cents.
    expect(findPoisonedProductDraftFields({ ...cleanDigital, price: 199, prices: { USD: 199 } }, live)).toEqual([]);
  });

  it('flags a snapshot whose price a sync set to 0 (a failed pricing fetch keeps the plan prices); numeric strings count', () => {
    const live = liveDigital(0, { stock: 999, freemius_plans: plans({ api_annual_price: '49.00' }) });

    expect(findPoisonedProductDraftFields(freemiusDraft(4900), live)).toEqual(['prices', 'sale_prices']);
  });

  it("reads every license tier's pricing row and the lifetime price: a match in the second row, or a lifetime-only plan", () => {
    // The sync takes the price from the first pricing row Freemius returns and keeps a row per license
    // quota, which getProduct() embeds in no set order: the row the price came from can come second.
    const tiers = liveDigital(0, {
      stock: 999,
      freemius_plans: plans({ license_quota: 5, api_annual_price: 99 }, { license_quota: 1, api_annual_price: 49 }),
    });
    expect(findPoisonedProductDraftFields(freemiusDraft(4900), tiers)).toEqual(['prices', 'sale_prices']);

    const lifetimeOnly = liveDigital(0, { stock: 999, freemius_plans: plans({ api_lifetime_price: 199 }) });
    expect(findPoisonedProductDraftFields(freemiusDraft(19900), lifetimeOnly)).toEqual(['prices', 'sale_prices']);
  });

  it('cannot see a snapshot once the plan prices changed too and the live price is 0 (a limit: a plan made free)', () => {
    const live = liveDigital(0, { stock: 999, freemius_plans: plans({ api_annual_price: 0 }) });

    expect(findPoisonedProductDraftFields(freemiusDraft(4900), live)).toEqual([]);
  });

  it('leaves a clean autosave alone on a store whose default currency has no cents (the form showed the plan cents unscaled)', () => {
    const live = liveDigital(999, {
      prices: { JPY: 999 },
      stock: 999,
      product_media: liveProduct().product_media,
      freemius_plans: plans({ api_monthly_price: 9.99 }),
    });
    // The editor replaced the image: kept, as for any clean autosave.
    const clean = { ...cleanDigital, price: 999, prices: { JPY: 999 }, product_media: [{ media_id: 'media-2' }] };

    expect(findPoisonedProductDraftFields(clean, live)).toEqual([]);
  });
});

describe('the stock the edit page shows', () => {
  it('shows the live stock beside the live variants when it repairs variants rebuilt with no stock', () => {
    const live = liveProduct({
      price: 5900,
      prices: { USD: 5900 },
      stock: 7,
      product_media: [],
      description_json: null,
      product_variants: [liveVariant({ id: 'variant-7', price: 5900, prices: { USD: 5900 }, stock_quantity: 7 })],
    });
    const rebuilt = draftVariant({ id: undefined, price: 4900, prices: { USD: 4900 }, stock_quantity: 0 });
    const draft = poisoned({
      stock: 0,
      variation_attributes: [{ attribute_id: ATTR_COLOR, term_ids: [TERM_RED] }],
      variants: [rebuilt],
    });

    expect(findPoisonedProductDraftFields(draft, live)).toEqual(['prices', 'sale_prices', 'variants']);
    const merged = editPage(live, draft);
    expect(merged.variants[0]).toMatchObject({ id: 'variant-7', stock_quantity: 7 });
    expect(merged.stock).toBe(7);
  });

  it('never flags a stock the draft does not carry: publish takes the live one', () => {
    const live = liveProduct({ product_variants: [], stock: 4 });
    const { stock: _snapshotStock, ...withoutStock } = poisoned();

    expect(findPoisonedProductDraftFields(withoutStock, live)).toEqual([
      'prices',
      'sale_prices',
      'product_media',
      'description_json',
    ]);
    expect(findPoisonedProductDraftFields(poisoned(), live)).toEqual([
      'prices',
      'sale_prices',
      'stock',
      'product_media',
      'description_json',
    ]);
  });

  it("repairs a digital product's snapshot stock without naming it: its form hides the stock", () => {
    const live = liveDigital(5900, { stock: 4 });
    const draft = poisoned({ product_type: 'digital', payment_provider: 'freemius', stock: 10 });

    const fields = findPoisonedProductDraftFields(draft, live);
    expect(fields).toEqual(['prices', 'sale_prices']);
    expect(buildPoisonedProductDraftPublishError(fields)).toContain('Affected in this draft: prices and sale prices.');
    expect(getProductDraftEditNotices(draft, live, CREATED)[0]).toContain('Affected in this draft: prices and sale prices.');
    expect(editPage(live, draft).stock).toBe(4);
  });
});
