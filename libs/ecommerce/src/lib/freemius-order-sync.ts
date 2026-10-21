import 'server-only';

import crypto from 'crypto';
import { Freemius } from '@freemius/sdk';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  evaluateFreemiusLicenseClaim,
  parseFreemiusTimestamp,
  retrieveFreemiusLicenseRecords,
  type FreemiusLicenseClaimRejection,
  type FreemiusLicenseRecordLike,
  type FreemiusLicenseRecords,
  type FreemiusUserRecordLike,
} from './freemius-license-claim';
import { assignInvoiceMetadata } from './invoice-server';
import { applyOrderInventoryDeduction } from './order-inventory';
import {
  parseFreemiusCheckoutCredentialsMap,
  readFreemiusEnvValue,
  resolveFreemiusCheckoutCredentials,
} from './providers/freemius';

export type FreemiusTrackedOrderStatus =
  | 'pending'
  | 'trial'
  | 'paid'
  | 'shipped'
  | 'cancelled'
  | 'refunded';

type SupabaseLikeClient = SupabaseClient<any>;

type FreemiusCheckoutPurchase = {
  initial_amount?: number | string | null;
  initialAmount?: number | string | null;
  gross?: number | string | null;
  total_gross?: number | string | null;
  totalGross?: number | string | null;
  trial_ends?: string | null;
  trialEnds?: string | null;
  canceled_at?: string | null;
  canceledAt?: string | null;
  license_id?: string | number | null;
  licenseId?: string | number | null;
  subscription_id?: string | number | null;
  subscriptionId?: string | number | null;
  user_id?: string | number | null;
  userId?: string | number | null;
  plugin_id?: string | number | null;
  product_id?: string | number | null;
  productId?: string | number | null;
  plan_id?: string | number | null;
  planId?: string | number | null;
  pricing_id?: string | number | null;
  pricingId?: string | number | null;
};

type FreemiusCheckoutTrial = {
  id?: string | number | null;
  license_id?: string | number | null;
  licenseId?: string | number | null;
  payment_id?: string | number | null;
  plugin_id?: string | number | null;
  product_id?: string | number | null;
  productId?: string | number | null;
  subscription_id?: string | number | null;
  subscriptionId?: string | number | null;
  user_id?: string | number | null;
  userId?: string | number | null;
  canceled_at?: string | null;
  canceledAt?: string | null;
  converted_at?: string | null;
  convertedAt?: string | null;
  trial_ends_at?: string | null;
  trialEndsAt?: string | null;
  with_payment_method?: boolean | null;
};

export type FreemiusCheckoutResponse = {
  purchase?: FreemiusCheckoutPurchase | null;
  trial?: FreemiusCheckoutTrial | null;
  user?: {
    id?: string | number | null;
    email?: string | null;
  } | null;
};

type FreemiusOrderRow = {
  id: string;
  status: FreemiusTrackedOrderStatus | string;
  provider: string | null;
  created_at?: string | null;
  freemius_product_id?: string | null;
  freemius_plan_id?: string | null;
  freemius_license_id?: string | null;
  freemius_subscription_id?: string | null;
  freemius_trial_id?: string | null;
  freemius_user_id?: string | null;
  freemius_trial_ends_at?: string | null;
};

type FreemiusOrderMetadata = {
  freemius_product_id?: string | null;
  freemius_plan_id?: string | null;
  freemius_license_id?: string | null;
  freemius_subscription_id?: string | null;
  freemius_trial_id?: string | null;
  freemius_user_id?: string | null;
  freemius_trial_ends_at?: string | null;
};

type FreemiusWebhookEvent = {
  id?: string | number | null;
  type?: string;
  data?: Record<string, any> | null;
  objects?: Record<string, any> | null;
};

function toStringOrNull(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  return String(value);
}

