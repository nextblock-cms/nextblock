// app/cms/settings/bot-protection/actions.ts
'use server';

import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { revalidatePath } from 'next/cache';
import type { SettingsActionResult } from '../../../../lib/cms/action-result';
import { getCmsActor, requireCmsAdmin } from '../../../../lib/auth/cms-actor';
import {
  BOT_PROTECTION_SECRET_SETTING_KEY,
  buildBotProtectionSecretValue,
  readStoredBotProtectionSecret,
  type BotProtectionSecretValue,
} from '../../../../lib/botProtection/secret';

export type BotProtectionSettings = {
  provider: 'none' | 'turnstile' | 'recaptcha';
  siteKey: string;
  secretKey?: string;
};

/**
 * ADMIN only, read with the service role after the role check. `bot_protection_secret` is
 * the ADMIN tier of `site_settings`, which migration 02023 gates behind `is_admin_mfa()`, so
 * through the cookie client an ADMIN on an aal1 "remember this device" session would see an
 * empty secret on their own form (see `lib/auth/cms-actor.ts`). Throws for anyone else; the
 * page is under /cms/settings, which proxy.ts keeps ADMIN-only.
 */
export async function getBotProtectionSettings(): Promise<BotProtectionSettings> {
  const { supabase } = await requireCmsAdmin();

  // Fetch public settings
  const { data: publicData } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', 'bot_protection_public')
    .maybeSingle();

  // Fetch secret settings
  const { data: secretData } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', BOT_PROTECTION_SECRET_SETTING_KEY)
    .maybeSingle();

  const publicVal = (publicData?.value || {}) as Record<string, any>;

  // Decrypts the stored envelope (a pre-encryption plaintext row passes through; an envelope
  // the configured key cannot open reads as empty so the admin re-enters it).
  const { secretKey } = readStoredBotProtectionSecret(secretData?.value);

  return {
    provider: (publicVal.provider as any) || 'none',
    siteKey: publicVal.siteKey || '',
    secretKey,
  };
}

export async function updateBotProtectionSettings(
  formData: FormData,
): Promise<SettingsActionResult> {
  // Verify auth and role (own profile row through the cookie session — never gated).
  const actor = await getCmsActor();
  if (!actor) {
    return { ok: false, error: 'You must be logged in to update settings.' };
  }

  if (actor.role !== 'ADMIN') {
    return { ok: false, error: 'You do not have permission to perform this action.' };
  }

  // Everything below writes with the service role: the secret row is in the ADMIN-only
  // write tier that migration 02023 gates behind is_admin_mfa(), which an admin on an aal1
  // "remember this device" session cannot satisfy through the cookie client. The role
  // check above is the authorization boundary.
  const supabase = getServiceRoleSupabaseClient();

  const provider = formData.get('provider') as 'none' | 'turnstile' | 'recaptcha';
  const siteKey = String(formData.get('siteKey') ?? '');
  const submittedSecret = String(formData.get('secretKey') ?? '').trim();

  // Decide what the secret row becomes BEFORE writing anything, so a missing encryption
  // key fails the whole save instead of leaving the public half updated.
  //
  // - A submitted secret is encrypted at rest (never stored or logged in cleartext).
  // - An empty field keeps whatever is stored: the form always re-submits the current
  //   value, so empty only comes from a hand-built request, and clobbering the secret
  //   with '' would silently break every captcha-protected form.
  // - A pre-encryption plaintext row is re-encrypted on this save even when the field is
  //   empty, which is how existing installs migrate without a data migration.
  const { data: existingSecret } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', BOT_PROTECTION_SECRET_SETTING_KEY)
    .maybeSingle();
  const stored = readStoredBotProtectionSecret(existingSecret?.value);
  const secretToStore =
    submittedSecret || (stored.storage === 'legacy-plaintext' ? stored.secretKey : '');

  let secretValue: BotProtectionSecretValue | null = null;
  if (secretToStore) {
    try {
      secretValue = buildBotProtectionSecretValue(secretToStore);
    } catch (error) {
      // The error names the missing env key, never the secret.
      console.error(
        'Error encrypting bot protection secret:',
        error instanceof Error ? error.message : 'unknown error',
      );
      return {
        ok: false,
        error:
          'Failed to encrypt the bot protection secret. Set NEXTBLOCK_ENCRYPTION_KEY (or the Supabase service-role key) and try again.',
      };
    }
  }

  // Update public settings (provider and siteKey)
  const { error: publicError } = await supabase
    .from('site_settings')
    .upsert({
      key: 'bot_protection_public',
      value: { provider, siteKey },
    });

  if (publicError) {
    console.error('Error updating public bot protection settings:', publicError);
    return { ok: false, error: 'Failed to update bot protection settings.' };
  }

  // Update secret settings (encrypted secretKey)
  if (secretValue) {
    const { error: secretError } = await supabase
      .from('site_settings')
      .upsert({
        key: BOT_PROTECTION_SECRET_SETTING_KEY,
        value: secretValue,
      });

    if (secretError) {
      console.error('Error updating secret bot protection settings:', secretError);
      return { ok: false, error: 'Failed to update bot protection secrets.' };
    }
  }

  // Revalidate root layout so scripts update instantly
  revalidatePath('/', 'layout');

  return { ok: true, message: 'Bot protection settings updated successfully.' };
}
