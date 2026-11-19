import { z } from './zod-config';

const productTypeSchema = z
  .enum(['physical', 'digital'])
  .or(z.literal(''))
  .refine((value) => value !== '', {
    message: 'Product type is required',
  })
  .transform((value) => value as 'physical' | 'digital');

const currencyPriceMapSchema = z.record(
  z.string().regex(/^[A-Z]{3}$/, 'Currency code must be ISO 4217'),
  z.coerce.number().min(0, 'Prices must be non-negative')
);

const currencySalePriceMapSchema = z.record(
  z.string().regex(/^[A-Z]{3}$/, 'Currency code must be ISO 4217'),
  z.coerce.number().min(0, 'Sale prices must be non-negative').nullable()
);

// Optional ISO date/time string for sale-schedule fields. Accepts undefined,
// null, or an empty string (all normalized to null) and any value parseable by
// Date. The form stores these as ISO-8601 UTC strings.
const scheduleDateTimeSchema = z
  .string()
  .trim()
  .refine((value) => value === '' || !Number.isNaN(Date.parse(value)), {
    message: 'Must be a valid date and time',
  })
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional();

function isSaleWindowOrdered(start?: string | null, end?: string | null) {
  if (!start || !end) {
    return true;
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return true;
  }
  return startMs < endMs;
}

const selectedOptionSchema = z.object({
  attribute_id: z.string().uuid(),
  attribute_name: z.string(),
  term_id: z.string().uuid(),
  term_value: z.string(),
  term_slug: z.string().optional(),
});

const variantDraftSchema = z.object({
  id: z.string().uuid().optional(),
  combination_key: z.string().min(1),
  sku: z.string().min(1, 'Variant SKU is required'),
  upc: z.string().optional().nullable(),
  price: z.coerce.number().min(0, 'Variant price must be non-negative'),
  prices: currencyPriceMapSchema.default({}),
  sale_price: z.coerce.number().min(0, 'Variant sale price must be non-negative').optional().nullable(),
  sale_prices: currencySalePriceMapSchema.default({}),
  sale_start_at: scheduleDateTimeSchema,
  sale_end_at: scheduleDateTimeSchema,
  stock_quantity: z.coerce.number().int().min(0, 'Variant stock must be a non-negative integer'),
  main_media_id: z.string().uuid().optional().nullable(),
  main_image_url: z.string().optional().nullable(),
  attribute_term_ids: z.array(z.string().uuid()).min(1),
  selected_options: z.array(selectedOptionSchema).min(1),
  label: z.string().min(1),
}).refine(
  (variant) => variant.sale_price === null || variant.sale_price === undefined || variant.sale_price <= variant.price,
  {
    message: 'Variant sale price cannot exceed the regular price',
    path: ['sale_price'],
  }
).refine(
  (variant) =>
    Object.entries(variant.sale_prices || {}).every(([currencyCode, salePrice]) => {
      if (salePrice === null || salePrice === undefined) {
        return true;
      }

      const regularPrice = variant.prices?.[currencyCode];
      return typeof regularPrice === 'number' ? salePrice <= regularPrice : true;
    }),
  {
    message: 'Variant sale prices cannot exceed regular prices',
    path: ['sale_prices'],
  }
).refine(
  (variant) => isSaleWindowOrdered(variant.sale_start_at, variant.sale_end_at),
  {
    message: 'Sale end must be after the sale start',
    path: ['sale_end_at'],
  }
);

const variationAttributeSchema = z.object({
  attribute_id: z.string().uuid(),
  term_ids: z.array(z.string().uuid()),
});

