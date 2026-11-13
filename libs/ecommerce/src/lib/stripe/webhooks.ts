import Stripe from 'stripe';
import { getStripeClient } from './client';
import { resolveStripeWebhookSecret } from '../payment-config';
import { syncStripeOrderFromSession } from './order-sync';

/** A Stripe event whose signature `handleStripeWebhook` verified. */
export type StripeWebhookEvent = Stripe.Event;

/**
 * Events that refund an order: a refund on its charge (full or partial), or a dispute the store
 * lost. Required in the Stripe webhook endpoint's event list (CMS → Payments).
 */
export const STRIPE_REFUND_EVENT_TYPES = ['charge.refunded', 'charge.dispute.closed'] as const;

export type StripeRefundEventType = (typeof STRIPE_REFUND_EVENT_TYPES)[number];

export function isStripeRefundEventType(type: unknown): type is StripeRefundEventType {
  return typeof type === 'string' && (STRIPE_REFUND_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Events that open a dispute on an order's charge: they refund nothing (the order keeps its
 * status), but the app holds the order's affiliate commission until the dispute closes
 * (`syncStripeOrderDisputeFromEvent`). `charge.dispute.closed`, a refund event, releases the hold
 * when the store did not lose. Required in the endpoint's event list (CMS → Payments).
 */
export const STRIPE_DISPUTE_EVENT_TYPES = ['charge.dispute.created'] as const;

export type StripeDisputeEventType = (typeof STRIPE_DISPUTE_EVENT_TYPES)[number];

export function isStripeDisputeEventType(type: unknown): type is StripeDisputeEventType {
  return typeof type === 'string' && (STRIPE_DISPUTE_EVENT_TYPES as readonly string[]).includes(type);
}

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

/** True for the events `handleStripeWebhook` turns into a paid order (a settled checkout session). */
export function isStripeSettledCheckoutEvent(event: Pick<Stripe.Event, 'type' | 'data'>): boolean {
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') {
    return false;
  }

  return isStripeSessionSettled(event.data.object as Stripe.Checkout.Session);
}

/**
 * Verifies the signature over the raw body, then marks orders paid from settled checkout
 * sessions. The verified `event` is returned too: the app's route applies refunds and disputes
 * (`charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`) itself, because they
 * also reach the affiliate commissions, which this package does not know about.
 */
export const handleStripeWebhook = async (
  signature: string,
  body: string | Buffer
): Promise<{ received: boolean; error?: string; event?: StripeWebhookEvent }> => {
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
        return { received: false, error: error.message || 'Failed to sync Stripe session', event };
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
      if (isStripeRefundEventType(event.type) || isStripeDisputeEventType(event.type)) {
        // Applied by the caller (syncStripeOrderRefundFromEvent / syncStripeOrderDisputeFromEvent
        // plus the affiliate ledger).
        break;
      }
      console.log(`Unhandled event type ${event.type}`);
  }

  return { received: true, event };
};
