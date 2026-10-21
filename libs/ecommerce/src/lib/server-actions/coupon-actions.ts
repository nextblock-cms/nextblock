'use server';

import 'server-only';

import { headers } from 'next/headers';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

import type { CartItem } from '../types';
import {
  consumeCouponValidationToken,
  getCouponQuote,
  resolveCouponValidationThrottleKey,
} from '../coupon-server';
import { COUPON_THROTTLED_ERROR_KEY, COUPON_THROTTLED_ERROR_MESSAGE } from '../coupons';

/**
 * Public coupon validation for the cart and checkout forms.
 *
 * Reachable by anyone (a server action is a POST endpoint dispatched by id, no session
 * needed) and it reads with the service-role client, so it is the only way a visitor can ask
 * "does this code exist?". Two things keep that from being an enumeration oracle:
 * `getCouponQuote` answers every unusable code with the same message, and this action spends a
 * per-client token before it touches the database. The bucket is in-memory and best-effort
 * (see coupon-server.ts); the uniform reply is what makes a slow probe also an unreliable one.
 */
export async function getCouponQuoteAction(input: {
  code?: string | null;
  items: CartItem[];
  currencyCode?: string | null;
}) {
  try {
    const requestHeaders = await headers();

    if (!consumeCouponValidationToken(resolveCouponValidationThrottleKey(requestHeaders))) {
      return {
        success: false as const,
        error: COUPON_THROTTLED_ERROR_MESSAGE,
        errorKey: COUPON_THROTTLED_ERROR_KEY,
      };
    }

    const supabase = getServiceRoleSupabaseClient();
    return await getCouponQuote({
      client: supabase as any,
      code: input.code,
      items: Array.isArray(input.items) ? input.items : [],
      currencyCode: input.currencyCode,
    });
  } catch (error) {
    // Log the cause; never hand database error text to an anonymous caller.
    console.error('Failed to validate coupon:', error);
    return {
      success: false as const,
      error: "We couldn't validate this coupon. Try again.",
      errorKey: 'ecommerce.coupon_validation_failed',
    };
  }
}
