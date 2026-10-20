import { NextResponse } from 'next/server';
import {
  hydrateFreemiusEnvFromDb,
  syncFreemiusOrderFromWebhookEvent,
  verifyFreemiusWebhookSignature,
} from '@nextblock-cms/ecommerce/server';

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
    const result = await syncFreemiusOrderFromWebhookEvent({ event });

    return NextResponse.json({ received: true, ...result });
    
  } catch (error) {
    console.error('Freemius Webhook Error:', error);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
