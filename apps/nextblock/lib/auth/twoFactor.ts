// Server-only two-factor orchestration: email-code challenges, the signed
// "email second factor satisfied" session cookie, and the gate that decides
// whether a signed-in user still owes a second factor before reaching the CMS.
import { createClient, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { generateNumericCode, hmacSign, safeEqual, sha256Hex } from './crypto';
import {
  TWO_FACTOR_COOKIE,
  clearCookie,
  getCookieValue,
  setSecureCookie,
} from './cookies';
import { hasValidTrustedDevice } from './trustedDevices';
import { getSecuritySettings } from '../privacy/settings';

const EMAIL_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TWO_FACTOR_SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours

/**
 * How many of a user's most recent codes stay usable at once.
 *
 * Relays (SMTP2GO, SES, …) do not preserve send order and can take minutes to deliver, so
 * a user who clicks "resend" often receives the ORIGINAL code first. Hard-invalidating on
 * every request made that first-arriving code fail — the classic "the code you emailed me
 * doesn't work" loop. Keeping a short window of concurrently valid codes removes the race;
 * the guess surface stays bounded because only this many are ever checked and all of them
 * die on first successful use (and after EMAIL_CODE_TTL_MS regardless).
 */
const MAX_LIVE_EMAIL_CODES = 3;

/**
 * Wrong email-code guesses allowed against one live code pool before it is burned. Low because the
 * attacker who reaches this already holds the first factor (the password); the legitimate user
 * mistypes a handful of times at most and can always request a fresh code.
 */
const MAX_VERIFY_ATTEMPTS = 5;

/**
 * Minimum gap between user-requested codes. Deliberately shorter than the UI countdown so a
 * normal user never sees the server refusal — the client timer is a courtesy that a crafted
 * request ignores, and this is what actually bounds how fast one session can drive the mailer.
 */
const RESEND_COOLDOWN_MS = 20_000;

/**
 * Create and persist a hashed 6-digit email code and return the RAW code so the caller can
 * email it. Earlier codes are deliberately left alive — see MAX_LIVE_EMAIL_CODES. Kept to a
 * single round trip: this sits directly in front of the SMTP handoff on a click path.
 */
export async function createEmailChallenge(userId: string): Promise<string> {
  const code = generateNumericCode(6);
  const svc = getServiceRoleSupabaseClient();

  await svc.from('email_2fa_challenges').insert({
    user_id: userId,
    token_hash: sha256Hex(code),
    expires_at: new Date(Date.now() + EMAIL_CODE_TTL_MS).toISOString(),
  });

  return code;
}

/**
 * Seconds the caller must wait before another code may be requested, or 0 when a send is
 * allowed. Considers consumed rows too — this measures time since the last SEND, not since
 * the last still-usable code.
 */
export async function getEmailResendCooldownSeconds(userId: string): Promise<number> {
  const svc = getServiceRoleSupabaseClient();
  const { data } = await svc
    .from('email_2fa_challenges')
    .select('created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);

  const latest = data?.[0]?.created_at;
  if (!latest) return 0;
  const elapsed = Date.now() - new Date(latest).getTime();
  if (!Number.isFinite(elapsed) || elapsed >= RESEND_COOLDOWN_MS) return 0;
  return Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
}

/** True when the user has an unconsumed, unexpired email code awaiting entry. */
export async function hasPendingEmailChallenge(userId: string): Promise<boolean> {
  const svc = getServiceRoleSupabaseClient();
  const { data } = await svc
    .from('email_2fa_challenges')
    .select('id')
    .eq('user_id', userId)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .limit(1);
  return Boolean(data && data.length > 0);
}

/**
 * Verify a submitted email code against the user's live challenges. Any of the newest
 * MAX_LIVE_EMAIL_CODES is accepted, so a code that arrives out of order still works;
 * anything older than that window is unreachable even though its row lingers until expiry.
 */
export async function verifyEmailChallenge(userId: string, code: string): Promise<boolean> {
  const trimmed = (code || '').trim();
  if (!/^\d{6}$/.test(trimmed)) return false;

  const svc = getServiceRoleSupabaseClient();
  const nowIso = new Date().toISOString();
  const { data } = await svc
    .from('email_2fa_challenges')
    .select('id, token_hash, expires_at')
    .eq('user_id', userId)
    .is('consumed_at', null)
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: false })
    .limit(MAX_LIVE_EMAIL_CODES);

  // An empty pool also covers the locked-out case: once MAX_VERIFY_ATTEMPTS is reached the pool is
  // burned (consumed) below, so a locked user has no live rows and must request a fresh code.
  if (!data || data.length === 0) return false;

  const candidateHash = sha256Hex(trimmed);
  const match = data.find((row) => safeEqual(row.token_hash, candidateHash));
  if (!match) {
    // Lockout: a party holding the victim's password must not iterate the 10^6 code space.
    // Count the failed guess atomically across the live pool (one shared budget, no read-then-
    // write race); when it reaches the cap, burn the pool so none of its codes stays redeemable.
    // `attempts` / bump_email_2fa_attempts arrive with migration 02022; cast past the generated
    // types until `npm run db:types` is regenerated.
    const { data: bumped } = await (svc as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: number | null }>;
    }).rpc('bump_email_2fa_attempts', { p_user_id: userId });
    if (typeof bumped === 'number' && bumped >= MAX_VERIFY_ATTEMPTS) {
      await svc
        .from('email_2fa_challenges')
        .update({ consumed_at: nowIso })
        .eq('user_id', userId)
        .is('consumed_at', null);
    }
    return false;
  }

  // Burn every live code for this user, not just the matched row: the siblings from a
  // resend have served their purpose and must not stay redeemable after a success.
  await svc
    .from('email_2fa_challenges')
    .update({ consumed_at: nowIso })
    .eq('user_id', userId)
    .is('consumed_at', null);
  return true;
}

