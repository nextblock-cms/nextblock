import { cache } from 'react';

import { createClient } from '@nextblock-cms/db/server';

import {
  DEFAULT_ENABLED_PAYMENT_PROVIDERS,
  derivePaymentProviderFromProductType,
  type EcommercePaymentProvider,
  type EnabledPaymentProviders,
  normalizeEnabledPaymentProviders,
  type ProductType,
} from '../../../types';
import { getPaymentConfigStatus } from '../../../payment-config';

export interface PaymentProviderConfigStatus {
  hasKeys: boolean;
  missing: string[];
}

export interface StorePaymentConfigStatus {
  stripe: PaymentProviderConfigStatus;
  freemius: PaymentProviderConfigStatus;
}

// "Configured" now reads DB-first (CMS) with an env fallback, so providers can be enabled
// once keys are entered in the CMS — without requiring environment variables. Freemius also
// weighs what memory knows of the developer key pair, never waiting on Freemius (payment-config.ts):
// a configured pair counts until Freemius refuses it, and one-product keys that can open no
// checkout (Freemius refuses a dedicated pair, no Product ID, no FREEMIUS_CHECKOUT_PRODUCTS_JSON
// entry with a publicKey: the key policy lets them stand in for no product) do not.
export async function getStoreConfigStatus(): Promise<StorePaymentConfigStatus> {
  return getPaymentConfigStatus();
}

export async function getEnabledPaymentProviders(): Promise<EnabledPaymentProviders> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', 'enabled_payment_providers')
    .maybeSingle();

  if (error || !data) {
    return { ...DEFAULT_ENABLED_PAYMENT_PROVIDERS };
  }

  return normalizeEnabledPaymentProviders(data.value);
}

export async function getPaymentSettings(): Promise<'stripe' | 'freemius'> {
  const enabledProviders = await getEnabledPaymentProviders();

  if (enabledProviders.stripe) {
    return 'stripe';
  }

  if (enabledProviders.freemius) {
    return 'freemius';
  }

  return 'stripe';
}

// --- Provider readiness --------------------------------------------------------
// One predicate, four consumers: the CMS publish warning, the CMS payments banner,
// the storefront buy-CTA swap, and the /api/checkout preflight. They MUST agree —
// a storefront that offers "Add to cart" while checkout refuses the same product is
// how a shopper ends up staring at a raw Stripe "Invalid API Key" error.
//
// Readiness is per-provider on purpose. `products_type_provider_consistency_check`
// welds physical->stripe and digital->freemius in the database, so a store with only
// Stripe configured keeps selling physical goods normally while digital ones fall
// back to the enquiry form.

export interface ProviderReadiness {
  provider: EcommercePaymentProvider;
  /** Human label for UI copy. */
  label: string;
  /** The admin flipped this provider on in CMS -> Payments. */
  enabled: boolean;
  /** Every credential the provider needs resolves (DB-first, env fallback). */
  hasKeys: boolean;
  /** The only field callers should branch on. */
  ready: boolean;
  /** Human labels of what is missing ('Secret key', ...). Never key material. */
  missing: string[];
}

export interface StoreReadiness {
  stripe: ProviderReadiness;
  freemius: ProviderReadiness;
}

const PROVIDER_LABELS: Record<EcommercePaymentProvider, string> = {
  stripe: 'Stripe',
  freemius: 'Freemius',
};

function buildReadiness(
  provider: EcommercePaymentProvider,
  enabledProviders: EnabledPaymentProviders,
  configStatus: StorePaymentConfigStatus
): ProviderReadiness {
  const enabled = enabledProviders[provider];
  const { hasKeys, missing } = configStatus[provider];
  return {
    provider,
    label: PROVIDER_LABELS[provider],
    enabled,
    hasKeys,
    ready: enabled && hasKeys,
    // A provider with keys that was simply never switched on needs different copy
    // from one with no credentials at all, so surface that as its own "missing" item.
    missing: hasKeys && !enabled ? ['Not enabled in CMS → Payments'] : missing,
  };
}

/**
 * Readiness for both providers.
 *
 * Wrapped in React `cache()` so the several consumers that can appear on one page — the
 * product-details renderer, the buy-CTA boundary, the JSON-LD builder — share a single
 * lookup per request. `getStoreConfigStatus()` is additionally memoised for 60s across
 * requests inside payment-config.ts; the per-request cache is what dedupes the
 * enabled-providers read, which uses the cookie-scoped client and is not.
 */
export const getStoreReadiness = cache(async (): Promise<StoreReadiness> => {
  const [enabledProviders, configStatus] = await Promise.all([
    getEnabledPaymentProviders(),
    getStoreConfigStatus(),
  ]);

  return {
    stripe: buildReadiness('stripe', enabledProviders, configStatus),
    freemius: buildReadiness('freemius', enabledProviders, configStatus),
  };
});

/** Readiness for the one provider a given product/checkout depends on. */
export async function getProviderReadiness(
  provider: EcommercePaymentProvider
): Promise<ProviderReadiness> {
  const readiness = await getStoreReadiness();
  return readiness[provider];
}

/** Readiness derived from a product row's `product_type`. */
export async function getReadinessForProductType(
  productType: ProductType
): Promise<ProviderReadiness> {
  return getProviderReadiness(derivePaymentProviderFromProductType(productType));
}
