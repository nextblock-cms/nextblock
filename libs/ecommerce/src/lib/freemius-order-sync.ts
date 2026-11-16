import 'server-only';

import crypto from 'crypto';
import { Freemius } from '@freemius/sdk';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  evaluateFreemiusLicenseClaim,
  logFreemiusCredentialsRefused,
  parseFreemiusTimestamp,
  retrieveFreemiusLicenseRecords,
  watchFreemiusAnswers,
  type FreemiusLicenseClaimRejection,
  type FreemiusLicenseRecordLike,
  type FreemiusLicenseRecords,
  type FreemiusUserRecordLike,
} from './freemius-license-claim';
import {
  FREEMIUS_USER_FIELDS,
  FREEMIUS_WEBHOOK_SECRET_MAX_AGE_MS,
  freemiusDeveloperRequest,
  getFreemiusProductKeys,
  isFreemiusApiError,
  orNullWhenNotFound,
  toFreemiusId,
  withFreemiusDeveloperScope,
  type FreemiusDeveloperStatus,
  type FreemiusProductKeys,
} from './freemius-developer-api';
import {
  createFreemiusLogThrottle,
  decideFreemiusOneProductStandIn,
  freemiusKeysMayBeDeveloperPair,
  isUnboundFreemiusProduct,
  parseFreemiusCheckoutCredentialsMap,
  readFreemiusEnvValue,
} from './freemius-key-policy';
import { assignInvoiceMetadata } from './invoice-server';
import { applyOrderInventoryDeduction } from './order-inventory';
import { resolveFreemiusCheckoutCredentials } from './providers/freemius';

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

