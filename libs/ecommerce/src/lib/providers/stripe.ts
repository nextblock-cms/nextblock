import 'server-only';

import Stripe from 'stripe';
import { getStripeClient } from '../stripe/client';
import { createClient } from '@supabase/supabase-js';
import { countries } from '../countries';
import {
  CheckoutSessionInput,
  CustomerAddressInput,
  normalizeOrderCustomerDetails,
} from '../customer';
import {
  getCouponQuote,
  getQuoteLineDiscountMap,
  recordCouponRedemption,
} from '../coupon-server';
import { type CouponQuote, getCartLineCouponKey, reconcileCouponContextItems } from '../coupons';
import {
  fillMissingUserProfileCheckoutDetails,
  upsertDefaultUserAddresses,
} from '../customer-addresses';
import {
  createInventoryInsufficientError,
  createInventoryUnavailableError,
  getEcommerceInventorySettings,
} from '../inventory-settings';
import {
  calculateCheckoutTaxes,
  getStripeTaxCodeForProduct,
  STRIPE_TAX_CODE_SHIPPING,
  STRIPE_TAX_CODE_NONTAXABLE,
} from '../tax-calculation';
import {
  getDefaultCurrency,
  normalizePriceMap,
  resolveEffectivePriceForCurrency,
} from '../currency';
import { buildOrderTaxDetailsFromCalculation } from '../order-tax-details';
import {
  createInvalidShippingMethodError,
  createShippingAddressRequiredError,
  createShippingMethodRequiredError,
  listEligibleShippingMethods,
  normalizeShippingDestination,
  resolveCheckoutShippingMethod,
} from '../shipping/checkout-shipping-method';
import { isDigitalItem, PaymentProvider } from '../types';
import { normalizeCheckoutItems } from './checkout-items';

const STRIPE_ALLOWED_COUNTRIES =
  countries.map((country) => country.code) as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[];

const STRIPE_SUPPORTED_LOCALES = new Set<string>([
  'bg',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'en-GB',
  'es',
  'es-419',
  'et',
  'fi',
  'fil',
  'fr',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'lt',
  'lv',
  'ms',
  'mt',
  'nb',
  'nl',
  'pl',
  'pt',
  'pt-BR',
  'ro',
  'ru',
  'sk',
  'sl',
  'sv',
  'th',
  'tr',
  'vi',
  'zh',
  'zh-HK',
  'zh-TW',
]);

function toStripeAddress(address?: CustomerAddressInput | null): Stripe.AddressParam | undefined {
  if (!address) {
    return undefined;
  }

  return {
    line1: address.line1 || undefined,
    line2: address.line2 || undefined,
    city: address.city || undefined,
    state: address.state || undefined,
    postal_code: address.postal_code || undefined,
    country: address.country_code || undefined,
  };
}

function resolveStripeCheckoutLocale(locale?: string | null) {
  const normalized = locale?.trim().replace('_', '-');

  if (!normalized) {
    return undefined;
  }

  const candidates = [normalized, normalized.toLowerCase(), normalized.split('-')[0].toLowerCase()];

  for (const candidate of candidates) {
    if (STRIPE_SUPPORTED_LOCALES.has(candidate as Stripe.Checkout.SessionCreateParams.Locale)) {
      return candidate as Stripe.Checkout.SessionCreateParams.Locale;
    }
  }

  return undefined;
}

async function upsertStripeCheckoutCustomer(input: {
  email?: string | null;
  phone?: string | null;
  userId?: string | null;
  billingAddress?: CustomerAddressInput | null;
  shippingAddress?: CustomerAddressInput | null;
}) {
  if (!input.email) {
    return null;
  }

  const stripe = await getStripeClient();
  const stripeShippingAddress = toStripeAddress(input.shippingAddress);
  const shippingName =
    input.shippingAddress?.recipient_name ||
    input.billingAddress?.recipient_name ||
    undefined;

  const customerPayload = {
    email: input.email,
    name:
      input.billingAddress?.recipient_name ||
      input.shippingAddress?.recipient_name ||
      undefined,
    phone: input.phone || undefined,
    address: toStripeAddress(input.billingAddress),
    metadata: input.userId ? { userId: input.userId } : undefined,
    ...(stripeShippingAddress && shippingName
      ? {
          shipping: {
            name: shippingName,
            phone: input.phone || undefined,
            address: stripeShippingAddress,
          },
        }
      : {}),
  };

  try {
    const existingCustomers = await stripe.customers.list({
      email: input.email,
      limit: 1,
    });
    const existingCustomer = existingCustomers.data[0];

    if (existingCustomer) {
      await stripe.customers.update(existingCustomer.id, customerPayload);
      return existingCustomer.id;
    }

    const createdCustomer = await stripe.customers.create(customerPayload);
    return createdCustomer.id;
  } catch (error) {
    console.error('Failed to upsert Stripe customer for checkout prefill:', error);
    return null;
  }
}

