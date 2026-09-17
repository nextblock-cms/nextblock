import type { CheckoutSessionInput } from './customer';
import type {
  CurrencyRecord,
  PriceMap,
  SalePriceMap,
} from './currency';

export type TranslationMap = Record<string, string>;
export type { CurrencyRecord, PriceMap, SalePriceMap };

export type ProductType = 'physical' | 'digital';
export type EcommercePaymentProvider = 'stripe' | 'freemius';

export interface EnabledPaymentProviders {
  stripe: boolean;
  freemius: boolean;
}

export const DEFAULT_ENABLED_PAYMENT_PROVIDERS: EnabledPaymentProviders = {
  stripe: false,
  freemius: false,
};

export function normalizeEnabledPaymentProviders(
  value: unknown
): EnabledPaymentProviders {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_ENABLED_PAYMENT_PROVIDERS };
  }

  const candidate = value as Partial<Record<keyof EnabledPaymentProviders, unknown>>;

  return {
    stripe: candidate.stripe === true,
    freemius: candidate.freemius === true,
  };
}

export function derivePaymentProviderFromProductType(
  productType: ProductType
): EcommercePaymentProvider {
  return productType === 'digital' ? 'freemius' : 'stripe';
}

// Basic Product interface for UI components
// In a real app, this might come from database types, but we define the UI requirement here.
export interface ProductAttributeTerm {
  id: string;
  attribute_id: string;
  value: string;
  slug: string;
  sort_order?: number | null;
  value_translations?: TranslationMap | null;
}

export interface ProductAttribute {
  id: string;
  name: string;
  slug: string;
  name_translations?: TranslationMap | null;
  terms: ProductAttributeTerm[];
}

export interface ProductVariantOption {
  attribute_id: string;
  attribute_name: string;
  term_id: string;
  term_value: string;
  term_slug?: string;
}

export interface ProductVariant {
  id: string;
  combination_key: string;
  sku: string;
  upc?: string | null;
  price: number;
  prices?: PriceMap | null;
  sale_price?: number | null;
  sale_prices?: SalePriceMap | null;
  sale_start_at?: string | null;
  sale_end_at?: string | null;
  scheduled_price?: number | null;
  scheduled_prices?: PriceMap | null;
  scheduled_price_at?: string | null;
  stock_quantity: number;
  attribute_term_ids: string[];
  selected_options: ProductVariantOption[];
  label: string;
  main_media_id?: string | null;
  image_url?: string | null;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  name_translations?: Record<string, string> | null;
  description_translations?: Record<string, string> | null;
}

export interface Product {
  id: string;
  title: string;
  slug: string;
  average_rating?: number;
  total_reviews?: number;
  categories?: Category[];
  sku: string;
  upc?: string | null;
  price: number;
  prices?: PriceMap | null;
  sale_price?: number | null;
  sale_prices?: SalePriceMap | null;
  sale_start_at?: string | null;
  sale_end_at?: string | null;
  scheduled_price?: number | null;
  scheduled_prices?: PriceMap | null;
  scheduled_price_at?: string | null;
  is_taxable?: boolean;
  product_type?: ProductType;
  payment_provider?: EcommercePaymentProvider;
  price_range_min?: number | null;
  price_range_max?: number | null;
  image_url?: string; // Resolved URL of the primary image
  images?: { url: string; alt?: string; width?: number; height?: number }[]; // Array of resolved image URLs
  short_description?: string | null;
  description_json?: any; // Tiptap JSON content
  description_blocks?: any[];
  stock?: number | null;
  freemius_product_id?: string;
  freemius_plan_id?: string;
  trial_period_days?: number | null;
  trial_requires_payment_method?: boolean | null;
  custom_props?: any;
  language_id: number;
  translation_group_id: string;
  language_code?: string;
  has_variants?: boolean;
  variant_id?: string;
  variant_label?: string;
  selected_options?: ProductVariantOption[];
  attributes?: ProductAttribute[];
  variants?: ProductVariant[];
  product_variants?: Array<{
    id: string;
    price: number;
    prices?: PriceMap | null;
    sale_price?: number | null;
    sale_prices?: SalePriceMap | null;
    sale_start_at?: string | null;
    sale_end_at?: string | null;
    scheduled_price?: number | null;
    scheduled_prices?: PriceMap | null;
    scheduled_price_at?: string | null;
  }>;
  freemius_plans?: Array<{
    id: string;
    name: string;
    title: string | null;
    freemius_pricing: Array<{
      id: string;
      license_quota: number | null;
      api_monthly_price: number | null;
      api_annual_price: number | null;
      api_lifetime_price: number | null;
      override_monthly_price: number | null;
      override_annual_price: number | null;
      override_lifetime_price: number | null;
      is_active: boolean;
    }>;
  }>;
}