/** Issue the signed cookie that marks the email second factor satisfied. */
export async function issueTwoFactorVerifiedCookie(userId: string): Promise<void> {
  const exp = Date.now() + TWO_FACTOR_SESSION_TTL_SECONDS * 1000;
  const payload = `${userId}.${exp}`;
  await setSecureCookie(
    TWO_FACTOR_COOKIE,
    `${payload}.${hmacSign(payload)}`,
    TWO_FACTOR_SESSION_TTL_SECONDS,
  );
}

export async function clearTwoFactorVerifiedCookie(): Promise<void> {
  await clearCookie(TWO_FACTOR_COOKIE);
}

/** Validate the signed email-2FA cookie for a specific user. */
export async function hasValidTwoFactorCookie(userId: string): Promise<boolean> {
  const raw = await getCookieValue(TWO_FACTOR_COOKIE);
  if (!raw) return false;
  const parts = raw.split('.');
  if (parts.length !== 3) return false;
  const [uid, expStr, sig] = parts;
  if (uid !== userId) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  return safeEqual(hmacSign(`${uid}.${expStr}`), sig);
}

export type TwoFactorStatus =
  | 'not_required'
  | 'satisfied'
  | 'totp_required'
  | 'email_required';

export interface TwoFactorEvaluation {
  status: TwoFactorStatus;
  userId: string | null;
  mfaType: 'totp' | 'email' | null;
}

/**
 * Whether to surface the "set up two-factor authentication" reminder banner to the
 * currently signed-in staff user. True only when: not in sandbox, the user is an
 * ADMIN/WRITER, the global "encourage staff to enable 2FA" policy is on, and the user
 * has not enrolled a second factor. Best-effort — any failure resolves to no banner.
 */
export async function getStaffTwoFactorReminder(): Promise<boolean> {
  // Sandbox runs on a shared demo account; never nag it (the page is disabled there too).
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') return false;

  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    const role = profile?.role;
    if (role !== 'ADMIN' && role !== 'WRITER') return false;

    const { enforce_staff_2fa } = await getSecuritySettings();
    if (!enforce_staff_2fa) return false;

    const { data: settings } = await supabase
      .from('user_security_settings')
      .select('mfa_enabled, mfa_type')
      .eq('user_id', user.id)
      .maybeSingle();

    return !(settings?.mfa_enabled && settings?.mfa_type);
  } catch {
    return false;
  }
}

/**
 * Decide whether the currently signed-in user still owes a second factor.
 * Used both to route sign-in and to guard /cms server-side.
 */
export async function evaluateTwoFactor(): Promise<TwoFactorEvaluation> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: 'not_required', userId: null, mfaType: null };

  // Sandbox/demo mode runs on a single shared public account. Never enforce a
  // second factor there — otherwise anyone enrolling the demo account in 2FA
  // would lock out every other visitor until the next sandbox reset.
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    return { status: 'satisfied', userId: user.id, mfaType: null };
  }

  const { data: settings } = await supabase
    .from('user_security_settings')
    .select('mfa_enabled, mfa_type')
    .eq('user_id', user.id)
    .maybeSingle();

  const mfaType = (settings?.mfa_type as 'totp' | 'email' | null) ?? null;
  if (!settings || !settings.mfa_enabled || !mfaType) {
    return { status: 'satisfied', userId: user.id, mfaType: null };
  }

  // A live trusted device bypasses the second factor entirely.
  if (await hasValidTrustedDevice(user.id)) {
    return { status: 'satisfied', userId: user.id, mfaType };
  }

  if (mfaType === 'totp') {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel === 'aal2') {
      return { status: 'satisfied', userId: user.id, mfaType };
    }
    return { status: 'totp_required', userId: user.id, mfaType };
  }

  // Email path.
  if (await hasValidTwoFactorCookie(user.id)) {
    return { status: 'satisfied', userId: user.id, mfaType };
  }
  return { status: 'email_required', userId: user.id, mfaType };
}
