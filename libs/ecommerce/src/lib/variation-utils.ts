import {
  type PriceMap,
  type ProductAttribute,
  type ProductAttributeTerm,
  type ProductVariant,
  type ProductVariantOption,
  type SalePriceMap,
  type TranslationMap,
} from './types';
import { isSaleWindowActive, normalizePriceMap, normalizeSalePriceMap } from './currency';
import { resolveMediaUrlWithSupabaseFallback } from '@nextblock-cms/utils/media-url';
import { normalizeCurrencyCode } from '@nextblock-cms/utils/utils';

type AttributeAccumulator = ProductAttribute & {
  terms: ProductAttributeTerm[];
  _termIds: Set<string>;
};

export interface VariationSelectionGroup {
  attribute_id: string;
  attribute_name: string;
  terms: ProductAttributeTerm[];
}

export interface ProductVariantDraft {
  id?: string;
  combination_key: string;
  sku: string;
  upc?: string | null;
  price: number;
  prices: PriceMap;
  sale_price?: number | null;
  sale_prices: SalePriceMap;
  sale_start_at?: string | null;
  sale_end_at?: string | null;
  stock_quantity: number;
  main_media_id?: string | null;
  main_image_url?: string | null;
  attribute_term_ids: string[];
  selected_options: ProductVariantOption[];
  label: string;
}

function normalizeTranslationMap(value: unknown): TranslationMap | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return Object.entries(value as Record<string, unknown>).reduce<TranslationMap>((accumulator, [key, entry]) => {
    if (typeof entry === 'string' && entry.trim()) {
      accumulator[key] = entry.trim();
    }

    return accumulator;
  }, {});
}

export function resolveTranslatedText(
  baseValue: string,
  translations?: TranslationMap | null,
  languageCode?: string | null
) {
  if (!languageCode || !translations) {
    return baseValue;
  }

  return translations[languageCode]?.trim() || baseValue;
}

export function resolveAttributeName(attribute: ProductAttribute, languageCode?: string | null) {
  return resolveTranslatedText(attribute.name, attribute.name_translations, languageCode);
}

export function resolveTermValue(term: ProductAttributeTerm, languageCode?: string | null) {
  return resolveTranslatedText(term.value, term.value_translations, languageCode);
}

/** `value` as a SKU part (lowercased, a-z, 0-9 and single inner hyphens); '' for anything that is not text. */
function slugifyToken(value: unknown) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function buildCombinationKey(attributeTermIds: string[]) {
  return [...attributeTermIds].sort().join('__');
}

export function buildVariantLabel(options: ProductVariantOption[]) {
  return options.map((option) => option.term_value).join(' / ');
}

/**
 * Whether a variant's own option can be used as it is: an object (not a list) with a text attribute id,
 * attribute name, term id and term value, and a text term slug when it has one, which is the shape
 * productSchema takes (its uuid checks aside) and the variations editor prints. Every option the form and
 * the live variants make is one. A product draft's can be anything (any WRITER can PATCH a draft), so the
 * product form and the app's edit page take a variant's options from its terms when they are not all
 * readable: a null one threw on mount; one whose term slug was set but not text (an object, a list, a
 * non-zero number, true), or that had no slug (or a false or 0 one) and a term value that was not text,
 * threw while filling the empty SKU of a variant whose term the store no longer has ("Cannot read
 * properties of undefined (reading 'toLowerCase')", "….toUpperCase is not a function"); and every other
 * one blocked every autosave (productSchema refuses it), one without the ids also opening the variations
 * editor with none of the variant's terms selected.
 */
export function isReadableVariantOption(option: unknown): option is ProductVariantOption {
  if (option === null || typeof option !== 'object' || Array.isArray(option)) {
    return false;
  }

  const { attribute_id, attribute_name, term_id, term_value, term_slug } = option as Record<string, unknown>;
  return (
    typeof attribute_id === 'string' &&
    typeof attribute_name === 'string' &&
    typeof term_id === 'string' &&
    typeof term_value === 'string' &&
    (term_slug === undefined || typeof term_slug === 'string')
  );
}

