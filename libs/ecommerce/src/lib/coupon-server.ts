import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  COUPON_INVALID_ERROR_KEY,
  COUPON_INVALID_ERROR_MESSAGE,
  type CouponDiscountType,
  type CouponProviderScope,
  type CouponQuote,
  type CouponQuoteResult,
  emptyProviderDiscounts,
  getCartLineCouponKey,
  normalizeCouponCode,
} from './coupons';
import type { CartItem, EcommercePaymentProvider } from './types';
import {
  type CurrencyRecord,
  getDefaultCurrency,
  normalizeCurrencyRecord,
  normalizePriceMap,
  normalizeSalePriceMap,
  resolveEffectivePriceForCurrency,
} from './currency';

type SupabaseLikeClient = SupabaseClient<any>;

type CouponRow = {
  id: string;
  code: string;
  name: string;
  provider_scope: CouponProviderScope;
  discount_type: CouponDiscountType;
  discount_amount: number;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  redemption_limit: number | null;
  redemptions_count: number | null;
};

type TrustedCartLine = {
  key: string;
  product_id: string;
  variant_id?: string | null;
  title: string;
  quantity: number;
  provider: EcommercePaymentProvider;
  subtotal: number;
  freemius_product_id?: string | null;
  freemius_plan_id?: string | null;
};

type TrustedScheduleColumns = {
  sale_start_at?: string | null;
  sale_end_at?: string | null;
  scheduled_price?: number | null;
  scheduled_prices?: Record<string, unknown> | null;
  scheduled_price_at?: string | null;
};

type TrustedProductRow = {
  id: string;
  title: string;
  price: number | null;
  prices?: Record<string, unknown> | null;
  sale_price?: number | null;
  sale_prices?: Record<string, unknown> | null;
  product_type?: string | null;
  payment_provider?: string | null;
  freemius_product_id?: string | null;
  freemius_plan_id?: string | null;
} & TrustedScheduleColumns;

type TrustedVariantRow = {
  id: string;
  product_id: string;
  price: number | null;
  prices?: Record<string, unknown> | null;
  sale_price?: number | null;
  sale_prices?: Record<string, unknown> | null;
} & TrustedScheduleColumns;

function toDate(value?: string | null) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isProviderEligible(scope: CouponProviderScope, provider: EcommercePaymentProvider) {
  return scope === 'all' || scope === provider;
}

function toProvider(value: unknown): EcommercePaymentProvider | null {
  return value === 'stripe' || value === 'freemius' ? value : null;
}

