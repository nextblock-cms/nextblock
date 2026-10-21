import 'server-only';

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { Database } from './types';

const SERVER_ONLY_ERROR_MESSAGE =
  'This module cannot be imported from a Client Component module. It should only be used from a Server Component.';

if (typeof window !== 'undefined') {
  throw new Error(SERVER_ONLY_ERROR_MESSAGE);
}

type Profile = Database['public']['Tables']['profiles']['Row'];
type Language = Database['public']['Tables']['languages']['Row'];

type ServerCookies = Awaited<ReturnType<typeof cookies>>;
type SupabaseCookiePayload = {
  name: string;
  value: string;
  options: CookieOptions;
};

// This is the standard server client creation function from the Vercel example.
//
// When the app is unconfigured (no Supabase env yet — e.g. a fresh `git clone`
// before the browser /setup wizard has run) we fall back to a harmless dummy host
// instead of throwing, so the process can boot far enough to render `/setup`. Real
// queries against the dummy host simply fail and are handled by callers (the
// middleware redirects unconfigured traffic to /setup, so these clients are rarely
// exercised in that state). This mirrors getSsgSupabaseClient's existing approach.
export const createClient = () => {
  // Accept every alias the Vercel Supabase integration may inject (the non-prefixed
  // names AND the new `sb_publishable_…` publishable key) as fallbacks, so a one-click
  // deploy works whichever copy of the vars the integration set. Keep this alias order
  // in sync with apps/nextblock/lib/setup/env-status.ts (a published lib can't import it).
  const supabaseUrl =
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ||
    process.env['SUPABASE_URL'] ||
    'https://dummy.supabase.co';
  const supabaseAnonKey =
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ||
    process.env['SUPABASE_ANON_KEY'] ||
    process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'] ||
    process.env['SUPABASE_PUBLISHABLE_KEY'] ||
    'dummy-anon-key';

  return createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll: async () => {
          try {
            const cookieStore: ServerCookies = await cookies();
            return cookieStore.getAll();
          } catch {
            return [];
          }
        },
        setAll: async (cookieList: SupabaseCookiePayload[]) => {
          try {
            const cookieStore: ServerCookies = await cookies();
            for (const { name, value, options } of cookieList) {
              if (value && value.length > 0) {
                cookieStore.set({ name, value, ...options });
              } else if (options && Object.keys(options).length > 0) {
                cookieStore.delete({ name, ...options });
              } else {
                cookieStore.delete(name);
              }
            }
          } catch {
            // Setting cookies is only allowed in Server Actions and Route Handlers.
          }
        },
      },
    }
  );
};

// Helper function to get profile with role (server-side)
export async function getProfileWithRoleServerSide(userId: string): Promise<Profile | null> {
  const supabase = createClient(); // Uses the server client defined above
  const { data: profileData, error: profileError } = await supabase
    .from('profiles')
    .select('id, full_name, avatar_url, role, updated_at, website')
    .eq('id', userId)
    .single();

  if (profileError || !profileData) {
    // Avoid logging full error in production if it contains sensitive info,
    // but log message for debugging.
    console.error('Error fetching profile (server-side):', profileError?.message);
    return null;
  }
  return profileData as Profile;
}

export async function getActiveLanguagesServerSide(): Promise<Language[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('languages')
    .select('id, code, name, is_default, is_active, created_at, updated_at')
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching languages (server-side):', error.message);
    return [];
  }
  return data || [];
}

/**
 * Creates a Supabase client with the Service Role key.
 * ⚠️ WARNING: This bypasses ALL Row Level Security (RLS).
 * MUST ONLY be used in secure server-side contexts (Server Actions/Route Handlers).
 */
export const getServiceRoleSupabaseClient = () => {
  const supabaseUrl =
    process.env['NEXT_PUBLIC_SUPABASE_URL'] || process.env['SUPABASE_URL'];
  // SUPABASE_SECRET_KEY is the Marketplace integration's name for the RLS-bypassing
  // key (the new `sb_secret_…` format); accept it as a fallback to SUPABASE_SERVICE_ROLE_KEY.
  const supabaseServiceKey =
    process.env['SUPABASE_SERVICE_ROLE_KEY'] || process.env['SUPABASE_SECRET_KEY'];

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Missing Supabase Service Role environment variables');
  }

  return createSupabaseJsClient<Database>(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
};
