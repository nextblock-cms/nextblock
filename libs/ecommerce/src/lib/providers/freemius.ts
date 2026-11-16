import 'server-only';

import { PaymentProvider } from '../types';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { Freemius } from '@freemius/sdk';
import { hydrateFreemiusEnvFromDb } from '../payment-config';
import {
  CheckoutSessionInput,
  insertPendingOrderWithAttribution,
  normalizeOrderCustomerDetails,
} from '../customer';
import { getCouponQuote, recordCouponRedemption } from '../coupon-server';
import { mintOrderAccessToken } from '../order-access-token';
import { reconcileCouponContextItems, type CouponQuote } from '../coupons';
import {
  fillMissingUserProfileCheckoutDetails,
  upsertDefaultUserAddresses,
} from '../customer-addresses';
import {
  getDefaultCurrency,
  isSaleWindowActive,
} from '../currency';
import {
  FREEMIUS_PRICED_PRODUCT_COLUMNS,
  resolveFreemiusUnitAmount,
  type FreemiusUnitAmountResolution,
} from '../freemius-pricing-server';
import { createInvalidCheckoutItemsError, normalizeCheckoutItems } from './checkout-items';
import {
  forgetFreemiusDeveloperCaches,
  getFreemiusProductKeys,
  isFreemiusApiError,
  openFreemiusCatalogReader,
  toFreemiusId,
} from '../freemius-developer-api';
import {
  createFreemiusLogThrottle,
  decideFreemiusOneProductStandIn,
  freemiusKeysMayBeDeveloperPair,
  parseFreemiusCheckoutCredentialsMap,
  readFreemiusEnvValue,
  readFreemiusOneProductKeys,
  type FreemiusOneProductStandInRefusal,
} from '../freemius-key-policy';

// The env readers live with the key policy (freemius-key-policy.ts), which must not import this
// module; they stay exported from here for the modules and installs that import them from here.
export {
  parseFreemiusCheckoutCredentialsMap,
  readFreemiusEnvValue,
  type FreemiusCheckoutCredentialEntry,
} from '../freemius-key-policy';

function splitFreemiusCustomerName(name?: string | null) {
    const trimmed = name?.trim();

    if (!trimmed) {
        return {
            firstName: null,
            lastName: null,
        };
    }

    const [firstName, ...rest] = trimmed.split(/\s+/);

    return {
        firstName: firstName || null,
        lastName: rest.length > 0 ? rest.join(' ') : null,
    };
}

function normalizeFreemiusTrialPeriod(value: unknown) {
    if (value === null || value === undefined || value === '') {
        return 0;
    }

    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 0;
    }

    return Math.round(parsed);
}

function isFreemiusTruthy(value: unknown) {
    return value === true || value === 1 || value === '1' || value === 'true';
}

function getFreemiusCollection(payload: any, key: string) {
    const value = payload?.[key];

    if (Array.isArray(value)) {
        return value;
    }

    if (value && typeof value === 'object') {
        return [value];
    }

    return [];
}

function getFirstFreemiusCollection(payload: any, keys: string[]) {
    for (const key of keys) {
        const collection = getFreemiusCollection(payload, key);

        if (collection.length > 0) {
            return collection;
        }
    }

    if (Array.isArray(payload)) {
        return payload;
    }

    return [];
}

function normalizeFreemiusAmount(value: unknown) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
}

function toMinorFreemiusAmount(value: number | null) {
    if (value === null) {
        return 0;
    }

    if (value > 5000) {
        console.warn(
            `[Freemius Sync] Suspiciously high price detected: ${value}. Assuming it is already in cents.`
        );
        return Math.round(value);
    }

    return Math.round(value * 100);
}

function getFreemiusLicenseQuota(value: unknown) {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed < 1) {
        return 1;
    }

    return Math.round(parsed);
}

/**
 * The configured keys bound to one product: its FREEMIUS_CHECKOUT_PRODUCTS_JSON entry (with a public
 * key), or the one-product keys when FREEMIUS_PRODUCT_ID names it (their sandbox overrides in
 * Freemius sandbox mode). Null when none are: then only the developer key pair, or the one-product
 * keys standing in where the key policy allows it, can open its checkout.
 */
export function resolveFreemiusBoundCheckoutCredentials(productId: string | number) {
    const credentialsMap = parseFreemiusCheckoutCredentialsMap();
    const productKey = String(productId);
    const productScopedCredentials = credentialsMap?.[productKey];
    const singleProductId = readFreemiusEnvValue('FREEMIUS_PRODUCT_ID');
    const sandboxOverridePublicKey = readFreemiusEnvValue(
        'FREEMIUS_ECOMMERCE_SANDBOX_PUBLIC_KEY'
    );
    const sandboxOverrideSecretKey = readFreemiusEnvValue(
        'FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY'
    );

    if (productScopedCredentials?.publicKey) {
        return {
            publicKey: productScopedCredentials.publicKey,
            secretKey: productScopedCredentials.secretKey ?? null,
            apiKey: productScopedCredentials.apiKey ?? null,
            source: 'product-map' as const,
        };
    }

    if (
        process.env.FREEMIUS_SANDBOX_ENABLED === 'true' &&
        singleProductId &&
        singleProductId === productKey &&
        sandboxOverridePublicKey
    ) {
        return {
            publicKey: sandboxOverridePublicKey,
            secretKey: sandboxOverrideSecretKey,
            apiKey: readFreemiusEnvValue('FREEMIUS_API_KEY'),
            source: 'single-product-sandbox-env' as const,
        };
    }

    if (singleProductId && singleProductId === productKey && readFreemiusEnvValue('FREEMIUS_PUBLIC_KEY')) {
        return {
            publicKey: readFreemiusEnvValue('FREEMIUS_PUBLIC_KEY'),
            secretKey: readFreemiusEnvValue('FREEMIUS_SECRET_KEY'),
            apiKey: readFreemiusEnvValue('FREEMIUS_API_KEY'),
            source: 'single-product-env' as const,
        };
    }

    return null;
}

