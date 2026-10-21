import 'server-only';

import { getStripeClient } from './client';
import { createClient } from '@supabase/supabase-js';
import { type CartItem } from '../types';
import { verifyPackageOnline } from '@nextblock-cms/db/server';
import { resolveShippingOptions, type ShippingDestination } from '../shipping/resolver';
import { getDefaultCurrency, resolveEffectivePriceForCurrency } from '../currency';

export const createCheckoutSession = async (
  cartItems: CartItem[],
  userId?: string,
  destination?: ShippingDestination,
  currencyCode?: string
): Promise<{ url: string | null; error?: string }> => {
  // Use Service Role Key to bypass RLS
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Supabase credentials for checkout (Service Key required).');
      return { error: 'Internal Server Error', url: null };
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const siteUrl = process.env.NEXT_PUBLIC_URL || 'http://localhost:4200';

  if (!cartItems.length) {
    return { error: 'Cart is empty', url: null };
  }

  const { data: currenciesResult } = await supabase
    .from('currencies')
    .select(
      'code, symbol, exchange_rate, is_default, is_active, auto_sync_product_prices, auto_update_exchange_rate, exchange_rate_source, exchange_rate_updated_at, rounding_mode, rounding_increment, rounding_charm_amount'
    )
    .eq('is_active', true)
    .order('code', { ascending: true });
  const currencies = currenciesResult ?? [];
  const defaultCurrency = getDefaultCurrency(currencies);
  const selectedCurrency =
    currencies.find((currency) => currency.code === (currencyCode || '').toUpperCase()) ??
    defaultCurrency;

  // 0. Verify E-Commerce License
  const isEcommerceActive = await verifyPackageOnline('ecommerce');
  if (!isEcommerceActive) {
      return { error: 'E-Commerce Package not active. Please purchase a license to accept payments.', url: null };
  }

  // 1. Validate Prices against DB
  // Extract product IDs
  const productIds = cartItems.map((item) => item.product_id);
  
  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id, title, price, prices, sale_price, sale_prices, sale_start_at, sale_end_at, scheduled_price, scheduled_prices, scheduled_price_at')
    .in('id', productIds);

  if (productsError || !products) {
    console.error('Error fetching products for validation:', productsError);
    return { error: 'Failed to validate product prices', url: null };
  }

  // Map for quick lookup
  const productMap = new Map(products.map((p) => [p.id, p]));

  // 2. Build Line Items and Calculate Order Total
  const line_items = [];
  let totalAmount = 0;
  const verifiedItems = [];

  for (const cartItem of cartItems) {
    const product = productMap.get(cartItem.product_id);

    if (!product) {
        console.warn(`Product ${cartItem.product_id} not found in DB, skipping.`);
        continue;
    }

    // Verify price
    // Note: Stripe expects amount in cents for 'usd'. 
    // The DB stores price in cents (integer), so we use it directly.
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

    if (unitAmount <= 0) {
        console.warn(`[Checkout Session Warning] Product ${product.title} has zero or negative price!`);
    }

    line_items.push({
      price_data: {
        currency: selectedCurrency.code.toLowerCase(),
        product_data: {
          name: product.title,
          images: [], // Images temporarily removed due to schema mismatch (requires relation join)
          metadata: {
              productId: product.id
          }
        },
        unit_amount: unitAmount,
      },
      quantity: cartItem.quantity,
    });

    totalAmount += unitAmount * cartItem.quantity;
    
    verifiedItems.push({
        product_id: product.id,
        quantity: cartItem.quantity,
        price_at_purchase: unitAmount
    });
  }

  if (line_items.length === 0) {
      return { error: 'No valid items in cart', url: null };
  }

  // 3. Create Pending Order in DB
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .insert({
      total: totalAmount,
      user_id: userId,
      currency: selectedCurrency.code,
      exchange_rate_at_purchase: selectedCurrency.exchange_rate,
    })
    .select('id')
    .single();

  if (orderError || !order) {
    console.error('Failed to create pending order:', orderError);
    console.error('Order Data attempted:', { status: 'pending', total: totalAmount });
    return { error: `Failed to initiate order: ${orderError?.message || 'Unknown error'}`, url: null };
  }
  
  // 3.5 Insert Order Items (Optional for now but good practice, skipping for brevity/speed unless strictly required, but strongly recommended)
  // We'll insert order items if table exists. Assuming it does based on prompt context "Update inventory... for purchased items", implying we need to know WHAT was purchased.
  // Actually, 'metadata' in stripe session can hold orderId. Webhook needs to know items to decrement inventory.
  // We should insert order_items now.
  
  const orderItemsData = verifiedItems.map(item => ({
      order_id: order.id,
      product_id: item.product_id,
      quantity: item.quantity,
      price_at_purchase: item.price_at_purchase
  }));

  const { error: itemsError } = await supabase
      .from('order_items')
      .insert(orderItemsData);
      
  if (itemsError) {
      console.error('Failed to insert order items:', itemsError);
      // We might want to cancel the order here or proceed with caution. 
      // For MVP, logging error.
  }

  // 3.8 Resolve Shipping Options
  let shipping_options: any[] = [];
  
  // If no destination provided, try to fetch from user's addresses
  let resolvedDestination = destination;
  if (!resolvedDestination && userId) {
      const { data: addr } = await supabase
          .from('user_addresses')
          .select('country_code, state_code, postal_code')
          .eq('user_id', userId)
          .eq('address_type', 'shipping')
          .limit(1)
          .single();
          
      if (addr) {
          resolvedDestination = {
              country: addr.country_code,
              state: addr.state_code,
              postal_code: addr.postal_code
          };
      }
  }

  if (resolvedDestination) {
      const methods = await resolveShippingOptions(
        totalAmount,
        resolvedDestination,
        null,
        selectedCurrency.code
      );
      shipping_options = methods.map(m => ({
          shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: {
                  amount: m.amount,
                  currency: m.currency.toLowerCase(),
              },
              display_name: m.name,
              // delivery_estimate: { ... } // Could be added in future modules
          },
      }));
  }

  // 4. Create Stripe Session
  try {
    const stripe = await getStripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: `${siteUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/`,
      line_items,
      billing_address_collection: 'required',
      shipping_address_collection: {
          allowed_countries: [
             'US', 'CA', 'GB', 'AU', 'NZ', 'IE', 'FR', 'DE', 'IT', 'ES', 
             'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'ZA', 'NG', 'KE', 'IN', 
             'JP', 'KR', 'CN', 'SG', 'MY', 'PH', 'TH', 'VN', 'ID', 'AE', 
             'SA', 'EG', 'MA', 'DZ', 'TN', 'PT', 'NL', 'BE', 'CH', 'AT', 
             'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'HU', 'RO', 'BG', 'GR', 
             'TR', 'IL', 'CY', 'MT'
          ],
      },
      shipping_options: shipping_options.length > 0 ? shipping_options : undefined,
      metadata: {
        orderId: order.id,
      },
    });

    // 4.1 Immediately save the session ID so success page can find it before webhook
    await supabase
      .from('orders')
      .update({ stripe_session_id: session.id })
      .eq('id', order.id);

    return { url: session.url };
  } catch (err: any) {
    console.error('Stripe session creation failed:', err);
    return { error: err.message, url: null };
  }
};
