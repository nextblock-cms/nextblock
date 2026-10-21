import Stripe from 'stripe';
import { getStripeClient } from './client';
import { resolveStripeWebhookSecret } from '../payment-config';
import { syncStripeOrderFromSession } from './order-sync';

/**
 * Only a session whose money has actually arrived may mark an order paid (which also issues the
 * invoice and deducts stock). With a delayed payment method enabled in the Stripe dashboard
 * (SEPA/ACH/Bacs debit, Boleto, OXXO, Konbini, bank transfer), `checkout.session.completed`
 * arrives with `payment_status: 'unpaid'` and the money follows, or never does, in
 * `checkout.session.async_payment_succeeded` / `_failed`. Until 2026-10-21 the completed event
 * alone marked the order paid, so a buyer could pick a voucher, never pay, and receive the goods.
 */
export function isStripeSessionSettled(session: Pick<Stripe.Checkout.Session, 'payment_status'>) {
  return session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
}

export const handleStripeWebhook = async (
  signature: string,
  body: string | Buffer
): Promise<{ received: boolean; error?: string }> => {
  // Resolve the webhook secret DB-first (CMS), falling back to STRIPE_WEBHOOK_SECRET.
  const webhookSecret = await resolveStripeWebhookSecret();

  if (!webhookSecret) {
    console.error('Missing Stripe webhook secret (configure it in CMS or STRIPE_WEBHOOK_SECRET)');
    return { received: false, error: 'Server configuration error' };
  }

  const stripe = await getStripeClient();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (error: any) {
    console.error(`Webhook signature verification failed: ${error.message}`);
    return { received: false, error: `Webhook Error: ${error.message}` };
  }

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as Stripe.Checkout.Session;

      if (!isStripeSessionSettled(session)) {
        // A delayed payment method: the order stays pending until async_payment_succeeded.
        console.log(
          `[Stripe Webhook] Session ${session.id} is ${session.payment_status}; waiting for the payment to settle`
        );
        break;
      }

      try {
        await syncStripeOrderFromSession(session);
      } catch (error: any) {
        console.error('[Stripe Webhook Error] Failed to sync completed session:', error);
        return { received: false, error: error.message || 'Failed to sync Stripe session' };
      }
      break;
    }
    case 'checkout.session.async_payment_failed': {
      const session = event.data.object as Stripe.Checkout.Session;
      // The order was never marked paid for this session, so it simply stays pending.
      console.warn(`[Stripe Webhook] Delayed payment failed for session ${session.id}; order stays unpaid`);
      break;
    }
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  return { received: true };
};
