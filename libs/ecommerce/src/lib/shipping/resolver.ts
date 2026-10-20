import { getSsgSupabaseClient } from '@nextblock-cms/db/server';
import { getDefaultCurrency } from '../currency';
import {
    listEligibleShippingMethods,
    toResolvedShippingMethod,
    type ResolvedShippingMethod,
    type ShippingDestination,
    type ShippingQueryClient,
} from './checkout-shipping-method';

export type { ResolvedShippingMethod, ShippingDestination };

/**
 * Resolves available shipping methods based on destination and cart value.
 *
 * This is the storefront estimate. The zone match, threshold check and currency conversion
 * live in `./checkout-shipping-method` and are the same code the Stripe checkout runs when
 * it re-validates the submitted method id, so what the shopper is shown here is what they
 * are charged there.
 */
export async function resolveShippingOptions(
    cartTotal: number,
    destination: ShippingDestination,
    languageCode?: string | null,
    currencyCode?: string | null
): Promise<ResolvedShippingMethod[]> {
    const supabase = getSsgSupabaseClient() as unknown as ShippingQueryClient;
    const { data: currenciesResult } = await supabase
        .from('currencies')
        .select(
          'code, symbol, exchange_rate, is_default, is_active, auto_sync_product_prices, auto_update_exchange_rate, exchange_rate_source, exchange_rate_updated_at, rounding_mode, rounding_increment, rounding_charm_amount'
        )
      .eq('is_active', true)
      .order('code', { ascending: true });
    const currencies = currenciesResult ?? [];
    const defaultCurrency = getDefaultCurrency(currencies);
    const selectedCurrencyCode = currencyCode || defaultCurrency.code;

    // 1-4. Zone for the destination, then its methods whose minimum order amount is met.
    const eligible = await listEligibleShippingMethods(supabase, {
        destination,
        cartTotal,
        currencies,
        currencyCode: selectedCurrencyCode,
    });

    if (!eligible.ok) {
        return [];
    }

    // 5. Convert valid methods into the shopper currency, then pick the cheapest.
    const resolvedMethods = eligible.methods.map((method) =>
        toResolvedShippingMethod(
            method,
            { currencies, currencyCode: selectedCurrencyCode },
            languageCode
        )
    );
    const cheapestMethod = resolvedMethods.sort((left, right) => left.amount - right.amount)[0];

    if (!cheapestMethod) {
        return [];
    }

    return [cheapestMethod];
}
