import 'server-only';

import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { getCmsActor } from '../../../../lib/auth/cms-actor';

/**
 * Admin gate shared by the Cortex AI settings server actions.
 *
 * Lives outside `actions.ts` because that file is `'use server'`, where every export
 * must itself be a valid server action — a helper returning a Supabase client cannot
 * be exported from there. Keeping one copy matters more than the file count: this is
 * the check standing between a WRITER and the OpenRouter key, the stock-photo keys,
 * and the MCP access tokens.
 *
 * The client it returns is the service-role client, not the caller's cookie session. The
 * key rows and `cortex_ai_mcp_settings` are secret rows of `site_settings`, which no API
 * session reaches since migration 02038; the other `cortex_ai_*` settings and
 * `mcp_access_tokens` (02022) sit behind `public.is_admin_mfa()`, which a "remember this
 * device" admin on `aal1` cannot satisfy. The role check itself reads the caller's own profile
 * row (never gated); see `lib/auth/cms-actor.ts`.
 */
export async function requireAdminSupabaseClient() {
  const actor = await getCmsActor();

  if (!actor) {
    throw new Error('You must be logged in to manage Cortex AI settings.');
  }

  if (actor.role !== 'ADMIN') {
    throw new Error('You do not have permission to manage Cortex AI settings.');
  }

  return { supabase: getServiceRoleSupabaseClient(), userId: actor.userId };
}
