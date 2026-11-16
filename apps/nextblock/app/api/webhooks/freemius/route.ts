import { NextResponse } from 'next/server';
import {
  getFreemiusWebhookVerification,
  hydrateFreemiusEnvFromDb,
  isFreemiusDisputeEventType,
  isFreemiusRefundEventType,
  syncFreemiusOrderFromWebhookEvent,
} from '@nextblock-cms/ecommerce/server';
import {
  handleFreemiusDisputeWebhookEvent,
  handleFreemiusRefundWebhookEvent,
  scheduleAffiliateCommissionSweep,
} from '../../../../lib/affiliates/refunds';

// Node runtime: the signature is an HMAC computed with node:crypto.
export const runtime = 'nodejs';

/** The 503 line for one reason is written at most once per window. */
const UNVERIFIABLE_LOG_WINDOW_MS = 60_000;
/** Reasons are a small fixed set from the lib; the cap only guards the map against anything else. */
const UNVERIFIABLE_LOG_MAX_REASONS = 16;
/** Per reason: when its line was last written, and how many 503s went unlogged since. */
const unverifiableLogged = new Map<string, { at: number; unlogged: number }>();

/**
 * Logs an event answered 503 at most once per reason per window, naming the product of the first
 * one. While Freemius throttles the developer key, anyone can post forged webhooks that each end
 * here (without any request to Freemius), so a line per webhook would let them fill the logs. The
 * values are digits and enum strings from the verification, never key material.
 */
function logUnverifiableWebhook(productId: string, reason: string, developerStatus: string) {
  const now = Date.now();
  const key = reason.slice(0, 64);
  const previous = unverifiableLogged.get(key);

  // A clock that went back counts as a new window.
  if (previous && now >= previous.at && now - previous.at < UNVERIFIABLE_LOG_WINDOW_MS) {
    previous.unlogged += 1;
    return;
  }

  if (!previous && unverifiableLogged.size >= UNVERIFIABLE_LOG_MAX_REASONS) {
    return;
  }

  const unlogged = previous?.unlogged ?? 0;
  unverifiableLogged.set(key, { at: now, unlogged: 0 });
  console.error(
    `[Freemius Webhook] Could not check the signature of an event of product ${productId} ` +
      `(${key}; developer key pair: ${developerStatus}). Answered 503 so Freemius redelivers it.` +
      (unlogged > 0 ? ` ${unlogged} more answered 503 for this reason since the previous line.` : '')
  );
}

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

    // Checked over the raw body, before it is parsed, with the secret of the product the event names
    // (plugin_id; an event without one is refused): that product's own key read with the developer
    // key pair, or that product's configured secret, never another product's. Awaited: the check is
    // async, and its outcome is an object, so only `outcome === 'valid'` lets the event through.
    const verification = await getFreemiusWebhookVerification(rawBody, signature);

    if (verification.outcome === 'unverifiable') {
      // A genuine event the app cannot check right now (Freemius unreachable, or the developer key
      // pair refused): 503 so Freemius redelivers it, and nothing is processed meanwhile.
      logUnverifiableWebhook(verification.productId, verification.reason, verification.developerStatus);
      return NextResponse.json(
        { error: 'Webhook signature could not be checked' },
        { status: 503, headers: { 'Retry-After': '60' } }
      );
    }

    if (verification.outcome !== 'valid') {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    // Every handler keeps to the product whose secret verified the event: each is handed that id
    // (`productId`), the event carries it as its plugin_id too, and an order of another product is
    // skipped (logged, answered 200).
    const productId = verification.productId;
    const event = { ...JSON.parse(rawBody), plugin_id: productId };
    const eventType = typeof event?.type === 'string' ? event.type : null;

    // A dispute that opened or was won refunds nothing, and its purchase data would read as paid:
    // never synced, and the order keeps its status. An open dispute holds the partner's
    // commission until it closes; one the store won releases it. A failure throws into the 500
    // below and Freemius redelivers.
    if (isFreemiusDisputeEventType(eventType)) {
      const dispute = await handleFreemiusDisputeWebhookEvent(event, { productId });

      return NextResponse.json({ received: true, type: eventType, handled: dispute.handled, orderId: dispute.orderId });
    }

    // Refunds and lost disputes are handled INSTEAD of the order sync, which would re-promote
    // the refunded order to paid. A failure throws into the 500 below and Freemius redelivers.
    if (isFreemiusRefundEventType(eventType)) {
      const refund = await handleFreemiusRefundWebhookEvent(event, { productId });

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

    const result = await syncFreemiusOrderFromWebhookEvent({ event, productId });

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
