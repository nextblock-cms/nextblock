'use server';

import 'server-only';

import { applyOrderInventoryDeduction } from '@nextblock-cms/ecommerce/order-inventory';
import { assignInvoiceMetadata, getInvoicePresentationData } from '@nextblock-cms/ecommerce/invoice-server';
import { getFreemiusOrderLicense } from '@nextblock-cms/ecommerce/freemius-license';
import { getStripeClient } from '@nextblock-cms/ecommerce/stripe/client';
import { syncStripeOrderFromSession } from '@nextblock-cms/ecommerce/stripe/order-sync';
import { verifyOrderAccessToken } from '@nextblock-cms/ecommerce/order-access-token';
import { createClient, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { getCmsActor } from '../../../lib/auth/cms-actor';
import { scheduleAffiliateCommissionSweep } from '../../../lib/affiliates/refunds';

/**
 * A Stripe Checkout Session id as Stripe issues it: `cs_test_` / `cs_live_` and an alphanumeric
 * suffix, 255 characters at most (Stripe's longest object id). Anything else is refused before the
 * database or Stripe is asked.
 */
const STRIPE_CHECKOUT_SESSION_ID_RE = /^cs_(?:test|live)_[A-Za-z0-9]{1,247}$/;

/** A Freemius order reference is the order's own id (a UUID). */
const ORDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type FulfillOrderFailure = { success: false; error: string; errorKey: string };
type FulfillOrderResult =
  | FulfillOrderFailure
  | {
      success: true;
      alreadyPaid: boolean;
      status: 'paid' | 'trial';
      invoice: Awaited<ReturnType<typeof getInvoicePresentationData>>;
      license?: Awaited<ReturnType<typeof getFreemiusOrderLicense>>;
    };

/**
 * The answer for a missing order and for one the caller may not see alike, so this action is not
 * an existence oracle.
 */
function orderNotFound(): FulfillOrderFailure {
  return {
    success: false,
    error: 'Order not found',
    errorKey: 'ecommerce.checkout_success_order_not_found',
  };
}

/**
 * Who may see a Freemius order, decided before any of it is read. This action is a public POST
 * dispatched by its id, and what it returns (the buyer's details, the Freemius license key) is read
 * with the service role, so this check IS the authorization:
 * - the guest who holds the capability token minted into the success redirect at checkout;
 * - an ADMIN whose session passed its enrolled second factor (`getCmsActor()`, which refuses a
 *   pending one). Orders are ADMIN-only data behind `is_admin_mfa()` (02023), and until 2026-11-13
 *   a role read through the cookie client let an ADMIN password alone reveal any order here;
 * - any other signed-in account, as the owner: the read is then filtered on its own user id, so
 *   nothing of another account's order comes back.
 * Returns `{ ownerId }` (null: no owner filter), or null when the caller may see no order at all.
 */
async function resolveOrderAccess(
  orderId: string,
  accessToken: string | null | undefined
): Promise<{ ownerId: string | null } | null> {
  if (verifyOrderAccessToken(orderId, accessToken)) return { ownerId: null };

  const {
    data: { user },
  } = await createClient().auth.getUser();
  if (!user) return null;

  const actor = await getCmsActor();
  if (actor?.role === 'ADMIN') return { ownerId: null };

  return { ownerId: user.id };
}

export async function fulfillOrderAction(
  sessionId: string,
  accessToken?: string | null
): Promise<FulfillOrderResult> {
  if (!sessionId || typeof sessionId !== 'string') {
    return {
      success: false,
      error: 'No session ID provided',
      errorKey: 'ecommerce.checkout_missing_session_id',
    };
  }

  try {
    if (sessionId.startsWith('cs_')) {
      // The session id is the capability here: Stripe shows it only to the buyer, in the success
      // redirect. It still must not reach Stripe unchecked, because every retrieve spends the
      // operator's Stripe API rate limit and this action is a public POST: until 2026-11-13 any
      // `cs_` string, random ones included, cost one Stripe call. Checkout hands the browser Stripe's
      // URL only once the session's order stores its id, and expires the session instead when that
      // write fails (providers/stripe.ts, stripe/checkout.ts): every session checkout hands a buyer is
      // found here, and Stripe is asked only about a session one of this store's orders names.
      if (!STRIPE_CHECKOUT_SESSION_ID_RE.test(sessionId)) {
        return orderNotFound();
      }

      const supabase = getServiceRoleSupabaseClient();
      const { data: storedOrder, error: lookupError } = await supabase
        .from('orders')
        .select('id')
        .eq('stripe_session_id', sessionId)
        .limit(1)
        .maybeSingle();

      if (lookupError) {
        throw new Error(`Stripe session order lookup failed: ${lookupError.message}`);
      }
      if (!storedOrder) {
        return orderNotFound();
      }

      const stripe = await getStripeClient();
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (session.payment_status !== 'paid') {
        return {
          success: false,
          error: 'Payment is still pending',
          errorKey: 'ecommerce.checkout_payment_pending',
        };
      }

      const result = await syncStripeOrderFromSession(session);
      const invoice = await getInvoicePresentationData(result.orderId, supabase);
      // Without a webhook (local dev, a delayed delivery) this visit is what marked the order
      // paid: send any COMMISSION_EARNED notices it produced (NextBlock Affiliates).
      scheduleAffiliateCommissionSweep();
      return {
        success: true,
        alreadyPaid: result.alreadyPaid,
        status: 'paid',
        invoice,
      };
    }

    if (!ORDER_ID_RE.test(sessionId)) {
      return orderNotFound();
    }
    // The id as checkout minted the access token for it (Postgres returns UUIDs in lower case).
    const orderId = sessionId.toLowerCase();

    const access = await resolveOrderAccess(orderId, accessToken);
    if (!access) {
      return orderNotFound();
    }

    const supabase = getServiceRoleSupabaseClient();
    let orderQuery = supabase
      .from('orders')
      .select(
        'id, user_id, status, provider, total, currency, subtotal, shipping_total, tax_total, tax_details, paid_at'
      )
      .eq('id', orderId);
    if (access.ownerId !== null) {
      orderQuery = orderQuery.eq('user_id', access.ownerId);
    }
    const { data: order, error: orderError } = await orderQuery.maybeSingle();

    if (orderError) {
      console.error('Order lookup failed:', orderError.message);
    }
    if (orderError || !order) {
      return orderNotFound();
    }

    if (order.provider !== 'freemius') {
      return {
        success: false,
        error: 'Only Freemius order references can be finalized here',
        errorKey: 'ecommerce.checkout_success_invalid_reference',
      };
    }

    if (order.status === 'paid') {
      try {
        await applyOrderInventoryDeduction(supabase, order.id);
      } catch (inventoryError) {
        console.error('Failed to reconcile inventory for paid order:', inventoryError);
        return {
          success: false,
          error: 'Failed to update order inventory',
          errorKey: 'ecommerce.checkout_success_inventory_update_failed',
        };
      }

      await assignInvoiceMetadata({
        orderId: order.id,
        paidAt: order.paid_at ?? null,
        client: supabase,
      });
      scheduleAffiliateCommissionSweep();

      return {
        success: true,
        alreadyPaid: true,
        status: 'paid',
        invoice: await getInvoicePresentationData(order.id, supabase),
        license: await getFreemiusOrderLicense({ orderId: order.id, client: supabase }),
      };
    }

    if (order.status === 'trial') {
      return {
        success: true,
        alreadyPaid: false,
        status: 'trial',
        invoice: await getInvoicePresentationData(order.id, supabase),
        license: await getFreemiusOrderLicense({ orderId: order.id, client: supabase }),
      };
    }

    return {
      success: false,
      error: 'Payment is still pending',
      errorKey:
        order.status === 'cancelled'
          ? 'order_status_cancelled'
          : 'ecommerce.checkout_payment_pending',
    };
  } catch (error) {
    console.error('Action error reconciling order:', error);
    return {
      success: false,
      error: 'Internal server error',
      errorKey: 'ecommerce.checkout_internal_server_error',
    };
  }
}
