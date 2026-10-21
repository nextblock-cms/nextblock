import 'server-only';

// lib/botProtection/verify.ts
//
// Shared server-side bot-protection verification: the honeypot check plus
// Cloudflare Turnstile / Google reCAPTCHA token verification. This is the single
// source of truth used by BOTH the page contact-form handler
// (app/actions/formActions.ts) and the account-signup action (app/actions.ts).
//
// Server-only: it reads the RLS-bypassing service-role client, which throws if
// imported into a Client Component.

import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

import {
  HONEYPOT_FIELD,
  LEGACY_HONEYPOT_FIELD,
  RECAPTCHA_TOKEN_FIELD,
  TURNSTILE_TOKEN_FIELD,
} from './fields';
import { BOT_PROTECTION_SECRET_SETTING_KEY, readStoredBotProtectionSecret } from './secret';

export type BotProtectionProvider = 'none' | 'turnstile' | 'recaptcha';

// Shared field names — the client widgets emit these, the verifier reads them. They live in
// ./fields so client components can import them without this server-only module.
export { HONEYPOT_FIELD, LEGACY_HONEYPOT_FIELD, RECAPTCHA_TOKEN_FIELD, TURNSTILE_TOKEN_FIELD };

export type BotProtectionResult =
  // Passed (or nothing configured beyond the honeypot).
  | { ok: true }
  // The honeypot was filled — almost certainly a bot. Callers should silently
  // discard the submission and fake a success so the bot learns nothing.
  | { ok: false; reason: 'honeypot' }
  // The captcha was missing, failed, or could not be checked. `message` is a
  // human-readable explanation safe to surface to the user.
  | { ok: false; reason: 'captcha'; message: string };

type VerifyOptions = {
  // A block/form may pin a specific provider; otherwise the site-wide setting
  // (site_settings.bot_protection_public.provider) is used.
  botProtectionProvider?: BotProtectionProvider;
};

/**
 * Verify a submitted FormData against the configured bot protection.
 *
 * Phase 1 (honeypot) needs no network/DB and always runs — it is the always-on
 * baseline. Phase 2 (captcha) reads the global provider + secret from
 * `site_settings` and calls the provider's siteverify endpoint.
 */
export async function verifyBotProtection(
  formData: FormData,
  options?: VerifyOptions
): Promise<BotProtectionResult> {
  // Phase 1: Honeypot validation
  const honeypotFilled = [HONEYPOT_FIELD, LEGACY_HONEYPOT_FIELD].some((field) => {
    const value = formData.get(field);
    return typeof value === 'string' && value.length > 0;
  });
  if (honeypotFilled) {
    console.warn('[Bot Protection] Honeypot triggered. Discarding submission from bot.');
    return { ok: false, reason: 'honeypot' };
  }

  // Phase 2: Advanced captcha verification
  try {
    const supabase = getServiceRoleSupabaseClient();

    const { data: publicSetting } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', 'bot_protection_public')
      .maybeSingle();

    const { data: secretSetting } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', BOT_PROTECTION_SECRET_SETTING_KEY)
      .maybeSingle();

    const publicVal = (publicSetting?.value || {}) as Record<string, any>;

    const pinnedProvider =
      options?.botProtectionProvider === 'turnstile' || options?.botProtectionProvider === 'recaptcha'
        ? options.botProtectionProvider
        : undefined;
    const provider: BotProtectionProvider = pinnedProvider || publicVal.provider || 'none';

    // The stored secret is envelope-encrypted at rest (lib/botProtection/secret.ts); a
    // pre-encryption plaintext row still reads fine. Env is the fallback either way.
    const stored = readStoredBotProtectionSecret(secretSetting?.value);
    if (provider !== 'none' && stored.storage === 'unreadable') {
      console.error(
        '[Bot Protection] The stored secret key cannot be decrypted with the configured encryption key. Re-enter it in CMS Settings > Bot Protection; falling back to the environment variable.'
      );
    }
    const secretKey =
      stored.secretKey ||
      (provider === 'turnstile'
        ? process.env.TURNSTILE_SECRET_KEY
        : process.env.RECAPTCHA_SECRET_KEY) ||
      '';

    if (provider === 'turnstile') {
      const token = formData.get(TURNSTILE_TOKEN_FIELD) as string;
      if (!token) {
        return { ok: false, reason: 'captcha', message: 'Security verification token is missing. Please try again.' };
      }
      if (!secretKey) {
        console.error('[Bot Protection] Turnstile secret key is not configured.');
        return { ok: false, reason: 'captcha', message: 'Bot protection is misconfigured. Please contact support.' };
      }

      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`,
      });

      const outcome = await res.json();
      if (!outcome.success) {
        console.warn('[Bot Protection] Turnstile verification failed:', outcome);
        return { ok: false, reason: 'captcha', message: 'Security verification failed. Please try again.' };
      }
    } else if (provider === 'recaptcha') {
      const token = formData.get(RECAPTCHA_TOKEN_FIELD) as string;
      if (!token) {
        return { ok: false, reason: 'captcha', message: 'Security verification token is missing. Please try again.' };
      }
      if (!secretKey) {
        console.error('[Bot Protection] reCAPTCHA secret key is not configured.');
        return { ok: false, reason: 'captcha', message: 'Bot protection is misconfigured. Please contact support.' };
      }

      const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`,
      });

      const outcome = await res.json();
      if (!outcome.success || outcome.score < 0.5) {
        console.warn('[Bot Protection] reCAPTCHA verification failed:', outcome);
        return { ok: false, reason: 'captcha', message: 'Security verification failed. Please try again.' };
      }
    }
  } catch (error) {
    console.error('[Bot Protection] Error during validation:', error);
    return { ok: false, reason: 'captcha', message: 'Sorry, security verification could not be completed at this time.' };
  }

  return { ok: true };
}