/**
 * The configured keys for a product's Freemius API calls (the bearer, the product keys): its bound
 * keys, else the one-product names (`legacy-env`). Never decides whether a checkout may open with
 * the one-product keys; `resolveFreemiusProductCredentials` does, under the key policy.
 */
export function resolveFreemiusCheckoutCredentials(productId: string | number) {
    return (
        resolveFreemiusBoundCheckoutCredentials(productId) ?? {
            ...readFreemiusOneProductKeys(),
            source: 'legacy-env' as const,
        }
    );
}

/** The keys a product's checkout opens with; `source: 'none'` (no public key) means the keyed 503. */
export type FreemiusProductCredentials = {
    publicKey: string | null;
    secretKey: string | null;
    apiKey: string | null;
    source:
        | 'developer-api'
        | 'product-map'
        | 'single-product-sandbox-env'
        | 'single-product-env'
        | 'legacy-env'
        | 'none';
    /** With `source: 'none'`: why the one-product keys may not stand in (a log value, never key material). */
    refusal?: FreemiusOneProductStandInRefusal;
};

/**
 * A product's checkout lines (a failed key read, a blocked checkout) are written at most once per
 * window per product. POST /api/checkout is public and the key read can fail on every request while
 * Freemius throttles the developer key (the failure is remembered, so no request is even sent): a
 * line per request let anyone fill the logs. Product ids come from the store's catalog; the cap only
 * guards the memory.
 */
const shouldLogCheckoutLine = createFreemiusLogThrottle({ windowMs: 60_000, maxKeys: 100 });

/**
 * A product's checkout keys, under the key policy (freemius-key-policy.ts) the webhook check uses
 * too. Call `hydrateFreemiusEnvFromDb()` first.
 * 1. With a developer key pair Freemius accepts and a product the account owns, the product's own
 *    keys read from Freemius (cached for minutes; the last ones it returned while it fails to answer).
 * 2. Its bound keys: its FREEMIUS_CHECKOUT_PRODUCTS_JSON entry, or the one-product keys (their
 *    Freemius-sandbox twins in Freemius sandbox mode) when FREEMIUS_PRODUCT_ID names it, unless
 *    those are, or may be, a developer key pair (`freemiusKeysMayBeDeveloperPair`: the webhook
 *    check refuses that secret for the product too). When the read in step 1 failed, nothing else.
 * 3. The one-product keys standing in for a product without bound keys, only where
 *    `decideFreemiusOneProductStandIn` allows it: never when they are, or may be, the developer key
 *    pair, so a failed read no longer opens a checkout (and writes its order) with the developer
 *    public key.
 * Otherwise no keys (`source: 'none'`): the caller answers the keyed 503 before it writes anything.
 */
export async function resolveFreemiusProductCredentials(productId: string | number): Promise<FreemiusProductCredentials> {
    let keyReadFailed = false;

    try {
        const keys = await getFreemiusProductKeys(String(productId));

        if (keys) {
            return {
                publicKey: keys.publicKey,
                secretKey: keys.secretKey,
                apiKey: null,
                source: 'developer-api',
            };
        }
    } catch (error) {
        keyReadFailed = true;

        if (shouldLogCheckoutLine(`read:${toFreemiusId(productId) ?? 'invalid'}`)) {
            console.warn(
                `[Freemius Checkout] Could not read product ${toFreemiusId(productId) ?? '(invalid id)'}'s keys with the developer key pair; only keys bound to it may open its checkout.`,
                isFreemiusApiError(error) ? `${error.kind}: ${error.message}` : 'unexpected error'
            );
        }
    }

    const bound = resolveFreemiusBoundCheckoutCredentials(productId);

    if (bound) {
        // A JSON entry is the product's own. FREEMIUS_PRODUCT_ID's binding stands too, offline
        // included (the operator declared those keys this product's), except where they are, or may
        // be, a developer pair: its public key would reach the buyer's browser and the order would
        // be written for a checkout that cannot work.
        if (bound.source === 'product-map' || !(await freemiusKeysMayBeDeveloperPair({ publicKey: bound.publicKey, secretKey: bound.secretKey }))) {
            return bound;
        }

        return { publicKey: null, secretKey: null, apiKey: null, source: 'none', refusal: 'one_product_keys_are_developer_pair' };
    }

    const standIn = await decideFreemiusOneProductStandIn(String(productId), { keyReadFailed });

    if (standIn.allowed) {
        return { ...readFreemiusOneProductKeys(), source: 'legacy-env' };
    }

    return { publicKey: null, secretKey: null, apiKey: null, source: 'none', refusal: standIn.reason };
}

