'use server';

import 'server-only';

import { createClient, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { revalidatePath } from 'next/cache';
import { sendTwoFactorCodeEmail } from '../../../actions/twoFactorEmail';
import {
  getSecuritySettings as readSecuritySettings,
  saveSecuritySettings,
} from '../../../../lib/privacy/settings';
import {
  MAX_TRUSTED_DEVICE_DAYS,
  MIN_TRUSTED_DEVICE_DAYS,
  type SecuritySettings,
} from '../../../../lib/privacy/types';
import {
  createEmailChallenge,
  evaluateTwoFactor,
  getEmailResendCooldownSeconds,
  issueTwoFactorVerifiedCookie,
  clearTwoFactorVerifiedCookie,
  verifyEmailChallenge,
} from '../../../../lib/auth/twoFactor';
import {
  listTrustedDevices,
  revokeAllTrustedDevices,
  revokeTrustedDevice,
  type TrustedDeviceRow,
} from '../../../../lib/auth/trustedDevices';
import {
  getSystemConfiguration,
  updateSystemConfiguration,
} from '../../../../lib/setup/system-config';
import { isEmailConfigured } from '../../../../lib/config/email-settings';

export interface SecurityPanelData {
  email: string;
  mfaEnabled: boolean;
  mfaType: 'totp' | 'email' | null;
  hasVerifiedTotp: boolean;
  isAdmin: boolean;
  globalSettings: SecuritySettings;
  trustedDevices: TrustedDeviceRow[];
  autoAcceptSignups: boolean;
  /** False when no SMTP transport resolves — the email factor cannot be offered. */
  emailConfigured: boolean;
}

/**
 * Every mutating action here returns this instead of throwing. Next replaces the message of
 * an uncaught Server Action error with a generic string in production, and these messages
 * ("that code was not valid", "only administrators can…") are exactly the ones the user has
 * to be able to read.
 */
export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; needsSmtp?: boolean };

async function requireUser() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error('You must be signed in.');
  }
  // A server action is reachable with nothing but the session cookie, so the /cms layout's
  // second-factor gate does not protect it. A first-factor-only session (a stolen cookie,
  // or a user who has not finished the challenge) must not be able to disable or re-enrol
  // the factor that is still owed.
  const twoFactor = await evaluateTwoFactor();
  if (twoFactor.status === 'totp_required' || twoFactor.status === 'email_required') {
    throw new Error('Verify your second factor before changing security settings.');
  }
  return { supabase, user };
}

/**
 * user_security_settings is written through the service role only (migration 02021 removed
 * the owner INSERT/UPDATE policies): the row decides whether /cms asks for a second factor,
 * so a session must not be able to flip it over REST without passing the verification these
 * actions perform first.
 */
function securitySettingsWriter() {
  return getServiceRoleSupabaseClient().from('user_security_settings');
}

/**
 * Runs an action body, converting anything it throws into a readable returned result.
 * Business-rule failures should `return` a failure directly; this is the net for the
 * unexpected (expired session, dropped connection) so it still surfaces a real message.
 */
async function guard(body: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await body();
  } catch (error) {
    console.error('Security settings action failed:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Something went wrong.',
    };
  }
}

export async function getSecurityPanelData(): Promise<SecurityPanelData> {
  const { supabase, user } = await requireUser();

  // Every read here is independent, so they all go out together — awaiting them inline in
  // the returned object would serialize the round trips behind each other on page load.
  const [
    { data: settings },
    { data: profile },
    { data: factors },
    emailConfigured,
    globalSettings,
    trustedDevices,
    systemConfig,
  ] = await Promise.all([
    supabase
      .from('user_security_settings')
      .select('mfa_enabled, mfa_type')
      .eq('user_id', user.id)
      .maybeSingle(),
    supabase.from('profiles').select('role').eq('id', user.id).single(),
    supabase.auth.mfa.listFactors(),
    isEmailConfigured(),
    readSecuritySettings(),
    listTrustedDevices(user.id),
    getSystemConfiguration(),
  ]);

  // listFactors().totp only contains verified TOTP factors.
  const hasVerifiedTotp = Boolean(factors?.totp && factors.totp.length > 0);

  return {
    email: user.email ?? '',
    mfaEnabled: Boolean(settings?.mfa_enabled),
    mfaType: (settings?.mfa_type as 'totp' | 'email' | null) ?? null,
    hasVerifiedTotp,
    isAdmin: profile?.role === 'ADMIN',
    globalSettings,
    trustedDevices,
    autoAcceptSignups: systemConfig.auto_accept_signups,
    emailConfigured,
  };
}

// --- Sign-up policy (admin only) ------------------------------------------------

export async function updateAutoAcceptSignups(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { supabase, user } = await requireUser();
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    if (profile?.role !== 'ADMIN') {
      return { ok: false, error: 'Only administrators can change the sign-up policy.' };
    }

    const enabled = formData.get('auto_accept_signups') === 'true';
    await updateSystemConfiguration({ auto_accept_signups: enabled });
    revalidatePath('/cms/settings/security');
    return {
      ok: true,
      message: enabled
        ? 'New sign-ups will be auto-approved without email verification.'
        : 'New sign-ups now require email verification.',
    };
  });
}

// --- Global policy (admin only) -------------------------------------------------

export async function updateGlobalSecuritySettings(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
      return { ok: false, error: 'Security settings are disabled in the sandbox environment.' };
    }
    const { supabase, user } = await requireUser();
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    if (profile?.role !== 'ADMIN') {
      return { ok: false, error: 'Only administrators can change the global security policy.' };
    }

    const days = Number.parseInt(formData.get('trusted_device_days')?.toString() ?? '', 10);
    const settings: SecuritySettings = {
      trusted_device_days: Number.isFinite(days)
        ? Math.min(MAX_TRUSTED_DEVICE_DAYS, Math.max(MIN_TRUSTED_DEVICE_DAYS, days))
        : 30,
      enforce_staff_2fa: formData.get('enforce_staff_2fa') === 'true',
    };

    await saveSecuritySettings(settings);
    revalidatePath('/cms/settings/security');
    return { ok: true, message: 'Security policy saved.' };
  });
}