function toIsoOrNull(value: unknown) {
  const raw = toStringOrNull(value);

  if (!raw) {
    return null;
  }

  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const parsed = new Date(normalized);

  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

function toNumberOrNull(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function hasPositiveAmount(...values: unknown[]) {
  return values.some((value) => {
    const parsed = toNumberOrNull(value);
    return parsed !== null && parsed > 0;
  });
}

function isCancellableStatus(status: string | null | undefined) {
  return status === 'pending' || status === 'trial';
}

function isCancellationEvent(eventType: string | null | undefined) {
  return [
    'license.cancelled',
    'license.deleted',
    'license.expired',
    'subscription.cancelled',
    'subscription.renewal.failed.last',
    'trial.cancelled',
    'trial.expired',
  ].includes(eventType || '');
}

function isPaidConversionEvent(eventType: string | null | undefined, eventData?: Record<string, any> | null) {
  return (
    eventType === 'license.extended' &&
    (eventData?.is_renewal === true ||
      eventData?.is_renewal === 1 ||
      eventData?.is_renewal === '1' ||
      eventData?.is_renewal === 'true')
  );
}

function isPositivePaymentEvent(event: FreemiusWebhookEvent) {
  const payment = event.objects?.payment ?? event.data?.payment ?? event.data;

  return (
    event.type === 'payment.created' &&
    hasPositiveAmount(
      payment?.gross,
      payment?.total_gross,
      payment?.amount,
      payment?.initial_amount
    )
  );
}

export function extractFreemiusCheckoutMetadata(
  response: FreemiusCheckoutResponse | null | undefined
): FreemiusOrderMetadata {
  const purchase = response?.purchase ?? null;
  const trial = response?.trial ?? null;

  return {
    freemius_product_id:
      toStringOrNull(purchase?.plugin_id) ??
      toStringOrNull(purchase?.product_id) ??
      toStringOrNull(purchase?.productId) ??
      toStringOrNull(trial?.plugin_id) ??
      toStringOrNull(trial?.product_id) ??
      toStringOrNull(trial?.productId),
    freemius_plan_id:
      toStringOrNull(purchase?.plan_id) ??
      toStringOrNull(purchase?.planId),
    freemius_license_id:
      toStringOrNull(purchase?.license_id) ??
      toStringOrNull(purchase?.licenseId) ??
      toStringOrNull(trial?.license_id) ??
      toStringOrNull(trial?.licenseId),
    freemius_subscription_id:
      toStringOrNull(purchase?.subscription_id) ??
      toStringOrNull(purchase?.subscriptionId) ??
      toStringOrNull(trial?.subscription_id) ??
      toStringOrNull(trial?.subscriptionId),
    freemius_trial_id: toStringOrNull(trial?.id),
    freemius_user_id:
      toStringOrNull(purchase?.user_id) ??
      toStringOrNull(purchase?.userId) ??
      toStringOrNull(trial?.user_id) ??
      toStringOrNull(trial?.userId) ??
      toStringOrNull(response?.user?.id),
    freemius_trial_ends_at:
      toIsoOrNull(trial?.trial_ends_at) ??
      toIsoOrNull(trial?.trialEndsAt) ??
      toIsoOrNull(purchase?.trial_ends) ??
      toIsoOrNull(purchase?.trialEnds),
  };
}

export function resolveFreemiusStatusFromCheckoutResponse(
  response: FreemiusCheckoutResponse | null | undefined,
  currentStatus = 'pending'
): FreemiusTrackedOrderStatus {
  const purchase = response?.purchase ?? null;
  const trial = response?.trial ?? null;

  if (currentStatus === 'paid') {
    return 'paid';
  }

  if (
    trial &&
    (trial.canceled_at || trial.canceledAt) &&
    isCancellableStatus(currentStatus)
  ) {
    return 'cancelled';
  }

  if (trial) {
    return 'trial';
  }

  if (!purchase) {
    return currentStatus as FreemiusTrackedOrderStatus;
  }

  if (
    (purchase.canceled_at || purchase.canceledAt) &&
    isCancellableStatus(currentStatus)
  ) {
    return 'cancelled';
  }

  if (
    hasPositiveAmount(
      purchase.initial_amount,
      purchase.initialAmount,
      purchase.gross,
      purchase.total_gross,
      purchase.totalGross
    )
  ) {
    return 'paid';
  }

  if (purchase.trial_ends || purchase.trialEnds || purchase.subscription_id || purchase.subscriptionId) {
    return 'trial';
  }

  return currentStatus as FreemiusTrackedOrderStatus;
}

export function resolveFreemiusStatusFromWebhookEvent(input: {
  event: FreemiusWebhookEvent;
  currentStatus: string;
  purchaseData?: Record<string, any> | null;
}) {
  const { event, currentStatus, purchaseData } = input;

  if (currentStatus === 'paid' && isCancellationEvent(event.type)) {
    return 'paid';
  }

  if (isCancellationEvent(event.type)) {
    return isCancellableStatus(currentStatus)
      ? 'cancelled'
      : (currentStatus as FreemiusTrackedOrderStatus);
  }

  if (isPositivePaymentEvent(event) || isPaidConversionEvent(event.type, event.data)) {
    return 'paid';
  }

  if (
    purchaseData &&
    hasPositiveAmount(
      purchaseData.initialAmount,
      purchaseData.initial_amount,
      purchaseData.gross,
      purchaseData.totalGross,
      purchaseData.total_gross
    )
  ) {
    return 'paid';
  }

  if (purchaseData?.canceled === true && isCancellableStatus(currentStatus)) {
    return 'cancelled';
  }

  // A free trial (no payment method) has no subscription and no positive
  // amount, so the only reliable "this is a trial" signal is the trial end
  // date carried on the purchase data. Without this a no-card trial would be
  // left as "pending" forever whenever purchase data is available.
  if (
    currentStatus === 'pending' &&
    (purchaseData?.trialEndsAt ||
      purchaseData?.trial_ends_at ||
      purchaseData?.trialEnds ||
      purchaseData?.trial_ends)
  ) {
    return 'trial';
  }

  if (
    purchaseData?.subscriptionId ||
    purchaseData?.subscription_id ||
    event.type === 'subscription.created' ||
    event.type === 'license.created'
  ) {
    return currentStatus === 'pending' ? 'trial' : (currentStatus as FreemiusTrackedOrderStatus);
  }

  return currentStatus as FreemiusTrackedOrderStatus;
}

// Combine the statuses resolved from the browser checkout callback and from
// Freemius purchase data, returning the furthest-along state without ever
// downgrading an order that is already paid. "paid" wins, then "cancelled",
// then "trial"; otherwise the current status is kept.
function mergeFreemiusCheckoutStatus(
  currentStatus: FreemiusTrackedOrderStatus,
  ...candidates: Array<FreemiusTrackedOrderStatus | null>
): FreemiusTrackedOrderStatus {
  const resolved = candidates.filter(
    (value): value is FreemiusTrackedOrderStatus => Boolean(value)
  );

  if (currentStatus === 'paid' || resolved.includes('paid')) {
    return 'paid';
  }

  if (resolved.includes('cancelled')) {
    return 'cancelled';
  }

  if (resolved.includes('trial')) {
    return 'trial';
  }

  if (resolved.includes('shipped')) {
    return 'shipped';
  }

  if (resolved.includes('refunded')) {
    return 'refunded';
  }

  return currentStatus;
}

function buildMetadataUpdate(metadata: FreemiusOrderMetadata, eventType: string | null) {
  const update: Record<string, any> = {
    freemius_last_event_type: eventType,
    freemius_last_synced_at: new Date().toISOString(),
  };

  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined && value !== null && value !== '') {
      update[key] = value;
    }
  }

  return update;
}

