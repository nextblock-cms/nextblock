import { NextResponse } from 'next/server';
import {
  hydrateFreemiusEnvFromDb,
  isFreemiusDisputeEventType,
  isFreemiusRefundEventType,
  syncFreemiusOrderFromWebhookEvent,
  verifyFreemiusWebhookSignature,
} from '@nextblock-cms/ecommerce/server';
import {
  handleFreemiusDisputeWebhookEvent,
  handleFreemiusRefundWebhookEvent,
  scheduleAffiliateCommissionSweep,
} from '../../../../lib/affiliates/refunds';

// Node runtime: the signature is an HMAC computed with node:crypto.
export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    // Make CMS-stored Freemius credentials available to the (sync) signature + sync helpers.
    await hydrateFreemiusEnvFromDb();

    const rawBody = await req.text();
    const signature =
      req.headers.get('x-signature') ?? req.headers.get('x-freemius-signature');

    // Always verify the signature. The previous NEXT_PUBLIC_IS_SANDBOX escape hatch let anyone
    // forge a webhook on a sandbox-flagged install — marking orders paid and writing license ids
    // (a self-registered account on the public demo could unlock premium). The signature is the
    // only thing that proves the request came from Freemius, so it is required on every install.
    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
    }

    if (!verifyFreemiusWebhookSignature(rawBody, signature)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const event = JSON.parse(rawBody);
    const eventType = typeof event?.type === 'string' ? event.type : null;

    // A dispute that opened or was won refunds nothing, and its purchase data would read as paid:
    // never synced, and the order keeps its status. An open dispute holds the partner's
    // commission until it closes; one the store won releases it. A failure throws into the 500
    // below and Freemius redelivers.
    if (isFreemiusDisputeEventType(eventType)) {
      const dispute = await handleFreemiusDisputeWebhookEvent(event);

      return NextResponse.json({ received: true, type: eventType, handled: dispute.handled, orderId: dispute.orderId });
    }

    // Refunds and lost disputes are handled INSTEAD of the order sync, which would re-promote
    // the refunded order to paid. A failure throws into the 500 below and Freemius redelivers.
    if (isFreemiusRefundEventType(eventType)) {
      const refund = await handleFreemiusRefundWebhookEvent(event);

      if (refund.handled) {
        scheduleAffiliateCommissionSweep();
      }

      return NextResponse.json({
        received: true,
        type: eventType,
        handled: refund.handled,
        orderId: refund.orderId,
        status: refund.orderStatusUpdated ? 'refunded' : null,
      });
    }

    const result = await syncFreemiusOrderFromWebhookEvent({ event });

    if ('status' in result && result.status === 'paid') {
      // The order is paid: the database trigger has recorded an attributed order's commission.
      scheduleAffiliateCommissionSweep();
    }

    return NextResponse.json({ received: true, ...result });

  } catch (error) {
    console.error('Freemius Webhook Error:', error);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