/** The documented sandbox token: md5(timestamp + product id + secret key + public key + 'checkout'). */
function buildFreemiusSandboxToken(input: { productId: string | number; publicKey: string; secretKey: string }) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const hashString = `${timestamp}${input.productId}${input.secretKey}${input.publicKey}checkout`;

    return {
        ctx: timestamp,
        token: crypto.createHash('md5').update(hashString).digest('hex'),
    };
}

async function getFreemiusSandboxParamsViaSdk(input: {
    productId: string | number;
    publicKey: string;
    secretKey: string;
    apiKey?: string | null;
}) {
    if (!input.apiKey) {
        throw new Error('Missing Freemius API key for SDK sandbox generation.');
    }

    const freemius = new Freemius({
        productId: Number(input.productId),
        apiKey: input.apiKey,
        secretKey: input.secretKey,
        publicKey: input.publicKey,
    });

    return freemius.checkout.getSandboxParams();
}

export class FreemiusProvider implements PaymentProvider {
    getProviderName(): string {
        return 'Freemius';
    }

    async createCheckoutSession({
      items: cartItems,
      customerEmail,
      customerPhone,
      userId,
      billingAddress,
      shippingAddress,
      currencyCode,
      couponCode,
      couponContextItems: submittedCouponContextItems,
      attribution,
    }: CheckoutSessionInput): Promise<{
      url: string | null;
      error?: string;
      errorKey?: string;
      errorParams?: Record<string, string | number>;
      errorStatus?: number;
      customProps?: any;
    }> {
      // Accept the Vercel Marketplace integration's new key names too.
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
      const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  
      if (!supabaseUrl || !supabaseServiceKey) {
        return { error: 'Missing Supabase credentials for checkout (Service Key required).', url: null };
      }
  
      const supabase = createClient(supabaseUrl, supabaseServiceKey);
      
      if (!cartItems || cartItems.length === 0) {
          return { error: 'Cart is empty', url: null };
      }

      if (cartItems.length !== 1) {
          return { error: 'Freemius items must be checked out one at a time.', url: null };
      }

      // Quantity is multiplied into the recorded subtotal and stored on order_items;
      // only a positive integer may get that far (see checkout-items.ts).
      const normalizedCartItems = normalizeCheckoutItems(cartItems);

      if (!normalizedCartItems.ok) {
          return { url: null, ...normalizedCartItems.error };
      }

      let couponContextItems = normalizedCartItems.items;

      if (submittedCouponContextItems && submittedCouponContextItems.length > 0) {
          const normalizedContextItems = normalizeCheckoutItems(submittedCouponContextItems);

          if (!normalizedContextItems.ok) {
              return { url: null, ...normalizedContextItems.error };
          }

          // The cart's own lines keep the cart's quantities; the context may only add lines.
          couponContextItems = reconcileCouponContextItems(
            normalizedCartItems.items,
            normalizedContextItems.items
          );
      }

      const { data: currenciesResult, error: currenciesError } = await supabase
        .from('currencies')
        .select(
          'code, symbol, exchange_rate, is_default, is_active, auto_sync_product_prices, auto_update_exchange_rate, exchange_rate_source, exchange_rate_updated_at, rounding_mode, rounding_increment, rounding_charm_amount'
        )
        .eq('is_active', true)
        .order('code', { ascending: true });
      const currencies = currenciesResult ?? [];

      if (currenciesError || currencies.length === 0) {
        return { error: 'Failed to resolve store currencies', url: null };
      }

      const defaultCurrency = getDefaultCurrency(currencies);
      const selectedCurrency =
        currencies.find((currency) => currency.code === (currencyCode || '').toUpperCase()) ??
        defaultCurrency;
      
      const item = normalizedCartItems.items[0];
      const { data: product, error: productError } = await supabase
        .from('products')
        .select(`${FREEMIUS_PRICED_PRODUCT_COLUMNS}, title, freemius_plan_id, freemius_product_id, trial_period_days, trial_requires_payment_method`)
        .eq('id', item.product_id)
        .single();

      if (productError || !product) {
          return { error: 'Product not found', url: null };
      }

      const freemiusPlanId = product.freemius_plan_id;
      const freemiusProductId = product.freemius_product_id;

      if (!freemiusPlanId || !freemiusProductId) {
          return { error: 'Product is not configured for Freemius checkout (missing Plan ID or Product ID)', url: null };
      }

      // Freemius charges its plan price for the cycle the checkout opens on, so the order
      // records that price, and the cycle sent to Freemius is the one validated here.
      let pricing: FreemiusUnitAmountResolution;

      try {
        pricing = await resolveFreemiusUnitAmount({
          client: supabase as any,
          product,
          billingCycle: item.billing_cycle,
          currencyCode: selectedCurrency.code,
          currencies,
        });
      } catch (pricingError) {
        console.error('Failed to resolve Freemius pricing:', pricingError);
        return { error: 'Failed to resolve product pricing', url: null };
      }

      if (!pricing.ok) {
        return { url: null, ...createInvalidCheckoutItemsError() };
      }

      const unitAmount = pricing.unitAmount;
      const billingCycle = pricing.billingCycle;
      // The locally recorded order price reflects the sale; the real Freemius
      // charge is enforced by an auto-generated, time-bounded coupon (see
      // syncProductSaleCouponToFreemius) appended to the checkout URL below.
      const productSaleActive = isSaleWindowActive({
        saleStartAt: product.sale_start_at,
        saleEndAt: product.sale_end_at,
      });
      const totalAmount = unitAmount * item.quantity;
      let couponQuote: CouponQuote | null = null;
      let discountTotal = 0;

      if (couponCode) {
          const quoteResult = await getCouponQuote({
              client: supabase as any,
              code: couponCode,
              // Quote this product on the cycle validated above, not on the context's copy.
              items: couponContextItems.map((line) =>
                  line.product_id === product.id
                      ? { ...line, billing_cycle: billingCycle ?? undefined }
                      : line
              ),
              currencyCode: selectedCurrency.code,
          });

          if (!quoteResult.success) {
              return {
                  error: quoteResult.error,
                  errorKey: quoteResult.errorKey,
                  errorStatus: 400,
                  url: null,
              };
          }

          couponQuote = quoteResult.quote;
          discountTotal = Math.min(
              totalAmount,
              couponQuote.lineDiscounts
                  .filter((line) => line.product_id === product.id)
                  .reduce((sum, line) => sum + line.discount, 0)
          );
      }
      const trialPeriodDays = normalizeFreemiusTrialPeriod(product.trial_period_days);
      const trialMode =
          trialPeriodDays > 0
              ? item.trial_preference
                  ? item.trial_preference
                  : product.trial_requires_payment_method
                      ? 'paid'
                      : 'free'
              : null;
      // The order is only a local checkout attempt until Freemius confirms the
      // purchase or trial through the checkout callback/webhook.
      const initialOrderStatus = 'pending';
      const freemiusCustomerName = splitFreemiusCustomerName(
        billingAddress?.recipient_name ?? null
      );
      
      // Overlay any CMS-configured Freemius credentials (DB-first) onto the env reads below.
      await hydrateFreemiusEnvFromDb();
      // Freemius checkout sandbox is independent from the app-wide demo sandbox. Read once: the
      // order records it as its payment mode and the checkout URL below uses the same value.
      const isFreemiusSandboxEnabled = process.env.FREEMIUS_SANDBOX_ENABLED === 'true';

      // The product's checkout keys are resolved before anything is written. With the developer
      // key pair they are read from Freemius on demand, and that read can fail (timeout, 5xx,
      // product missing) even while store readiness is green from a cached verdict; then only keys
      // bound to the product may stand in (never the one-product names, which may hold the
      // developer pair). A checkout that cannot open must leave no pending order behind and spend
      // no coupon redemption: redeem_coupon_atomically never gives a slot back.
      const checkoutCredentials = await resolveFreemiusProductCredentials(freemiusProductId);
      const publicKey = checkoutCredentials.publicKey;
      const secretKey = checkoutCredentials.secretKey;
      const apiKey = checkoutCredentials.apiKey;

      if (!publicKey || (isFreemiusSandboxEnabled && !secretKey)) {
          // The shopper cannot act on "missing FREEMIUS_PUBLIC_KEY", and naming the store's
          // environment variables to the public is needless detail. Log the specifics (source and
          // policy reason: enum values, never key material), once a minute per product, and return
          // the same keyed message the Stripe path uses.
          if (shouldLogCheckoutLine(`blocked:${toFreemiusId(freemiusProductId) ?? 'invalid'}`)) {
              console.error(
                  `Freemius checkout blocked for product ${toFreemiusId(freemiusProductId) ?? '(invalid id)'}: no usable keys ` +
                      `(source ${checkoutCredentials.source}${checkoutCredentials.refusal ? `, ${checkoutCredentials.refusal}` : ''}). ` +
                      'Check CMS → Payments (developer key pair, Product ID, keys) or the environment.'
              );
          }
          return {
              error: 'This store is not able to take payments right now. Please contact the seller to complete your purchase.',
              errorKey: 'ecommerce.checkout_payments_unavailable',
              errorStatus: 503,
              url: null,
          };
      }

      if (isFreemiusSandboxEnabled && checkoutCredentials.source === 'legacy-env') {
          const configuredProductId = readFreemiusEnvValue('FREEMIUS_PRODUCT_ID');
          const hasSandboxOverridePublicKey = Boolean(
              readFreemiusEnvValue('FREEMIUS_ECOMMERCE_SANDBOX_PUBLIC_KEY')
          );
          const hasSandboxOverrideSecretKey = Boolean(
              readFreemiusEnvValue('FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY')
          );
          console.warn(
              `[Freemius Checkout] Sandbox is enabled for product ${freemiusProductId}, but no product-scoped checkout credentials were selected. Falling back to legacy FREEMIUS_PUBLIC_KEY/FREEMIUS_SECRET_KEY may open live checkout instead of sandbox.`,
              {
                  configuredProductId,
                  productIdsMatch: configuredProductId === String(freemiusProductId),
                  hasSandboxOverridePublicKey,
                  hasSandboxOverrideSecretKey,
                  hasCheckoutProductsJson: Boolean(
                      readFreemiusEnvValue('FREEMIUS_CHECKOUT_PRODUCTS_JSON')
                  ),
              }
          );
      }

      // 3. Create Pending Order in DB. The attribution columns ride along only when the app
      // resolved a partner; a database without them (or refusing them) gets the order without
      // attribution, never a failed checkout. A sandbox purchase is recorded as test mode, so its
      // commission is never paid out with live money.
      const {
        result: { data: order, error: orderError },
      } = await insertPendingOrderWithAttribution({
        provider: 'Freemius',
        attribution,
        livemode: !isFreemiusSandboxEnabled,
        row: {
          status: initialOrderStatus,
          total: Math.max(0, totalAmount - discountTotal),
          currency: selectedCurrency.code,
          exchange_rate_at_purchase: selectedCurrency.exchange_rate,
          subtotal: totalAmount,
          discount_total: discountTotal,
          coupon_id: couponQuote?.couponId ?? null,
          coupon_code: couponQuote?.code ?? null,
          discount_details: couponQuote
            ? {
                code: couponQuote.code,
                discount_type: couponQuote.discountType,
                discount_amount: couponQuote.discountAmount,
                provider: 'freemius',
                provider_discounts: couponQuote.providerDiscounts,
                line_discounts: couponQuote.lineDiscounts,
                final_amount_owned_by: 'freemius',
              }
            : null,
          provider: 'freemius',
          freemius_product_id: String(freemiusProductId),
          freemius_plan_id: String(freemiusPlanId),
          user_id: userId || null,
          customer_details: normalizeOrderCustomerDetails({
            email: customerEmail,
            phone: customerPhone,
            name: billingAddress?.recipient_name,
            billing: billingAddress,
            shipping: shippingAddress,
          }),
        },
        insert: (row) => supabase.from('orders').insert(row).select('id').single(),
      });

      if (orderError || !order) {
        console.error('Failed to create pending order:', orderError);
        return { error: `Failed to initiate order`, url: null };
      }
      
      // Insert Order Items
      const { error: itemsError } = await supabase
        .from('order_items')
        .insert([{
            order_id: order.id,
            product_id: product.id,
            quantity: item.quantity,
            price_at_purchase: unitAmount
        }]);
          
      if (itemsError) {
          console.error('Failed to insert order items:', itemsError);
      }

      if (userId) {
          try {
              await upsertDefaultUserAddresses({
                  userId,
                  billingAddress,
                  shippingAddress,
                  client: supabase as any,
              });
              await fillMissingUserProfileCheckoutDetails({
                  userId,
                  fullName:
                      billingAddress?.recipient_name ?? shippingAddress?.recipient_name ?? null,
                  phone: customerPhone,
                  client: supabase as any,
              });
          } catch (profileSyncError) {
              console.error(
                  'Failed to sync checkout profile defaults before checkout:',
                  profileSyncError
              );
          }
      }

      if (couponQuote) {
          const redemption = await recordCouponRedemption({
              client: supabase as any,
              quote: couponQuote,
              orderId: order.id,
              provider: 'freemius',
              discountTotal,
              userId,
              customerEmail,
              metadata: {
                  currency: selectedCurrency.code,
                  subtotal: totalAmount,
                  final_amount_owned_by: 'freemius',
              },
          });

          // The redemption counter is enforced atomically in the DB. If it was already exhausted
          // the coupon must not apply: fail the just-created order and stop before the Freemius
          // checkout URL is built, rather than honouring a discount the buyer cannot claim.
          if (!redemption.success) {
              await supabase.from('orders').update({ status: 'failed' }).eq('id', order.id);
              return { url: null, error: 'Coupon is no longer available.', errorKey: 'ecommerce.coupon_invalid' };
          }
      }

      let sandboxPayload: any = false;

      // With an API key, the official Freemius SDK sandbox API first; otherwise (the developer
      // key pair reads no API key) or when it fails, the documented MD5 token, which is the same.
      if (isFreemiusSandboxEnabled && secretKey && publicKey) {
          if (apiKey) {
              try {
                  sandboxPayload = await getFreemiusSandboxParamsViaSdk({
                      productId: freemiusProductId,
                      publicKey,
                      secretKey,
                      apiKey,
                  });
              } catch (sdkSandboxError) {
                  console.warn(
                      'Freemius Checkout - SDK sandbox generation failed. Falling back to manual token generation.',
                      sdkSandboxError instanceof Error ? sdkSandboxError.message : 'unexpected error',
                      {
                          credentialSource: checkoutCredentials.source,
                      }
                  );
              }
          }

          if (!sandboxPayload) {
              sandboxPayload = buildFreemiusSandboxToken({ productId: freemiusProductId, publicKey, secretKey });
          }
      }
      
      const url = new URL(`https://checkout.freemius.com/app/${freemiusProductId}/plan/${freemiusPlanId}/`);
      if (isFreemiusSandboxEnabled && secretKey && publicKey) {
          // Use correct secure parameters for Sandbox Direct Linking
          url.searchParams.append('sandbox', sandboxPayload.token);
          url.searchParams.append('s_ctx_ts', sandboxPayload.ctx);
      } else if (isFreemiusSandboxEnabled) {
          url.searchParams.append('sandbox', 'true');
      }
      
      if (customerEmail) url.searchParams.append('user_email', customerEmail);
      if (freemiusCustomerName.firstName) {
          url.searchParams.append('user_firstname', freemiusCustomerName.firstName);
      }
      if (freemiusCustomerName.lastName) {
          url.searchParams.append('user_lastname', freemiusCustomerName.lastName);
      }
      url.searchParams.append('currency', selectedCurrency.code.toLowerCase());
      if (billingCycle) {
          url.searchParams.append('billing_cycle', billingCycle);
      }
      if (trialMode) {
          url.searchParams.append('trial', trialMode);
      }
      if (couponQuote) {
          url.searchParams.append('coupon', couponQuote.code);
      } else if (productSaleActive) {
          // No user coupon: apply the auto-generated sale coupon so the
          // scheduled discount is enforced on the Freemius-hosted checkout.
          const { data: saleCoupon } = await supabase
            .from('product_freemius_sale_coupons')
            .select('freemius_coupon_code, is_active, starts_at, ends_at, sync_status')
            .eq('product_id', product.id)
            .maybeSingle();
          if (
            saleCoupon?.is_active &&
            saleCoupon.sync_status === 'synced' &&
            saleCoupon.freemius_coupon_code &&
            isSaleWindowActive({
              saleStartAt: saleCoupon.starts_at,
              saleEndAt: saleCoupon.ends_at,
            })
          ) {
              url.searchParams.append('coupon', saleCoupon.freemius_coupon_code);
          }
      }

      return {
          url: url.toString(),
          customProps: {
              provider: 'freemius',
              plugin_id: freemiusProductId,
              plan_id: freemiusPlanId,
              public_key: publicKey,
              user_email: customerEmail,
              user_firstname: freemiusCustomerName.firstName,
              user_lastname: freemiusCustomerName.lastName,
              credential_source: checkoutCredentials.source,
              sandbox: sandboxPayload,
              billing_cycle: billingCycle,
              trial: trialMode,
              trial_period_days: trialPeriodDays,
              trial_requires_payment_method: product.trial_requires_payment_method,
              initial_order_status: initialOrderStatus,
              coupon: couponQuote?.code ?? null,
              order_id: order.id,
              // Capability token for /checkout/success: proves the holder initiated this order
              // (guest or signed-in) without exposing the order to anyone who learns its id.
              success_token: mintOrderAccessToken(order.id)
          }
      };
    }
}