function getServiceRoleSupabaseClient() {
  // Accept the Vercel Marketplace integration's new key names too.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Supabase Service Role environment variables');
  }

  return createSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function getFreemiusOrderById(client: SupabaseLikeClient, orderId: string) {
  const { data, error } = await (client as any)
    .from('orders')
    .select(
      'id, status, provider, created_at, freemius_product_id, freemius_plan_id, freemius_license_id, freemius_subscription_id, freemius_trial_id, freemius_user_id, freemius_trial_ends_at'
    )
    .eq('id', orderId)
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'Order not found');
  }

  return data as FreemiusOrderRow;
}

async function getFreemiusOrderByLicenseId(client: SupabaseLikeClient, licenseId: string) {
  const { data, error } = await (client as any)
    .from('orders')
    .select(
      'id, status, provider, created_at, freemius_product_id, freemius_plan_id, freemius_license_id, freemius_subscription_id, freemius_trial_id, freemius_user_id, freemius_trial_ends_at'
    )
    .eq('freemius_license_id', licenseId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data as FreemiusOrderRow | null) ?? null;
}

async function applyFreemiusOrderState(input: {
  client: SupabaseLikeClient;
  order: FreemiusOrderRow;
  nextStatus: FreemiusTrackedOrderStatus;
  metadata: FreemiusOrderMetadata;
  eventType: string | null;
}) {
  const update = buildMetadataUpdate(input.metadata, input.eventType);
  const currentStatus = input.order.status;
  const nextStatus =
    currentStatus === 'paid' && input.nextStatus !== 'paid'
      ? 'paid'
      : input.nextStatus;

  if (nextStatus !== currentStatus) {
    update.status = nextStatus;
  }

  const { error } = await (input.client as any)
    .from('orders')
    .update(update)
    .eq('id', input.order.id);

  if (error) {
    throw new Error(error.message);
  }

  if (nextStatus === 'paid' && currentStatus !== 'paid') {
    await assignInvoiceMetadata({
      orderId: input.order.id,
      client: input.client,
    });
    await applyOrderInventoryDeduction(input.client, input.order.id);
  }

  return nextStatus;
}

