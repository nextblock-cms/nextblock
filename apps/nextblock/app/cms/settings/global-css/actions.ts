// app/cms/settings/global-css/actions.ts
'use server';

import { createClient, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { revalidatePath } from 'next/cache';
import type { SettingsActionResult } from '../../../../lib/cms/action-result';
import { getCmsActor } from '../../../../lib/auth/cms-actor';

export async function getGlobalCss(): Promise<string> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', 'global_css')
    .single();

  if (error || !data || !data.value) {
    return ''; // Default empty
  }

  // Value is stored as JSONB, but we might have saved it as a raw string or JSON encoded string.
  // Let's handle both.
  if (typeof data.value === 'string') {
      // If it looks like a JSON string with quotes, parse it
      if (data.value.startsWith('"') && data.value.endsWith('"')) {
          try {
              return JSON.parse(data.value);
          }catch{
              return data.value;
          }
      }
      return data.value;
  }

  return String(data.value);
}

export async function updateGlobalCss(css: string): Promise<SettingsActionResult> {
  const actor = await getCmsActor();
  if (!actor) {
    return { ok: false, error: 'You must be logged in to update settings.' };
  }

  // ADMIN only. `global_css` is injected site-wide (including /cms), so 02022 moved it into
  // the ADMIN-only write tier of site_settings; a WRITER has been refused by RLS since then,
  // and this check says so instead of returning an opaque write error.
  if (actor.role !== 'ADMIN') {
    return { ok: false, error: 'You do not have permission to perform this action.' };
  }

  // Written with the service role: migration 02023 gates that tier behind is_admin_mfa(),
  // which an admin on an aal1 "remember this device" session cannot satisfy through the
  // cookie client. The role check above is the authorization boundary.
  const { error } = await getServiceRoleSupabaseClient()
    .from('site_settings')
    .upsert({ key: 'global_css', value: css });

  if (error) {
    console.error('Error updating global CSS:', error);
    return { ok: false, error: 'Failed to update CSS.' };
  }

  revalidatePath('/', 'layout');
  return { ok: true, message: 'Global CSS updated successfully.' };
}
