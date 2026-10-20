import type { SupabaseClient } from '@supabase/supabase-js';

import { normalizeCountryCode } from '../countries';
import { getDefaultCurrency, type CurrencyRecord } from '../currency';
import type { CheckoutErrorPayload } from '../inventory-settings';
import { resolveShippingRateAmountForCurrency } from '../shipping-rate-currency';
import { normalizeSubdivisionCode } from '../states';
import type { TranslationMap } from '../types';
import { resolveTranslatedText } from '../variation-utils';

/**
 * Shipping-method resolution shared by the storefront estimate (`resolveShippingOptions`)
 * and the Stripe checkout. Both MUST price a method the same way: the estimate is what the
 * shopper is shown, the checkout is what they are charged, and every `shipping_zone_methods`
 * row (id, cost, free-shipping threshold, zone) is publicly readable, so a checkout that
 * trusted the submitted id alone could be handed the $0 free-shipping id on a $20 cart, or a
 * domestic rate on an international address.
 *
 * Every helper takes the Supabase client as a parameter: the estimate runs with the public
 * client, the checkout with the service-role one.
 */

export interface ShippingDestination {
  country: string;
  state?: string;
  postal_code?: string;
}

export interface ResolvedShippingMethod {
  id: string;
  name: string;
  amount: number;
  currency: string;
  type: 'flat_rate' | 'free_shipping';
}

export type ShippingQueryClient = SupabaseClient<any>;

export const SHIPPING_ZONE_METHOD_COLUMNS =
  'id, zone_id, method_type, cost_amount, cost_amounts, cost_currency, currency_pricing_mode, min_order_amount, min_order_amounts, name, name_translations';

export interface ShippingZoneMethodRow {
  id: string;
  zone_id: string;
  method_type: string | null;
  cost_amount: number | null;
  cost_amounts: unknown;
  cost_currency: string | null;
  currency_pricing_mode: string | null;
  min_order_amount: number | null;
  min_order_amounts: unknown;
  name: string;
  name_translations: unknown;
}

