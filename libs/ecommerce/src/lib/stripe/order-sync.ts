import 'server-only';

import Stripe from 'stripe';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';
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

/**
 * Statuses past "paid" that a session sync keeps: a replayed webhook or a revisit of the success
 * page must never move a refunded order back to paid (that would revive it for fulfilment) nor
 * undo a shipment.
 */
const STRIPE_SYNC_KEPT_STATUSES: ReadonlySet<string> = new Set(['refunded', 'shipped']);

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
    status: STRIPE_SYNC_KEPT_STATUSES.has(orderRecord.status) ? orderRecord.status : 'paid',
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

/** What a refund event did to its order, and the amounts the affiliate ledger needs. */
export interface StripeOrderRefundSync {
  /** False when the event refunds nothing (a dispute that was won or withdrawn, another event). */
  isRefund: boolean;
  /** The order the charge paid for; null when none matches. */
  orderId: string | null;
  /** The whole charge is refunded (or the dispute was lost). */
  full: boolean;
  /** CUMULATIVE refunded amount of the charge, in its minor units (`charge.amount_refunded`). */
  refundedMinor: number;
  /** The charge amount, in the same minor units. */
  totalMinor: number;
  /** `orders.status` before this event. */
  previousStatus: string | null;
  /** True when this event moved the order to 'refunded'. */
  statusUpdated: boolean;
}

/** The Stripe calls the refund lookup may need (the client is only built when it does). */
export interface StripeRefundLookupApi {
  charges: { retrieve(id: string): Promise<{ metadata?: unknown; payment_intent?: unknown }> };
  paymentIntents: { retrieve(id: string): Promise<{ metadata?: unknown }> };
}

type StripeRefundOrderRow = {
  id: string;
  status: string | null;
  provider: string | null;
  payment_intent_id: string | null;
};

/** Only a paid order (or one already on its way) becomes refunded; others keep their status. */
const STRIPE_REFUNDABLE_ORDER_STATUSES = ['paid', 'shipped'];
const STRIPE_REFUND_ORDER_COLUMNS = 'id, status, provider, payment_intent_id';
const STRIPE_ORDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stripeObjectId(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() || null;
  }

  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id.trim() || null;
  }

  return null;
}

function stripeMetadataOrderId(metadata: unknown): string | null {
  const raw =
    metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>)['orderId'] : null;

  return typeof raw === 'string' && STRIPE_ORDER_ID_PATTERN.test(raw.trim())
    ? raw.trim().toLowerCase()
    : null;
}

function stripeMinorAmount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** A Stripe object that no longer exists (another integration's charge, a deleted test object). */
function isStripeMissingResourceError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  return record['code'] === 'resource_missing' || record['statusCode'] === 404;
}

/** What leads from a charge event to its order. */
type StripeOrderLookup = {
  paymentIntentId: string | null;
  /** A charge the event names by id only (a dispute): retrieved when nothing else leads to the order. */
  unexpandedChargeId: string | null;
  metadataOrderId: string | null;
};

type StripeRefundSignal = StripeOrderLookup & {
  full: boolean;
  refundedMinor: number;
  totalMinor: number;
};

/** A dispute names its PaymentIntent, or a charge (expanded or by id) that knows it. */
function readStripeDisputeLookup(dispute: Stripe.Dispute): StripeOrderLookup {
  const charge = dispute.charge && typeof dispute.charge === 'object' ? dispute.charge : null;

  return {
    paymentIntentId: stripeObjectId(dispute.payment_intent) ?? stripeObjectId(charge?.payment_intent),
    unexpandedChargeId: charge ? null : stripeObjectId(dispute.charge),
    metadataOrderId: stripeMetadataOrderId(charge?.metadata),
  };
}