/** Clock skew tolerated between Freemius and this server when ordering timestamps. */
const FREEMIUS_CLOCK_SKEW_MS = 5 * 60_000;

/** What a refused checkout sync tells the browser, whatever the reason (logged server-side). */
export const FREEMIUS_CHECKOUT_SYNC_REFUSED_MESSAGE =
  'This checkout could not be verified with Freemius. Your license key is in your purchase email.';

export type FreemiusCheckoutLicenseRejection =
  | FreemiusLicenseClaimRejection
  | 'license_linked_to_other_order'
  | 'license_predates_order'
  | 'missing_order_product'
  | 'no_license_in_callback'
  | 'order_has_other_license';

/**
 * Pure decision for the browser checkout sync: may this order be linked to the license the
 * checkout callback named? The callback is attacker-controlled (anyone holding an order can
 * POST it with any license id), and the success page and the order history reveal the linked
 * license's key, so a link is accepted only when Freemius itself says the license is the
 * buyer's fresh, never-activated license for THIS order's product (the vendor claim rules),
 * it was created after the order, and no other order holds it. Product and plan ids always
 * come from the order or from Freemius, never from the callback.
 */
export function evaluateFreemiusCheckoutLicense(input: {
  callbackEmail: string | null | undefined;
  callbackUserId: string | null | undefined;
  license: FreemiusLicenseRecordLike | null | undefined;
  licenseId: string | null | undefined;
  linkedToOtherOrder: boolean;
  now?: Date;
  order: Pick<FreemiusOrderRow, 'created_at' | 'freemius_license_id' | 'freemius_product_id'>;
  user: FreemiusUserRecordLike | null | undefined;
}): { ok: true } | { ok: false; reason: FreemiusCheckoutLicenseRejection } {
  const licenseId = toStringOrNull(input.licenseId);
  const productId = toStringOrNull(input.order.freemius_product_id);

  if (!licenseId) {
    return { ok: false, reason: 'no_license_in_callback' };
  }
  if (!productId) {
    return { ok: false, reason: 'missing_order_product' };
  }
  const linked = toStringOrNull(input.order.freemius_license_id);
  if (linked && linked !== licenseId) {
    return { ok: false, reason: 'order_has_other_license' };
  }
  if (input.linkedToOtherOrder) {
    return { ok: false, reason: 'license_linked_to_other_order' };
  }

  const claim = evaluateFreemiusLicenseClaim({
    license: input.license,
    now: input.now,
    request: {
      email: input.callbackEmail ?? '',
      kind: 'purchase',
      licenseId,
      productId,
      userId: toStringOrNull(input.callbackUserId) ?? '',
    },
    user: input.user,
  });
  if (!claim.ok) {
    return claim;
  }

  const orderCreated = input.order.created_at ? Date.parse(input.order.created_at) : Number.NaN;
  const licenseCreated = parseFreemiusTimestamp(input.license?.created);
  if (
    !Number.isFinite(orderCreated) ||
    licenseCreated === null ||
    licenseCreated < orderCreated - FREEMIUS_CLOCK_SKEW_MS
  ) {
    return { ok: false, reason: 'license_predates_order' };
  }

  return { ok: true };
}