export interface ShippingZone {
  id: string;
  name: string;
  priority_order: number;
  countries: string[];
  states: string[];
}

export interface TaxRate {
  id: string;
  country_code: string;
  state_code?: string | null;
  tax_name: string;
  tax_rate: number;
  created_at?: string | null;
  updated_at?: string | null;
}

export type TaxCalculationMode = 'manual' | 'automatic';

export interface EcommerceSettings {
  trackQuantities: boolean;
  enableTaxes: boolean;
  taxCalculationMode: TaxCalculationMode;
}

export interface TaxCalculationLine {
  id?: string;
  name: string;
  rate: number;
  amount: number;
  country_code: string;
  state_code?: string | null;
}

export interface TaxCalculationResult {
  enabled: boolean;
  mode: TaxCalculationMode;
  amount: number;
  taxableSubtotal: number;
  lines: TaxCalculationLine[];
  isPendingExternalCalculation?: boolean;
}

export type BillingCycle = 'monthly' | 'annual' | 'lifetime';

export type CartItemProvider = EcommercePaymentProvider;

export type CartItem = Product & {
  quantity: number;
  product_id: string;
  currency_code?: string;
  /** Which payment provider handles this cart item */
  provider?: CartItemProvider;
  /** For Freemius items: the selected billing cycle */
  billing_cycle?: BillingCycle;
  /** For Freemius items: explicitly requested trial mode (free vs paid) */
  trial_preference?: 'free' | 'paid';
  /** The MSRP/Original price before any sale_price logic */
  original_price?: number;
};

export function getProductPaymentProvider(
  value:
    | Pick<Product, 'payment_provider' | 'product_type' | 'freemius_product_id'>
    | Pick<CartItem, 'provider' | 'payment_provider' | 'product_type' | 'freemius_product_id'>
    | null
    | undefined
): EcommercePaymentProvider | null {
  if (!value) {
    return null;
  }

  if ('provider' in value && value.provider) {
    return value.provider;
  }

  if (value.payment_provider) {
    return value.payment_provider;
  }

  if (value.product_type) {
    return derivePaymentProviderFromProductType(value.product_type);
  }

  if ('freemius_product_id' in value && value.freemius_product_id) {
    return 'freemius';
  }

  return null;
}

export function isDigitalProduct(
  value:
    | Pick<Product, 'payment_provider' | 'product_type' | 'freemius_product_id'>
    | Pick<CartItem, 'provider' | 'payment_provider' | 'product_type' | 'freemius_product_id'>
    | null
    | undefined
): boolean {
  return getProductPaymentProvider(value) === 'freemius';
}

export interface CheckoutProviderError {
  error: string;
  errorKey?: string;
  errorParams?: Record<string, string | number>;
  errorStatus?: number;
}

/** Helper to check if a cart item is a Freemius digital product */
export function isDigitalItem(
  item: Pick<CartItem, 'provider' | 'payment_provider' | 'product_type' | 'freemius_product_id'>
): boolean {
  return isDigitalProduct(item);
}

export interface PaymentProvider {
  createCheckoutSession(input: CheckoutSessionInput): Promise<{
    url: string | null;
    error?: string;
    errorKey?: string;
    errorParams?: Record<string, string | number>;
    errorStatus?: number;
    customProps?: any;
  }>;
  getProviderName(): string;
}

export interface FreemiusPlanAPI {
  id: number;
  name: string;
  title: string;
  description: string;
  trial_period?: number | string | null;
  is_require_subscription?: boolean | number | string | null;
  created: string;
  updated: string;
}

export interface FreemiusPricingAPI {
  id: number;
  plan_id: number;
  currency: string;
  monthly_price: number | null;
  annual_price: number | null;
  lifetime_price: number | null;
  licenses: number;
}

/** Resolved pricing tier for the storefront (override takes precedence over api) */
export interface ResolvedPricingTier {
  id: string;
  license_quota: number;
  monthly_price: number | null;
  annual_price: number | null;
  lifetime_price: number | null;
  is_active: boolean;
}

export interface ResolvedPlanWithPricing {
  id: string;
  name: string;
  title: string;
  pricing: ResolvedPricingTier[];
}