/**
 * Imports every product of the Freemius developer account (plans and pricing) as store products.
 * Reads with the developer key pair (CMS developer fields first, then FREEMIUS_DEVELOPER_PUBLIC_KEY /
 * FREEMIUS_DEVELOPER_SECRET_KEY, then the legacy FREEMIUS_PUBLIC_KEY / FREEMIUS_SECRET_KEY) through
 * the GET-only catalog reader, the one developer-scope use the sandbox reset keeps. A product added
 * in Freemius then works everywhere at once: the cached product list and keys are dropped. A first
 * product list Freemius did not answer (a 2xx that is not a list included) stops it before anything
 * is written or dropped.
 *
 * The CMS Sync from Freemius (triggerFreemiusSync / triggerSingleProductSync) refuses on the public
 * sandbox, so there only the demo's 15-minute reset runs this. This function and
 * syncSingleFreemiusProduct are relays named in DEVELOPER_KEY_CALLERS
 * (tools/scripts/lib/sandbox-guards.js), which checks each of their callers: renaming either breaks
 * that entry (security:check fails until it is updated).
 */
export async function syncFreemiusProductsToSupabase() {
    // CMS-saved developer ids and keys count too (the sandbox reads no row and syncs from its env).
    await hydrateFreemiusEnvFromDb();
    // Accept the Vercel Marketplace integration's new key names too.
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
        throw new Error('Missing necessary environment variables for Freemius Sync.');
    }

    const catalog = await openFreemiusCatalogReader();
    const devId = catalog.developerId;
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
        auth: { autoRefreshToken: false, persistSession: false }
    });

    const fetcher = (path: string) => catalog.read(path);

    try {
        console.log(`[Freemius Sync] Fetching all plugins for developer ${devId}...`);
        const pluginsData = await fetcher('/plugins.json');
        const plugins = getFirstFreemiusCollection(pluginsData, ['plugins', 'plugin']);

        console.log(`[Freemius Sync] Found ${plugins.length} plugins. Syncing plans...`);

        let totalSyncCount = 0;

        // Get English language ID for default product language
        const { data: enLang } = await supabase.from('languages').select('id').eq('code', 'en').single();
        const enLangId = enLang?.id;
        if (!enLangId) {
            throw new Error('English language not found in database. Cannot sync products.');
        }

        for (const plugin of plugins) {
            const pluginId = toFreemiusId(plugin?.id);

            if (!pluginId) {
                // Never log the plugin itself: at developer scope it carries the product's keys.
                console.warn('[Freemius Sync] Skipping a plugin without an id.');
                continue;
            }

            const count = await syncSingleFreemiusProductInternal(
                supabase,
                pluginId,
                plugin.title || plugin.name || `Freemius Product ${pluginId}`,
                fetcher,
                enLangId
            );
            totalSyncCount += count;
        }

        forgetFreemiusDeveloperCaches();
        return { success: true, count: totalSyncCount };
    } catch (err: any) {
        console.error('[Freemius Sync] Global Error:', err);
        throw err;
    }
}

