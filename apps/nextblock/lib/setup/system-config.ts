import 'server-only';
// Server-only read/write for the `system_configuration` singleton table.
// Mirrors lib/privacy/settings.ts, but the data lives in a dedicated ADMIN-only
// table (migration 00000000000030) rather than the public site_settings store.
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import type { Json } from '@nextblock-cms/db';
import { requireCmsAdmin } from '../auth/cms-actor';
import { DEFAULT_SYSTEM_CONFIGURATION, type SystemConfiguration } from './types';

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === 'on';
  return fallback;
}

function asSettings(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type ConfigPatch = Partial<Pick<SystemConfiguration, 'auto_accept_signups'>> & {
  settings?: Record<string, unknown>;
};

/** Build a row payload, casting the loosely-typed settings object to the DB Json type. */
function toRow(patch: ConfigPatch): {
  auto_accept_signups?: boolean;
  settings?: Json;
  updated_at: string;
} {
  const row: { auto_accept_signups?: boolean; settings?: Json; updated_at: string } = {
    updated_at: new Date().toISOString(),
  };
  if (patch.auto_accept_signups !== undefined) {
    row.auto_accept_signups = patch.auto_accept_signups;
  }
  if (patch.settings !== undefined) {
    row.settings = patch.settings as unknown as Json;
  }
  return row;
}

/**
 * Read the singleton config. Uses the service-role client so it works from any
 * context — including the anonymous public sign-up path, which must read
 * `auto_accept_signups` even though the table is otherwise ADMIN-only. Falls back to
 * safe defaults when the service-role key is absent (unconfigured instance).
 */
export async function getSystemConfiguration(): Promise<SystemConfiguration> {
  let supabase: ReturnType<typeof getServiceRoleSupabaseClient>;
  try {
    supabase = getServiceRoleSupabaseClient();
  } catch {
    return DEFAULT_SYSTEM_CONFIGURATION;
  }

  const { data, error } = await supabase
    .from('system_configuration')
    .select('auto_accept_signups, settings')
    .eq('id', 1)
    .maybeSingle();

  if (error || !data) {
    return DEFAULT_SYSTEM_CONFIGURATION;
  }

  return {
    auto_accept_signups: asBool(data.auto_accept_signups, false),
    settings: asSettings(data.settings),
  };
}

/**
 * Persist a partial update for the signed-in ADMIN — used by the CMS security and
 * registration settings. The write uses the service-role client after requireCmsAdmin():
 * migration 02028 puts system_configuration behind public.is_admin_mfa(), which an admin on a
 * "remember this device" session or on the email second factor never passes over PostgREST, so
 * the in-code check is the authorization boundary. Throws `Unauthorized` / `Forbidden`. The
 * wizard (which runs before any admin exists) uses setSystemConfigurationServiceRole instead.
 */
export async function updateSystemConfiguration(patch: ConfigPatch): Promise<void> {
  const { supabase } = await requireCmsAdmin();
  const { error } = await supabase
    .from('system_configuration')
    .update(toRow(patch))
    .eq('id', 1);

  if (error) {
    console.error('Error saving system configuration:', error.message);
    throw new Error('Failed to save system configuration.');
  }
}

/**
 * Seed/update the singleton with the service-role client (bypasses RLS). Used by the
 * /setup wizard before the first admin exists.
 */
export async function setSystemConfigurationServiceRole(patch: ConfigPatch): Promise<void> {
  const supabase = getServiceRoleSupabaseClient();
  const { error } = await supabase
    .from('system_configuration')
    .upsert({ id: 1, ...toRow(patch) });

  if (error) {
    console.error('Error seeding system configuration:', error.message);
    throw new Error('Failed to seed system configuration.');
  }
}
