import type { CartItem } from './types';
import { normalizeCountryCode } from './countries';
import { countryUsesStructuredStates, normalizeSubdivisionCode } from './states';

export type CustomerAddressType = 'billing' | 'shipping';

export interface CustomerAddressInput {
  company_name?: string | null;
  recipient_name?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country_code?: string | null;
}

export interface OrderCustomerDetails {
  email: string | null;
  name: string | null;
  phone: string | null;
  billing: CustomerAddressInput | null;
  shipping: CustomerAddressInput | null;
}

/** How a sale reached a partner: their storefront (signed token in the cart) or a referral link (cookie). */
export type CheckoutAttributionSource = 'storefront' | 'referral_link';

/**
 * The partner a checkout is attributed to (NextBlock Affiliates). Resolved by the app on the
 * server from a verified storefront token or the referral cookie, never read from the request
 * body. The providers only copy it onto the pending order row.
 */
export interface CheckoutAttribution {
  affiliateId: string;
  source: CheckoutAttributionSource;
  /** Store default currency code at checkout (the commission currency), or null. */
  baseCurrency: string | null;
}

export interface CheckoutSessionInput {
  items: CartItem[];
  couponCode?: string | null;
  couponContextItems?: CartItem[];
  customerEmail?: string | null;
  customerPhone?: string | null;
  billingAddress: CustomerAddressInput;
  shippingAddress?: CustomerAddressInput | null;
  shippingMethodId?: string | null;
  currencyCode?: string | null;
  locale?: string | null;
  userId?: string;
  /** Server-resolved partner attribution; absent or null when the sale is not attributed. */
  attribution?: CheckoutAttribution | null;
}

/** The `orders` columns that carry an attribution (migration 02030). */
export interface OrderAttributionColumns {
  affiliate_id: string;
  affiliate_source: CheckoutAttributionSource;
  affiliate_base_currency: string | null;
  /**
   * The payment mode of the checkout that creates the order: false for a Stripe test key or the
   * Freemius sandbox, true for live money, null when unknown (recorded as live). The commission
   * inherits it, and only a payout of the same mode ever pays it.
   */
  affiliate_livemode: boolean | null;
}

const ATTRIBUTION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTRIBUTION_CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ATTRIBUTION_SOURCES: ReadonlySet<string> = new Set<CheckoutAttributionSource>(['storefront', 'referral_link']);

/**
 * The order columns for an attribution, or null when there is none or it is malformed. The
 * values are checked against the database CHECKs so a bad value can never fail the insert.
 * `livemode` is the payment mode of the checkout (Stripe: the key's prefix; Freemius: the
 * sandbox flag); anything but a boolean is stored as null.
 */
export function buildOrderAttributionColumns(
  attribution?: CheckoutAttribution | null,
  livemode?: boolean | null
): OrderAttributionColumns | null {
  if (!attribution || typeof attribution !== 'object') {
    return null;
  }

  const affiliateId =
    typeof attribution.affiliateId === 'string' ? attribution.affiliateId.trim().toLowerCase() : '';

  if (!ATTRIBUTION_UUID_PATTERN.test(affiliateId) || !ATTRIBUTION_SOURCES.has(attribution.source)) {
    return null;
  }

  const baseCurrency =
    typeof attribution.baseCurrency === 'string' ? attribution.baseCurrency.trim().toUpperCase() : '';

  return {
    affiliate_id: affiliateId,
    affiliate_source: attribution.source,
    affiliate_base_currency: ATTRIBUTION_CURRENCY_PATTERN.test(baseCurrency) ? baseCurrency : null,
    affiliate_livemode: typeof livemode === 'boolean' ? livemode : null,
  };
}