// --- TOTP enrollment ------------------------------------------------------------

export type EnrollTotpResult =
  | { ok: true; factorId: string; qrCode: string; secret: string }
  | { ok: false; error: string };

export async function startTotpEnrollment(): Promise<EnrollTotpResult> {
  const { supabase } = await requireUser();

  // Clear any half-finished factors so re-enrolling never hits a name clash.
  // `listFactors().totp` only returns verified factors, so check `all`.
  const { data: existing } = await supabase.auth.mfa.listFactors();
  for (const factor of existing?.all ?? []) {
    if (factor.factor_type === 'totp' && factor.status === 'unverified') {
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: `nextblock-totp-${Date.now()}`,
  });

  if (error || !data) {
    return {
      ok: false,
      error:
        error?.message ??
        'Could not start authenticator setup. Ensure TOTP MFA is enabled for this Supabase project.',
    };
  }

  return {
    ok: true,
    factorId: data.id,
    qrCode: data.totp.qr_code,
    secret: data.totp.secret,
  };
}

export async function verifyTotpEnrollment(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { supabase, user } = await requireUser();
    const factorId = formData.get('factorId')?.toString() ?? '';
    const code = (formData.get('code')?.toString() ?? '').trim();

    if (!factorId || !/^\d{6}$/.test(code)) {
      return { ok: false, error: 'Enter the 6-digit code from your authenticator app.' };
    }

    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId,
    });
    if (challengeError || !challenge) {
      return { ok: false, error: challengeError?.message ?? 'Could not start verification.' };
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code,
    });
    if (verifyError) {
      return { ok: false, error: 'That code was not valid. Please try again.' };
    }

    const { error: upsertError } = await securitySettingsWriter().upsert({
      user_id: user.id,
      mfa_enabled: true,
      mfa_type: 'totp',
      updated_at: new Date().toISOString(),
    });
    if (upsertError) {
      return { ok: false, error: 'Verified, but failed to save your preference. Please retry.' };
    }

    revalidatePath('/cms/settings/security');
    return { ok: true, message: 'Authenticator app enabled.' };
  });
}

// --- Email-code enrollment ------------------------------------------------------

export async function sendEmailEnrollmentCode(): Promise<ActionResult> {
  return guard(async () => {
    const { user } = await requireUser();
    if (!user.email) {
      return { ok: false, error: 'Your account has no email address on file.' };
    }

    // Check before minting a challenge: without a transport the code can never arrive, and
    // an unconfigured instance should say so rather than claim an email is on its way.
    if (!(await isEmailConfigured())) {
      return {
        ok: false,
        needsSmtp: true,
        error:
          'Email is not configured on this site, so a code cannot be delivered. Set up SMTP first.',
      };
    }

    const wait = await getEmailResendCooldownSeconds(user.id);
    if (wait > 0) {
      return {
        ok: false,
        error: `A code was just sent. Please wait ${wait}s before requesting another.`,
      };
    }

    const code = await createEmailChallenge(user.id);
    try {
      await sendTwoFactorCodeEmail(user.email, code, 'enable email two-factor authentication');
    } catch (sendError) {
      console.error('Failed to send 2FA enrollment code:', sendError);
      return {
        ok: false,
        error:
          'Your mail server rejected the message. Check the SMTP settings under Settings → Email and try again.',
      };
    }

    return { ok: true, message: `We sent a 6-digit code to ${user.email}.` };
  });
}

export async function verifyEmailEnrollment(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { user } = await requireUser();
    const code = (formData.get('code')?.toString() ?? '').trim();

    const verified = await verifyEmailChallenge(user.id, code);
    if (!verified) {
      return { ok: false, error: 'That code was incorrect or expired. Request a new one.' };
    }

    const { error } = await securitySettingsWriter().upsert({
      user_id: user.id,
      mfa_enabled: true,
      mfa_type: 'email',
      updated_at: new Date().toISOString(),
    });
    if (error) {
      return { ok: false, error: 'Verified, but failed to save your preference. Please retry.' };
    }

    // The user just proved control of their inbox, so this session is satisfied.
    await issueTwoFactorVerifiedCookie(user.id);
    revalidatePath('/cms/settings/security');
    return { ok: true, message: 'Email verification enabled.' };
  });
}

// --- Disable / device management ------------------------------------------------

export async function disableMfa(): Promise<ActionResult> {
  return guard(async () => {
    const { supabase, user } = await requireUser();

    const { data: factors } = await supabase.auth.mfa.listFactors();
    for (const factor of factors?.all ?? []) {
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }

    const { error } = await securitySettingsWriter().upsert({
      user_id: user.id,
      mfa_enabled: false,
      mfa_type: null,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      return {
        ok: false,
        error: 'Could not turn off two-factor authentication. Please retry.',
      };
    }

    await revokeAllTrustedDevices(user.id);
    await clearTwoFactorVerifiedCookie();

    revalidatePath('/cms/settings/security');
    return { ok: true, message: 'Two-factor authentication disabled.' };
  });
}

export async function revokeTrustedDeviceAction(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const { user } = await requireUser();
    const id = formData.get('id')?.toString() ?? '';
    if (!id) {
      return { ok: false, error: 'Missing device id.' };
    }
    await revokeTrustedDevice(user.id, id);
    revalidatePath('/cms/settings/security');
    return { ok: true, message: 'Device revoked.' };
  });
}