export interface ShippingRateContext {
  currencies: CurrencyRecord[];
  /** Shopper currency; falls back to the store default. */
  currencyCode?: string | null;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toNonNegativeAmount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Normalizes a destination the way the storefront estimate does (country alias → ISO code,
 * state name → subdivision code). Returns null when there is no usable country.
 */
export function normalizeShippingDestination(
  destination:
    | { country?: string | null; state?: string | null; postal_code?: string | null }
    | null
    | undefined
): ShippingDestination | null {
  const country = normalizeCountryCode(destination?.country);

  if (!country) {
    return null;
  }

  return {
    country,
    state: normalizeSubdivisionCode(country, destination?.state) || undefined,
    postal_code: destination?.postal_code?.trim() || undefined,
  };
}

/**
 * Picks the shipping zone for a destination.
 * Priority: a state match, then a country-wide location, then the first zone by
 * `priority_order`. `postal_code` exists in the schema but is not matched yet (docs/02).
 */
export async function resolveShippingZoneIdForDestination(
  client: ShippingQueryClient,
  destination: ShippingDestination
): Promise<{ zoneId: string | null; error: unknown | null }> {
  const { data: matches, error } = await client
    .from('shipping_zone_locations')
    .select(
      `
            zone_id,
            country_code,
            state_code,
            postal_code,
            shipping_zones!inner(priority_order)
        `
    )
    .eq('country_code', destination.country)
    .order('shipping_zones(priority_order)', { ascending: true });

  if (error) {
    return { zoneId: null, error };
  }

  if (!matches || matches.length === 0) {
    return { zoneId: null, error: null };
  }

  let selectedZoneId: string | null = null;

  if (destination.state) {
    const stateMatch = matches.find((m: any) => m.state_code === destination.state);
    if (stateMatch) selectedZoneId = stateMatch.zone_id;
  }

  if (!selectedZoneId) {
    const countryMatch = matches.find((m: any) => !m.state_code && !m.postal_code);
    if (countryMatch) selectedZoneId = countryMatch.zone_id;
  }

  if (!selectedZoneId) {
    selectedZoneId = matches[0].zone_id;
  }

  return { zoneId: selectedZoneId, error: null };
}

function resolveContextCurrencyCode(context: ShippingRateContext) {
  return context.currencyCode || getDefaultCurrency(context.currencies).code;
}

/** The method's minimum order amount, in the shopper currency (minor units). */
export function resolveShippingMethodThreshold(
  method: ShippingZoneMethodRow,
  context: ShippingRateContext
) {
  return resolveShippingRateAmountForCurrency({
    amountMap: (method.min_order_amounts as Record<string, number> | null) || {},
    fallbackAmount: method.min_order_amount || 0,
    sourceCurrencyCode: method.cost_currency || getDefaultCurrency(context.currencies).code,
    mode: method.currency_pricing_mode,
    currencyCode: resolveContextCurrencyCode(context),
    currencies: context.currencies,
  });
}

/** The method's cost, in the shopper currency (minor units). */
export function resolveShippingMethodAmount(
  method: ShippingZoneMethodRow,
  context: ShippingRateContext
) {
  return resolveShippingRateAmountForCurrency({
    amountMap: (method.cost_amounts as Record<string, number> | null) || {},
    fallbackAmount: method.cost_amount || 0,
    sourceCurrencyCode: method.cost_currency || getDefaultCurrency(context.currencies).code,
    mode: method.currency_pricing_mode,
    currencyCode: resolveContextCurrencyCode(context),
    currencies: context.currencies,
  });
}

/** `cartTotal` is the discounted merchandise subtotal in the shopper currency. */
export function isShippingMethodEligibleForCart(
  method: ShippingZoneMethodRow,
  cartTotal: number,
  context: ShippingRateContext
) {
  return toNonNegativeAmount(cartTotal) >= resolveShippingMethodThreshold(method, context);
}

export function toResolvedShippingMethod(
  method: ShippingZoneMethodRow,
  context: ShippingRateContext,
  languageCode?: string | null
): ResolvedShippingMethod {
  return {
    id: method.id,
    name: resolveTranslatedText(
      method.name,
      (method.name_translations || null) as TranslationMap | null,
      languageCode
    ),
    amount: resolveShippingMethodAmount(method, context),
    currency: resolveContextCurrencyCode(context),
    type: method.method_type as 'flat_rate' | 'free_shipping',
  };
}

export type EligibleShippingMethodsResult =
  | { ok: true; zoneId: string | null; methods: ShippingZoneMethodRow[] }
  | { ok: false; error: unknown };

/**
 * Every method of the destination's zone whose minimum order amount the cart meets.
 * Unsorted; the storefront estimate keeps only the cheapest.
 */
export async function listEligibleShippingMethods(
  client: ShippingQueryClient,
  params: {
    destination: ShippingDestination;
    cartTotal: number;
  } & ShippingRateContext
): Promise<EligibleShippingMethodsResult> {
  const { zoneId, error: zoneError } = await resolveShippingZoneIdForDestination(
    client,
    params.destination
  );

  if (zoneError) {
    return { ok: false, error: zoneError };
  }

  if (!zoneId) {
    return { ok: true, zoneId: null, methods: [] };
  }

  const { data: methods, error: methodsError } = await client
    .from('shipping_zone_methods')
    .select(SHIPPING_ZONE_METHOD_COLUMNS)
    .eq('zone_id', zoneId);

  if (methodsError) {
    return { ok: false, error: methodsError };
  }

  const context: ShippingRateContext = {
    currencies: params.currencies,
    currencyCode: params.currencyCode,
  };

  return {
    ok: true,
    zoneId,
    methods: ((methods || []) as ShippingZoneMethodRow[]).filter((method) =>
      isShippingMethodEligibleForCart(method, params.cartTotal, context)
    ),
  };
}

export type CheckoutShippingMethodRejection =
  | 'not_found'
  | 'zone_mismatch'
  | 'threshold_not_met';

export type CheckoutShippingMethodResolution =
  | { ok: true; method: ResolvedShippingMethod & { zoneId: string } }
  | { ok: false; reason: CheckoutShippingMethodRejection }
  | { ok: false; reason: 'load_failed'; error: unknown };

/**
 * Re-validates the shipping method a checkout submitted: the id must exist, belong to the
 * zone resolved from the shipping address, and its minimum order amount must be met by the
 * cart. The amount comes from the DB row, never from the request.
 */
export async function resolveCheckoutShippingMethod(
  client: ShippingQueryClient,
  params: {
    methodId: unknown;
    destination: ShippingDestination;
    cartTotal: number;
    languageCode?: string | null;
  } & ShippingRateContext
): Promise<CheckoutShippingMethodResolution> {
  const methodId = typeof params.methodId === 'string' ? params.methodId.trim() : '';

  // Postgres rejects a malformed uuid with a 22P02 error; treat it as "no such method"
  // rather than a server failure.
  if (!UUID_SHAPE.test(methodId)) {
    return { ok: false, reason: 'not_found' };
  }

  const { data: method, error: methodError } = await client
    .from('shipping_zone_methods')
    .select(SHIPPING_ZONE_METHOD_COLUMNS)
    .eq('id', methodId)
    .maybeSingle();

  if (methodError) {
    return { ok: false, reason: 'load_failed', error: methodError };
  }

  if (!method) {
    return { ok: false, reason: 'not_found' };
  }

  const methodRow = method as ShippingZoneMethodRow;
  const { zoneId, error: zoneError } = await resolveShippingZoneIdForDestination(
    client,
    params.destination
  );

  if (zoneError) {
    return { ok: false, reason: 'load_failed', error: zoneError };
  }

  if (!zoneId || zoneId !== methodRow.zone_id) {
    return { ok: false, reason: 'zone_mismatch' };
  }

  const context: ShippingRateContext = {
    currencies: params.currencies,
    currencyCode: params.currencyCode,
  };

  if (!isShippingMethodEligibleForCart(methodRow, params.cartTotal, context)) {
    return { ok: false, reason: 'threshold_not_met' };
  }

  return {
    ok: true,
    method: {
      ...toResolvedShippingMethod(methodRow, context, params.languageCode),
      zoneId,
    },
  };
}

export function createShippingAddressRequiredError(): CheckoutErrorPayload {
  return {
    error: 'A shipping address is required for this order.',
    errorKey: 'ecommerce.checkout_shipping_address_required',
    errorStatus: 400,
  };
}

export function createShippingMethodRequiredError(): CheckoutErrorPayload {
  return {
    error: 'Please select a shipping method before continuing.',
    errorKey: 'ecommerce.shipping_method_required',
    errorStatus: 400,
  };
}

export function createInvalidShippingMethodError(): CheckoutErrorPayload {
  return {
    error: 'The selected shipping method is not available for this order.',
    errorKey: 'ecommerce.checkout_invalid_shipping_method',
    errorStatus: 400,
  };
}
