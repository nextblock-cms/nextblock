import { NextRequest, NextResponse } from 'next/server';

import { syncStoreCurrencyRates } from '@nextblock-cms/ecommerce/server';

import { isCronRequestAuthorized } from '../../../../lib/cron/cron-secret';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  // CRON_SECRET is optional: when set we enforce Vercel's `Authorization: Bearer`
  // header (compared in constant time), but a zero-config deploy can leave it unset (the
  // job only does low-harm FX-rate sync). Set CRON_SECRET in the project env to lock the
  // endpoint down.
  if (!isCronRequestAuthorized(request, { whenUnset: 'allow' })) {
    return new NextResponse('Unauthorized', {
      status: 401,
    });
  }

  try {
    const result = await syncStoreCurrencyRates();

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    // The route can be open (CRON_SECRET unset), so the provider's or the database's error text is
    // logged on the server only and the caller gets a fixed message.
    console.error('[sync-currencies] FX rate sync failed:', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'Failed to sync currency exchange rates.' }, { status: 500 });
  }
}