/**
 * A new variant's SKU: the product's SKU plus each option's term slug (its value slugified when it has
 * none). Text only: a product SKU, an option, a slug or a value that is not text adds nothing. The product
 * form fills a loaded variant's empty SKU with this, and a product draft can hold anything (any WRITER can
 * PATCH one): an option whose term slug was set but not text (an object, a list, a non-zero number,
 * true), or that had no slug (or a false or 0 one) and a term value that was not text, or a product SKU
 * that was not text, made ProductForm throw when it mounted in the browser ("Cannot read properties of
 * undefined (reading 'toLowerCase')", "value.toLowerCase is not a function", "….toUpperCase is not a
 * function", "baseSku.trim is not a function"; the edit page's client shell renders the form only after
 * mount, and /cms has no error boundary, so the page was lost for every reader), and the variations editor
 * threw the same way on a term toggle beside such a product SKU.
 */
export function buildVariantSku(baseSku: string, options: ProductVariantOption[]) {
  const skuSuffix = (Array.isArray(options) ? (options as unknown[]) : [])
    .map((option) => {
      const { term_slug: slug, term_value: value } = (
        option !== null && typeof option === 'object' ? option : {}
      ) as Record<string, unknown>;
      return (typeof slug === 'string' && slug ? slug : slugifyToken(value)).toUpperCase();
    })
    .filter(Boolean)
    .join('-');

  return [typeof baseSku === 'string' ? baseSku.trim() : '', skuSuffix].filter(Boolean).join('-');
}

/**
 * A product-form price map (major units: 49.99) as a new variant takes it: each currency with a
 * finite, non-negative amount and, with `keepCleared`, each sale amount cleared to null.
 * normalizePriceMap / normalizeSalePriceMap are for stored minor-unit amounts and round to a whole
 * number, which priced a variant generated from a $49.99 product at $50.00.
 */
function normalizeFormAmountMap(value: unknown, keepCleared: false): PriceMap;
function normalizeFormAmountMap(value: unknown, keepCleared: true): SalePriceMap;
function normalizeFormAmountMap(value: unknown, keepCleared: boolean): SalePriceMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value as Record<string, unknown>).reduce<SalePriceMap>(
    (accumulator, [code, amount]) => {
      const normalizedAmount = typeof amount === 'string' ? Number.parseFloat(amount) : amount;

      if (typeof normalizedAmount === 'number' && Number.isFinite(normalizedAmount) && normalizedAmount >= 0) {
        accumulator[normalizeCurrencyCode(code)] = normalizedAmount;
      } else if (normalizedAmount === null && keepCleared) {
        accumulator[normalizeCurrencyCode(code)] = null;
      }

      return accumulator;
    },
    {}
  );
}

function cartesianProduct<T>(groups: T[][]): T[][] {
  if (groups.length === 0) {
    return [];
  }

  return groups.reduce<T[][]>(
    (accumulator, current) =>
      accumulator.flatMap((existing) => current.map((item) => [...existing, item])),
    [[]]
  );
}

/**
 * Every combination of the selected terms, as variant drafts. A combination the previous drafts
 * hold keeps every value of its own; a new one starts from the product's: its SKU plus the term
 * slugs, its price and per-currency prices, and its sale (price and per-currency amounts, with the
 * window when it takes an amount). The base amounts are the product form's (major units).
 */