async function isLicenseLinkedToAnotherOrder(client: SupabaseLikeClient, licenseId: string, orderId: string) {
  const { data, error } = await (client as any)
    .from('orders')
    .select('id')
    .eq('freemius_license_id', licenseId)
    .neq('id', orderId)
    .limit(1);

  if (error) {
    throw new Error(error.message);
  }

  return Array.isArray(data) && data.length > 0;
}

export async function syncFreemiusCheckoutOrder(input: {
  orderId: string;
  checkoutResponse?: FreemiusCheckoutResponse | null;
  client?: SupabaseLikeClient;
  /** Freemius lookup; injectable for tests. */
  retrieveLicense?: (productId: string, licenseId: string) => Promise<FreemiusLicenseRecords>;
  now?: Date;
}) {
  const client = input.client ?? getServiceRoleSupabaseClient();
  const order = await getFreemiusOrderById(client, input.orderId);

  if (order.provider !== 'freemius') {
    return {
      success: false,
      error: 'Only Freemius orders can be synced from Freemius checkout',
    };
  }

  const checkoutMetadata = extractFreemiusCheckoutMetadata(input.checkoutResponse);
  const licenseId = checkoutMetadata.freemius_license_id ?? null;
  const productId = toStringOrNull(order.freemius_product_id);
  const alreadyLinked = Boolean(licenseId) && toStringOrNull(order.freemius_license_id) === licenseId;

  // A license already linked to this order was verified when it was linked (or linked by a
  // signed webhook); re-syncing it only re-applies the callback state. Anything else is
  // verified against Freemius before a single field is written.
  let verifiedLicense: FreemiusLicenseRecordLike | null = null;
  if (!alreadyLinked) {
    let decision: ReturnType<typeof evaluateFreemiusCheckoutLicense>;
    if (!licenseId || !productId) {
      decision = evaluateFreemiusCheckoutLicense({
        callbackEmail: null,
        callbackUserId: null,
        license: null,
        licenseId,
        linkedToOtherOrder: false,
        order,
        user: null,
      });
    } else {
      const records = await (input.retrieveLicense ?? retrieveFreemiusLicenseRecords)(productId, licenseId);
      if (!records.ok) {
        console.error(
          `[Freemius Checkout Sync] Could not verify license ${licenseId} for order ${order.id}: ${records.reason}`
        );
        return { success: false, error: FREEMIUS_CHECKOUT_SYNC_REFUSED_MESSAGE };
      }
      decision = evaluateFreemiusCheckoutLicense({
        callbackEmail: input.checkoutResponse?.user?.email ?? null,
        callbackUserId: checkoutMetadata.freemius_user_id ?? null,
        license: records.license,
        licenseId,
        linkedToOtherOrder: await isLicenseLinkedToAnotherOrder(client, licenseId, order.id),
        now: input.now,
        order,
        user: records.user,
      });
      verifiedLicense = records.license;
    }

    if (!decision.ok) {
      console.warn(
        `[Freemius Checkout Sync] Refused license ${licenseId ?? '(none)'} for order ${order.id}: ${decision.reason}`
      );
      return { success: false, error: FREEMIUS_CHECKOUT_SYNC_REFUSED_MESSAGE };
    }
  }

  // Ids Freemius vouched for (or the order already holds) replace the callback's.
  const trustedMetadata: FreemiusOrderMetadata = {
    ...checkoutMetadata,
    freemius_product_id: productId,
    freemius_plan_id:
      toStringOrNull(verifiedLicense?.plan_id) ?? toStringOrNull(order.freemius_plan_id) ?? null,
    freemius_license_id: licenseId,
    freemius_user_id:
      toStringOrNull(verifiedLicense?.user_id) ?? toStringOrNull(order.freemius_user_id) ?? null,
  };
  let purchaseData: Record<string, any> | null = null;

  if (licenseId) {
    try {
      purchaseData = await retrieveFreemiusPurchaseData(productId, licenseId);
    } catch (error) {
      console.error('[Freemius Checkout Sync] Failed to retrieve purchase data:', error);
    }
  }

  const event = {
    type: 'checkout.purchaseCompleted',
    data: { license_id: checkoutMetadata.freemius_license_id },
    objects: {},
  };
  const metadata = {
    ...trustedMetadata,
    ...getEventMetadata(event, purchaseData),
    // Purchase data is fetched for this order's product; keep the order's product id
    // authoritative whatever it reports.
    freemius_product_id: productId,
  };
  const callbackStatus = resolveFreemiusStatusFromCheckoutResponse(
    input.checkoutResponse,
    order.status
  );
  const webhookStatus = purchaseData
    ? resolveFreemiusStatusFromWebhookEvent({
        event,
        currentStatus: order.status,
        purchaseData,
      })
    : null;
  // The browser checkout callback can confirm a trial, but it must never be
  // trusted to assert a *paid* state on its own (the amount can be missing or
  // tampered with client-side). Only purchase data fetched from Freemius may
  // promote an order to "paid".
  const trustedCallbackStatus =
    callbackStatus === 'paid'
      ? (order.status as FreemiusTrackedOrderStatus)
      : callbackStatus;
  // Take the most advanced state either signal reports, so a valid "trial" from
  // the callback is not lost when purchase-data resolution can only see
  // "pending" (e.g. a no-card trial with no subscription).
  const nextStatus = mergeFreemiusCheckoutStatus(
    order.status as FreemiusTrackedOrderStatus,
    trustedCallbackStatus,
    webhookStatus
  );
  const status = await applyFreemiusOrderState({
    client,
    order,
    nextStatus,
    metadata,
    eventType: 'checkout.purchaseCompleted',
  });

  return {
    success: true,
    orderId: order.id,
    status,
    metadata,
  };
}

