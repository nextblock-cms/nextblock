// utils/supabase/ssg-client.ts
import { createClient as createSupabaseJsClient, SupabaseClient } from '@supabase/supabase-js';
import {
  UNCONFIGURED_SUPABASE_KEY,
  UNCONFIGURED_SUPABASE_URL,
  unconfiguredSupabaseFetch,
} from './unconfigured';

let warnedUnconfigured = false;

export const getSsgSupabaseClient = (): SupabaseClient => {
  // Accept every alias the Vercel Supabase integration may inject (non-prefixed names
  // and the new publishable key). Keep this order in sync with env-status.ts.
  const resolvedUrl =
    process.env['NEXT_PUBLIC_SUPABASE_URL'] || process.env['SUPABASE_URL'];
  const resolvedKey =
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ||
    process.env['SUPABASE_ANON_KEY'] ||
    process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'] ||
    process.env['SUPABASE_PUBLISHABLE_KEY'];

  if (resolvedUrl && resolvedKey) {
    return createSupabaseJsClient(resolvedUrl, resolvedKey);
  }

  // No Supabase env yet (a scaffold building before /setup): instead of crashing the build, a
  // client that answers every query with a "not configured" error and sends no request
  // (./unconfigured.ts). Warn once per process: a build's static workers call this for every page.
  if (!warnedUnconfigured) {
    warnedUnconfigured = true;
    console.warn(
      'Supabase URL or anon key is missing: the SSG client answers every query with a "not configured" error and sends no request.'
    );
  }

  return createSupabaseJsClient(UNCONFIGURED_SUPABASE_URL, UNCONFIGURED_SUPABASE_KEY, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { fetch: unconfiguredSupabaseFetch },
  });
};