export function generateVariantDrafts(params: {
  baseSku: string;
  basePrice: number;
  basePrices?: Record<string, number | null | undefined> | null;
  baseSalePrice?: number | null;
  baseSalePrices?: Record<string, number | null | undefined> | null;
  baseSaleStartAt?: string | null;
  baseSaleEndAt?: string | null;
  selectedAttributes: VariationSelectionGroup[];
  previousVariants?: ProductVariantDraft[];
}) {
  const {
    baseSku,
    basePrice,
    basePrices = {},
    baseSalePrice = null,
    baseSalePrices = {},
    baseSaleStartAt = null,
    baseSaleEndAt = null,
    selectedAttributes,
    previousVariants = [],
  } = params;

  if (
    selectedAttributes.length === 0 ||
    selectedAttributes.some((attribute) => attribute.terms.length === 0)
  ) {
    return [];
  }

  const previousByKey = new Map(
    previousVariants.map((variant) => [variant.combination_key, variant])
  );
  // A new combination takes the product's sale window only with a product sale amount. A variant's
  // sale follows the variant's own window and none means always on (isSaleWindowActive), so a sale
  // price without the product's window was on sale at once and for good; and the window of a
  // product without a sale price (last year's, say) kept a sale set later on the variant from ever
  // applying.
  const takesProductSale =
    typeof baseSalePrice === 'number' ||
    Object.values(normalizeFormAmountMap(baseSalePrices, true)).some((amount) => typeof amount === 'number');
  const newSaleStartAt = takesProductSale ? baseSaleStartAt || null : null;
  const newSaleEndAt = takesProductSale ? baseSaleEndAt || null : null;

  const groupedTerms = selectedAttributes.map((attribute) =>
    attribute.terms.map((term) => ({
      attribute_id: attribute.attribute_id,
      attribute_name: attribute.attribute_name,
      term,
    }))
  );

  return cartesianProduct(groupedTerms).map((combination) => {
    const selectedOptions: ProductVariantOption[] = combination.map(({ attribute_id, attribute_name, term }) => ({
      attribute_id,
      attribute_name,
      term_id: term.id,
      term_value: term.value,
      term_slug: term.slug,
    }));

    const attributeTermIds = selectedOptions.map((option) => option.term_id);
    const combinationKey = buildCombinationKey(attributeTermIds);
    const previous = previousByKey.get(combinationKey);

    // IMPORTANT (future agents): every per-variant field a user can edit MUST be carried over from
    // `previous` here. The variations editor re-runs this function when a term is toggled (or the
    // currencies change), replacing the draft list. If a field is omitted, it silently resets on
    // the next regenerate and then gets autosaved away, which is exactly how the sale window
    // (sale_start_at/sale_end_at) used to "revert after publish". An existing variant
    // keeps its own values, an empty one included: `previous?.sale_price ?? baseSalePrice` read a
    // stored null as "unset" and gave a variant with no sale price the product's sale price with no
    // window, so publishing put that variant (and its SKU in every language) on sale at once and
    // for good. Only a new combination takes the product's values.
    return {
      id: previous?.id,
      combination_key: combinationKey,
      sku: previous?.sku || buildVariantSku(baseSku, selectedOptions),
      upc: previous?.upc ?? null,
      price: previous?.price ?? basePrice,
      prices: previous ? previous.prices ?? {} : normalizeFormAmountMap(basePrices, false),
      sale_price: previous ? previous.sale_price ?? null : baseSalePrice,
      sale_prices: previous ? previous.sale_prices ?? {} : normalizeFormAmountMap(baseSalePrices, true),
      sale_start_at: previous ? previous.sale_start_at ?? null : newSaleStartAt,
      sale_end_at: previous ? previous.sale_end_at ?? null : newSaleEndAt,
      stock_quantity: previous?.stock_quantity ?? 0,
      main_media_id: previous?.main_media_id ?? null,
      main_image_url: previous?.main_image_url ?? null,
      attribute_term_ids: attributeTermIds,
      selected_options: selectedOptions,
      label: buildVariantLabel(selectedOptions),
    };
  });
}

export function extractSelectedTermsByAttribute(variants: Array<{
  selected_options?: ProductVariantOption[];
}>) {
  const selected: Record<string, string[]> = {};

  for (const variant of variants) {
    for (const option of variant.selected_options ?? []) {
      const current = new Set(selected[option.attribute_id] ?? []);
      current.add(option.term_id);
      selected[option.attribute_id] = [...current];
    }
  }

  return selected;
}