export async function syncSingleFreemiusProduct(productId: string) {
    const freemiusProductId = toFreemiusId(productId);

    if (!freemiusProductId) {
        throw new Error('This is not a Freemius product id.');
    }

    // CMS-saved developer ids and keys count too (the sandbox reads no row and syncs from its env).
    await hydrateFreemiusEnvFromDb();
    // Accept the Vercel Marketplace integration's new key names too.
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
        throw new Error('Missing environment variables for Freemius Sync.');
    }

    const catalog = await openFreemiusCatalogReader();
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const fetcher = (path: string) => catalog.read(path);

    // Get English language ID for default product language
    const { data: enLang } = await supabase.from('languages').select('id').eq('code', 'en').single();
    const enLangId = enLang?.id;
    if (!enLangId) {
        throw new Error('English language not found in database. Cannot sync products.');
    }

    // First fetch the plugin details to get the title
    const pluginResponse = await fetcher(`/plugins/${freemiusProductId}.json`);
    const plugin = pluginResponse?.plugin ?? pluginResponse ?? {};

    const count = await syncSingleFreemiusProductInternal(
        supabase,
        freemiusProductId,
        plugin.title || plugin.name || `Freemius Product ${freemiusProductId}`,
        fetcher,
        enLangId
    );
    forgetFreemiusDeveloperCaches();
    return { success: true, count };
}