function readStripeRefundSignal(event: Stripe.Event): StripeRefundSignal | null {
  if (event.type === 'charge.refunded') {
    const charge = event.data.object as Stripe.Charge;
    const totalMinor = stripeMinorAmount(charge.amount);
    const refundedMinor = stripeMinorAmount(charge.amount_refunded);

    return {
      full: charge.refunded === true || (totalMinor > 0 && refundedMinor >= totalMinor),
      refundedMinor,
      totalMinor,
      paymentIntentId: stripeObjectId(charge.payment_intent),
      unexpandedChargeId: null,
      metadataOrderId: stripeMetadataOrderId(charge.metadata),
    };
  }

  if (event.type === 'charge.dispute.closed') {
    const dispute = event.data.object as Stripe.Dispute;

    // Only a lost dispute takes the money back; won, prevented and warning closures do not.
    if (dispute.status !== 'lost') {
      return null;
    }

    const amount = stripeMinorAmount(dispute.amount);

    return {
      full: true,
      refundedMinor: amount,
      totalMinor: amount,
      ...readStripeDisputeLookup(dispute),
    };
  }

  return null;
}

async function findStripeOrderByPaymentIntent(
  supabase: SupabaseClient<any>,
  paymentIntentId: string
): Promise<StripeRefundOrderRow | null> {
  const { data, error } = await supabase
    .from('orders')
    .select(STRIPE_REFUND_ORDER_COLUMNS)
    .eq('payment_intent_id', paymentIntentId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(error.message || 'Order lookup failed');
  }

  return Array.isArray(data) && data[0] ? (data[0] as StripeRefundOrderRow) : null;
}

/**
 * The order a refunded charge paid for: by `payment_intent_id` (recorded when the order was
 * marked paid), else by the `orderId` the checkout wrote into the charge or PaymentIntent
 * metadata. A metadata match must be a Stripe order whose recorded PaymentIntent, if any, is
 * this one.
 */
async function findStripeRefundOrder(
  supabase: SupabaseClient<any>,
  signal: StripeOrderLookup,
  loadStripe: () => Promise<StripeRefundLookupApi>
): Promise<StripeRefundOrderRow | null> {
  let paymentIntentId = signal.paymentIntentId;
  let orderId = signal.metadataOrderId;

  if (paymentIntentId) {
    const byPaymentIntent = await findStripeOrderByPaymentIntent(supabase, paymentIntentId);

    if (byPaymentIntent) {
      return byPaymentIntent;
    }
  }

  try {
    if (!orderId && !paymentIntentId && signal.unexpandedChargeId) {
      // A dispute names its charge by id only: the charge knows the PaymentIntent.
      const charge = await (await loadStripe()).charges.retrieve(signal.unexpandedChargeId);
      orderId = stripeMetadataOrderId(charge.metadata);
      paymentIntentId = stripeObjectId(charge.payment_intent);

      if (paymentIntentId) {
        const byPaymentIntent = await findStripeOrderByPaymentIntent(supabase, paymentIntentId);

        if (byPaymentIntent) {
          return byPaymentIntent;
        }
      }
    }

    if (!orderId && paymentIntentId) {
      const paymentIntent = await (await loadStripe()).paymentIntents.retrieve(paymentIntentId);
      orderId = stripeMetadataOrderId(paymentIntent.metadata);
    }
  } catch (error) {
    if (isStripeMissingResourceError(error)) {
      return null;
    }

    throw error;
  }

  if (!orderId) {
    return null;
  }

  const { data, error } = await supabase
    .from('orders')
    .select(STRIPE_REFUND_ORDER_COLUMNS)
    .eq('id', orderId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || 'Order lookup failed');
  }

  const order = (data as StripeRefundOrderRow | null) ?? null;

  if (!order || order.provider !== 'stripe') {
    return null;
  }

  if (order.payment_intent_id && paymentIntentId && order.payment_intent_id !== paymentIntentId) {
    console.warn(
      `[Stripe Refund] Order ${order.id} belongs to another PaymentIntent; the refund is not applied to it`
    );
    return null;
  }

  return order;
}

/**
 * Applies a verified `charge.refunded` or `charge.dispute.closed` event to its order. A full
 * refund (or a lost dispute) moves a paid or shipped order to 'refunded' in one conditional
 * update, so a replay changes nothing; the database's order trigger then voids the order's
 * affiliate commission. A partial refund leaves the status alone. Database errors throw (the
 * webhook answers 5xx and Stripe redelivers). The amounts come back for the affiliate ledger,
 * which this package does not touch.
 */
