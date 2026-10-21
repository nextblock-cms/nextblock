import 'server-only';

import { createClient } from '@nextblock-cms/db/server';
import { getCmsActor } from '../../../lib/auth/cms-actor';

/**
 * Admin gate shared by the Messages server actions.
 *
 * Lives outside `actions.ts` because that file is `'use server'`, where every export
 * must itself be a valid server action — a helper returning a Supabase client cannot be
 * exported from there.
 *
 * This is the check standing between a WRITER and every private conversation on the
 * site: visitor names, addresses, and free text. The actions read and write the message
 * tables with the service-role client after it, so this check IS the authorization: since
 * migration 02028 the ADMIN policies on message_threads, thread_messages and
 * product_inquiries need public.is_admin_mfa(), which an admin on a "remember this device"
 * session or on the email second factor never passes over PostgREST. The role comes from
 * getCmsActor(), which also refuses a session whose second factor is still pending (a
 * stolen password alone must not reach the inbox through a server action).
 */
export async function requireAdminSupabaseClient() {
  const actor = await getCmsActor();

  if (!actor) {
    throw new Error('You must be logged in to manage messages.');
  }

  if (actor.role !== 'ADMIN') {
    throw new Error('You do not have permission to manage messages.');
  }

  // The admin's own profile row: the owner branch of profiles_read_policy, never aal-gated.
  const supabase = createClient();
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', actor.userId)
    .maybeSingle();

  return { supabase, userId: actor.userId, fullName: (profile?.full_name as string | null) ?? null };
}
