import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { runAffiliatePayoutCycleNow } from '../../../../../lib/affiliates/payout-runner';
import { isAffiliatesProgramActive } from '../../../../../lib/affiliates/package-state';

/**
 * Daily automated affiliate payouts (SPEC §10 W2-PAYOUTS). Called by a scheduler that holds
 * `CRON_SECRET` — the pg_cron job `npm run affiliates:schedule-payouts` installs, or any external
 * cron — with `Authorization: Bearer <CRON_SECRET>`, by GET or POST. No `vercel.json` cron: it
 * would ship to every 1-click install (CLAUDE.md).
 *
 * Fails closed: 404 in the sandbox (payouts never run there), 503 while `CRON_SECRET` is unset
 * or shorter than 16 characters, 401 for a missing or wrong bearer (SHA-256 of both sides
 * compared with `timingSafeEqual`, so neither the length nor the content leaks through timing).
 * An inactive Affiliates package answers `{ skipped }`. The response is the run summary (counts
 * and short error codes, never a stack or a database message), never cached.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MIN_SECRET_LENGTH = 16;
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function json(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function bearerToken(header: string | null): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header?.trim() ?? '');
  return match ? match[1] : null;
}

function isAuthorized(header: string | null, secret: string): boolean {
  const presented = bearerToken(header);
  if (!presented) return false;
  return timingSafeEqual(sha256(presented), sha256(secret));
}

async function handle(request: Request): Promise<Response> {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    return new NextResponse('Not Found', { status: 404, headers: NO_STORE });
  }

  const secret = process.env['CRON_SECRET']?.trim() ?? '';
  if (secret.length < MIN_SECRET_LENGTH) {
    return json({ ok: false, error: 'not configured' }, 503);
  }
  if (!isAuthorized(request.headers.get('authorization'), secret)) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  let active = false;
  try {
    active = await isAffiliatesProgramActive();
  } catch {
    active = false;
  }
  if (!active) return json({ ok: true, skipped: 'package_inactive' }, 200);

  try {
    const { skipped, ...summary } = await runAffiliatePayoutCycleNow('cron');
    return json({ ok: true, skipped, summary }, 200);
  } catch (error) {
    console.error('[affiliates] Payout cron run failed:', error instanceof Error ? error.message : String(error));
    return json({ ok: false, error: 'payout run failed' }, 500);
  }
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