export class StripeProvider implements PaymentProvider {
  getProviderName(): string {
    return 'Stripe';
  }

  async createCheckoutSession({
    items: submittedCartItems,
    customerEmail,
    customerPhone,
    userId,
    billingAddress,
    shippingAddress,
    shippingMethodId,
    currencyCode,
    locale,
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
    const stripe = await getStripeClient();
    // Accept the Vercel Marketplace integration's new key names too.
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Supabase credentials for checkout (Service Key required).');
      return { error: 'Internal Server Error', url: null };
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const siteUrl = process.env.NEXT_PUBLIC_URL || 'http://localhost:4200';

    if (!submittedCartItems?.length) {
      return { error: 'Cart is empty', url: null };
    }

    // The request body is the only source of quantities. Reject anything that is not a
    // positive integer and merge duplicate product+variant lines before any pricing,
    // inventory check or order row sees them (see checkout-items.ts for the failure mode).
    const normalizedCartItems = normalizeCheckoutItems(submittedCartItems);

    if (!normalizedCartItems.ok) {
      return { url: null, ...normalizedCartItems.error };
    }

    const cartItems = normalizedCartItems.items;
    let couponContextItems = cartItems;

    if (submittedCouponContextItems && submittedCouponContextItems.length > 0) {
      const normalizedContextItems = normalizeCheckoutItems(submittedCouponContextItems);

      if (!normalizedContextItems.ok) {
        return { url: null, ...normalizedContextItems.error };
      }

      // The cart's own lines keep the cart's quantities; the context may only add lines.
      couponContextItems = reconcileCouponContextItems(cartItems, normalizedContextItems.items);
    }

    const hasPhysicalProducts = cartItems.some((item) => !isDigitalItem(item));

    const { data: currenciesResult, error: currenciesError } = await supabase
      .from('currencies')
      .select(
        'code, symbol, exchange_rate, is_default, is_active, auto_sync_product_prices, auto_update_exchange_rate, exchange_rate_source, exchange_rate_updated_at, rounding_mode, rounding_increment, rounding_charm_amount'
      )
      .eq('is_active', true)
      .order('code', { ascending: true });
    const currencies = currenciesResult ?? [];

    if (currenciesError || currencies.length === 0) {
      console.error('Error fetching currencies for checkout:', currenciesError);
      return { error: 'Failed to resolve store currencies', url: null };
    }

    const defaultCurrency = getDefaultCurrency(currencies);
    const selectedCurrency =
      currencies.find((currency) => currency.code === (currencyCode || '').toUpperCase()) ??
      defaultCurrency;
    const checkoutCurrencyCode = selectedCurrency.code.toLowerCase();

    const inventorySettings = await getEcommerceInventorySettings(supabase as any);

    const productIds = cartItems.map((item) => item.product_id);
    const variantIds = cartItems
      .map((item) => item.variant_id)
      .filter((variantId): variantId is string => Boolean(variantId));
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('id, title, sku, price, prices, sale_price, sale_prices, sale_start_at, sale_end_at, scheduled_price, scheduled_prices, scheduled_price_at, stock, is_taxable')
      .in('id', productIds);

    if (productsError || !products) {
      console.error('Error fetching products for validation:', productsError);
      return { error: 'Failed to validate product prices', url: null };
    }

    const { data: variants, error: variantsError } = variantIds.length
      ? await supabase
          .from('product_variants')
          .select('id, product_id, sku, price, prices, sale_price, sale_prices, sale_start_at, sale_end_at, scheduled_price, scheduled_prices, scheduled_price_at, stock_quantity')
          .in('id', variantIds)
      : { data: [], error: null };

    if (variantsError) {
      console.error('Error fetching variants for validation:', variantsError);
      return { error: 'Failed to validate product variants', url: null };
    }

    const productMap = new Map(products.map((product) => [product.id, product]));
    const variantMap = new Map((variants || []).map((variant) => [variant.id, variant]));
    const inventorySkus = new Set<string>();
    const requestedQuantityBySku = new Map<string, number>();

    for (const cartItem of cartItems) {
      const product = productMap.get(cartItem.product_id);

      if (!product) {
        continue;
      }

      const variant = cartItem.variant_id ? variantMap.get(cartItem.variant_id) : null;
      const inventorySku = variant?.sku || product.sku;

      if (!inventorySku) {
        continue;
      }

      inventorySkus.add(inventorySku);
      requestedQuantityBySku.set(
        inventorySku,
        (requestedQuantityBySku.get(inventorySku) ?? 0) + cartItem.quantity
      );
    }

    const { data: inventoryRows, error: inventoryError } = inventorySkus.size
      ? await (supabase as any)
          .from('inventory_items')
          .select('sku, quantity')
          .in('sku', [...inventorySkus])
      : { data: [], error: null };

    if (inventoryError) {
      console.error('Error fetching SKU inventory for validation:', inventoryError);
      return { error: 'Failed to validate SKU inventory', url: null };
    }

    const inventoryBySku = new Map<string, number>(
      (inventoryRows || []).map((row: { sku: string; quantity: number | null }) => [
        row.sku,
        Math.max(0, row.quantity ?? 0),
      ])
    );

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
    const taxableItems: Array<{
      product_id: string;
      quantity: number;
      unit_amount: number;
      discount_amount?: number;
      is_taxable: boolean;
    }> = [];
    const verifiedItems: Array<{
      product_id: string;
      quantity: number;
      price_at_purchase: number;
      variant_id?: string | null;
    }> = [];
    let totalAmount = 0;
    let discountTotal = 0;
    let couponQuote: CouponQuote | null = null;

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
    }

    const lineDiscounts = getQuoteLineDiscountMap(couponQuote);

    const pushDiscountedLineItems = (input: {
      name: string;
      currency: string;
      productId: string;
      variantId?: string | null;
      isTaxable: boolean;
      unitAmount: number;
      quantity: number;
      lineDiscount: number;
    }) => {
      const originalLineTotal = input.unitAmount * input.quantity;
      const discountedLineTotal = Math.max(0, originalLineTotal - input.lineDiscount);

      if (discountedLineTotal <= 0) {
        return;
      }

      const baseUnitAmount = Math.floor(discountedLineTotal / input.quantity);
      const remainderQuantity = discountedLineTotal - baseUnitAmount * input.quantity;
      const pushLine = (unitAmount: number, quantity: number) => {
        if (quantity <= 0 || unitAmount <= 0) {
          return;
        }

        lineItems.push({
          price_data: {
            currency: input.currency,
            product_data: {
              name: input.name,
              tax_code: getStripeTaxCodeForProduct(input.isTaxable),
              metadata: {
                productId: input.productId,
                variantId: input.variantId || '',
              },
            },
            tax_behavior: 'exclusive',
            unit_amount: unitAmount,
          },
          quantity,
        });
      };

      pushLine(baseUnitAmount, input.quantity - remainderQuantity);
      pushLine(baseUnitAmount + 1, remainderQuantity);
    };

    for (const cartItem of cartItems) {
      const product = productMap.get(cartItem.product_id);

      if (!product) {
        console.warn(`Product ${cartItem.product_id} not found in DB.`);
        return {
          url: null,
          ...createInventoryUnavailableError(cartItem.title),
        };
      }

      const productPrice = resolveEffectivePriceForCurrency({
        prices: normalizePriceMap(product.prices),
        salePrices: product.sale_prices || {},
        fallbackPrice: product.price,
        fallbackSalePrice: product.sale_price,
        saleStartAt: product.sale_start_at,
        saleEndAt: product.sale_end_at,
        scheduledPrice: product.scheduled_price,
        scheduledPrices: normalizePriceMap(product.scheduled_prices),
        scheduledPriceAt: product.scheduled_price_at,
        currencyCode: selectedCurrency.code,
        currencies,
      });
      let unitAmount = productPrice.sale_price ?? productPrice.price;
      let lineItemName = product.title;
      let resolvedVariantId: string | null = null;

      if (cartItem.variant_id) {
        const variant = variantMap.get(cartItem.variant_id);

        if (!variant || variant.product_id !== cartItem.product_id) {
          return {
            url: null,
            ...createInventoryUnavailableError(cartItem.title),
          };
        }

        const requestedQuantity = requestedQuantityBySku.get(variant.sku) ?? cartItem.quantity;
        const availableQuantity = inventoryBySku.has(variant.sku)
          ? inventoryBySku.get(variant.sku) ?? 0
          : Math.max(0, variant.stock_quantity ?? 0);

        if (inventorySettings.trackQuantities && requestedQuantity > availableQuantity) {
          return {
            url: null,
            ...createInventoryInsufficientError(cartItem.title, availableQuantity),
          };
        }

        const variantPrice = resolveEffectivePriceForCurrency({
          prices: normalizePriceMap(variant.prices),
          salePrices: variant.sale_prices || {},
          fallbackPrice: variant.price,
          fallbackSalePrice: variant.sale_price,
          saleStartAt: variant.sale_start_at,
          saleEndAt: variant.sale_end_at,
          scheduledPrice: variant.scheduled_price,
          scheduledPrices: normalizePriceMap(variant.scheduled_prices),
          scheduledPriceAt: variant.scheduled_price_at,
          currencyCode: selectedCurrency.code,
          currencies,
        });
        unitAmount = variantPrice.sale_price ?? variantPrice.price;
        resolvedVariantId = variant.id;
        lineItemName = cartItem.variant_label
          ? `${product.title} - ${cartItem.variant_label}`
          : `${product.title} - ${variant.sku}`;
      } else {
        const requestedQuantity = requestedQuantityBySku.get(product.sku) ?? cartItem.quantity;
        const availableQuantity = inventoryBySku.has(product.sku)
          ? inventoryBySku.get(product.sku) ?? 0
          : Math.max(0, product.stock ?? 0);

        if (inventorySettings.trackQuantities && requestedQuantity > availableQuantity) {
          return {
            url: null,
            ...createInventoryInsufficientError(cartItem.title, availableQuantity),
          };
        }
      }

      const isTaxable = product.is_taxable ?? true;

      if (unitAmount < 0) {
        return { error: 'A product variation produced an invalid price.', url: null };
      }

      const lineDiscount = Math.min(
        unitAmount * cartItem.quantity,
        lineDiscounts.get(getCartLineCouponKey(cartItem)) ?? 0
      );

      pushDiscountedLineItems({
        name: lineItemName,
        currency: checkoutCurrencyCode,
        productId: product.id,
        variantId: resolvedVariantId,
        isTaxable,
        unitAmount,
        quantity: cartItem.quantity,
        lineDiscount,
      });

      totalAmount += unitAmount * cartItem.quantity;
      discountTotal += lineDiscount;
      verifiedItems.push({
        product_id: product.id,
        quantity: cartItem.quantity,
        price_at_purchase: unitAmount,
        variant_id: resolvedVariantId,
      });
      taxableItems.push({
        product_id: product.id,
        quantity: cartItem.quantity,
        unit_amount: unitAmount,
        discount_amount: lineDiscount,
        is_taxable: isTaxable,
      });
    }

    if (lineItems.length === 0 && discountTotal >= totalAmount) {
      return {
        error: 'This coupon would reduce the Stripe order to zero. Use a smaller discount for Stripe checkout.',
        errorKey: 'ecommerce.coupon_zero_total_not_supported',
        errorStatus: 400,
        url: null,
      };
    }

    if (lineItems.length === 0) {
      return { error: 'No valid items in cart', url: null };
    }

    let shippingAmount = 0;
    let resolvedShippingMethodName: string | null = null;

    if (hasPhysicalProducts) {
      // The request only names a method id; its cost, free-shipping threshold and zone are
      // re-read from the DB against the shipping address and the DISCOUNTED subtotal, the
      // same inputs the estimate shown at checkout used (resolveShippingOptions). Method
      // rows are publicly readable, so an unvalidated id was a free pick of the cheapest
      // rate in the store, and omitting the id was a free pick of no rate at all.
      const shippingDestination = normalizeShippingDestination({
        country: shippingAddress?.country_code,
        state: shippingAddress?.state,
        postal_code: shippingAddress?.postal_code,
      });

      if (!shippingDestination) {
        return { url: null, ...createShippingAddressRequiredError() };
      }

      const shippingRateInput = {
        destination: shippingDestination,
        cartTotal: Math.max(0, totalAmount - discountTotal),
        currencies,
        currencyCode: selectedCurrency.code,
      };

      if (shippingMethodId) {
        const resolution = await resolveCheckoutShippingMethod(supabase as any, {
          ...shippingRateInput,
          methodId: shippingMethodId,
          languageCode: locale,
        });

        if (!resolution.ok) {
          if (resolution.reason === 'load_failed') {
            console.error('Failed to load shipping method:', resolution.error);
            return { error: 'Failed to load shipping method', url: null };
          }

          console.warn(
            `Checkout rejected shipping method ${shippingMethodId}: ${resolution.reason}`
          );
          return { url: null, ...createInvalidShippingMethodError() };
        }

        shippingAmount = resolution.method.amount;
        resolvedShippingMethodName = resolution.method.name;
      } else {
        // No method submitted: only acceptable when the store offers none for this
        // destination (the storefront disables payment otherwise).
        const eligible = await listEligibleShippingMethods(supabase as any, shippingRateInput);

        if (!eligible.ok) {
          console.error('Failed to load shipping methods:', eligible.error);
          return { error: 'Failed to load shipping method', url: null };
        }

        if (eligible.methods.length > 0) {
          return { url: null, ...createShippingMethodRequiredError() };
        }
      }
    }

    const taxDestination = hasPhysicalProducts ? shippingAddress ?? billingAddress : billingAddress;
    let taxCalculation;

    try {
      taxCalculation = await calculateCheckoutTaxes(supabase as any, {
        items: taxableItems,
        destination: {
          country_code: taxDestination?.country_code,
          state: taxDestination?.state,
        },
      });
    } catch (taxError: any) {
      console.error('Failed to calculate checkout taxes:', taxError);
      return { error: 'Failed to calculate taxes', url: null };
    }

    if (shippingAmount > 0 && resolvedShippingMethodName) {
      lineItems.push({
        price_data: {
          currency: checkoutCurrencyCode,
          product_data: {
            name: resolvedShippingMethodName,
            tax_code:
              taxCalculation.enabled && taxCalculation.mode === 'automatic'
                ? STRIPE_TAX_CODE_SHIPPING
                : STRIPE_TAX_CODE_NONTAXABLE,
          },
          tax_behavior: 'exclusive',
          unit_amount: shippingAmount,
        },
        quantity: 1,
      });
    }

    const manualTaxAmount =
      taxCalculation.enabled &&
      taxCalculation.mode === 'manual' &&
      !taxCalculation.isPendingExternalCalculation
        ? taxCalculation.amount
        : 0;

    if (manualTaxAmount > 0) {
      lineItems.push({
        price_data: {
          currency: checkoutCurrencyCode,
          product_data: {
            name: 'Tax',
            tax_code: STRIPE_TAX_CODE_NONTAXABLE,
          },
          tax_behavior: 'exclusive',
          unit_amount: manualTaxAmount,
        },
        quantity: 1,
      });
    }

    const initialCustomerDetails = normalizeOrderCustomerDetails({
      email: customerEmail,
      phone: customerPhone,
      name: billingAddress?.recipient_name,
      billing: billingAddress,
      shipping: shippingAddress,
    });
    const currency = selectedCurrency.code;
    const orderTaxDetails = buildOrderTaxDetailsFromCalculation({
      calculation: taxCalculation,
      subtotal: totalAmount,
      shippingTotal: shippingAmount,
      total: Math.max(0, totalAmount - discountTotal) + shippingAmount + manualTaxAmount,
      currency,
    });
    const orderTotal = Math.max(0, totalAmount - discountTotal) + shippingAmount + manualTaxAmount;

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        status: 'pending',
        total: orderTotal,
        currency,
        exchange_rate_at_purchase: selectedCurrency.exchange_rate,
        subtotal: totalAmount,
        shipping_total: shippingAmount,
        tax_total: manualTaxAmount,
        tax_details: orderTaxDetails as any,
        coupon_id: couponQuote?.couponId ?? null,
        coupon_code: couponQuote?.code ?? null,
        discount_total: discountTotal,
        discount_details: couponQuote
          ? {
              code: couponQuote.code,
              discount_type: couponQuote.discountType,
              discount_amount: couponQuote.discountAmount,
              provider: 'stripe',
              provider_discounts: couponQuote.providerDiscounts,
              line_discounts: couponQuote.lineDiscounts,
            }
          : null,
        provider: 'stripe',
        user_id: userId,
        customer_details: initialCustomerDetails,
      })
      .select('id')
      .single();

    if (orderError || !order) {
      console.error('Failed to create pending order:', orderError);
      return { error: 'Failed to initiate order', url: null };
    }

    const orderId = order.id;

    const { error: itemsError } = await supabase.from('order_items').insert(
      verifiedItems.map((item) => ({
        order_id: orderId,
        product_id: item.product_id,
        variant_id: item.variant_id ?? null,
        quantity: item.quantity,
        price_at_purchase: item.price_at_purchase,
      }))
    );

    if (itemsError) {
      console.error('Failed to insert order items:', itemsError);
      await supabase.from('orders').update({ status: 'failed' }).eq('id', orderId);
      return { error: 'Failed to record order items', url: null };
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
      } catch (addressError) {
        console.error(
          'Failed to sync checkout profile defaults before checkout:',
          addressError
        );
      }
    }

    if (couponQuote) {
      const redemption = await recordCouponRedemption({
        client: supabase as any,
        quote: couponQuote,
        orderId,
        provider: 'stripe',
        discountTotal,
        userId,
        customerEmail,
        metadata: {
          currency: selectedCurrency.code,
          subtotal: totalAmount,
          shipping_total: shippingAmount,
          tax_total: manualTaxAmount,
        },
      });

      // The redemption counter is enforced atomically in the DB. If it was already exhausted the
      // coupon must not apply: fail the just-created order and stop before a Stripe session is
      // created, rather than letting the N+1 buyer check out with a discount they cannot claim.
      if (!redemption.success) {
        await supabase.from('orders').update({ status: 'failed' }).eq('id', orderId);
        return { url: null, error: 'Coupon is no longer available.', errorKey: 'ecommerce.coupon_invalid' };
      }
    }

    const stripeCustomerId = await upsertStripeCheckoutCustomer({
      email: customerEmail,
      phone: customerPhone,
      userId,
      billingAddress,
      shippingAddress,
    });

    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: `${siteUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${siteUrl}/checkout`,
        locale: resolveStripeCheckoutLocale(locale),
        line_items: lineItems,
        automatic_tax:
          taxCalculation.enabled && taxCalculation.mode === 'automatic'
            ? { enabled: true }
            : undefined,
        billing_address_collection: 'auto',
        customer: stripeCustomerId || undefined,
        customer_email: stripeCustomerId ? undefined : customerEmail || undefined,
        customer_creation: stripeCustomerId ? undefined : 'if_required',
        customer_update: stripeCustomerId
          ? {
              name: 'auto',
              address: 'auto',
              shipping: 'auto',
            }
          : undefined,
        shipping_address_collection: hasPhysicalProducts
          ? {
              allowed_countries: STRIPE_ALLOWED_COUNTRIES,
            }
          : undefined,
        metadata: {
          orderId,
          taxMode: taxCalculation.mode,
          currencyCode: selectedCurrency.code,
          couponCode: couponQuote?.code || '',
        },
      });

      const { error: updateOrderError } = await supabase
        .from('orders')
        .update({ stripe_session_id: session.id })
        .eq('id', orderId);

      if (updateOrderError) {
        console.error('Failed to save Stripe session ID on order:', updateOrderError);
      }

      return { url: session.url };
    } catch (error: any) {
      console.error('Stripe session creation failed:', error);
      await supabase.from('orders').update({ status: 'failed' }).eq('id', orderId);

      // Never hand a raw Stripe message to a shopper. Stripe's own text for a bad key
      // ("Invalid API Key provided: sk_test_*ummy") is meaningless to them and leaks
      // implementation detail; the real cause is already in the server log above.
      const isConfigError =
        error?.name === 'StripeNotConfiguredError' ||
        error?.type === 'StripeAuthenticationError';

      if (isConfigError) {
        return {
          error:
            'This store is not able to take payments right now. Please contact the seller to complete your purchase.',
          errorKey: 'ecommerce.checkout_payments_unavailable',
          errorStatus: 503,
          url: null,
        };
      }

      return {
        error: 'Something went wrong while preparing your checkout. Please try again.',
        errorKey: 'ecommerce.checkout_internal_server_error',
        url: null,
      };
    }
  }
}