export function findMatchingVariant(
  variants: ProductVariant[],
  selections: Record<string, string | undefined>
) {
  const selectedTermIds = Object.values(selections).filter(Boolean) as string[];

  if (selectedTermIds.length === 0) {
    return null;
  }

  return (
    variants.find(
      (variant) =>
        variant.attribute_term_ids.length === selectedTermIds.length &&
        selectedTermIds.every((termId) => variant.attribute_term_ids.includes(termId))
    ) ?? null
  );
}

export function getAvailableTermIdsForAttribute(
  variants: ProductVariant[],
  attributeId: string,
  selections: Record<string, string | undefined>
) {
  const available = new Set<string>();

  for (const variant of variants) {
    const matchesOtherSelections = Object.entries(selections).every(([selectedAttributeId, termId]) => {
      if (!termId || selectedAttributeId === attributeId) {
        return true;
      }

      return variant.attribute_term_ids.includes(termId);
    });

    if (!matchesOtherSelections) {
      continue;
    }

    const option = variant.selected_options.find((candidate) => candidate.attribute_id === attributeId);
    if (option) {
      available.add(option.term_id);
    }
  }

  return available;
}

export function chooseInitialVariantSelections(
  attributes: ProductAttribute[],
  variants: ProductVariant[]
) {
  const preferredVariant = variants.find((variant) => variant.stock_quantity > 0) ?? variants[0] ?? null;

  if (preferredVariant) {
    return preferredVariant.selected_options.reduce<Record<string, string>>((accumulator, option) => {
      accumulator[option.attribute_id] = option.term_id;
      return accumulator;
    }, {});
  }

  return attributes.reduce<Record<string, string>>((accumulator, attribute) => {
    const firstTerm = attribute.terms[0];
    if (firstTerm) {
      accumulator[attribute.id] = firstTerm.id;
    }
    return accumulator;
  }, {});
}

/**
 * The selections after the shopper picks `termId` for `attributeId`.
 *
 * The pick always wins. Every other attribute keeps its current term when some variant
 * combines it with everything chosen so far, and otherwise moves to the first term that
 * does. With a sparse matrix (only Red/S and Blue/M exist) choosing Blue therefore lands on
 * Blue/M. The old flow re-normalized `{...current, [attributeId]: termId}` attribute by
 * attribute, which reverted the pick itself whenever it clashed with another dropdown.
 */
export function applyVariantSelection(
  attributes: ProductAttribute[],
  variants: ProductVariant[],
  current: Record<string, string | undefined>,
  attributeId: string,
  termId: string
) {
  const next: Record<string, string | undefined> = { [attributeId]: termId };

  for (const attribute of attributes) {
    if (attribute.id === attributeId) {
      continue;
    }

    const availableTermIds = getAvailableTermIdsForAttribute(variants, attribute.id, next);
    const kept = current[attribute.id];

    if (kept && availableTermIds.has(kept)) {
      next[attribute.id] = kept;
      continue;
    }

    const fallback = attribute.terms.find((term) => availableTermIds.has(term.id));
    if (fallback) {
      next[attribute.id] = fallback.id;
    }
  }

  return next;
}

export function normalizeSelectionsToAvailableVariants(
  attributes: ProductAttribute[],
  variants: ProductVariant[],
  selections: Record<string, string | undefined>
) {
  const normalized = { ...selections };

  for (const attribute of attributes) {
    const availableTermIds = getAvailableTermIdsForAttribute(variants, attribute.id, normalized);

    if (availableTermIds.size === 0) {
      delete normalized[attribute.id];
      continue;
    }

    const current = normalized[attribute.id];
    if (current && availableTermIds.has(current)) {
      continue;
    }

    const fallback = attribute.terms.find((term) => availableTermIds.has(term.id));
    if (fallback) {
      normalized[attribute.id] = fallback.id;
    }
  }

  return normalized;
}