function readDatabaseErrorField(error: unknown, field: 'code' | 'message' | 'details' | 'hint') {
  if (!error || typeof error !== 'object') {
    return '';
  }

  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

/**
 * The database has no attribution columns: PostgREST's schema cache does not know them
 * (`PGRST204`) or Postgres does not (`42703`). The case of an install whose migrations stop
 * before 02030.
 */
export function isMissingOrderAttributionColumnError(error: unknown): boolean {
  const code = readDatabaseErrorField(error, 'code');
  return code === 'PGRST204' || code === '42703';
}

/**
 * An insert error that dropping the attribution columns can cure: the columns are missing, or
 * the database refused their values (the partner row vanished between attribution and the
 * insert, a CHECK on an attribution column).
 */
export function isOrderAttributionInsertError(error: unknown): boolean {
  if (isMissingOrderAttributionColumnError(error)) {
    return true;
  }

  const code = readDatabaseErrorField(error, 'code');

  if (code !== '23503' && code !== '23514') {
    return false;
  }

  const text = (['message', 'details', 'hint'] as const)
    .map((field) => readDatabaseErrorField(error, field))
    .join(' ');

  return /affiliate/i.test(text);
}

let missingOrderAttributionColumnsLogged = false;

/**
 * Insert a pending order with its attribution columns. When the database refuses them, the
 * order is inserted again without them: attribution must never cost the store a sale. A missing
 * column is logged once per process; other refusals each time. `attributed` is the attribution
 * the stored row carries (null when it carries none). `livemode` (the checkout's payment mode)
 * is written with the attribution only.
 */
export async function insertPendingOrderWithAttribution<R extends { error: unknown }>(input: {
  row: Record<string, unknown>;
  attribution?: CheckoutAttribution | null;
  livemode?: boolean | null;
  insert: (row: Record<string, unknown>) => PromiseLike<R>;
  provider: string;
}): Promise<{ result: R; attributed: OrderAttributionColumns | null }> {
  const columns = buildOrderAttributionColumns(input.attribution, input.livemode);

  if (!columns) {
    return { result: await input.insert(input.row), attributed: null };
  }

  const attributedResult = await input.insert({ ...input.row, ...columns });

  if (!attributedResult.error || !isOrderAttributionInsertError(attributedResult.error)) {
    return { result: attributedResult, attributed: attributedResult.error ? null : columns };
  }

  if (isMissingOrderAttributionColumnError(attributedResult.error)) {
    if (!missingOrderAttributionColumnsLogged) {
      missingOrderAttributionColumnsLogged = true;
      console.warn(
        `[${input.provider} checkout] The orders table has no affiliate attribution columns (migration 02030 not applied); orders are saved without attribution.`
      );
    }
  } else {
    console.warn(
      `[${input.provider} checkout] The database refused the affiliate attribution (${readDatabaseErrorField(attributedResult.error, 'code')}); the order is saved without it.`
    );
  }

  return { result: await input.insert(input.row), attributed: null };
}

export interface CheckoutCustomerDefaults {
  isAuthenticated: boolean;
  email?: string | null;
  fullName?: string | null;
  phone?: string | null;
  billingAddress?: CustomerAddressInput | null;
  shippingAddress?: CustomerAddressInput | null;
}

export const emptyCustomerAddress = (): CustomerAddressInput => ({
  company_name: '',
  recipient_name: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  postal_code: '',
  country_code: 'CA',
});

function cleanString(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function normalizeCustomerAddress(
  address?: CustomerAddressInput | null
): CustomerAddressInput | null {
  if (!address) {
    return null;
  }

  const normalized: CustomerAddressInput = {
    company_name: cleanString(address.company_name),
    recipient_name: cleanString(address.recipient_name),
    line1: cleanString(address.line1),
    line2: cleanString(address.line2),
    city: cleanString(address.city),
    postal_code: cleanString(address.postal_code),
    country_code: normalizeCountryCode(address.country_code),
  };
  normalized.state = normalizeSubdivisionCode(
    normalized.country_code,
    cleanString(address.state)
  );

  const hasAnyValue = Object.values(normalized).some(Boolean);

  return hasAnyValue ? normalized : null;
}

export function isCustomerAddressComplete(address?: CustomerAddressInput | null) {
  const normalized = normalizeCustomerAddress(address);

  if (!normalized) {
    return false;
  }

  return Boolean(
    normalized.recipient_name &&
      normalized.line1 &&
      normalized.city &&
      normalized.postal_code &&
      normalized.country_code &&
      (!countryUsesStructuredStates(normalized.country_code) || normalized.state)
  );
}

export function normalizeOrderCustomerDetails(input: {
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  billing?: CustomerAddressInput | null;
  shipping?: CustomerAddressInput | null;
}): OrderCustomerDetails {
  const billing = normalizeCustomerAddress(input.billing);
  const shipping = normalizeCustomerAddress(input.shipping);
  const email = cleanString(input.email)?.toLowerCase() ?? null;
  const phone = cleanString(input.phone);
  const name =
    cleanString(input.name) ??
    billing?.recipient_name ??
    shipping?.recipient_name ??
    null;

  return {
    email,
    name,
    phone,
    billing,
    shipping,
  };
}

export function addressesMatch(
  first?: CustomerAddressInput | null,
  second?: CustomerAddressInput | null
) {
  const normalizedFirst = normalizeCustomerAddress(first);
  const normalizedSecond = normalizeCustomerAddress(second);

  return JSON.stringify(normalizedFirst) === JSON.stringify(normalizedSecond);
}
