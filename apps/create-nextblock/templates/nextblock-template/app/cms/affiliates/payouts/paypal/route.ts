import 'server-only';

import { NextResponse } from 'next/server';
import { buildAffiliatePayPalPayoutsFileNow } from '../../../../../lib/affiliates/manual-payouts';

/**
 * "Download PayPal payouts file" on /cms/affiliates/payouts (02036): GET `?currency=CAD` answers a
 * CSV for PayPal's Payouts web upload (lib/affiliates/paypal-payouts-csv.ts has the format) listing
 * every PREPARED manual payout of that currency whose partner is active and has a payout email
 * PayPal can take, at the amount prepared. ADMIN only: `buildAffiliatePayPalPayoutsFileNow()` runs
 * `requireCmsAdmin()` (session, second factor, role) before it reads anything, whatever `proxy.ts`
 * let through. It only reads (a GET never changes the ledger): "Prepare PayPal payouts", a server
 * action, reserves the commissions first, and each payout is recorded with "Record payout" once
 * PayPal sent it. Never cached, and the refusals are fixed sentences (no database or provider text).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PRIVATE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } as const;

export async function GET(request: Request): Promise<Response> {
  const currency = new URL(request.url).searchParams.get('currency') ?? '';
  const file = await buildAffiliatePayPalPayoutsFileNow(currency);
  if (!file.ok) {
    return new NextResponse(file.error, { status: file.status, headers: { ...PRIVATE, 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  return new NextResponse(file.csv, {
    status: 200,
    headers: {
      ...PRIVATE,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
    },
  });
}
