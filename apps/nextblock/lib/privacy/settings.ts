import 'server-only';

// Server-only read/write for the `privacy_settings` and `security_settings`
// rows in the site_settings key-value table. Reads use the cookie client (both keys are
// readable by every staff role, privacy_settings by everyone). Writes verify ADMIN and use
// the service role: both keys are in the ADMIN-only write tier that migration 02023 gates
// behind `is_admin_mfa()`, which an ADMIN on an aal1 "remember this device" session cannot
// satisfy through the cookie client (see lib/auth/cms-actor.ts). revalidatePath is handled
// by callers.
import type { Json } from '@nextblock-cms/db';
import { createClient } from '@nextblock-cms/db/server';
import { requireCmsAdmin } from '../auth/cms-actor';
import {
  DEFAULT_PRIVACY_SETTINGS,
  DEFAULT_SECURITY_SETTINGS,
  MAX_TRUSTED_DEVICE_DAYS,
  MIN_TRUSTED_DEVICE_DAYS,
  type CorporateIdentity,
  type PrivacySettings,
  type SecuritySettings,
} from './types';

const PRIVACY_KEY = 'privacy_settings';
const SECURITY_KEY = 'security_settings';

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === 'on';
  return fallback;
}

function normalizePrivacy(value: unknown): PrivacySettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const corporateRaw = (raw.corporate && typeof raw.corporate === 'object'
    ? raw.corporate
    : {}) as Record<string, unknown>;
  const corporate: CorporateIdentity = {
    legal_name: asString(corporateRaw.legal_name),
    address: asString(corporateRaw.address),
    support_email: asString(corporateRaw.support_email),
  };
  return {
    banner_enabled: asBool(raw.banner_enabled, DEFAULT_PRIVACY_SETTINGS.banner_enabled),
    gtm_id: asString(raw.gtm_id),
    ga_measurement_id: asString(raw.ga_measurement_id),
    custom_scripts: asString(raw.custom_scripts),
    corporate,
  };
}

function clampTrustDays(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(asString(value), 10);
  if (!Number.isFinite(n)) return DEFAULT_SECURITY_SETTINGS.trusted_device_days;
  return Math.min(MAX_TRUSTED_DEVICE_DAYS, Math.max(MIN_TRUSTED_DEVICE_DAYS, Math.round(n)));
}

function normalizeSecurity(value: unknown): SecuritySettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    trusted_device_days: clampTrustDays(raw.trusted_device_days),
    enforce_staff_2fa: asBool(raw.enforce_staff_2fa, DEFAULT_SECURITY_SETTINGS.enforce_staff_2fa),
  };
}

export async function getPrivacySettings(): Promise<PrivacySettings> {
  const supabase = createClient();
  const { data } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', PRIVACY_KEY)
    .maybeSingle();
  return normalizePrivacy(data?.value);
}

export async function getSecuritySettings(): Promise<SecuritySettings> {
  const supabase = createClient();
  const { data } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', SECURITY_KEY)
    .maybeSingle();
  return normalizeSecurity(data?.value);
}

export async function savePrivacySettings(input: PrivacySettings): Promise<void> {
  const { supabase } = await requireCmsAdmin();
  const value = normalizePrivacy(input);
  const { error } = await supabase
    .from('site_settings')
    .upsert({ key: PRIVACY_KEY, value: value as unknown as Json });
  if (error) {
    console.error('Error saving privacy settings:', error.message);
    throw new Error('Failed to save privacy settings.');
  }
}

// Privacy/consent and Google Analytics share the single `privacy_settings` row but
// are edited from two different CMS pages (Settings -> Privacy vs Settings -> Google
// Analytics). Each page must persist only its own fields without clobbering the other
// page's, so writes read-merge against the current row. (We may split this into a
// dedicated `analytics_settings` key later.)
export async function mergePrivacySettings(
  patch: Partial<PrivacySettings>
): Promise<void> {
  const current = await getPrivacySettings();
  await savePrivacySettings({ ...current, ...patch });
}

export async function saveSecuritySettings(input: SecuritySettings): Promise<void> {
  const { supabase } = await requireCmsAdmin();
  const value = normalizeSecurity(input);
  const { error } = await supabase
    .from('site_settings')
    .upsert({ key: SECURITY_KEY, value: value as unknown as Json });
  if (error) {
    console.error('Error saving security settings:', error.message);
    throw new Error('Failed to save security settings.');
  }
}