function getEventLicenseId(event: FreemiusWebhookEvent) {
  return (
    toStringOrNull(event.data?.license_id) ??
    toStringOrNull(event.objects?.license?.id) ??
    toStringOrNull(event.objects?.subscription?.license_id) ??
    toStringOrNull(event.objects?.payment?.license_id) ??
    toStringOrNull(event.data?.payment?.license_id)
  );
}

function getEventMetadata(event: FreemiusWebhookEvent, purchaseData?: Record<string, any> | null) {
  const license = event.objects?.license;
  const subscription = event.objects?.subscription;
  const trial = event.objects?.trial;
  const payment = event.objects?.payment ?? event.data?.payment;

  return {
    freemius_product_id:
      toStringOrNull(purchaseData?.productId) ??
      toStringOrNull(purchaseData?.product_id) ??
      toStringOrNull(license?.plugin_id) ??
      toStringOrNull(subscription?.plugin_id) ??
      toStringOrNull(payment?.plugin_id),
    freemius_plan_id:
      toStringOrNull(purchaseData?.planId) ??
      toStringOrNull(purchaseData?.plan_id) ??
      toStringOrNull(license?.plan_id),
    freemius_license_id:
      toStringOrNull(purchaseData?.licenseId) ??
      toStringOrNull(purchaseData?.license_id) ??
      getEventLicenseId(event),
    freemius_subscription_id:
      toStringOrNull(purchaseData?.subscriptionId) ??
      toStringOrNull(purchaseData?.subscription_id) ??
      toStringOrNull(subscription?.id) ??
      toStringOrNull(event.data?.subscription_id),
    freemius_trial_id:
      toStringOrNull(trial?.id) ??
      toStringOrNull(event.data?.trial_id),
    freemius_user_id:
      toStringOrNull(purchaseData?.userId) ??
      toStringOrNull(purchaseData?.user_id) ??
      toStringOrNull(event.objects?.user?.id),
    freemius_trial_ends_at:
      toIsoOrNull(trial?.trial_ends_at) ??
      toIsoOrNull(trial?.trial_ends) ??
      toIsoOrNull(license?.trial_ends) ??
      toIsoOrNull(purchaseData?.trialEndsAt) ??
      toIsoOrNull(purchaseData?.trial_ends_at),
  };
}

