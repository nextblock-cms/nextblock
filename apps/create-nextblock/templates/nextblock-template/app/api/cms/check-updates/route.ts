import { NextResponse } from 'next/server';
import { createClient } from '@nextblock-cms/db/server';
import { getCmsActor } from '../../../../lib/auth/cms-actor';
import { refreshUpstreamStatus } from '../../../../lib/updates/check-upstream';

// Node runtime: the update checker reads the filesystem (.git / workflow detection) and
// uses the service-role client. force-dynamic so it never gets statically cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SECOND_FACTOR_MESSAGE = 'Complete two-factor verification, then try again.';

/** True when the request carries a signed-in user (to word a refusal; never to grant anything). */
async function hasSignedInUser(): Promise<boolean> {
  try {
    const {
      data: { user },
    } = await createClient().auth.getUser();
    return Boolean(user);
  } catch {
    return false;
  }
}

/**
 * Admin-triggered upstream update check (Track B). Polls the GitHub Releases API,
 * compares versions, and — on a standalone install — records a runtime_update_available
 * alert. Returns the comparison either way so an admin "Check for updates" control can
 * show the result inline.
 */
export async function POST() {
  // An ADMIN past their enrolled second factor, before anything else, as in
  // lib/full-backup/server.ts: a route handler never passes the CMS layout's 2FA redirect, and
  // until 2026-11-14 a cookie-client role read let an admin password alone (the first factor) run
  // the check, which records its alerts and the upstream status in system_configuration with the
  // service role.
  const actor = await getCmsActor();
  if (!actor) {
    // getCmsActor() is null without a session and while an enrolled second factor is pending.
    // The refusal stands either way; this only picks the answer.
    return (await hasSignedInUser())
      ? NextResponse.json({ ok: false, error: SECOND_FACTOR_MESSAGE }, { status: 403 })
      : NextResponse.json({ ok: false, error: 'Not authenticated.' }, { status: 401 });
  }
  if (actor.role !== 'ADMIN') {
    return NextResponse.json({ ok: false, error: 'Administrator role required.' }, { status: 403 });
  }

  const { update, conflicts, snapshot } = await refreshUpstreamStatus();
  // The check itself succeeded as an operation even if a network call failed; surface any
  // soft error in the body rather than 500ing the admin action.
  const ok = update.ok && conflicts.ok;
  return NextResponse.json({ ok, update, conflicts, snapshot }, { status: ok ? 200 : 502 });
}
