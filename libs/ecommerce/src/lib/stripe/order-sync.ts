import Stripe from 'stripe';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@nextblock-cms/db';
import {
  CustomerAddressInput,
  normalizeCustomerAddress,
  normalizeOrderCustomerDetails,
  type OrderCustomerDetails,
} from '../customer';
import { upsertDefaultUserAddresses } from '../customer-addresses';
import { applyOrderInventoryDeduction } from '../order-inventory';
import {
  buildOrderTaxDetailsFromStripeSession,
  normalizeOrderTaxDetails,
} from '../order-tax-details';
import { assignInvoiceMetadata } from '../invoice-server';
import { getStripeClient } from './client';

const STRIPE_CHECKOUT_SESSION_TAX_EXPANDS = ['total_details.breakdown'] as const;
const STRIPE_CHECKOUT_LINE_ITEM_TAX_EXPANDS = ['data.taxes.rate'] as const;

function getServiceRoleSupabaseClient() {
  // Accept the Vercel Marketplace integration's new key names too.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase Service Role environment variables');
  }

  return createSupabaseClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function fromStripeAddress(
  address?: Stripe.Address | Stripe.AddressParam | null,
  recipientName?: string | null
): CustomerAddressInput | null {
  if (!address) {
    return null;
  }

  return normalizeCustomerAddress({
    recipient_name: recipientName,
    line1: address.line1 ?? null,
    line2: address.line2 ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    postal_code: address.postal_code ?? null,
    country_code: address.country ?? null,
  });
}

function parseStoredCustomerDetails(value: unknown): OrderCustomerDetails {
  const details = (value ?? {}) as Partial<OrderCustomerDetails>;

  return normalizeOrderCustomerDetails({
    email: typeof details.email === 'string' ? details.email : null,
    name: typeof details.name === 'string' ? details.name : null,
    phone: typeof details.phone === 'string' ? details.phone : null,
    billing: details.billing ?? null,
    shipping: details.shipping ?? null,
  });
}

