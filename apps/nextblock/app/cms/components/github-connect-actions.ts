'use server';

import 'server-only';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { createClient } from '@nextblock-cms/db/server';
import { getCmsActor } from '../../../lib/auth/cms-actor';
import {
  startDeviceFlow,
  pollDeviceFlowOnce,
  installSyncWorkflow,
} from '../../../lib/updates/github-device';
import { markSyncWorkflowInstalled } from '../../../lib/updates/check-upstream';

const DEVICE_COOKIE = 'nb_gh_device';

const ADMIN_REQUIRED_MESSAGE = 'Administrator role required.';
const SECOND_FACTOR_MESSAGE = 'Complete two-factor verification, then try again.';

/**
 * ADMIN gate, mirroring the rest of the CMS server entry points: null for an ADMIN whose session
 * passed its enrolled second factor (getCmsActor() refuses a pending one), otherwise the refusal to
 * show. pollGithubConnect ends in a service-role write (markSyncWorkflowInstalled:
 * system_configuration, ADMIN-only behind is_admin_mfa() since 02028), and a server action never
 * passes the CMS layout's 2FA redirect, so until 2026-11-13 a role read through the cookie client
 * let an ADMIN password alone reach it. A signed-in caller whose factor is pending is told to
 * complete it, like the other actions fixed that day (until 2026-11-14 this answered
 * "Administrator role required." to an ADMIN in that state).
 */
async function adminRefusal(): Promise<string | null> {
  const actor = await getCmsActor();
  if (actor?.role === 'ADMIN') return null;
  if (actor) return ADMIN_REQUIRED_MESSAGE;
  // getCmsActor() is null without a session and while an enrolled second factor is pending. The
  // refusal stands either way; this only picks the message.
  return (await hasSignedInUser()) ? SECOND_FACTOR_MESSAGE : ADMIN_REQUIRED_MESSAGE;
}

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

export interface StartConnectResult {
  ok: boolean;
  userCode?: string;
  verificationUri?: string;
  interval?: number;
  expiresIn?: number;
  error?: string;
}

/** Begin the device flow; stash the device code in an httpOnly cookie for polling. */
export async function startGithubConnect(): Promise<StartConnectResult> {
  const refusal = await adminRefusal();
  if (refusal) return { ok: false, error: refusal };

  try {
    const flow = await startDeviceFlow();
    const store = await cookies();
    store.set(DEVICE_COOKIE, flow.deviceCode, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/cms',
      maxAge: flow.expiresIn,
    });
    return {
      ok: true,
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      interval: flow.interval,
      expiresIn: flow.expiresIn,
    };
  } catch (caught) {
    return { ok: false, error: caught instanceof Error ? caught.message : 'Could not start GitHub connect.' };
  }
}

export type PollConnectResult =
  | { status: 'installed'; htmlUrl?: string }
  | { status: 'pending'; slowDown?: boolean }
  | { status: 'error'; error: string };

/** Poll once; on authorization, install the workflow and clear the device cookie. */
export async function pollGithubConnect(): Promise<PollConnectResult> {
  const refusal = await adminRefusal();
  if (refusal) return { status: 'error', error: refusal };

  const store = await cookies();
  const deviceCode = store.get(DEVICE_COOKIE)?.value;
  if (!deviceCode) {
    return { status: 'error', error: 'Connect session expired — start again.' };
  }

  const poll = await pollDeviceFlowOnce(deviceCode);

  if (poll.status === 'pending') return { status: 'pending', slowDown: poll.slowDown };

  if (poll.status === 'authorized') {
    const install = await installSyncWorkflow(poll.token);
    store.delete({ name: DEVICE_COOKIE, path: '/cms' });
    if (install.ok) {
      // We just installed the workflow — flip the onboarding state now instead of waiting
      // for the throttled background poll / GitHub's registration lag.
      await markSyncWorkflowInstalled();
      revalidatePath('/cms', 'layout');
      return { status: 'installed', htmlUrl: install.htmlUrl };
    }
    return { status: 'error', error: install.error ?? 'Could not install the workflow.' };
  }

  // expired / denied / error — clear the session.
  store.delete({ name: DEVICE_COOKIE, path: '/cms' });
  if (poll.status === 'expired') return { status: 'error', error: 'Authorization timed out — start again.' };
  if (poll.status === 'denied') return { status: 'error', error: 'Authorization was declined.' };
  return { status: 'error', error: poll.error };
}
