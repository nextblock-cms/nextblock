// app/cms/settings/registration/actions.ts
'use server';

import { createClient } from '@nextblock-cms/db/server';
import { revalidatePath } from 'next/cache';
import {
  getSystemConfiguration,
  updateSystemConfiguration,
} from '../../../../lib/setup/system-config';
import type { SettingsActionResult } from '../../../../lib/cms/action-result';

export async function getRegistrationSettings(): Promise<{ autoAcceptSignups: boolean }> {
  const config = await getSystemConfiguration();
  return { autoAcceptSignups: config.auto_accept_signups };
}

/** Null when the caller is an ADMIN, otherwise the failure to return. */
async function adminCheck(): Promise<SettingsActionResult | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: 'You must be logged in to update settings.' };
  }
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (error || !profile || profile.role !== 'ADMIN') {
    return { ok: false, error: 'You do not have permission to perform this action.' };
  }
  return null;
}

export async function updateRegistrationSettings(
  formData: FormData,
): Promise<SettingsActionResult> {
  // The sandbox's admin login is public: auto-approve there would hand anyone live accounts.
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    return { ok: false, error: 'Sign-up settings are disabled in the sandbox.' };
  }
  const denied = await adminCheck();
  if (denied) return denied;

  const autoAcceptSignups =
    formData.get('autoAcceptSignups') === 'on' || formData.get('autoAcceptSignups') === 'true';

  try {
    await updateSystemConfiguration({ auto_accept_signups: autoAcceptSignups });
  } catch (error) {
    console.error('Failed to save registration settings:', error);
    return { ok: false, error: 'Failed to save registration settings.' };
  }

  revalidatePath('/cms/settings/registration');
  return { ok: true, message: 'Registration settings saved.' };
}
