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

function resolveMediaUrl(filePath?: string | null) {
  if (!filePath) {
    return null;
  }

  if (filePath.startsWith('http')) {
    return filePath;
  }

  if (process.env.NEXT_PUBLIC_R2_BASE_URL) {
    return `${process.env.NEXT_PUBLIC_R2_BASE_URL}/${filePath}`;
  }

  if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/media/${filePath}`;
  }

  return filePath;
}

function slugifyToken(value: string) {
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

export function generateVariantDrafts(params: {
  baseSku: string;
  basePrice: number;
  basePrices?: PriceMap | null;
  baseSalePrice?: number | null;
  baseSalePrices?: SalePriceMap | null;
  selectedAttributes: VariationSelectionGroup[];
  previousVariants?: ProductVariantDraft[];
}) {
  const {
    baseSku,
    basePrice,
    basePrices = {},
    baseSalePrice = null,
    baseSalePrices = {},
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
    const skuSuffix = selectedOptions
      .map((option) => (option.term_slug ? option.term_slug : slugifyToken(option.term_value)).toUpperCase())
      .filter(Boolean)
      .join('-');

    return {
      id: previous?.id,
      combination_key: combinationKey,
      sku: previous?.sku || [baseSku.trim(), skuSuffix].filter(Boolean).join('-'),
      upc: previous?.upc ?? null,
      price: previous?.price ?? basePrice,
      prices: previous?.prices ?? normalizePriceMap(basePrices),
      sale_price: previous?.sale_price ?? baseSalePrice,
      sale_prices: previous?.sale_prices ?? normalizeSalePriceMap(baseSalePrices),
      // IMPORTANT (future agents): every per-variant field a user can edit MUST
      // be carried over from `previous` here. This function re-runs whenever the
      // variations editor mounts or attributes/base prices change, replacing the
      // draft list. If a field is omitted, it silently resets to null on the next
      // regenerate and then gets autosaved away — which is exactly how the sale
      // window (sale_start_at/sale_end_at) used to "revert after publish".
      sale_start_at: previous?.sale_start_at ?? null,
      sale_end_at: previous?.sale_end_at ?? null,
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
        image_url: resolveMediaUrl(
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
