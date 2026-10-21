'use server';

import { headers } from 'next/headers';
import { isSafeInternalPath } from '../../../lib/auth-redirects';
import { redirect } from 'next/navigation';
import { createClient } from '@nextblock-cms/db/server';
import {
  createEmailChallenge,
  getEmailResendCooldownSeconds,
  issueTwoFactorVerifiedCookie,
  verifyEmailChallenge,
} from '../../../lib/auth/twoFactor';
import { issueTrustedDevice } from '../../../lib/auth/trustedDevices';
import {
  REMEMBER_INTENT_COOKIE,
  clearCookie,
  getCookieValue,
} from '../../../lib/auth/cookies';
import { sendTwoFactorCodeEmail } from '../../actions/twoFactorEmail';
import { isEmailConfigured } from '../../../lib/config/email-settings';

// One shared rule for redirect targets: `/\evil.com` (from `/%5Cevil.com`) passed the old
// startsWith('/') check and sent the user off-site after their second factor (2026-10-21).
function safeRedirect(path?: string): string {
  return path && isSafeInternalPath(path) ? path : '/cms/dashboard';
}

/** If the user opted into "remember this device" at login, mint the trust now. */
async function maybeIssueTrustedDevice(userId: string): Promise<void> {
  const intent = await getCookieValue(REMEMBER_INTENT_COOKIE);
  if (intent !== '1') return;
  const userAgent = (await headers()).get('user-agent');
  await issueTrustedDevice(userId, userAgent);
  await clearCookie(REMEMBER_INTENT_COOKIE);
}

export async function verifyTotpChallenge(formData: FormData) {
  const code = (formData.get('code')?.toString() ?? '').trim();
  const redirectTo = safeRedirect(formData.get('redirect_to')?.toString());
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Your session expired. Please sign in again.' };
  if (!/^\d{6}$/.test(code)) return { error: 'Enter the 6-digit code from your app.' };

  const { data: factors } = await supabase.auth.mfa.listFactors();
  const factor = factors?.totp?.find((f) => f.status === 'verified');
  if (!factor) return { error: 'No authenticator is set up for this account.' };

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId: factor.id,
  });
  if (challengeError || !challenge) return { error: 'Could not start verification.' };

  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId: factor.id,
    challengeId: challenge.id,
    code,
  });
  if (verifyError) return { error: 'That code was not valid. Please try again.' };

  await maybeIssueTrustedDevice(user.id);
  redirect(redirectTo);
}

export async function verifyEmailCode(formData: FormData) {
  const code = (formData.get('code')?.toString() ?? '').trim();
  const redirectTo = safeRedirect(formData.get('redirect_to')?.toString());
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Your session expired. Please sign in again.' };

  const ok = await verifyEmailChallenge(user.id, code);
  if (!ok) return { error: 'That code was incorrect or expired. Request a new one.' };

  await issueTwoFactorVerifiedCookie(user.id);
  await maybeIssueTrustedDevice(user.id);
  redirect(redirectTo);
}

export async function resendEmailCode() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { error: 'No email address is associated with your account.' };

  // No transport means the code can never arrive; say so rather than claiming it was sent.
  if (!(await isEmailConfigured())) {
    return {
      error:
        'This site has no email server configured, so a code cannot be sent. Contact your administrator.',
    };
  }

  const wait = await getEmailResendCooldownSeconds(user.id);
  if (wait > 0) {
    return { error: `A code was just sent. Please wait ${wait}s before requesting another.` };
  }

  const code = await createEmailChallenge(user.id);
  try {
    await sendTwoFactorCodeEmail(user.email, code);
  } catch (sendError) {
    console.error('Failed to send 2FA email code:', sendError);
    return { error: 'The mail server rejected the message. Please try again in a moment.' };
  }
  return { success: true, message: `A new code is on its way to ${user.email}.` };
}