export function mapRawVariantRelations(rawVariants: any[] = [], languageCode?: string | null) {
  const attributeMap = new Map<string, AttributeAccumulator>();

  const variants: ProductVariant[] = rawVariants
    .map((variant) => {
      const selectedOptions: ProductVariantOption[] = (variant.variant_attribute_mapping || [])
        .map((mapping: any) => {
          const term = mapping.product_attribute_terms;
          const attribute = term?.product_attributes;

          if (!term || !attribute) {
            return null;
          }

          const existingAttribute: AttributeAccumulator = attributeMap.get(attribute.id) || {
            id: attribute.id,
            name: resolveTranslatedText(
              attribute.name,
              normalizeTranslationMap(attribute.name_translations),
              languageCode
            ),
            slug: attribute.slug,
            name_translations: normalizeTranslationMap(attribute.name_translations),
            terms: [],
            _termIds: new Set<string>(),
          };

          if (!existingAttribute._termIds.has(term.id)) {
            existingAttribute.terms.push({
              id: term.id,
              attribute_id: term.attribute_id,
              value: resolveTranslatedText(
                term.value,
                normalizeTranslationMap(term.value_translations),
                languageCode
              ),
              slug: term.slug,
              sort_order: term.sort_order ?? null,
              value_translations: normalizeTranslationMap(term.value_translations),
            });
            existingAttribute._termIds.add(term.id);
          }

          attributeMap.set(attribute.id, existingAttribute);

          return {
            attribute_id: attribute.id,
            attribute_name: resolveTranslatedText(
              attribute.name,
              normalizeTranslationMap(attribute.name_translations),
              languageCode
            ),
            term_id: term.id,
            term_value: resolveTranslatedText(
              term.value,
              normalizeTranslationMap(term.value_translations),
              languageCode
            ),
            term_slug: term.slug,
          };
        })
        .filter(
          (option: ProductVariantOption | null): option is ProductVariantOption => option !== null
        )
        .sort((left: ProductVariantOption, right: ProductVariantOption) =>
          left.attribute_name.localeCompare(right.attribute_name)
        );

      const attributeTermIds = selectedOptions.map((option) => option.term_id);

      return {
        id: variant.id,
        combination_key: buildCombinationKey(attributeTermIds),
        sku: variant.sku,
        upc: variant.upc ?? null,
        price: variant.price ?? 0,
        prices: normalizePriceMap(variant.prices),
        sale_price: variant.sale_price ?? null,
        sale_prices: normalizeSalePriceMap(variant.sale_prices),
        sale_start_at: variant.sale_start_at ?? null,
        sale_end_at: variant.sale_end_at ?? null,
        scheduled_price: variant.scheduled_price ?? null,
        scheduled_prices: normalizePriceMap(variant.scheduled_prices),
        scheduled_price_at: variant.scheduled_price_at ?? null,
        stock_quantity: variant.stock_quantity ?? 0,
        main_media_id: variant.main_media_id ?? null,
        image_url: resolveMediaUrlWithSupabaseFallback(
          variant.media?.file_path ?? variant.media?.object_key ?? null
        ),
        attribute_term_ids: attributeTermIds,
        selected_options: selectedOptions,
        label: buildVariantLabel(selectedOptions),
      };
    });

  const attributes: ProductAttribute[] = [...attributeMap.values()]
    .map((attribute) => ({
      id: attribute.id,
      name: attribute.name,
      slug: attribute.slug,
      name_translations: attribute.name_translations,
      terms: [...attribute.terms].sort((left, right) => {
        const leftOrder = left.sort_order ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = right.sort_order ?? Number.MAX_SAFE_INTEGER;

        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }

        return left.value.localeCompare(right.value);
      }),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { attributes, variants };
}

export function getVariantEffectivePriceRange(
  variants: Array<
    Pick<ProductVariant, 'price' | 'sale_price' | 'sale_start_at' | 'sale_end_at'>
  >,
  now?: Date
) {
  if (!variants.length) {
    return null;
  }

  const effectivePrices = variants.map((variant) => {
    // Only treat the sale price as effective while its schedule window is active.
    const saleActive = isSaleWindowActive({
      saleStartAt: variant.sale_start_at,
      saleEndAt: variant.sale_end_at,
      now,
    });
    return saleActive && typeof variant.sale_price === 'number'
      ? variant.sale_price
      : variant.price;
  });

  return {
    min: Math.min(...effectivePrices),
    max: Math.max(...effectivePrices),
  };
}
