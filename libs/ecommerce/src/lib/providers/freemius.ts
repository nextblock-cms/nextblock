import { PaymentProvider } from '../types';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { Freemius } from '@freemius/sdk';
import { hydrateFreemiusEnvFromDb } from '../payment-config';
import { CheckoutSessionInput, normalizeOrderCustomerDetails } from '../customer';
import { getCouponQuote, recordCouponRedemption } from '../coupon-server';
import { mintOrderAccessToken } from '../order-access-token';
import type { CouponQuote } from '../coupons';
import {
  fillMissingUserProfileCheckoutDetails,
  upsertDefaultUserAddresses,
} from '../customer-addresses';
import {
  getDefaultCurrency,
  isSaleWindowActive,
  resolveEffectivePriceForCurrency,
} from '../currency';
import { normalizeCheckoutItems } from './checkout-items';

export type FreemiusCheckoutCredentialEntry = {
    publicKey?: string;
    secretKey?: string;
    apiKey?: string;
};

export function readFreemiusEnvValue(name: keyof NodeJS.ProcessEnv) {
    const raw = process.env[name];

    if (!raw) {
        return null;
    }

    const trimmed = raw.trim();

    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        return trimmed.slice(1, -1).trim();
    }

    return trimmed;
}

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

export function parseFreemiusCheckoutCredentialsMap():
    | Record<string, FreemiusCheckoutCredentialEntry>
    | null {
    const raw = readFreemiusEnvValue('FREEMIUS_CHECKOUT_PRODUCTS_JSON');

    if (!raw) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as Record<string, FreemiusCheckoutCredentialEntry>;
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        console.error(
            '[Freemius Checkout] Failed to parse FREEMIUS_CHECKOUT_PRODUCTS_JSON:',
            error
        );
        return null;
    }
}

