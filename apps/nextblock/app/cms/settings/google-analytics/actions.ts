'use server';

import { createClient, isSandboxEnvironment } from '@nextblock-cms/db/server';
import { revalidatePath } from 'next/cache';
import {
  getPrivacySettings as readPrivacySettings,
  mergePrivacySettings,
} from '../../../../lib/privacy/settings';
import type { PrivacySettings } from '../../../../lib/privacy/types';
import type { SettingsActionResult } from '../../../../lib/cms/action-result';
import { SITE_SCRIPTS_SANDBOX_MESSAGE } from '../site-scripts/sandbox-lock';

export interface GoogleAnalyticsSettings {
  gtm_id: string;
  ga_measurement_id: string;
  custom_scripts: string;
}

export async function getGoogleAnalyticsSettings(): Promise<GoogleAnalyticsSettings> {
  const settings = await readPrivacySettings();
  return {
    gtm_id: settings.gtm_id,
    ga_measurement_id: settings.ga_measurement_id,
    custom_scripts: settings.custom_scripts,
  };
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
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (!profile || profile.role !== 'ADMIN') {
    return { ok: false, error: 'You do not have permission to perform this action.' };
  }
  return null;
}

export async function updateGoogleAnalyticsSettings(
  formData: FormData,
): Promise<SettingsActionResult> {
  const denied = await adminCheck();
  if (denied) return denied;

  // The sandbox's admin login is public: a GTM container or a custom script saved there would run
  // for every later visitor (ConsentGatedAnalytics injects nothing there either).
  if (isSandboxEnvironment()) return { ok: false, error: SITE_SCRIPTS_SANDBOX_MESSAGE };

  // Only the analytics fields are touched; mergePrivacySettings preserves the
  // banner/corporate fields owned by the Privacy & Consent page.
  const patch: Partial<PrivacySettings> = {
    gtm_id: (formData.get('gtm_id')?.toString() ?? '').trim(),
    ga_measurement_id: (formData.get('ga_measurement_id')?.toString() ?? '').trim(),
    custom_scripts: formData.get('custom_scripts')?.toString() ?? '',
  };

  try {
    await mergePrivacySettings(patch);
  } catch (error) {
    console.error('Failed to save Google Analytics settings:', error);
    return { ok: false, error: 'Failed to save Google Analytics settings.' };
  }
  // The analytics guard (GTM/GA4 + custom scripts) lives in the root layout.
  revalidatePath('/', 'layout');

  return { ok: true, message: 'Google Analytics settings saved.' };
}