export async function syncStripeOrderRefundFromEvent(
  event: Stripe.Event,
  options: { client?: SupabaseClient<any>; stripe?: StripeRefundLookupApi } = {}
): Promise<StripeOrderRefundSync> {
  const signal = readStripeRefundSignal(event);

  if (!signal) {
    return {
      isRefund: false,
      orderId: null,
      full: false,
      refundedMinor: 0,
      totalMinor: 0,
      previousStatus: null,
      statusUpdated: false,
    };
  }

  const supabase = options.client ?? (getServiceRoleSupabaseClient() as unknown as SupabaseClient<any>);
  let stripeApi: StripeRefundLookupApi | null = options.stripe ?? null;
  const loadStripe = async () => {
    stripeApi ??= (await getStripeClient()) as unknown as StripeRefundLookupApi;
    return stripeApi;
  };
  const order = await findStripeRefundOrder(supabase, signal, loadStripe);
  const result: StripeOrderRefundSync = {
    isRefund: true,
    orderId: order?.id ?? null,
    full: signal.full,
    refundedMinor: signal.refundedMinor,
    totalMinor: signal.totalMinor,
    previousStatus: order?.status ?? null,
    statusUpdated: false,
  };

  if (!order || !signal.full || !STRIPE_REFUNDABLE_ORDER_STATUSES.includes(order.status ?? '')) {
    return result;
  }

  const { data: updated, error } = await supabase
    .from('orders')
    .update({ status: 'refunded' })
    .eq('id', order.id)
    .in('status', STRIPE_REFUNDABLE_ORDER_STATUSES)
    .select('id');

  if (error) {
    throw new Error(error.message || 'Failed to mark the order refunded');
  }

  result.statusUpdated = Array.isArray(updated) && updated.length > 0;
  return result;
}

/** What a dispute event means for its order's affiliate commission. */
export interface StripeOrderDisputeSync {
  /**
   * The event opens a dispute (`charge.dispute.created`) or closes one without taking the money
   * back (`charge.dispute.closed`, any status but `lost`). A lost dispute is a refund
   * (`syncStripeOrderRefundFromEvent`), so it is not a dispute here.
   */
  isDispute: boolean;
  /** True: the dispute opened (hold the commission); false: it closed without loss (release it). */
  open: boolean;
  /** The order the disputed charge paid for; null when none matches. */
  orderId: string | null;
  /** The dispute's status (`needs_response`, `warning_needs_response`, `won`, …). */
  status: string | null;
}

function readStripeDisputeSignal(event: Stripe.Event): { open: boolean; status: string | null; lookup: StripeOrderLookup } | null {
  if (event.type !== 'charge.dispute.created' && event.type !== 'charge.dispute.closed') {
    return null;
  }

  const dispute = event.data.object as Stripe.Dispute;
  const status = typeof dispute.status === 'string' ? dispute.status : null;

  if (event.type === 'charge.dispute.closed' && status === 'lost') {
    return null;
  }

  return { open: event.type === 'charge.dispute.created', status, lookup: readStripeDisputeLookup(dispute) };
}

/**
 * Finds the order of a verified `charge.dispute.created` or `charge.dispute.closed` (not lost)
 * event, the same way a refund does (`payment_intent_id`, else the checkout's `orderId`
 * metadata). The order itself is never changed: a dispute takes no money back until it is lost.
 * The app holds or releases the order's affiliate commission with the answer. Database errors,
 * and Stripe errors other than an unknown object, throw (the webhook answers 5xx and Stripe
 * redelivers).
 */
export async function syncStripeOrderDisputeFromEvent(
  event: Stripe.Event,
  options: { client?: SupabaseClient<any>; stripe?: StripeRefundLookupApi } = {}
): Promise<StripeOrderDisputeSync> {
  const signal = readStripeDisputeSignal(event);

  if (!signal) {
    return { isDispute: false, open: false, orderId: null, status: null };
  }

  const supabase = options.client ?? (getServiceRoleSupabaseClient() as unknown as SupabaseClient<any>);
  let stripeApi: StripeRefundLookupApi | null = options.stripe ?? null;
  const loadStripe = async () => {
    stripeApi ??= (await getStripeClient()) as unknown as StripeRefundLookupApi;
    return stripeApi;
  };
  const order = await findStripeRefundOrder(supabase, signal.lookup, loadStripe);

  return { isDispute: true, open: signal.open, orderId: order?.id ?? null, status: signal.status };
}