export type FreemiusWebhookEvent = {
  id?: string | number | null;
  type?: string;
  /**
   * The product the event belongs to. Freemius sends it on every event; the webhook route refuses
   * an event without one and stamps the id of the product whose secret verified the event here.
   */
  plugin_id?: string | number | null;
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
  // Pinned states: a paid order is never downgraded by a later lifecycle event, and a refunded
  // one is never revived (a replayed payment or license event, or a revisit of the checkout
  // sync, would otherwise mark the refunded sale paid again).
  const nextStatus =
    currentStatus === 'refunded'
      ? 'refunded'
      : currentStatus === 'paid' && input.nextStatus !== 'paid'
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

function freemiusIdString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

/** "YYYY-MM-DD HH:mm:ss" (UTC, as Freemius sends it) → Date, as `@freemius/sdk` parses it. */
function parseFreemiusDateTime(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;

  const [datePart, timePart, ...rest] = value.split(' ');

  if (!datePart || !timePart || rest.length > 0) return null;

  const date = datePart.split('-').map((part) => Number.parseInt(part, 10));
  const time = timePart.split(':').map((part) => Number.parseInt(part, 10));

  if (date.length !== 3 || time.length !== 3 || [...date, ...time].some((part) => Number.isNaN(part))) return null;

  return new Date(Date.UTC(date[0], date[1] - 1, date[2], time[0], time[1], time[2], 0));
}

function parseFreemiusNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;

  const parsed = Number.parseFloat(value);

  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Purchase data exactly as `@freemius/sdk` `purchase.retrievePurchaseData()` returns it
 * (PurchaseInfo.toData), from a license, its owner and its subscription (null for a license
 * without one). The webhook and checkout status rules read this shape.
 */
function toFreemiusPurchaseData(
  user: Record<string, any>,
  license: Record<string, any>,
  subscription: Record<string, any> | null
): Record<string, any> {
  const expiration = license.expiration ? parseFreemiusDateTime(license.expiration) : null;
  const canceled = license.is_cancelled ?? false;
  const billingCycle = subscription ? Number.parseInt(String(subscription.billing_cycle ?? ''), 10) : null;
  const currency = subscription && typeof subscription.currency === 'string' ? subscription.currency.toLowerCase() : null;
  const gateway = subscription && typeof subscription.gateway === 'string' ? subscription.gateway : null;

  return {
    email: user.email,
    firstName: user.first ?? '',
    lastName: user.last ?? '',
    userId: freemiusIdString(license.user_id),
    planId: freemiusIdString(license.plan_id),
    pricingId: freemiusIdString(license.pricing_id),
    licenseId: freemiusIdString(license.id),
    expiration,
    canceled,
    subscriptionId: subscription ? freemiusIdString(subscription.id) : null,
    billingCycle: subscription ? (billingCycle === 1 ? 'monthly' : billingCycle === 12 ? 'yearly' : 'oneoff') : null,
    quota: license.quota ?? null,
    isActive: !canceled && !(expiration && expiration < new Date()),
    initialAmount: subscription ? parseFreemiusNumber(subscription.initial_amount) : null,
    renewalAmount: subscription ? parseFreemiusNumber(subscription.renewal_amount) : null,
    currency: currency === 'usd' ? 'USD' : currency === 'eur' ? 'EUR' : currency === 'gbp' ? 'GBP' : null,
    renewalDate: subscription?.next_payment ? parseFreemiusDateTime(subscription.next_payment) : null,
    paymentMethod: gateway?.startsWith('stripe') ? 'card' : gateway?.startsWith('paypal') ? 'paypal' : null,
    created: parseFreemiusDateTime(license.created) ?? new Date(),
  };
}

/** retrievePurchaseData at developer scope: the license, its subscription (404: none) and its owner. */
async function retrieveFreemiusPurchaseDataAtDeveloperScope(productId: string, licenseId: string) {
  const license = await orNullWhenNotFound(
    freemiusDeveloperRequest<Record<string, any>>({ path: `/plugins/${productId}/licenses/${licenseId}.json` })
  );

  if (!license || !license.id) {
    return null;
  }

  const subscription = await orNullWhenNotFound(
    freemiusDeveloperRequest<Record<string, any>>({ path: `/plugins/${productId}/licenses/${licenseId}/subscription.json` })
  );
  const userId = toFreemiusId(license.user_id);
  const user = userId
    ? await orNullWhenNotFound(
        freemiusDeveloperRequest<Record<string, any>>({
          path: `/plugins/${productId}/users/${userId}.json`,
          query: { fields: FREEMIUS_USER_FIELDS },
        })
      )
    : null;

  if (!user || !user.id) {
    return null;
  }

  return toFreemiusPurchaseData(user, license, subscription && subscription.id ? subscription : null);
}

/**
 * The purchase behind a license: with the developer key pair when it works and the account owns
 * the product, else with the product's bearer (`@freemius/sdk`). Null without either, or for ids
 * that are not Freemius ids. A 401/403 on the license, subscription or user lookup is logged as a
 * configuration error (`logFreemiusCredentialsRefused`, throttled): the developer pair then falls
 * back to the bearer, and a refused bearer reads as no purchase data, as before, never silently.
 */
async function retrieveFreemiusPurchaseData(productId: string | null | undefined, licenseId: string) {
  const freemiusProductId = toFreemiusId(productId);
  const freemiusLicenseId = toFreemiusId(licenseId);

  if (!freemiusProductId || !freemiusLicenseId) {
    return null;
  }

  const viaDeveloper = await withFreemiusDeveloperScope(freemiusProductId, async () => {
    try {
      return await retrieveFreemiusPurchaseDataAtDeveloperScope(freemiusProductId, freemiusLicenseId);
    } catch (error) {
      if (isFreemiusApiError(error) && error.kind === 'auth') {
        logFreemiusCredentialsRefused('developer', freemiusProductId, error.status, 'purchase data lookup');
      }

      throw error;
    }
  });

  if (viaDeveloper.handled) {
    return viaDeveloper.value;
  }

  const credentials = resolveFreemiusCheckoutCredentials(freemiusProductId);

  if (!credentials.apiKey || !credentials.secretKey || !credentials.publicKey) {
    return null;
  }

  const freemius = new Freemius({
    productId: Number(freemiusProductId),
    apiKey: credentials.apiKey,
    secretKey: credentials.secretKey,
    publicKey: credentials.publicKey,
  });
  // The SDK reads any failed lookup as "no purchase": its answers' statuses tell a refused token apart.
  const statuses = watchFreemiusAnswers(freemius);
  const purchaseData = await freemius.purchase.retrievePurchaseData(freemiusLicenseId);
  const refused = statuses.find((status) => status === 401 || status === 403);

  if (refused !== undefined) {
    logFreemiusCredentialsRefused('bearer', freemiusProductId, refused, 'purchase data lookup');
  }

  return purchaseData;
}

/**
 * Which product's orders a signed webhook event may change: the product whose secret verified it.
 * The route passes that id (`productId`, from `getFreemiusWebhookVerification`) and stamps it on the
 * event as `plugin_id`, which the verification requires and checks the signature with; a caller
 * that passes no id gets the event's own `plugin_id`.
 * - `undefined`: no product at all (a caller outside the webhook route, such as a test): the order
 *   of the license is used, as before.
 * - `null`: the ids disagree, or one is not a Freemius id: no order matches.
 */
function resolveWebhookProductScope(
  event: FreemiusWebhookEvent | null | undefined,
  productId: string | undefined
): string | null | undefined {
  const named = event?.plugin_id;
  const namedId = toFreemiusId(named);
  const namesProduct = named !== undefined && named !== null && named !== '';

  if (productId === undefined) {
    return namesProduct ? namedId : undefined;
  }

  const verifiedId = toFreemiusId(productId);

  return verifiedId && (!namesProduct || namedId === verifiedId) ? verifiedId : null;
}

/** A value from a signed event, safe to print on one log line. */
function forLogLine(value: unknown): string {
  const printable = String(value ?? '').replace(/[^\w.:-]/g, '').slice(0, 64);
  return printable || '(none)';
}

/**
 * `orderProduct` names what the order is for in the line: its stored product by default, or the
 * products its items name (`deriveOrderFreemiusProducts`) for an order that stores none.
 */
function warnWebhookProductMismatch(
  eventType: string | null | undefined,
  licenseId: string,
  order: FreemiusOrderRow,
  scope: string | null,
  orderProduct = `product ${toFreemiusId(order.freemius_product_id) ?? '(none)'}`
) {
  console.warn(
    `[Freemius Webhook] Skipped ${forLogLine(eventType)} for license ${forLogLine(licenseId)}: its order ${order.id} is ` +
      `for ${orderProduct}, not for product ${scope ?? '(none)'}, whose secret verified the event.`
  );
}

/**
 * An order that stores no product and whose items prove none is logged at most once a minute per
 * order: Freemius sends several events per purchase, refund or cancellation, and each would repeat
 * the same line. 50 orders a window at most.
 */
const shouldLogUnprovenOrderProduct = createFreemiusLogThrottle({ windowMs: 60_000, maxKeys: 50 });

function warnWebhookOrderProductUnproven(
  eventType: string | null | undefined,
  licenseId: string,
  order: FreemiusOrderRow,
  scope: string
) {
  if (!shouldLogUnprovenOrderProduct(order.id)) {
    return;
  }

  console.warn(
    `[Freemius Webhook] Skipped ${forLogLine(eventType)} for license ${forLogLine(licenseId)}: its order ${order.id} records no ` +
      `Freemius product and its items prove none (no items, an item whose product is gone, or a product without a Freemius ` +
      `Product ID), so it cannot be tied to product ${scope}, whose secret verified the event. Fill in the Freemius Product ID ` +
      'of the product it sold (CMS → Products), or the order’s freemius_product_id, for later events to apply.'
  );
}

/**
 * The Freemius products an order's own items name, from the database alone: each item's product,
 * then that product's `freemius_product_id` (what checkout bound the order to). `complete` is true
 * when the order has items and every one of them names a product with a Freemius Product ID.
 * Database errors throw, so the webhook answers 5xx and Freemius redelivers.
 */
async function deriveOrderFreemiusProducts(
  client: SupabaseLikeClient,
  orderId: string
): Promise<{ productIds: string[]; complete: boolean }> {
  const { data: items, error: itemsError } = await (client as any)
    .from('order_items')
    .select('product_id')
    .eq('order_id', orderId);

  if (itemsError) {
    throw new Error(itemsError.message || 'Failed to read the order items');
  }

  const localIds = (Array.isArray(items) ? items : []).map((item: { product_id?: unknown }) => toStringOrNull(item?.product_id));
  const knownIds = Array.from(new Set(localIds.filter((id): id is string => id !== null)));
  const freemiusIdByProduct = new Map<string, string | null>();

  if (knownIds.length > 0) {
    const { data: products, error: productsError } = await (client as any)
      .from('products')
      .select('id, freemius_product_id')
      .in('id', knownIds);

    if (productsError) {
      throw new Error(productsError.message || 'Failed to read the order products');
    }

    for (const product of Array.isArray(products) ? products : []) {
      freemiusIdByProduct.set(String(product?.id), toFreemiusId(product?.freemius_product_id));
    }
  }

  const freemiusIds = localIds.map((id) => (id === null ? null : freemiusIdByProduct.get(id) ?? null));

  return {
    productIds: Array.from(new Set(freemiusIds.filter((id): id is string => id !== null))),
    complete: freemiusIds.length > 0 && freemiusIds.every((id) => id !== null),
  };
}

/**
 * Writes the product the items proved into an order that stored none, unless something wrote one
 * meanwhile (the update matches the value read). Throws on a database error.
 */
async function backfillOrderFreemiusProduct(client: SupabaseLikeClient, order: FreemiusOrderRow, productId: string) {
  const update = (client as any).from('orders').update({ freemius_product_id: productId }).eq('id', order.id);
  const { error } = await (order.freemius_product_id === null || order.freemius_product_id === undefined
    ? update.is('freemius_product_id', null)
    : update.eq('freemius_product_id', order.freemius_product_id));

  if (error) {
    throw new Error(error.message || 'Failed to record the order product');
  }
}

/**
 * Whether a signed event may act on the order of its license: every order for a caller that names
 * no product (`scope` undefined), none when the ids disagree (`null`), otherwise only an order of
 * the verified product. An order that stores no product (written before checkout stored it, or
 * imported without it) is that product's only when its own items prove it
 * (`deriveOrderFreemiusProducts`: every item's product carries that Freemius Product ID), never on
 * the event's word: a forged event signed with one product's secret can name any license, and any
 * product in its objects. The proof is then written to the order's `freemius_product_id`, whichever
 * handler runs (a dispute or a renewal's refund included), so later events read it directly. An
 * order out of scope is logged, without a database read when it stores a product.
 */
async function isOrderInWebhookProductScope(input: {
  client: SupabaseLikeClient;
  order: FreemiusOrderRow;
  scope: string | null | undefined;
  eventType: string | null | undefined;
  licenseId: string;
}): Promise<boolean> {
  const { client, order, scope, eventType, licenseId } = input;

  if (scope === undefined) {
    return true;
  }

  if (scope === null || toStringOrNull(order.freemius_product_id) !== null) {
    if (scope !== null && toFreemiusId(order.freemius_product_id) === scope) {
      return true;
    }

    warnWebhookProductMismatch(eventType, licenseId, order, scope);
    return false;
  }

  const derived = await deriveOrderFreemiusProducts(client, order.id);

  if (derived.complete && derived.productIds.length === 1 && derived.productIds[0] === scope) {
    await backfillOrderFreemiusProduct(client, order, scope);
    return true;
  }

  if (derived.productIds.some((productId) => productId !== scope)) {
    warnWebhookProductMismatch(
      eventType,
      licenseId,
      order,
      scope,
      `${derived.productIds.length === 1 ? 'product' : 'products'} ${derived.productIds.join(', ')} (from its items)`
    );
    return false;
  }

  warnWebhookOrderProductUnproven(eventType, licenseId, order, scope);
  return false;
}

export async function syncFreemiusOrderFromWebhookEvent(input: {
  event: FreemiusWebhookEvent;
  client?: SupabaseLikeClient;
  /**
   * The product whose secret verified the event (`getFreemiusWebhookVerification`): the order of
   * another product is skipped. Defaults to the event's own `plugin_id`.
   */
  productId?: string;
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

  const productScope = resolveWebhookProductScope(input.event, input.productId);

  if (!(await isOrderInWebhookProductScope({ client, order, scope: productScope, eventType: input.event.type, licenseId }))) {
    return {
      success: true,
      ignored: true,
      reason: 'product_mismatch',
      licenseId,
      type: input.event.type,
    };
  }

  let purchaseData: Record<string, any> | null = null;

  try {
    // In scope, the verified product is the order's own (stored, or proven by its items).
    purchaseData = await retrieveFreemiusPurchaseData(
      productScope ?? order.freemius_product_id ?? input.event.objects?.license?.plugin_id,
      licenseId
    );
  } catch (error) {
    console.error('[Freemius Sync] Failed to retrieve purchase data:', error);
  }

  const metadata = getEventMetadata(input.event, purchaseData);

  if (productScope) {
    // The order stays with the product that verified the event, whatever product its objects name.
    metadata.freemius_product_id = productScope;
  }

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

/**
 * Freemius events that take a payment back, every one a FULL refund: `payment.refund` (the name
 * Freemius sends; `payment.refunded` is accepted too) and a dispute that was lost or closed by
 * refunding. The webhook route handles these INSTEAD of `syncFreemiusOrderFromWebhookEvent`,
 * whose purchase-data path would read the refunded purchase as paid.
 */
export const FREEMIUS_REFUND_EVENT_TYPES = [
  'payment.refund',
  'payment.refunded',
  'payment.dispute.lost',
  'payment.dispute.closed',
] as const;

/**
 * Dispute events that refund nothing: opened, or won by the store. Never synced (their purchase
 * data would read as paid) and the order status never changes; the app holds the order's
 * affiliate commission while the dispute is open and releases it when the store wins
 * (`syncFreemiusOrderDisputeFromWebhookEvent`).
 */
export const FREEMIUS_DISPUTE_EVENT_TYPES = ['payment.dispute.created', 'payment.dispute.won'] as const;

export function isFreemiusRefundEventType(type: unknown): boolean {
  return typeof type === 'string' && (FREEMIUS_REFUND_EVENT_TYPES as readonly string[]).includes(type);
}

export function isFreemiusDisputeEventType(type: unknown): boolean {
  return typeof type === 'string' && (FREEMIUS_DISPUTE_EVENT_TYPES as readonly string[]).includes(type);
}

/** What a refund event did to its order. */
export interface FreemiusOrderRefundSync {
  /** False when the event is not a refund. */
  isRefund: boolean;
  /**
   * The refunded payment was a renewal: the order records the first purchase, which stands,
   * and renewals never earned a commission, so nothing is applied.
   */
  isRenewal: boolean;
  /** The order of the event's license; null when none matches. */
  orderId: string | null;
  /** `orders.status` before this event. */
  previousStatus: string | null;
  /** True when this event moved the order to 'refunded'. */
  statusUpdated: boolean;
  /**
   * Why nothing was applied to an order, when nothing was. `product_mismatch`: the license's order
   * is for another product than the one whose secret verified the event, or stores no product and
   * its items prove none (`orderId` stays null).
   */
  reason: 'not_a_refund' | 'missing_license_id' | 'unknown_license_id' | 'product_mismatch' | 'renewal' | null;
}

/** Only a paid order becomes refunded; a pending, trial or cancelled one keeps its status. */
const FREEMIUS_REFUNDABLE_ORDER_STATUSES = ['paid', 'shipped'];

function isFreemiusFlagSet(value: unknown) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/**
 * Applies a signed Freemius refund or lost-dispute event to the order of its license: a paid
 * order moves to 'refunded' in one conditional update (a replay changes nothing), and the
 * database's order trigger voids its affiliate commission. A renewal's refund changes nothing,
 * and so does an event for an order of another product than the one whose secret verified it
 * (`productId`, else the event's `plugin_id`), or for an order that stores no product and whose
 * items prove none (`isOrderInWebhookProductScope`). Database errors throw so the webhook answers
 * 5xx and Freemius redelivers.
 */
export async function syncFreemiusOrderRefundFromWebhookEvent(input: {
  event: FreemiusWebhookEvent;
  client?: SupabaseLikeClient;
  /** The product whose secret verified the event (`getFreemiusWebhookVerification`). */
  productId?: string;
}): Promise<FreemiusOrderRefundSync> {
  const eventType = input.event?.type ?? null;
  const result: FreemiusOrderRefundSync = {
    isRefund: false,
    isRenewal: false,
    orderId: null,
    previousStatus: null,
    statusUpdated: false,
    reason: 'not_a_refund',
  };

  if (!isFreemiusRefundEventType(eventType)) {
    return result;
  }

  const payment = input.event.objects?.payment ?? input.event.data?.payment ?? input.event.data ?? null;
  result.isRefund = true;
  result.isRenewal = isFreemiusFlagSet(payment?.is_renewal);

  const licenseId = getEventLicenseId(input.event);

  if (!licenseId) {
    result.reason = 'missing_license_id';
    return result;
  }

  const client = input.client ?? getServiceRoleSupabaseClient();
  const order = await getFreemiusOrderByLicenseId(client, licenseId);

  if (!order) {
    result.reason = 'unknown_license_id';
    return result;
  }

  const productScope = resolveWebhookProductScope(input.event, input.productId);

  if (!(await isOrderInWebhookProductScope({ client, order, scope: productScope, eventType, licenseId }))) {
    result.reason = 'product_mismatch';
    return result;
  }

  result.orderId = order.id;
  result.previousStatus = order.status ?? null;

  if (result.isRenewal) {
    result.reason = 'renewal';
    return result;
  }

  result.reason = null;

  if (!FREEMIUS_REFUNDABLE_ORDER_STATUSES.includes(order.status)) {
    return result;
  }

  const { data, error } = await (client as any)
    .from('orders')
    .update({
      status: 'refunded',
      freemius_last_event_type: eventType,
      freemius_last_synced_at: new Date().toISOString(),
    })
    .eq('id', order.id)
    .in('status', FREEMIUS_REFUNDABLE_ORDER_STATUSES)
    .select('id');

  if (error) {
    throw new Error(error.message || 'Failed to mark the order refunded');
  }

  result.statusUpdated = Array.isArray(data) && data.length > 0;
  return result;
}

/** What a dispute event means for its order's affiliate commission. */
export interface FreemiusOrderDisputeSync {
  /** False when the event neither opens a dispute nor closes one the store won. */
  isDispute: boolean;
  /** True: the dispute opened (hold the commission); false: the store won it (release it). */
  open: boolean;
  /** The disputed payment was a renewal: the first purchase's commission is not affected. */
  isRenewal: boolean;
  /** The order of the event's license; null when none matches. */
  orderId: string | null;
  /**
   * Why no commission is concerned, when none is. `product_mismatch`: the license's order is for
   * another product than the one whose secret verified the event, or stores no product and its
   * items prove none (`orderId` stays null).
   */
  reason: 'not_a_dispute' | 'missing_license_id' | 'unknown_license_id' | 'product_mismatch' | 'renewal' | null;
}

/**
 * Finds the order of a signed `payment.dispute.created` or `payment.dispute.won` event by its
 * license, without changing its status (a dispute takes no money back until it is lost or closed by
 * a refund, which `syncFreemiusOrderRefundFromWebhookEvent` handles; an order that stored no
 * product gets the one its items prove). A dispute on a renewal payment concerns no commission, and
 * neither does an order of another product than the one whose secret verified the event
 * (`productId`, else the event's `plugin_id`). Database errors throw so the webhook answers 5xx and
 * Freemius redelivers.
 */
export async function syncFreemiusOrderDisputeFromWebhookEvent(input: {
  event: FreemiusWebhookEvent;
  client?: SupabaseLikeClient;
  /** The product whose secret verified the event (`getFreemiusWebhookVerification`). */
  productId?: string;
}): Promise<FreemiusOrderDisputeSync> {
  const eventType = input.event?.type ?? null;
  const result: FreemiusOrderDisputeSync = {
    isDispute: false,
    open: false,
    isRenewal: false,
    orderId: null,
    reason: 'not_a_dispute',
  };

  if (!isFreemiusDisputeEventType(eventType)) {
    return result;
  }

  const payment = input.event.objects?.payment ?? input.event.data?.payment ?? input.event.data ?? null;
  result.isDispute = true;
  result.open = eventType === 'payment.dispute.created';
  result.isRenewal = isFreemiusFlagSet(payment?.is_renewal);

  const licenseId = getEventLicenseId(input.event);

  if (!licenseId) {
    result.reason = 'missing_license_id';
    return result;
  }

  const client = input.client ?? getServiceRoleSupabaseClient();
  const order = await getFreemiusOrderByLicenseId(client, licenseId);

  if (!order) {
    result.reason = 'unknown_license_id';
    return result;
  }

  const productScope = resolveWebhookProductScope(input.event, input.productId);

  if (!(await isOrderInWebhookProductScope({ client, order, scope: productScope, eventType, licenseId }))) {
    result.reason = 'product_mismatch';
    return result;
  }

  result.orderId = order.id;
  result.reason = result.isRenewal ? 'renewal' : null;
  return result;
}

/**
 * The configured webhook secrets of ONE product (Freemius signs each product's webhooks with that
 * product's own secret key): its FREEMIUS_CHECKOUT_PRODUCTS_JSON entry, and the one-product secret
 * (FREEMIUS_SECRET_KEY, with its sandbox override FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY) only when
 * FREEMIUS_PRODUCT_ID names that product, so another product's secret never verifies its events.
 * A `productId` that is not a Freemius id has none. Without options: every configured secret, an
 * inventory, never a list to verify an event with. The synchronous check of older routes uses it
 * as is; the async check (`resolveFreemiusBoundWebhookSecrets`) also drops a FREEMIUS_PRODUCT_ID-bound
 * secret that may be a developer pair's, which a synchronous check cannot ask about.
 */
export function getFreemiusWebhookSecretCandidates(options?: { productId?: string | null }) {
  const credentialsMap = parseFreemiusCheckoutCredentialsMap() ?? {};
  let candidates: unknown[];

  if (options === undefined) {
    candidates = [
      readFreemiusEnvValue('FREEMIUS_SECRET_KEY'),
      readFreemiusEnvValue('FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY'),
      ...Object.values(credentialsMap).map((entry) => entry?.secretKey ?? null),
    ];
  } else {
    const productId = toFreemiusId(options.productId);
    const ownsSingleProductSecret =
      productId !== null && toFreemiusId(readFreemiusEnvValue('FREEMIUS_PRODUCT_ID')) === productId;

    candidates = productId
      ? [
          Object.prototype.hasOwnProperty.call(credentialsMap, productId) ? credentialsMap[productId]?.secretKey ?? null : null,
          ...(ownsSingleProductSecret
            ? [readFreemiusEnvValue('FREEMIUS_SECRET_KEY'), readFreemiusEnvValue('FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY')]
            : []),
        ]
      : [];
  }

  return Array.from(new Set(candidates.filter((value): value is string => typeof value === 'string' && Boolean(value))));
}

/**
 * The bound secrets the async check accepts for `productId` (a Freemius id): its
 * FREEMIUS_CHECKOUT_PRODUCTS_JSON entry, and the secrets FREEMIUS_PRODUCT_ID binds to it
 * (FREEMIUS_SECRET_KEY, and its Freemius-sandbox override) unless the key policy finds that key set
 * is, or may be, a developer pair (`freemiusKeysMayBeDeveloperPair`, the rule the checkout's bound
 * keys follow): with the one-product names holding the developer pair, a Product ID let that secret,
 * revoked or leaked included, verify the product's payments and refunds. The synchronous check of
 * older routes keeps `getFreemiusWebhookSecretCandidates` as it was (it cannot ask).
 */
async function resolveFreemiusBoundWebhookSecrets(productId: string): Promise<string[]> {
  const credentialsMap = parseFreemiusCheckoutCredentialsMap() ?? {};
  const secrets: Array<string | null> = [
    Object.prototype.hasOwnProperty.call(credentialsMap, productId) ? credentialsMap[productId]?.secretKey ?? null : null,
  ];

  if (toFreemiusId(readFreemiusEnvValue('FREEMIUS_PRODUCT_ID')) === productId) {
    const keySets = [
      { publicKey: readFreemiusEnvValue('FREEMIUS_PUBLIC_KEY'), secretKey: readFreemiusEnvValue('FREEMIUS_SECRET_KEY') },
      {
        publicKey: readFreemiusEnvValue('FREEMIUS_ECOMMERCE_SANDBOX_PUBLIC_KEY'),
        secretKey: readFreemiusEnvValue('FREEMIUS_ECOMMERCE_SANDBOX_SECRET_KEY'),
      },
    ];

    for (const keys of keySets) {
      if (keys.secretKey && !(await freemiusKeysMayBeDeveloperPair(keys))) {
        secrets.push(keys.secretKey);
      }
    }
  }

  return Array.from(new Set(secrets.filter((value): value is string => typeof value === 'string' && Boolean(value))));
}

/**
 * The one-product secret (FREEMIUS_SECRET_KEY) for a product without bound keys (no entry of its
 * own, FREEMIUS_PRODUCT_ID empty: `isUnboundFreemiusProduct`); null otherwise. The Payments screen
 * let that Product ID stay empty, and such an install sells products without an entry on the
 * one-product keys. The async check uses it only where the key policy lets the one-product keys
 * stand in (`decideFreemiusOneProductStandIn`); the synchronous check of older routes applies it as is.
 */
function getUnscopedSingleProductSecret(productId: string): string | null {
  return isUnboundFreemiusProduct(productId) ? readFreemiusEnvValue('FREEMIUS_SECRET_KEY') : null;
}

/** A presented signature: the 64 hex characters of an HMAC-SHA256, or null. */
function normalizeFreemiusSignature(signature: string | null | undefined): string | null {
  const trimmed = typeof signature === 'string' ? signature.trim() : '';
  return /^[0-9a-f]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** HMAC-SHA256 of the raw body with `secretKey`, compared with the presented hex signature in constant time. */
function freemiusSignatureMatches(secretKey: string, rawBody: string, signature: string): boolean {
  const expected = crypto.createHmac('sha256', secretKey).update(rawBody).digest();
  const presented = Buffer.from(signature, 'hex');

  return presented.length === expected.length && crypto.timingSafeEqual(expected, presented);
}

/**
 * The product a webhook names (`plugin_id`), read only to choose which secret to check the
 * signature with. Nothing else in the body is used before the signature checks out. An event
 * without one is refused (Freemius always sends it), and an id only selects that product's own
 * secret, so a forged id gains nothing without that product's secret.
 */
function readFreemiusWebhookProductId(rawBody: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? toFreemiusId((parsed as Record<string, unknown>)['plugin_id'])
      : null;
  } catch {
    return null;
  }
}

/** A product secret read more than this long ago is read once more when a signature fails (rotation). */
const FREEMIUS_WEBHOOK_KEY_REFRESH_AFTER_MS = 60_000;

/** What `getFreemiusWebhookVerification` concluded about a webhook. */
export type FreemiusWebhookVerification =
  /** Signed with the secret of `productId`, the product the event names: process it, for that product's orders only. */
  | { outcome: 'valid'; productId: string }
  /** Not signed for the product it names, or it names none, or the signature is malformed: answer 401. */
  | {
      outcome: 'invalid';
      productId: string | null;
      reason: 'malformed_signature' | 'missing_product_id' | 'signature_mismatch';
    }
  /**
   * The app could not check it: the developer key pair owns (or may own) the product, the product's
   * secret could not be read from Freemius, and no configured secret of THAT product matched. Answer
   * 503 so Freemius redelivers it, and never process it.
   * - `product_key_read_failed`: reading the product's keys failed (Freemius unreachable, throttled,
   *   or the product list it last answered lacks the id while its re-read went unanswered), or the
   *   last keys it returned are older than FREEMIUS_WEBHOOK_SECRET_MAX_AGE_MS.
   * - `product_keys_unavailable`: the account lists the product, but Freemius returned no keys for it.
   * - `developer_pair_unreachable`: Freemius could not be asked whether the pair owns the product.
   * - `developer_pair_refused`: Freemius refuses the configured pair (rotated or revoked keys).
   * - `one_product_keys_unconfirmed`: the event matches the one-product secret, the only configured
   *   "pair" is those names and Freemius refuses it, and Freemius did not answer whether those keys
   *   are this product's own (`confirmFreemiusOneProductKeys`).
   */
  | {
      outcome: 'unverifiable';
      productId: string;
      reason:
        | 'product_key_read_failed'
        | 'product_keys_unavailable'
        | 'developer_pair_unreachable'
        | 'developer_pair_refused'
        | 'one_product_keys_unconfirmed';
      /** The developer key pair's state (`getFreemiusDeveloperStatus`), for the log line; never key material. */
      developerStatus: FreemiusDeveloperStatus['state'] | 'unknown';
    };

type FreemiusWebhookUnverifiableReason = Extract<FreemiusWebhookVerification, { outcome: 'unverifiable' }>['reason'];

/** A product's failed key read is logged at most once per window. */
const KEY_READ_FAILURE_LOG_WINDOW_MS = 60_000;
/**
 * At most this many products are remembered, and so logged, per window. plugin_id is whatever the
 * sender wrote, and an id missing from the account's list reaches the failure path while Freemius
 * does not answer, so both the memory and the lines that forged webhooks can cause stay bounded.
 */
const KEY_READ_FAILURE_LOG_MAX_PRODUCTS = 50;

/**
 * Whether a failed key read of a product is logged now. While Freemius throttles the developer
 * key, every forged webhook ends here without a request being sent (the failure is remembered), so
 * an unthrottled line per webhook let anyone fill the logs.
 */
const shouldLogKeyReadFailure = createFreemiusLogThrottle({
  windowMs: KEY_READ_FAILURE_LOG_WINDOW_MS,
  maxKeys: KEY_READ_FAILURE_LOG_MAX_PRODUCTS,
});

function describeKeyReadError(error: unknown): string {
  return isFreemiusApiError(error) ? `${error.kind}: ${error.message}` : 'unexpected error';
}

/** Logs a product's failed key read (digits, an error kind and Freemius' message: never key material), throttled. */
function logFreemiusProductKeyReadFailure(productId: string, detail: string) {
  if (!shouldLogKeyReadFailure(productId)) {
    return;
  }

  console.error(`[Freemius Webhook] Could not read product ${productId}'s keys with the developer key pair:`, detail);
}

/**
 * Checks a Freemius webhook over its raw body, before the event is parsed for use: the
 * `x-signature` header is the hex HMAC-SHA256 of the body with the secret key of the product the
 * event names (`plugin_id`), compared in constant time. An event that names no product is refused.
 *
 * 1. When the developer key pair owns the product, its secret is the one read from Freemius (read
 *    once more after a minute, for a rotated secret), and no other secret is tried. Keys served
 *    from memory through an outage verify for FREEMIUS_WEBHOOK_SECRET_MAX_AGE_MS at most: past
 *    that, they count as a failed read.
 * 2. The product's bound secrets (`resolveFreemiusBoundWebhookSecrets`): its
 *    FREEMIUS_CHECKOUT_PRODUCTS_JSON entry, or the one-product secret when FREEMIUS_PRODUCT_ID
 *    names it, unless the one-product keys are, or may be, a developer pair (the checkout's rule
 *    for its bound keys). After a failed read in step 1, nothing else.
 * 3. The one-product secret for a product without bound keys, only where the key policy lets the
 *    one-product keys stand in (`decideFreemiusOneProductStandIn`, the rule the checkout follows):
 *    no developer pair, the public sandbox, a product outside a working developer account (never
 *    when the one-product names hold the developer pair), or a refused "pair" that is only the
 *    one-product names, once Freemius confirms they are this product's keys. That confirmation is
 *    asked for only after the signature matches the one-product secret (a forger without it sends
 *    nothing to Freemius): refused gives `invalid`, no answer gives `unverifiable`. Never while a
 *    dedicated pair is refused or Freemius is unreachable.
 * 4. When the pair owns (or may own) the product and its secret could not be read, the outcome is
 *    `unverifiable`: the route answers 503, so Freemius redelivers the event, never 401.
 *
 * `valid` carries the product id the handlers must keep to (`productId` on the order syncs); the
 * outcome is an object, so test `outcome === 'valid'`, never its truthiness. Always `await` it.
 * Call `hydrateFreemiusEnvFromDb()` first.
 */
export async function getFreemiusWebhookVerification(
  rawBody: string,
  signature: string | null
): Promise<FreemiusWebhookVerification> {
  const presented = normalizeFreemiusSignature(signature);

  if (!presented) {
    return { outcome: 'invalid', productId: null, reason: 'malformed_signature' };
  }

  const productId = readFreemiusWebhookProductId(rawBody);

  if (!productId) {
    return { outcome: 'invalid', productId: null, reason: 'missing_product_id' };
  }

  const matches = (secretKey: string) => freemiusSignatureMatches(secretKey, rawBody, presented);
  const valid: FreemiusWebhookVerification = { outcome: 'valid', productId };
  const mismatch: FreemiusWebhookVerification = { outcome: 'invalid', productId, reason: 'signature_mismatch' };
  const unverifiable = (
    reason: FreemiusWebhookUnverifiableReason,
    developerStatus: FreemiusDeveloperStatus['state'] | 'unknown'
  ): FreemiusWebhookVerification => ({ outcome: 'unverifiable', productId, reason, developerStatus });

  // 1. The product's own secret, read with the developer key pair when the account owns the product.
  let keys: FreemiusProductKeys | null = null;
  let keyReadFailed = false;

  try {
    keys = await getFreemiusProductKeys(productId);
  } catch (error) {
    keyReadFailed = true;
    logFreemiusProductKeyReadFailure(productId, describeKeyReadError(error));
  }

  if (keys && Date.now() - keys.fetchedAt > FREEMIUS_WEBHOOK_SECRET_MAX_AGE_MS) {
    // Served from memory through a long outage (reads failing, or the shared developer key pushed
    // into 429s): a secret rotated because it leaked must not keep verifying forged payments and
    // refunds. Only this product's configured secrets count until Freemius answers again.
    keys = null;
    keyReadFailed = true;
    logFreemiusProductKeyReadFailure(productId, 'Freemius has not answered since its last keys outlived the webhook limit.');
  }

  if (keys) {
    if (matches(keys.secretKey)) {
      return valid;
    }

    if (Date.now() - keys.fetchedAt < FREEMIUS_WEBHOOK_KEY_REFRESH_AFTER_MS) {
      return mismatch;
    }

    try {
      const fresh = await getFreemiusProductKeys(productId, { maxAgeMs: 0 });

      if (fresh && fresh.fetchedAt > keys.fetchedAt) {
        // Freemius answered again: its current secret decides.
        return fresh.secretKey !== keys.secretKey && matches(fresh.secretKey) ? valid : mismatch;
      }

      // The same keys back: Freemius gave no new answer (unreachable, or a read in the last minute
      // went unanswered), so the current secret is unknown. No keys any more: decided below too.
      keyReadFailed = fresh !== null;
    } catch (error) {
      keyReadFailed = true;
      logFreemiusProductKeyReadFailure(productId, describeKeyReadError(error));
    }
  }

  // 2. The bound secrets of this product, and of no other.
  if ((await resolveFreemiusBoundWebhookSecrets(productId)).some(matches)) {
    return valid;
  }

  // 3. The one-product secret standing in for a product without bound keys, where the key policy
  // (the checkout's rule too) allows it. It also reads the developer key pair's state for step 4.
  // Where the policy needs Freemius to confirm those keys are this product's, it may ask only for
  // an event that the one-product secret signed.
  const oneProductSecret = readFreemiusEnvValue('FREEMIUS_SECRET_KEY');
  const signedWithOneProductSecret = Boolean(oneProductSecret && matches(oneProductSecret));
  const standIn = await decideFreemiusOneProductStandIn(productId, { keyReadFailed, confirm: signedWithOneProductSecret });

  if (signedWithOneProductSecret) {
    if (standIn.allowed) {
      return valid;
    }

    if (standIn.reason === 'one_product_keys_not_this_product') {
      // Freemius says the one-product keys are another product's, or a developer pair's: a secret
      // that signs any product id once it leaked.
      return mismatch;
    }

    if (standIn.reason === 'one_product_keys_unconfirmed') {
      return unverifiable('one_product_keys_unconfirmed', standIn.developer.state);
    }
  }

  // 4. Could the developer key pair vouch for a secret the app could not read?
  const developer = standIn.developer;

  if (keyReadFailed) {
    return unverifiable('product_key_read_failed', developer.state);
  }

  switch (developer.state) {
    case 'working':
      // The account lists the product but gave no keys for it; another account's product has only
      // its bound secrets, and the one-product secret where the policy lets it stand in.
      return developer.owned ? unverifiable('product_keys_unavailable', 'working') : mismatch;
    case 'missing':
    case 'sandbox':
      return mismatch;
    case 'refused':
      // A rotated or revoked pair: redelivered once it is fixed, never verified meanwhile.
      return unverifiable('developer_pair_refused', 'refused');
    default:
      return unverifiable('developer_pair_unreachable', developer.state);
  }
}

/**
 * `getFreemiusWebhookVerification` as a boolean, kept for route files written before it: true only
 * for a `valid` event. Such a route answers 401 to an event the app could not check (the current
 * route answers 503 so Freemius redelivers it) and must still keep its handlers to the event's own
 * product, which the order syncs do from the event's `plugin_id`. Async: always `await` it.
 */
export async function verifyFreemiusWebhookRequest(rawBody: string, signature: string | null): Promise<boolean> {
  return (await getFreemiusWebhookVerification(rawBody, signature)).outcome === 'valid';
}

/**
 * The synchronous check of route files from 0.23.3 and older (`if (!verifyFreemiusWebhookSignature(
 * rawBody, signature))`), which scaffolds keep when they upgrade the libs. It stays synchronous (an
 * async version under this name returns a Promise, which is truthy, and that `if` would pass every
 * forged webhook) and accepts what it always did: the event must name its product (`plugin_id`)
 * and match that product's bound secret (`getFreemiusWebhookSecretCandidates({ productId })`) or,
 * for a product without bound keys (no FREEMIUS_CHECKOUT_PRODUCTS_JSON entry, FREEMIUS_PRODUCT_ID
 * empty), the one-product secret. That last rule is how those routes verify a one-product install
 * that left its Product ID empty; dropping it would answer that install's genuine webhooks 401.
 *
 * It never reads developer keys and never asks Freemius (it cannot wait), so it cannot apply the
 * key policy of `getFreemiusWebhookVerification`: where the one-product names hold the developer
 * pair (nextblock.dev), such a route also accepts that secret for every product without bound keys.
 * A route on this check should move to `getFreemiusWebhookVerification` (answering 503 on
 * `unverifiable` and passing the verified `productId` to the handlers).
 */
export function verifyFreemiusWebhookSignature(rawBody: string, signature: string | null) {
  const presented = normalizeFreemiusSignature(signature);
  const productId = presented ? readFreemiusWebhookProductId(rawBody) : null;

  if (!presented || !productId) {
    return false;
  }

  const unscoped = getUnscopedSingleProductSecret(productId);

  return [...getFreemiusWebhookSecretCandidates({ productId }), ...(unscoped ? [unscoped] : [])].some((secretKey) =>
    freemiusSignatureMatches(secretKey, rawBody, presented)
  );
}
