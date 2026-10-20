'use server';

import { headers } from 'next/headers';

import { createClient, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

import type { CartItem, TaxCalculationResult } from '../types';
import {
  buildCheckoutTaxableItemsFromCart,
  calculateCheckoutTaxes,
  type TaxDestinationInput,
} from '../tax-calculation';
import {
  consumeCouponValidationToken,
  getCouponQuote,
  getQuoteLineDiscountMap,
  resolveCouponValidationThrottleKey,
} from '../coupon-server';

export async function getTaxEstimate(
  cartItems: CartItem[],
  destination?: TaxDestinationInput | null,
  currencyCode = 'USD',
  couponCode?: string | null,
  couponContextItems?: CartItem[]
): Promise<{ success: boolean; tax?: TaxCalculationResult; error?: string }> {
  try {
    const supabase = createClient();
    const serviceSupabase = getServiceRoleSupabaseClient();
    const { data: currenciesResult } = await supabase
      .from('currencies')
      .select(
        'code, symbol, exchange_rate, is_default, is_active, auto_sync_product_prices, auto_update_exchange_rate, exchange_rate_source, exchange_rate_updated_at, rounding_mode, rounding_increment, rounding_charm_amount'
      )
      .eq('is_active', true)
      .order('code', { ascending: true });
    const currencies = currenciesResult ?? [];
    let lineDiscounts: Map<string, number> | undefined;

    if (couponCode) {
      // getTaxEstimate is a public server action (a POST dispatched by id, no session), and the
      // tax it returns reflects any coupon discount — so it is a second coupon-existence oracle
      // beside getCouponQuoteAction. Spend a token on the SAME per-client bucket set before the
      // coupon is quoted: that bucket is shared with the coupon action (see coupon-server.ts), so
      // a caller cannot double its probe budget by alternating the two, and the limit is
      // best-effort (in-memory, per warm instance). Over budget, the coupon is simply not applied,
      // so a throttled valid code and an un-throttled invalid code both yield tax computed with no
      // discount — the shopper still gets a tax line, just without the coupon reflected.
      const throttleKey = resolveCouponValidationThrottleKey(await headers());

      if (consumeCouponValidationToken(throttleKey)) {
        const quoteResult = await getCouponQuote({
          client: serviceSupabase as any,
          code: couponCode,
          items:
            couponContextItems && couponContextItems.length > 0 ? couponContextItems : cartItems,
          currencyCode,
        });

        if (quoteResult.success) {
          lineDiscounts = getQuoteLineDiscountMap(quoteResult.quote);
        }
      }
    }

    const items = await buildCheckoutTaxableItemsFromCart(
      supabase as any,
      cartItems,
      currencyCode,
      currencies,
      lineDiscounts
    );
    const tax = await calculateCheckoutTaxes(supabase as any, {
      items,
      destination,
    });

    return { success: true, tax };
  } catch (error: any) {
    console.error('Failed to estimate taxes:', error);
    return {
      success: false,
      error: error.message || 'Failed to calculate taxes',
    };
  }
}