export function resolveFreemiusCheckoutCredentials(productId: string | number) {
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

    return {
        publicKey: readFreemiusEnvValue('FREEMIUS_PUBLIC_KEY'),
        secretKey: readFreemiusEnvValue('FREEMIUS_SECRET_KEY'),
        apiKey: readFreemiusEnvValue('FREEMIUS_API_KEY'),
        source: 'legacy-env' as const,
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

          couponContextItems = normalizedContextItems.items;
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
        .select('id, title, price, prices, sale_price, sale_prices, sale_start_at, sale_end_at, scheduled_price, scheduled_prices, scheduled_price_at, freemius_plan_id, freemius_product_id, trial_period_days, trial_requires_payment_method')
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

      const resolvedPrice = resolveEffectivePriceForCurrency({
        prices: product.prices || {},
        salePrices: product.sale_prices || {},
        fallbackPrice: product.price,
        fallbackSalePrice: product.sale_price,
        saleStartAt: product.sale_start_at,
        saleEndAt: product.sale_end_at,
        scheduledPrice: product.scheduled_price,
        scheduledPrices: product.scheduled_prices || {},
        scheduledPriceAt: product.scheduled_price_at,
        currencyCode: selectedCurrency.code,
        currencies,
      });
      const unitAmount = resolvedPrice.sale_price ?? resolvedPrice.price;
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
              items: couponContextItems,
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
      
      // 3. Create Pending Order in DB
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
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
        })
        .select('id')
        .single();
  
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
            
      // Overlay any CMS-configured Freemius credentials (DB-first) onto the env reads below.
      await hydrateFreemiusEnvFromDb();
      // Freemius checkout sandbox is independent from the app-wide demo sandbox.
      const isFreemiusSandboxEnabled = process.env.FREEMIUS_SANDBOX_ENABLED === 'true';
      const checkoutCredentials = resolveFreemiusCheckoutCredentials(freemiusProductId);
      const publicKey = checkoutCredentials.publicKey;
      const secretKey = checkoutCredentials.secretKey;
      const apiKey = checkoutCredentials.apiKey;

      if (!publicKey || (isFreemiusSandboxEnabled && !secretKey)) {
          // The shopper cannot act on "missing FREEMIUS_PUBLIC_KEY", and naming the store's
          // environment variables to the public is needless detail. Log the specifics,
          // return the same keyed message the Stripe path uses.
          console.error(
              'Freemius checkout blocked: missing credentials (PUBLIC_KEY or SECRET_KEY) in CMS → Payments or environment.'
          );
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
      
      let sandboxPayload: any = false;
      
      // Prefer the official Freemius SDK sandbox API. Fall back to the documented
      // MD5 token flow if the SDK path is unavailable or fails.
      if (isFreemiusSandboxEnabled && secretKey && publicKey) {
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
                  sdkSandboxError,
                  {
                      credentialSource: checkoutCredentials.source,
                      hasApiKey: !!apiKey,
                  }
              );

              const timestamp = Math.floor(Date.now() / 1000).toString();
              
              // MD5 String format: timestamp + plugin_id + secret_key + public_key + 'checkout'
              const hashString = `${timestamp}${freemiusProductId}${secretKey}${publicKey}checkout`;
              const hash = crypto.createHash('md5').update(hashString).digest('hex');
              
              sandboxPayload = {
                  ctx: timestamp,
                  token: hash
              };
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
      if (item.billing_cycle) {
          url.searchParams.append('billing_cycle', item.billing_cycle);
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
              billing_cycle: item.billing_cycle,
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
 * Internal helper for Freemius API calls with correct signature
 */
async function fetchFreemiusHelper(path: string, devId: string, publicKey: string, secretKey: string) {
    const method = 'GET';
    const date = new Date().toUTCString().replace('GMT', '+0000');
    
    // HMAC-SHA256 signature format: METHOD \n CONTENT_MD5 \n CONTENT_TYPE \n DATE \n URL
    const stringToSign = `${method}\n\n\n${date}\n${path}`;
    
    const hexHash = crypto.createHmac('sha256', secretKey).update(stringToSign).digest('hex');
    const signature = Buffer.from(hexHash)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
    
    const authHeader = `FS ${devId}:${publicKey}:${signature}`;

    const response = await fetch(`https://api.freemius.com${path}`, {
        headers: {
            'Authorization': authHeader,
            'Date': date,
            'Accept': 'application/json'
        }
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error(`[Freemius API] [ERROR] ${path} returned ${response.status}: ${errText}`);
        throw new Error(`Freemius API failed on ${path}: ${response.status} - ${errText}`);
    }

    return response.json();
}

export async function syncFreemiusProductsToSupabase() {
    const devId = readFreemiusEnvValue('FREEMIUS_DEVELOPER_ID');
    const publicKey = readFreemiusEnvValue('FREEMIUS_PUBLIC_KEY');
    const secretKey = readFreemiusEnvValue('FREEMIUS_SECRET_KEY');
    // Accept the Vercel Marketplace integration's new key names too.
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

    if (!devId || !publicKey || !secretKey || !supabaseUrl || !supabaseServiceKey) {
        throw new Error('Missing necessary environment variables for Freemius Sync.');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
        auth: { autoRefreshToken: false, persistSession: false }
    });

    const fetcher = (path: string) => fetchFreemiusHelper(path, devId, publicKey, secretKey);

    try {
        console.log(`[Freemius Sync] Fetching all plugins for developer ${devId}...`);
        const pluginsData = await fetcher(`/v1/developers/${devId}/plugins.json`);
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
            const pluginId = plugin.id?.toString();

            if (!pluginId) {
                console.warn('[Freemius Sync] Skipping plugin without an id:', plugin);
                continue;
            }

            const count = await syncSingleFreemiusProductInternal(
                supabase,
                devId,
                pluginId,
                plugin.title || plugin.name || `Freemius Product ${pluginId}`,
                fetcher,
                enLangId
            );
            totalSyncCount += count;
        }

        return { success: true, count: totalSyncCount };
    } catch (err: any) {
        console.error('[Freemius Sync] Global Error:', err);
        throw err;
    }
}

export async function syncSingleFreemiusProduct(productId: string) {
    const devId = readFreemiusEnvValue('FREEMIUS_DEVELOPER_ID');
    const publicKey = readFreemiusEnvValue('FREEMIUS_PUBLIC_KEY');
    const secretKey = readFreemiusEnvValue('FREEMIUS_SECRET_KEY');
    // Accept the Vercel Marketplace integration's new key names too.
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

    if (!devId || !publicKey || !secretKey || !supabaseUrl || !supabaseServiceKey) {
        throw new Error('Missing environment variables for Freemius Sync.');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const fetcher = (path: string) => fetchFreemiusHelper(path, devId, publicKey, secretKey);

    // Get English language ID for default product language
    const { data: enLang } = await supabase.from('languages').select('id').eq('code', 'en').single();
    const enLangId = enLang?.id;
    if (!enLangId) {
        throw new Error('English language not found in database. Cannot sync products.');
    }

    // First fetch the plugin details to get the title
    const pluginResponse = await fetcher(`/v1/developers/${devId}/plugins/${productId}.json`);
    const plugin = pluginResponse.plugin ?? pluginResponse;
    
    const count = await syncSingleFreemiusProductInternal(
        supabase,
        devId,
        productId,
        plugin.title || plugin.name || `Freemius Product ${productId}`,
        fetcher,
        enLangId
    );
    return { success: true, count };
}

async function syncSingleFreemiusProductInternal(
    supabase: any, 
    devId: string, 
    productId: string, 
    pluginTitle: string,
    fetchFreemius: (path: string) => Promise<any>,
    languageId: number
) {
    console.log(`[Freemius Sync] Fetching plans for plugin: ${pluginTitle} (${productId})...`);
    let syncCount = 0;

    try {
        const plansPath = `/v1/developers/${devId}/plugins/${productId}/plans.json`;
        const plansData = await fetchFreemius(plansPath);
        const plans = getFirstFreemiusCollection(plansData, ['plans', 'plan']);
        console.log(`[Freemius Sync] Received ${plans.length} plans for plugin ${productId}.`);

        for (const plan of plans) {
            const planIdStr = plan.id?.toString();

            if (!planIdStr) {
                console.warn('[Freemius Sync] Skipping plan without an id:', plan);
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
                    const planDetailsPath = `/v1/developers/${devId}/plugins/${productId}/plans/${planIdStr}.json`;
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
                const pricingPath = `/v1/developers/${devId}/plugins/${productId}/plans/${planIdStr}/pricing.json`;
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