async function retrieveFreemiusPurchaseData(productId: string | null | undefined, licenseId: string) {
  if (!productId) {
    return null;
  }

  const credentials = resolveFreemiusCheckoutCredentials(productId);

  if (!credentials.apiKey || !credentials.secretKey || !credentials.publicKey) {
    return null;
  }

  const freemius = new Freemius({
    productId: Number(productId),
    apiKey: credentials.apiKey,
    secretKey: credentials.secretKey,
    publicKey: credentials.publicKey,
  });

  return freemius.purchase.retrievePurchaseData(licenseId);
}

export async function syncFreemiusOrderFromWebhookEvent(input: {
  event: FreemiusWebhookEvent;
  client?: SupabaseLikeClient;
}) {
  const client = input.client ?? getServiceRoleSupabaseClient();
  const licenseId = getEventLicenseId(input.event);

  if (!licenseId) {
    return {
      success: true,
      ignored: true,
      reason: 'missing_license_id',
      type: input.event.type,
    };
  }

  const order = await getFreemiusOrderByLicenseId(client, licenseId);

  if (!order) {
    return {
      success: true,
      ignored: true,
      reason: 'unknown_license_id',
      licenseId,
      type: input.event.type,
    };
  }

  let purchaseData: Record<string, any> | null = null;

  try {
    purchaseData = await retrieveFreemiusPurchaseData(
      order.freemius_product_id ?? input.event.objects?.license?.plugin_id,
      licenseId
    );
  } catch (error) {
    console.error('[Freemius Sync] Failed to retrieve purchase data:', error);
  }

  const metadata = getEventMetadata(input.event, purchaseData);
  const nextStatus = resolveFreemiusStatusFromWebhookEvent({
    event: input.event,
    currentStatus: order.status,
    purchaseData,
  });
  const status = await applyFreemiusOrderState({
    client,
    order,
    nextStatus,
    metadata,
    eventType: input.event.type ?? null,
  });

  return {
    success: true,
    orderId: order.id,
    status,
    type: input.event.type,
  };
}

export function getFreemiusWebhookSecretCandidates() {
  const candidates = [
    readFreemiusEnvValue('FREEMIUS_SECRET_KEY'),
    readFreemiusEnvValue('FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY'),
    ...Object.values(parseFreemiusCheckoutCredentialsMap() ?? {}).map(
      (entry) => entry.secretKey ?? null
    ),
  ];

  return Array.from(
    new Set(candidates.filter((value): value is string => Boolean(value)))
  );
}

export function verifyFreemiusWebhookSignature(rawBody: string, signature: string | null) {
  if (!signature) {
    return false;
  }

  return getFreemiusWebhookSecretCandidates().some((secretKey) => {
    const hash = crypto.createHmac('sha256', secretKey).update(rawBody).digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(hash, 'hex'),
        Buffer.from(signature, 'hex')
      );
    } catch {
      return false;
    }
  });
}
