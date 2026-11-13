import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';

import { createAffiliateConnectRefreshLink } from '../../../../../../../lib/affiliates/connect-service';
import { readAffiliateStripeRedirectUrl } from '../../../../../../../lib/affiliates/portal-data';
import { requireRetailer } from '../../../../../../../lib/affiliates/retailer-actor';

/**
 * Stripe Connect's `refresh_url`: Stripe sends the partner here when an onboarding link expired
 * or was already used. `GET` → `requireRetailer()` → a fresh account link → 302 to Stripe. Any
 * refusal or error lands on the payouts page with `?connect_error=1` (which signs the visitor in
 * first when needed). The target must be an https stripe.com URL, so this never becomes an open
 * redirect, and readiness is never inferred from this request.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAYOUTS_ERROR_PATH = '/portal/retailer/payouts?connect_error=1';

function noStore(response: NextResponse) {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function backToPayouts(request: NextRequest) {
  return noStore(NextResponse.redirect(new URL(PAYOUTS_ERROR_PATH, request.nextUrl.origin), 302));
}

export async function GET(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') return backToPayouts(request);

  try {
    const { actor } = await requireRetailer();
    const url = readAffiliateStripeRedirectUrl(await createAffiliateConnectRefreshLink(actor));
    if (!url) return backToPayouts(request);
    return noStore(NextResponse.redirect(url, 302));
  } catch (error) {
    if (!(error instanceof Error) || !['Unauthorized', 'Forbidden', 'Suspended', 'PackageInactive'].includes(error.message)) {
      console.error('[affiliates] Connect refresh link failed:', error instanceof Error ? error.message : String(error));
    }
    return backToPayouts(request);
  }
}
