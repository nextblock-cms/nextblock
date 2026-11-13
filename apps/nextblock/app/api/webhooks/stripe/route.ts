import { NextResponse } from 'next/server';
import {
  handleStripeWebhook,
  isStripeDisputeEventType,
  isStripeRefundEventType,
  isStripeSettledCheckoutEvent,
} from '@nextblock-cms/ecommerce/server';
import {
  handleStripeDisputeWebhookEvent,
  handleStripeRefundWebhookEvent,
  scheduleAffiliateCommissionSweep,
} from '../../../../lib/affiliates/refunds';

// Node runtime: the Stripe SDK verifies the signature with node:crypto over a Buffer.
export const runtime = 'nodejs';

// Prevent Next.js from parsing the body automatically, needed for stripe signature verification
// BUT in App Router 'req.text()' gives us the raw body without needing config.api.bodyParser = false

export async function POST(req: Request) {
  try {
    const body = await req.text();
    const signature = req.headers.get('stripe-signature');

    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
    }

    // Verifies the signature over the raw body first; settled checkout sessions are synced inside.
    const { received, error, event } = await handleStripeWebhook(signature, Buffer.from(body));

    if (error) {
        return NextResponse.json({ error }, { status: 400 });
    }

    if (event && (isStripeRefundEventType(event.type) || isStripeDisputeEventType(event.type))) {
      // A refund or a lost dispute: the order (store side) and the affiliate commission. A
      // dispute that opens (`charge.dispute.created`) holds the commission, and one that closes
      // without loss (`charge.dispute.closed`) releases it; the order is untouched. Every step is
      // idempotent, so a failure answers 5xx and Stripe redelivers the event.
      try {
        const refund = isStripeRefundEventType(event.type) ? await handleStripeRefundWebhookEvent(event) : null;
        await handleStripeDisputeWebhookEvent(event);

        if (refund?.handled) {
          scheduleAffiliateCommissionSweep();
        }
      } catch (refundError) {
        console.error('[Stripe Webhook] Refund or dispute handling failed:', refundError);
        return NextResponse.json({ error: 'Refund or dispute handling failed' }, { status: 500 });
      }
    } else if (event && isStripeSettledCheckoutEvent(event)) {
      // The order is paid: the database trigger has recorded an attributed order's commission.
      scheduleAffiliateCommissionSweep();
    }

    return NextResponse.json({ received });
  } catch (err: any) {
    console.error('Webhook processing error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
