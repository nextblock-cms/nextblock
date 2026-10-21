'use server';

import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import {
  applyOrderInventoryDeduction,
  assignInvoiceMetadata,
  getFreemiusOrderLicense,
  getInvoicePresentationData,
  getStripeClient,
  syncStripeOrderFromSession,
  verifyOrderAccessToken,
} from '@nextblock-cms/ecommerce/server';
import { createClient } from '@nextblock-cms/db/server';
import { resolveSupabaseUrl } from '../../../lib/setup/env-status';
import { resolveSupabaseServiceKey } from '../../../lib/setup/service-key';

function getServiceRoleSupabaseClient() {
  const supabaseUrl = resolveSupabaseUrl();
  const serviceRoleKey = resolveSupabaseServiceKey();

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

export async function fulfillOrderAction(sessionId: string, accessToken?: string | null) {
  if (!sessionId) {
    return {
      success: false,
      error: 'No session ID provided',
      errorKey: 'ecommerce.checkout_missing_session_id',
    };
  }

  try {
    if (sessionId.startsWith('cs_')) {
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
      const invoice = await getInvoicePresentationData(result.orderId, getServiceRoleSupabaseClient() as any);
      return {
        success: true,
        alreadyPaid: result.alreadyPaid,
        status: 'paid',
        invoice,
      };
    }

    const supabase = getServiceRoleSupabaseClient();
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select(
        'id, user_id, status, provider, total, currency, subtotal, shipping_total, tax_total, tax_details, paid_at'
      )
      .eq('id', sessionId)
      .single();

    if (orderError || !order) {
      console.error('Order not found or error:', orderError);
      return {
        success: false,
        error: 'Order not found',
        errorKey: 'ecommerce.checkout_success_order_not_found',
      };
    }

    // Object-level authorization. The service-role read above bypasses RLS and this action is a
    // public POST dispatched by action id, so without this check anyone who learns an order's
    // UUID (shared link, referer, logs) could read its buyer PII and Freemius license key.
    // Authorized by any one of: the capability token minted into the success redirect at checkout
    // (so a guest who just paid can see their own order), the owning account, or staff. An order
    // with no owner and no valid token is never disclosed. (The `cs_` branch above is
    // capability-gated by Stripe's own session id.)
    {
      let authorized = verifyOrderAccessToken(order.id, accessToken);

      if (!authorized) {
        const cookieClient = createClient();
        const {
          data: { user: sessionUser },
        } = await cookieClient.auth.getUser();

        if (sessionUser) {
          if (order.user_id && order.user_id === sessionUser.id) {
            authorized = true;
          } else {
            const { data: profile } = await cookieClient
              .from('profiles')
              .select('role')
              .eq('id', sessionUser.id)
              .single();
            // Orders are ADMIN-only data (02023), and this page reveals the buyer's details and
            // license key, so staff access is ADMIN only; a WRITER is not a support role here.
            if (profile?.role === 'ADMIN') authorized = true;
          }
        }
      }

      if (!authorized) {
        // Same generic response as a missing order, so this does not become an existence oracle.
        return {
          success: false,
          error: 'Order not found',
          errorKey: 'ecommerce.checkout_success_order_not_found',
        };
      }
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
        await applyOrderInventoryDeduction(supabase as any, order.id);
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
        client: supabase as any,
      });

      return {
        success: true,
        alreadyPaid: true,
        status: 'paid',
        invoice: await getInvoicePresentationData(order.id, supabase as any),
        license: await getFreemiusOrderLicense({ orderId: order.id, client: supabase as any }),
      };
    }

    if (order.status === 'trial') {
      return {
        success: true,
        alreadyPaid: false,
        status: 'trial',
        invoice: await getInvoicePresentationData(order.id, supabase as any),
        license: await getFreemiusOrderLicense({ orderId: order.id, client: supabase as any }),
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