export async function syncStripeOrderFromSession(session: Stripe.Checkout.Session) {
  const supabase = getServiceRoleSupabaseClient();
  const stripe = await getStripeClient();
  let detailedSession = session;

  try {
    detailedSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: [...STRIPE_CHECKOUT_SESSION_TAX_EXPANDS],
    });
  } catch (error) {
    console.error('[Stripe Sync] Failed to rehydrate session tax details:', error);
  }

  const orderId = detailedSession.metadata?.orderId;

  let orderQuery = supabase
    .from('orders')
    .select(
      'id, user_id, status, total, currency, subtotal, shipping_total, tax_total, tax_details, customer_details'
    )
    .eq('stripe_session_id', session.id)
    .maybeSingle();

  if (orderId) {
    orderQuery = supabase
      .from('orders')
      .select(
        'id, user_id, status, total, currency, subtotal, shipping_total, tax_total, tax_details, customer_details'
      )
      .eq('id', orderId)
      .maybeSingle();
  }

  const { data: orderRecord, error: orderFetchError } = await orderQuery;

  if (orderFetchError || !orderRecord) {
    throw new Error(orderFetchError?.message || 'Order lookup failed');
  }

  const existingDetails = parseStoredCustomerDetails(orderRecord.customer_details);
  const existingTaxDetails = normalizeOrderTaxDetails(orderRecord.tax_details);
  const stripeBilling = fromStripeAddress(
    detailedSession.customer_details?.address,
    detailedSession.customer_details?.name ?? existingDetails.name
  );
  // Stripe moved the collected shipping address from `shipping_details` to
  // `collected_information.shipping_details` in API version 2025-03-31.basil, so on every
  // current API version (the SDK pins 2026-08-26.dahlia) the old field is undefined and the
  // Stripe-collected address was silently dropped. It only went unnoticed because the address
  // stored at checkout creation wins below. The legacy read stays as a fallback for sessions
  // retrieved through an account pinned to an older API version.
  type StripeShippingDetails = NonNullable<
    NonNullable<typeof detailedSession.collected_information>['shipping_details']
  >;
  const legacyShipping = (
    detailedSession as unknown as { shipping_details?: StripeShippingDetails | null }
  ).shipping_details;
  const collectedShipping =
    detailedSession.collected_information?.shipping_details ?? legacyShipping ?? null;
  const stripeShipping = fromStripeAddress(
    collectedShipping?.address,
    collectedShipping?.name ?? existingDetails.name
  );

  const mergedCustomerDetails = normalizeOrderCustomerDetails({
    email: detailedSession.customer_details?.email ?? existingDetails.email,
    name: detailedSession.customer_details?.name ?? existingDetails.name,
    phone: detailedSession.customer_details?.phone ?? existingDetails.phone,
    billing: existingDetails.billing ?? stripeBilling,
    shipping: existingDetails.shipping ?? stripeShipping,
  });

  const wasAlreadyPaid = orderRecord.status === 'paid';
  const lineItemsResponse = await stripe.checkout.sessions.listLineItems(detailedSession.id, {
    limit: 100,
    expand: [...STRIPE_CHECKOUT_LINE_ITEM_TAX_EXPANDS],
  });
  const finalizedStripeTaxDetails = buildOrderTaxDetailsFromStripeSession({
    session: detailedSession,
    lineItems: lineItemsResponse.data,
    subtotal:
      typeof orderRecord.subtotal === 'number'
        ? orderRecord.subtotal
        : existingTaxDetails?.subtotal ?? 0,
    shippingTotal:
      typeof orderRecord.shipping_total === 'number'
        ? orderRecord.shipping_total
        : existingTaxDetails?.shipping_total ?? 0,
    fallbackMode: existingTaxDetails?.mode ?? 'automatic',
    currency:
      (detailedSession.currency ?? orderRecord.currency ?? existingTaxDetails?.currency ?? 'USD').toUpperCase(),
  });
  const finalizedTaxDetails =
    finalizedStripeTaxDetails.tax_total > 0 || finalizedStripeTaxDetails.lines.length > 0
      ? finalizedStripeTaxDetails
      : existingTaxDetails ?? finalizedStripeTaxDetails;
  const finalizedTaxTotal =
    finalizedTaxDetails?.tax_total ??
    (typeof orderRecord.tax_total === 'number' ? orderRecord.tax_total : 0);
  const finalizedCurrency =
    (detailedSession.currency ?? orderRecord.currency ?? finalizedTaxDetails?.currency ?? 'USD').toUpperCase();

  const updateData = {
    status: 'paid',
    stripe_session_id: detailedSession.id,
    payment_intent_id:
      typeof detailedSession.payment_intent === 'string' ? detailedSession.payment_intent : null,
    provider: 'stripe',
    customer_details: mergedCustomerDetails as any,
    total:
      typeof detailedSession.amount_total === 'number'
        ? detailedSession.amount_total
        : orderRecord.total,
    currency: finalizedCurrency,
    tax_total: finalizedTaxTotal,
    tax_details: finalizedTaxDetails as any,
  };

  const { error: updateError } = await supabase
    .from('orders')
    .update(updateData)
    .eq('id', orderRecord.id);

  if (updateError) {
    throw new Error(updateError.message);
  }

  if (orderRecord.user_id) {
    try {
      await upsertDefaultUserAddresses({
        userId: orderRecord.user_id,
        billingAddress: mergedCustomerDetails.billing,
        shippingAddress: mergedCustomerDetails.shipping,
        client: supabase,
      });
    } catch (addressError) {
      console.error('[Stripe Sync] Failed to refresh saved customer addresses:', addressError);
    }
  }

  const invoiceMetadata = await assignInvoiceMetadata({
    orderId: orderRecord.id,
    client: supabase,
  });

  await applyOrderInventoryDeduction(supabase, orderRecord.id);

  return {
    orderId: orderRecord.id,
    alreadyPaid: wasAlreadyPaid,
    customerDetails: mergedCustomerDetails,
    order: {
      id: orderRecord.id,
      invoice_number: invoiceMetadata.invoiceNumber,
      paid_at: invoiceMetadata.paidAt,
      total: updateData.total,
      currency: finalizedCurrency,
      subtotal:
        typeof orderRecord.subtotal === 'number'
          ? orderRecord.subtotal
          : finalizedTaxDetails?.subtotal ?? 0,
      shipping_total:
        typeof orderRecord.shipping_total === 'number'
          ? orderRecord.shipping_total
          : finalizedTaxDetails?.shipping_total ?? 0,
      tax_total: finalizedTaxTotal,
      tax_details: finalizedTaxDetails,
    },
  };
}
