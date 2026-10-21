import 'server-only';

import { NextResponse } from 'next/server';
import { syncFreemiusCheckoutOrder, verifyOrderAccessToken } from '@nextblock-cms/ecommerce/server';

/**
 * The Freemius overlay's browser callback reports which license the checkout created. This
 * route is public, so it trusts nothing in the body: the caller must hold the order's access
 * token (minted at checkout and handed only to the buyer's browser), and the sync itself links
 * a license only after Freemius confirms it belongs to this order (see
 * `evaluateFreemiusCheckoutLicense`). Before 2026-10-21 neither held, and any guest could
 * attach any license id to their own order and read its key on the success page.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const orderId = typeof body.orderId === 'string' ? body.orderId : null;
    const token = typeof body.token === 'string' ? body.token : null;

    if (!orderId) {
      return NextResponse.json(
        { success: false, error: 'Missing Freemius order ID' },
        { status: 400 }
      );
    }

    if (!verifyOrderAccessToken(orderId, token)) {
      return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
    }

    const result = await syncFreemiusCheckoutOrder({
      orderId,
      checkoutResponse: body.checkoutResponse ?? body.response ?? null,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (error) {
    console.error('[Freemius Checkout Sync] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Freemius checkout sync failed' },
      { status: 500 }
    );
  }
}