async function syncSingleFreemiusProductInternal(
    supabase: any,
    productId: string,
    pluginTitle: string,
    fetchFreemius: (path: string) => Promise<any>,
    languageId: number
) {
    console.log(`[Freemius Sync] Fetching plans for plugin: ${pluginTitle} (${productId})...`);
    let syncCount = 0;

    try {
        const plansPath = `/plugins/${productId}/plans.json`;
        const plansData = await fetchFreemius(plansPath);
        const plans = getFirstFreemiusCollection(plansData, ['plans', 'plan']);
        console.log(`[Freemius Sync] Received ${plans.length} plans for plugin ${productId}.`);

        for (const plan of plans) {
            const planIdStr = toFreemiusId(plan?.id);

            if (!planIdStr) {
                console.warn('[Freemius Sync] Skipping a plan without an id.');
                continue;
            }

            const planName = plan.name || plan.title || planIdStr;
            const planTitle = plan.title || planName;

            console.log(`[Freemius Sync] Processing plan: ${planTitle} (${planIdStr})...`);

            let planDetails = plan;
            if (
                planDetails.trial_period === undefined ||
                planDetails.is_require_subscription === undefined
            ) {
                try {
                    const planDetailsPath = `/plugins/${productId}/plans/${planIdStr}.json`;
                    const fetchedPlanDetails = await fetchFreemius(planDetailsPath);
                    const fetchedPlanPayload = fetchedPlanDetails.plan ?? fetchedPlanDetails;
                    planDetails = {
                        ...planDetails,
                        ...fetchedPlanPayload,
                    };
                } catch (planDetailsErr) {
                    console.warn(
                        `[Freemius Sync] Could not fetch trial details for plan ${planIdStr}:`,
                        planDetailsErr instanceof Error
                            ? planDetailsErr.message
                            : planDetailsErr
                    );
                }
            }

            const trialPeriodDays = normalizeFreemiusTrialPeriod(planDetails.trial_period);
            const trialRequiresPaymentMethod =
                trialPeriodDays > 0 && isFreemiusTruthy(planDetails.is_require_subscription);
            
            // 1. Fetch pricing for this specific plan
            let price = 0;
            let fullPricing: any[] = [];
            try {
                const pricingPath = `/plugins/${productId}/plans/${planIdStr}/pricing.json`;
                const pricingData = await fetchFreemius(pricingPath);
                fullPricing = getFirstFreemiusCollection(pricingData, [
                    'pricing',
                    'prices',
                    'pricings',
                ]);
                if (fullPricing.length > 0) {
                    const firstPricing = fullPricing[0];
                    const rawPrice =
                        normalizeFreemiusAmount(firstPricing.annual_price) ??
                        normalizeFreemiusAmount(firstPricing.monthly_price) ??
                        normalizeFreemiusAmount(firstPricing.lifetime_price);

                    price = toMinorFreemiusAmount(rawPrice);
                }
                console.log(`[Freemius Sync] Plan: ${planTitle} -> Resolved Price (cents): ${price}`);
            } catch (pricingErr) {
                console.warn(`[Freemius Sync] Could not fetch pricing for plan ${planIdStr}:`, pricingErr instanceof Error ? pricingErr.message : pricingErr);
            }

            const productSlug = `${pluginTitle}-${planTitle}`
                .toLowerCase()
                .replace(/[^\w\s-]/g, '')
                .replace(/[\s_]+/g, '-')
                .replace(/^-+|-+$/g, '');

            const productPayload = {
                title: `${pluginTitle} - ${planTitle}`,
                slug: productSlug,
                short_description: plan.description || '',
                price: price,
                product_type: 'digital',
                payment_provider: 'freemius',
                freemius_plan_id: planIdStr,
                freemius_product_id: productId,
                trial_period_days: trialPeriodDays,
                trial_requires_payment_method: trialRequiresPaymentMethod,
                status: 'active',
                stock: 999, 
                sku: `FM-${productId}-${planIdStr}`,
                language_id: languageId,
                // No trigger maintains products.updated_at. The visual editor publishes the title and
                // short description of a pre-0.23.4 draft that holds a copy of the products row only
                // while the row is unchanged since the draft was created (updated_at at or before
                // product_drafts.created_at): a sync that left it alone was reverted by that publish.
                updated_at: new Date().toISOString(),
            };

            // 2. Upsert Core Product
            const { data: upsertData, error: upsertError } = await supabase
                .from('products')
                .upsert(productPayload, { onConflict: 'language_id, sku' })
                .select();

            if (upsertError || !upsertData || upsertData.length === 0) {
                console.error(`[Freemius Sync] Error upserting product ${productPayload.sku}:`, upsertError);
                continue; // Cannot proceed without parent product
            }

            const localProductId = upsertData[0].id;

            // 3. Sync Freemius Plan
            const { data: existingPlan, error: existingPlanError } = await supabase
                .from('freemius_plans')
                .select('id')
                .eq('product_id', localProductId)
                .eq('name', planName)
                .maybeSingle();

            if (existingPlanError) {
                console.warn(
                    `[Freemius Sync] Could not check existing local plan for ${productPayload.sku}:`,
                    existingPlanError.message || existingPlanError
                );
            }

            let localPlanIdStr = '';

            if (existingPlan) {
                localPlanIdStr = existingPlan.id;
                const { error: planUpdateError } = await supabase
                    .from('freemius_plans')
                    .update({ title: planTitle, updated_at: new Date().toISOString() })
                    .eq('id', localPlanIdStr);

                if (planUpdateError) {
                    console.warn(
                        `[Freemius Sync] Could not update local plan ${localPlanIdStr}:`,
                        planUpdateError.message || planUpdateError
                    );
                }
            } else {
                const { data: newPlan, error: planInsertError } = await supabase
                    .from('freemius_plans')
                    .insert({
                        product_id: localProductId,
                        name: planName,
                        title: planTitle
                    })
                    .select('id')
                    .single();

                if (planInsertError) {
                    console.warn(
                        `[Freemius Sync] Could not insert local plan for ${productPayload.sku}:`,
                        planInsertError.message || planInsertError
                    );
                }

                if (newPlan) localPlanIdStr = newPlan.id;
            }

            // 4. Sync Pricing Configurations Safely (Preserving Overrides)
            if (localPlanIdStr && fullPricing.length > 0) {
                for (const pr of fullPricing) {
                    const lQuota = getFreemiusLicenseQuota(
                        pr.licenses ?? pr.license_quota ?? pr.quota
                    );
                    
                    const { data: existingPricing, error: existingPricingError } = await supabase
                        .from('freemius_pricing')
                        .select('id')
                        .eq('plan_id', localPlanIdStr)
                        .eq('license_quota', lQuota)
                        .maybeSingle();

                    if (existingPricingError) {
                        console.warn(
                            `[Freemius Sync] Could not check pricing for plan ${localPlanIdStr}, quota ${lQuota}:`,
                            existingPricingError.message || existingPricingError
                        );
                    }

                    const pPayload = {
                        api_monthly_price: normalizeFreemiusAmount(pr.monthly_price),
                        api_annual_price: normalizeFreemiusAmount(pr.annual_price),
                        api_lifetime_price: normalizeFreemiusAmount(pr.lifetime_price),
                        updated_at: new Date().toISOString()
                    };

                    if (existingPricing) {
                        const { error: pricingUpdateError } = await supabase
                            .from('freemius_pricing')
                            .update(pPayload)
                            .eq('id', existingPricing.id);

                        if (pricingUpdateError) {
                            console.warn(
                                `[Freemius Sync] Could not update pricing ${existingPricing.id}:`,
                                pricingUpdateError.message || pricingUpdateError
                            );
                        }
                    } else {
                        const { error: pricingInsertError } = await supabase
                            .from('freemius_pricing')
                            .insert({
                                plan_id: localPlanIdStr,
                                license_quota: lQuota,
                                ...pPayload
                            });

                        if (pricingInsertError) {
                            console.warn(
                                `[Freemius Sync] Could not insert pricing for plan ${localPlanIdStr}, quota ${lQuota}:`,
                                pricingInsertError.message || pricingInsertError
                            );
                        }
                    }
                }
            }
            
            console.log(`[Freemius Sync] Successfully fully synced product ${productPayload.sku}.`);
            syncCount++;
        }
    } catch (err: any) {
        console.error(`[Freemius Sync] Failed sync for plugin ${productId}:`, err.message);
    }
    return syncCount;
}
