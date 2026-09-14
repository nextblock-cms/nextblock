import 'server-only';
import { createClient } from './supabase/server';
import { unstable_cache } from 'next/cache';

/**
 * Verifies if a package is active and valid.
 *
 * @param packageId - The ID of the package to verify (e.g., 'ecommerce')
 * @returns boolean - true if active, false otherwise
 */
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';

/**
 * Cache tag for every cached activation read. Activation and deactivation call
 * `updateTag(PACKAGE_ACTIVATION_CACHE_TAG)` so a purchase unlocks the CMS on the very
 * next request instead of after the 60 s window.
 */
export const PACKAGE_ACTIVATION_CACHE_TAG = 'package-activation';

/** Freemius timestamps are "YYYY-MM-DD HH:mm:ss" UTC; ISO strings pass through. */
function parseLicenseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const trimmed = value.trim();
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const parsed = Date.parse(hasZone ? trimmed : `${trimmed.replace(' ', 'T')}Z`);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The moment a stored activation stops being valid, from what the row knows:
 * the license expiration (recorded from the vendor at checkout, from Freemius at
 * activation, and refreshed by the background re-validation) or the trial end. Null
 * when the row carries no date, which is the case for keys activated before these
 * fields existed and for lifetime licenses.
 */
export function resolvePackageActivationExpiry(meta: unknown): number | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }

  const record = meta as Record<string, unknown>;
  const nextblock =
    record['nextblock'] && typeof record['nextblock'] === 'object' && !Array.isArray(record['nextblock'])
      ? (record['nextblock'] as Record<string, unknown>)
      : null;
  const candidates = [nextblock?.['expiration'], nextblock?.['trial_ends_at'], record['expiration']]
    .map(parseLicenseTimestamp)
    .filter((value): value is number => value !== null);

  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/** A row counts only while its status is active AND any known expiry is in the future. */
export function isPackageActivationRowValid(row: { meta?: unknown; status?: unknown }, now = Date.now()) {
  if (row.status !== 'active') {
    return false;
  }

  const expiry = resolvePackageActivationExpiry(row.meta);

  return expiry === null || expiry > now;
}

async function queryPackageActivation(packageId: string, supabase: any): Promise<boolean> {
  try {
    // No single(): a second row for the same package (a re-purchase whose old row was
    // not cleaned up) must read as active, not as a PostgREST error.
    const { data, error } = await supabase
      .from('package_activations')
      .select('status, meta')
      .eq('package_id', packageId)
      .eq('status', 'active')
      .limit(5);

    if (error || !Array.isArray(data)) {
      return false;
    }

    return data.some((row: { meta?: unknown; status?: unknown }) => isPackageActivationRowValid(row));
  } catch (err) {
    console.error(`Error verifying package ${packageId}:`, err);
    return false;
  }
}

const verifyPackageOnlineCached = unstable_cache(
  async (packageId: string): Promise<boolean> => {
    const url = process.env['NEXT_PUBLIC_SUPABASE_URL'] || process.env['SUPABASE_URL'];
    const serviceKey =
      process.env['SUPABASE_SERVICE_ROLE_KEY'] ||
      process.env['SUPABASE_SECRET_KEY'] ||
      process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ||
      process.env['SUPABASE_ANON_KEY'] ||
      process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'] ||
      process.env['SUPABASE_PUBLISHABLE_KEY'];

    if (!url || !serviceKey) {
      return false;
    }

    const supabase = createSupabaseJsClient(url, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    return queryPackageActivation(packageId, supabase);
  },
  ['package-activation'],
  { revalidate: 60, tags: [PACKAGE_ACTIVATION_CACHE_TAG] }
);

export async function verifyPackageOnline(packageId: string, customClient?: any): Promise<boolean> {
  if (customClient) {
    return queryPackageActivation(packageId, customClient);
  }

  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'] || process.env['SUPABASE_URL'];
  const serviceKey =
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ||
    process.env['SUPABASE_SECRET_KEY'] ||
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ||
    process.env['SUPABASE_ANON_KEY'] ||
    process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'] ||
    process.env['SUPABASE_PUBLISHABLE_KEY'];

  if (url && serviceKey) {
    return verifyPackageOnlineCached(packageId);
  }

  const supabase = await createClient();
  return queryPackageActivation(packageId, supabase);
}
