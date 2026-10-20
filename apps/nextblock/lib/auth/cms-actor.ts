import 'server-only';

import { cache } from 'react';
import { createClient, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

/**
 * Who is calling a CMS server component or server action, and with which role — resolved
 * through the cookie session so the privileged read or write that follows can use the
 * service-role client.
 *
 * Why the service role: migration 02023 (after 02022) gates every ADMIN policy on `orders`,
 * `order_items`, `profiles` (other accounts' rows) and the ADMIN tier of `site_settings`
 * behind `public.is_admin_mfa()`, so an ADMIN who enrolled a second factor must present an
 * `aal2` Supabase session to reach those rows over PostgREST. The app's own 2FA gate
 * (`evaluateTwoFactor()` in app/cms/layout.tsx) honours a "remember this device" cookie, so a
 * legitimate admin is routinely inside /cms on an `aal1` session: a cookie-client read of a
 * gated table would come back empty for exactly the person the screen exists for. The role
 * check below reads the caller's OWN profile row — the owner branch of `profiles_read_policy`,
 * which no aal check touches — and the caller then reads or writes with the service role,
 * the same shape as 02022's dashboard/packages change and `requireEcomAdmin()` in
 * libs/ecommerce.
 *
 * A server action is a public POST dispatched by its id whatever route the request hit
 * (`proxy.ts` only gates /cms URLs), so an action that reaches for the service role has no
 * guard unless it calls one of these first. They throw: a server component gets the error
 * boundary, and an action that wants a readable message catches and returns it.
 */

export type CmsActorRole = 'ADMIN' | 'WRITER' | 'USER';
export type CmsStaffRole = Extract<CmsActorRole, 'ADMIN' | 'WRITER'>;
export type CmsActor = { userId: string; role: CmsActorRole };
export type ServiceRoleClient = ReturnType<typeof getServiceRoleSupabaseClient>;

const STAFF_ROLES: ReadonlySet<string> = new Set<CmsStaffRole>(['ADMIN', 'WRITER']);

export function isCmsStaffRole(role: string | null | undefined): role is CmsStaffRole {
  return typeof role === 'string' && STAFF_ROLES.has(role);
}

/**
 * The signed-in user and their CMS role, or null without a session. An account whose
 * profile row is missing or carries an unknown role is reported as `USER`.
 *
 * Memoised per request with React `cache`: the layout, the page and every helper they call
 * resolve the actor once instead of each re-running `auth.getUser()` (a round trip to the
 * auth server) and the profile read. Outside a React request — a unit test, a script — the
 * wrapper is a plain pass-through.
 */
export const getCmsActor = cache(async (): Promise<CmsActor | null> => {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  const role = profile?.role;
  return { userId: user.id, role: role === 'ADMIN' || role === 'WRITER' ? role : 'USER' };
});

/**
 * Require an authenticated ADMIN. Returns the service-role client for the privileged read
 * or write, plus the caller's id. Throws `Unauthorized` (no session) or `Forbidden`.
 */
export async function requireCmsAdmin(): Promise<{ supabase: ServiceRoleClient; userId: string }> {
  const actor = await getCmsActor();
  if (!actor) throw new Error('Unauthorized');
  if (actor.role !== 'ADMIN') throw new Error('Forbidden');
  return { supabase: getServiceRoleSupabaseClient(), userId: actor.userId };
}

/**
 * Require an authenticated staff member (ADMIN or WRITER). Returns the service-role client,
 * the caller's id and which of the two roles they hold, so a caller can keep an ADMIN-only
 * branch inside an otherwise staff-wide read. Throws `Unauthorized` or `Forbidden`.
 */
export async function requireCmsStaff(): Promise<{
  supabase: ServiceRoleClient;
  userId: string;
  role: CmsStaffRole;
}> {
  const actor = await getCmsActor();
  if (!actor) throw new Error('Unauthorized');
  if (!isCmsStaffRole(actor.role)) throw new Error('Forbidden');
  return { supabase: getServiceRoleSupabaseClient(), userId: actor.userId, role: actor.role };
}