export const productSchema = z.object({
  product_type: productTypeSchema,
  payment_provider: z.enum(['stripe', 'freemius']),
  title: z.string().min(1, 'Title is required'),
  slug: z
    .string()
    .min(1, 'Slug is required')
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens'),
  sku: z.string().min(1, 'SKU is required'),
  upc: z.string().optional().nullable(),
  price: z.coerce.number().min(0, 'Price must be non-negative'),
  prices: currencyPriceMapSchema.default({}),
  sale_price: z.coerce.number().min(0, 'Sale price must be non-negative').optional().nullable(),
  sale_prices: currencySalePriceMapSchema.default({}),
  sale_start_at: scheduleDateTimeSchema,
  sale_end_at: scheduleDateTimeSchema,
  stock: z.coerce.number().int().min(0, 'Stock must be a non-negative integer'),
  meta_title: z.string().optional().nullable(),
  meta_description: z.string().optional().nullable(),
  custom_canonical: z.string().optional().nullable(),
  short_description: z.string().optional(),
  description_json: z.any().optional(), // Using any for Tiptap JSON structure
  freemius_plan_id: z.string().optional(), // ID from Freemius Dashboard
  freemius_product_id: z.string().optional(), // Product or App ID from Freemius Dashboard
  trial_period_days: z.coerce.number().int().min(0, 'Trial period must be zero or greater').default(0),
  trial_requires_payment_method: z.boolean().default(false),
  media_id: z.string().optional(), // For the main product image (backward compat or single select)
  product_media: z.array(z.object({
      media_id: z.string(),
      // We can sort based on index in this array, or explicit sort_order from UI
  })).optional(),
  category_ids: z.array(z.string().uuid()).optional(),
  is_taxable: z.boolean(),
  status: z.enum(['draft', 'active', 'archived']),
  language_id: z.coerce.number().int().min(1, 'Language is required'),
  translation_group_id: z.string().uuid().optional().or(z.literal('')).transform(val => val === '' ? undefined : val),
  explicitly_removed_media_ids: z.array(z.string()).optional(),
  variation_attributes: z.array(variationAttributeSchema).optional(),
  variants: z.array(variantDraftSchema).optional(),
  // The stock the edit page loaded, per SKU ({ sku: quantity }: each variant's, or the product's when it
  // has none). The form never shows it; the autosave stores it in the draft, and publishing writes a
  // SKU's stock only when the draft's quantity differs from it (publish_product_draft, migration 02044),
  // so a sale made while the page was open keeps its deduction. Lenient on purpose: a hidden field that
  // refused a value would block every autosave, and the publish ignores an entry it cannot read. A null
  // entry is what publish sends for a SKU the live product stocks that the draft's baseline lacks
  // (resolvePublishedStockBaseline in the app); the form's own baseline holds numbers only.
  stock_baseline: z.record(z.string(), z.number().nullable()).nullable().optional(),
  // The product's publish count when the edit page loaded `stock_baseline` (public.product_stock_publishes,
  // migration 02047). Carried unseen like the baseline: publishing counts a baseline loaded before the
  // product's last publish from the figures that publish entered, so a change it made live is not applied
  // again. Lenient for the same reason; the publish ignores a value that is not a whole number from 0.
  stock_baseline_publish_count: z.number().nullable().optional(),
}).refine(
  (product) =>
    product.sale_price === null ||
    product.sale_price === undefined ||
    product.sale_price <= product.price,
  {
    message: 'Sale price cannot exceed the regular price',
    path: ['sale_price'],
  }
).refine(
  (product) =>
    Object.entries(product.sale_prices || {}).every(([currencyCode, salePrice]) => {
      if (salePrice === null || salePrice === undefined) {
        return true;
      }

      const regularPrice = product.prices?.[currencyCode];
      return typeof regularPrice === 'number' ? salePrice <= regularPrice : true;
    }),
  {
    message: 'Sale prices cannot exceed regular prices',
    path: ['sale_prices'],
  }
).refine(
  (product) => isSaleWindowOrdered(product.sale_start_at, product.sale_end_at),
  {
    message: 'Sale end must be after the sale start',
    path: ['sale_end_at'],
  }
);

export type ProductFormValues = z.infer<typeof productSchema>;
