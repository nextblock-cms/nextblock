import 'server-only';

import { NextResponse } from 'next/server';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

import { setSecureCookie } from '../../../lib/auth/cookies';
import {
  THREAD_COOKIE,
  secondsUntilExpiry,
  verifyThreadToken,
} from '../../../lib/messages/thread-token';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Exchange a mailed thread link for a session cookie, then get the token out of the URL.
 *
 * This redirect is the most important control in the whole feature. The app sends
 * `Referrer-Policy: strict-origin-when-cross-origin`, which means the FULL url travels in
 * the Referer header on same-origin navigations — so a token left in the address bar
 * would leak to every internal link the visitor clicks, into browser history, into any
 * screenshot they share, and into proxy access logs. Held in an HttpOnly cookie it does
 * none of that, and script on the page cannot read it either.
 *
 * Every failure lands on the same token-less page with no cookie set. The visitor is
 * never told which kind of failure it was: distinguishing "expired" from "never existed"
 * would turn this route into an oracle.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  // Built from the REQUEST's own origin, not the configured site URL: the visitor must
  // land back on the host they arrived at. Deriving it from settings sends anyone whose
  // host differs from NEXT_PUBLIC_URL (a preview deploy, a custom domain, local dev on a
  // non-default port) to the wrong origin — and the cookie set here would not follow.
  const redirect = NextResponse.redirect(new URL('/thread', request.url), { status: 302 });
  redirect.headers.set('Cache-Control', 'no-store');

  try {
    const supabase = getServiceRoleSupabaseClient();
    const verification = await verifyThreadToken(supabase, token);

    if (!verification.valid) {
      console.warn(`[thread] Rejected thread link (${verification.reason}).`);
      return redirect;
    }

    const maxAge = secondsUntilExpiry(verification.thread.token_expires_at);
    if (maxAge <= 0) return redirect;

    await setSecureCookie(THREAD_COOKIE, token, maxAge);
  } catch (error) {
    console.error('[thread] Could not process a thread link:', error);
  }

  return redirect;
}