async function getActiveCurrencies(client: SupabaseLikeClient): Promise<CurrencyRecord[]> {
  const { data, error } = await (client as any)
    .from('currencies')
    .select(
      'code, symbol, exchange_rate, is_default, is_active, auto_sync_product_prices, auto_update_exchange_rate, exchange_rate_source, exchange_rate_updated_at, rounding_mode, rounding_increment, rounding_charm_amount'
    )
    .eq('is_active', true)
    .order('code', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map((currency: any) => normalizeCurrencyRecord(currency));
}

async function buildTrustedCartLines(input: {
  client: SupabaseLikeClient;
  items: CartItem[];
  currencyCode?: string | null;
}) {
  const { client, items } = input;
  const currencies = await getActiveCurrencies(client);

  if (currencies.length === 0) {
    throw new Error('No active currencies are configured.');
  }

  const selectedCurrency =
    currencies.find((currency) => currency.code === (input.currencyCode || '').toUpperCase()) ??
    getDefaultCurrency(currencies);
  const productIds = [...new Set(items.map((item) => item.product_id).filter(Boolean))];
  const variantIds = [
    ...new Set(
      items
        .map((item) => item.variant_id)
        .filter((variantId): variantId is string => Boolean(variantId))
    ),
  ];

  if (productIds.length === 0) {
    return {
      lines: [] as TrustedCartLine[],
      currencies,
      selectedCurrency,
    };
  }

  const [{ data: products, error: productsError }, variantsResponse] = await Promise.all([
    (client as any)
      .from('products')
      .select(
        'id, title, price, prices, sale_price, sale_prices, sale_start_at, sale_end_at, scheduled_price, scheduled_prices, scheduled_price_at, product_type, payment_provider, freemius_product_id, freemius_plan_id'
      )
      .in('id', productIds),
    variantIds.length
      ? (client as any)
          .from('product_variants')
          .select('id, product_id, price, prices, sale_price, sale_prices, sale_start_at, sale_end_at, scheduled_price, scheduled_prices, scheduled_price_at')
          .in('id', variantIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (productsError) {
    throw new Error(productsError.message);
  }

  if (variantsResponse.error) {
    throw new Error(variantsResponse.error.message);
  }

  const productRows = (products || []) as TrustedProductRow[];
  const variantRows = (variantsResponse.data || []) as TrustedVariantRow[];
  const productMap = new Map<string, TrustedProductRow>(
    productRows.map((product) => [product.id, product])
  );
  const variantMap = new Map<string, TrustedVariantRow>(
    variantRows.map((variant) => [variant.id, variant])
  );
  const lines: TrustedCartLine[] = [];

  for (const item of items) {
    const product = productMap.get(item.product_id);

    if (!product) {
      continue;
    }

    const provider =
      toProvider(product.payment_provider) ??
      (product.product_type === 'digital' ? 'freemius' : 'stripe');
    const variant = item.variant_id ? variantMap.get(item.variant_id) : null;
    const priceSource = variant && variant.product_id === product.id ? variant : product;
    const resolvedPrice = resolveEffectivePriceForCurrency({
      prices: normalizePriceMap(priceSource.prices),
      salePrices: normalizeSalePriceMap(priceSource.sale_prices),
      fallbackPrice: priceSource.price,
      fallbackSalePrice: priceSource.sale_price,
      saleStartAt: priceSource.sale_start_at,
      saleEndAt: priceSource.sale_end_at,
      scheduledPrice: priceSource.scheduled_price,
      scheduledPrices: normalizePriceMap(priceSource.scheduled_prices),
      scheduledPriceAt: priceSource.scheduled_price_at,
      currencyCode: selectedCurrency.code,
      currencies,
    });
    const quantity = provider === 'freemius' ? 1 : Math.max(1, Number(item.quantity) || 1);
    const unitAmount = Math.max(0, resolvedPrice.sale_price ?? resolvedPrice.price);

    lines.push({
      key: getCartLineCouponKey(item),
      product_id: product.id,
      variant_id: variant?.id ?? null,
      title: product.title,
      quantity,
      provider,
      subtotal: unitAmount * quantity,
      freemius_product_id: product.freemius_product_id ?? null,
      freemius_plan_id: product.freemius_plan_id ?? null,
    });
  }

  return {
    lines,
    currencies,
    selectedCurrency,
  };
}

async function getCouponProductScope(client: SupabaseLikeClient, couponId: string) {
  const { data, error } = await (client as any)
    .from('coupon_products')
    .select('product_id')
    .eq('coupon_id', couponId);

  if (error) {
    throw new Error(error.message);
  }

  return new Set((data || []).map((row: { product_id: string }) => row.product_id));
}

function allocateFixedDiscount(lines: TrustedCartLine[], amount: number) {
  const eligibleSubtotal = lines.reduce((sum, line) => sum + line.subtotal, 0);
  const cappedAmount = Math.min(amount, eligibleSubtotal);

  if (eligibleSubtotal <= 0 || cappedAmount <= 0) {
    return new Map<string, number>();
  }

  const allocations = new Map<string, number>();
  let allocated = 0;

  lines.forEach((line, index) => {
    const isLast = index === lines.length - 1;
    const discount = isLast
      ? cappedAmount - allocated
      : Math.min(
          line.subtotal,
          Math.floor((cappedAmount * line.subtotal) / eligibleSubtotal)
        );
    allocated += discount;
    allocations.set(line.key, discount);
  });

  return allocations;
}

/**
 * Why a found-but-unusable coupon answers exactly like a missing one.
 *
 * `getCouponQuoteAction` is a public server action (any visitor, no session), so every
 * distinguishable reply is an oracle. The old per-state keys (`coupon_not_found` vs
 * `coupon_inactive` / `coupon_expired` / `coupon_limit_reached` / `coupon_not_applicable`)
 * let a dictionary run confirm which codes EXIST, including unlaunched, staff and
 * product-scoped promotions. The shopper gets one message for all of them; the detailed
 * reason is opt-in (`detailedErrors`) for an authenticated CMS surface only — never pass it
 * from a public caller.
 */
type CouponRejectionReason =
  | 'not_found'
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'limit_reached'
  | 'not_applicable';

const DETAILED_COUPON_REJECTIONS: Record<
  CouponRejectionReason,
  { error: string; errorKey: string }
> = {
  not_found: { error: 'Coupon code not found.', errorKey: 'ecommerce.coupon_not_found' },
  inactive: { error: 'This coupon is not active.', errorKey: 'ecommerce.coupon_inactive' },
  not_started: {
    error: 'This coupon is not active yet.',
    errorKey: 'ecommerce.coupon_not_started',
  },
  expired: { error: 'This coupon has expired.', errorKey: 'ecommerce.coupon_expired' },
  limit_reached: {
    error: 'This coupon has reached its redemption limit.',
    errorKey: 'ecommerce.coupon_limit_reached',
  },
  not_applicable: {
    error: 'This coupon does not apply to the items in your cart.',
    errorKey: 'ecommerce.coupon_not_applicable',
  },
};

function rejectCoupon(reason: CouponRejectionReason, detailed: boolean): CouponQuoteResult {
  const detail = detailed
    ? DETAILED_COUPON_REJECTIONS[reason]
    : { error: COUPON_INVALID_ERROR_MESSAGE, errorKey: COUPON_INVALID_ERROR_KEY };

  return { success: false, ...detail };
}

export async function getCouponQuote(input: {
  client: SupabaseLikeClient;
  code?: string | null;
  items: CartItem[];
  currencyCode?: string | null;
  /**
   * Return the specific rejection reason instead of the uniform shopper message. Only for
   * authenticated CMS tooling: on a public path it re-opens the code-enumeration oracle.
   */
  detailedErrors?: boolean;
}): Promise<CouponQuoteResult> {
  const code = normalizeCouponCode(input.code);
  const detailed = input.detailedErrors === true;

  if (!code) {
    return {
      success: false,
      error: 'Enter a coupon code.',
      errorKey: 'ecommerce.coupon_code_required',
    };
  }

  if (!input.items.length) {
    return {
      success: false,
      error: 'Add an item to your cart before applying a coupon.',
      errorKey: 'ecommerce.coupon_cart_empty',
    };
  }

  const { data: coupon, error: couponError } = await (input.client as any)
    .from('coupons')
    .select(
      'id, code, name, provider_scope, discount_type, discount_amount, is_active, starts_at, ends_at, redemption_limit, redemptions_count'
    )
    .ilike('code', code)
    .maybeSingle();

  if (couponError) {
    throw new Error(couponError.message);
  }

  if (!coupon) {
    return rejectCoupon('not_found', detailed);
  }

  const couponRow = coupon as CouponRow;
  const now = new Date();
  const startsAt = toDate(couponRow.starts_at);
  const endsAt = toDate(couponRow.ends_at);

  if (!couponRow.is_active) {
    return rejectCoupon('inactive', detailed);
  }

  if (startsAt && startsAt > now) {
    return rejectCoupon('not_started', detailed);
  }

  if (endsAt && endsAt <= now) {
    return rejectCoupon('expired', detailed);
  }

  // A UX pre-check only: this counter can lag under concurrency. The cap itself is enforced
  // by `redeem_coupon_atomically` when the redemption is recorded (see recordCouponRedemption).
  if (
    couponRow.redemption_limit !== null &&
    (couponRow.redemptions_count ?? 0) >= couponRow.redemption_limit
  ) {
    return rejectCoupon('limit_reached', detailed);
  }

  const [{ lines }, productScope] = await Promise.all([
    buildTrustedCartLines({
      client: input.client,
      items: input.items,
      currencyCode: input.currencyCode,
    }),
    getCouponProductScope(input.client, couponRow.id),
  ]);
  const hasProductScope = productScope.size > 0;
  const eligibleLines = lines.filter(
    (line) =>
      line.subtotal > 0 &&
      isProviderEligible(couponRow.provider_scope, line.provider) &&
      (!hasProductScope || productScope.has(line.product_id))
  );

  if (eligibleLines.length === 0) {
    return rejectCoupon('not_applicable', detailed);
  }

  const fixedAllocations =
    couponRow.discount_type === 'fixed'
      ? allocateFixedDiscount(eligibleLines, couponRow.discount_amount)
      : null;
  const providerDiscounts = emptyProviderDiscounts();
  const lineDiscounts = eligibleLines.map((line) => {
    const discount =
      couponRow.discount_type === 'percent'
        ? Math.min(line.subtotal, Math.round((line.subtotal * couponRow.discount_amount) / 100))
        : fixedAllocations?.get(line.key) ?? 0;

    providerDiscounts[line.provider] += discount;

    return {
      key: line.key,
      product_id: line.product_id,
      variant_id: line.variant_id,
      provider: line.provider,
      title: line.title,
      quantity: line.quantity,
      subtotal: line.subtotal,
      discount,
    };
  });
  const quote: CouponQuote = {
    couponId: couponRow.id,
    code: couponRow.code,
    name: couponRow.name,
    discountType: couponRow.discount_type,
    discountAmount: couponRow.discount_amount,
    providerScope: couponRow.provider_scope,
    eligibleSubtotal: eligibleLines.reduce((sum, line) => sum + line.subtotal, 0),
    discountTotal: providerDiscounts.stripe + providerDiscounts.freemius,
    providerDiscounts,
    lineDiscounts,
  };

  return {
    success: true,
    quote,
  };
}

export function getQuoteLineDiscountMap(quote?: CouponQuote | null) {
  const discounts = new Map<string, number>();

  for (const line of quote?.lineDiscounts ?? []) {
    discounts.set(line.key, line.discount);
  }

  return discounts;
}

export type CouponRedemptionResult =
  | {
      success: true;
      /** True when this order already held a redemption, so no new slot was taken. */
      alreadyRecorded: boolean;
    }
  | {
      success: false;
      /**
       * `limit_reached`: `redeem_coupon_atomically` refused the slot (exhausted, or the coupon
       * was deactivated/deleted since the quote). `error`: a database failure; nothing was
       * recorded. Both carry the uniform shopper message, so a checkout that surfaces them
       * tells a probing caller nothing a validation call would not.
       */
      reason: 'limit_reached' | 'error';
      error: string;
      errorKey: string;
    };

/**
 * Take one redemption slot for `quote.couponId` and record it against `orderId`.
 *
 * The counter is bumped by `public.redeem_coupon_atomically(uuid)` (migration 02022): a single
 * locked `UPDATE ... WHERE redemptions_count < redemption_limit RETURNING`, so N concurrent
 * checkouts of a `redemption_limit = N` coupon get exactly N `true`s and every later call gets
 * `false`. The previous SELECT-then-UPDATE with an app-computed literal lost increments under
 * concurrency and let the cap be bypassed. The RPC is EXECUTE-granted to `service_role` only,
 * so `client` must be the service-role client (the providers already use it here).
 *
 * The slot is reserved BEFORE the audit row is inserted: if the insert then fails, the slot
 * is lost rather than the cap exceeded, which is the conservative failure for a promotion.
 * The call is idempotent per order so a retry (a redelivered webhook, once redemption moves
 * to payment confirmation) cannot consume a second slot. Validation (`getCouponQuote`) never
 * touches the counter.
 */
export async function recordCouponRedemption(input: {
  client: SupabaseLikeClient;
  quote: CouponQuote;
  orderId: string;
  provider: EcommercePaymentProvider;
  discountTotal: number;
  userId?: string | null;
  customerEmail?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<CouponRedemptionResult> {
  const failure = (reason: 'limit_reached' | 'error'): CouponRedemptionResult => ({
    success: false,
    reason,
    error: COUPON_INVALID_ERROR_MESSAGE,
    errorKey: COUPON_INVALID_ERROR_KEY,
  });

  const { data: existing, error: existingError } = await (input.client as any)
    .from('coupon_redemptions')
    .select('id')
    .eq('order_id', input.orderId)
    .maybeSingle();

  if (existingError) {
    console.error('Failed to look up existing coupon redemption:', existingError);
    return failure('error');
  }

  if (existing) {
    return { success: true, alreadyRecorded: true };
  }

  const { data: redeemed, error: redeemError } = await (input.client as any).rpc(
    'redeem_coupon_atomically',
    { p_coupon_id: input.quote.couponId }
  );

  if (redeemError) {
    console.error('Failed to reserve coupon redemption:', redeemError);
    return failure('error');
  }

  if (redeemed !== true) {
    return failure('limit_reached');
  }

  const { error: redemptionError } = await (input.client as any)
    .from('coupon_redemptions')
    .insert({
      coupon_id: input.quote.couponId,
      order_id: input.orderId,
      coupon_code: input.quote.code,
      provider: input.provider,
      discount_total: Math.max(0, input.discountTotal),
      user_id: input.userId || null,
      customer_email: input.customerEmail || null,
      metadata: input.metadata || {},
    });

  if (redemptionError) {
    // The slot is already counted; the missing audit row is the lesser harm.
    console.error('Failed to record coupon redemption:', redemptionError);
  }

  return { success: true, alreadyRecorded: false };
}

/* ------------------------------------------------------------------------------------------
 * Coupon-validation throttle
 *
 * A best-effort token bucket for the public validation action. It lives in process memory:
 * on serverless hosts every warm instance has its own buckets and a cold start forgets them,
 * so this slows a single-origin dictionary run (and, with the uniform rejection above, makes
 * it unreliable) rather than guaranteeing a ceiling. Nothing here is persisted or logged, so
 * the key is the raw client address, not a masked one: masking to a /24 would make 256 hosts
 * share one bucket, and a tripped bucket clears the shopper's applied coupon in CouponForm.
 * ---------------------------------------------------------------------------------------- */

/** Burst allowance per client. CouponForm re-validates on every cart change, so be generous. */
const COUPON_VALIDATION_BUCKET_CAPACITY = 30;
/** Sustained rate per client: one validation every 5 s. */
const COUPON_VALIDATION_REFILL_PER_SECOND = 12 / 60;
/** Memory bound; beyond it the idlest buckets are evicted (they would be full anyway). */
const COUPON_VALIDATION_MAX_BUCKETS = 5000;

/**
 * Shared bucket for requests whose origin cannot be read. Unattributable requests are
 * throttled TOGETHER, never exempted: "could not parse the address" must not mean "no limit".
 */
export const COUPON_VALIDATION_UNKNOWN_CLIENT_KEY = 'unknown';

type TokenBucket = { tokens: number; updatedAt: number };

export function createCouponValidationThrottle(options?: {
  capacity?: number;
  refillPerSecond?: number;
  maxBuckets?: number;
}) {
  const capacity = options?.capacity ?? COUPON_VALIDATION_BUCKET_CAPACITY;
  const refillPerSecond = options?.refillPerSecond ?? COUPON_VALIDATION_REFILL_PER_SECOND;
  const maxBuckets = options?.maxBuckets ?? COUPON_VALIDATION_MAX_BUCKETS;
  const fullAfterMs = (capacity / refillPerSecond) * 1000;
  const buckets = new Map<string, TokenBucket>();

  function evict(now: number) {
    for (const [key, bucket] of buckets) {
      if (now - bucket.updatedAt >= fullAfterMs) {
        buckets.delete(key);
      }
    }

    // Still over: drop the oldest entries (Map iterates in insertion order).
    for (const key of buckets.keys()) {
      if (buckets.size < maxBuckets) {
        break;
      }
      buckets.delete(key);
    }
  }

  return {
    /** Spend one token for `key`; false means the caller is over its budget right now. */
    consume(key: string, now: number = Date.now()): boolean {
      let bucket = buckets.get(key);

      if (!bucket) {
        if (buckets.size >= maxBuckets) {
          evict(now);
        }
        bucket = { tokens: capacity, updatedAt: now };
        buckets.set(key, bucket);
      } else {
        const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
        bucket.updatedAt = now;
      }

      if (bucket.tokens < 1) {
        return false;
      }

      bucket.tokens -= 1;
      return true;
    },
    get size() {
      return buckets.size;
    },
  };
}

const couponValidationThrottle = createCouponValidationThrottle();

/** Spend one validation token for `key` on the process-wide bucket set. */
export function consumeCouponValidationToken(key: string, now?: number): boolean {
  return couponValidationThrottle.consume(key, now);
}

function firstHop(headerValue: string | null): string | null {
  const [first] = (headerValue ?? '').split(',');
  const trimmed = first?.trim() ?? '';
  return trimmed || null;
}

/**
 * Throttle key for a request: the client address as the platform reports it.
 *
 * `x-forwarded-for` is a list the client can prepend to, so on an appending proxy its leftmost
 * entry is attacker-controlled and would mint a fresh bucket per request. `x-vercel-forwarded-for`
 * and `x-real-ip` are overwritten by the proxy on every request, so they win. No address at all
 * lands in the shared unknown bucket.
 */
export function resolveCouponValidationThrottleKey(requestHeaders: {
  get(name: string): string | null;
}): string {
  return (
    firstHop(requestHeaders.get('x-vercel-forwarded-for')) ??
    firstHop(requestHeaders.get('x-real-ip')) ??
    firstHop(requestHeaders.get('x-forwarded-for')) ??
    COUPON_VALIDATION_UNKNOWN_CLIENT_KEY
  );
}
