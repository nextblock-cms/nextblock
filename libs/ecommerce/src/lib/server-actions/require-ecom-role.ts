import 'server-only';

import { createClient, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

/**
 * Authorization guard for ecommerce server actions that write with the service-role client.
 *
 * A Next.js server action is a public POST endpoint dispatched by its action id regardless of
 * which route the request hit, so `apps/nextblock/proxy.ts` (which only gates `/cms` *URLs*)
 * is NOT a backstop for an action bundled into a public page. An action that reaches for the
 * service-role client (which bypasses RLS) therefore has no guard at all unless it checks the
 * caller itself — which is exactly what these helpers do, mirroring the long-standing
 * `getAdminClient()` in `coupons/actions.ts` and `requireAdminActor()` in the app's
 * `package-actions.ts`.
 *
 * Each helper verifies the cookie-scoped session's CMS role, then returns the service-role
 * client for the privileged write. `service_role`/`postgres` callers (background jobs, the
 * setup wizard, the sandbox reset) never carry a user session and must not reach these
 * actions; they call the underlying service-role paths directly.
 */

export type EcomActorRole = 'ADMIN' | 'WRITER';

/**
 * The caller's CMS role, or null for a customer or no session. For a read that must fail
 * closed WITHOUT throwing: a CMS list a WRITER may open but that RLS never gave them anything
 * from (orders) returns empty instead of an error page, and only an ADMIN gets the
 * service-role read (migration 02023 puts the ADMIN policies on orders / order_items /
 * profiles / site_settings behind `is_admin_mfa()`, which an aal1 "remember this device"
 * admin cannot satisfy through the cookie client).
 */
export async function getEcomActorRole(): Promise<EcomActorRole | null> {
  return resolveActorRole();
}

/**
 * Process-wide key under which the app publishes its CMS second-factor check
 * (apps/nextblock/lib/auth/second-factor-gate.ts). The lib cannot import the app.
 */
const SECOND_FACTOR_GATE_KEY = Symbol.for('nextblock.cms.secondFactorGate');

type ClientLike = ReturnType<typeof createClient>;

/**
 * Has this session passed the account's second factor (or is none enrolled)? These helpers
 * return the service-role client, which no aal2 policy can stop, so before 2026-10-21 a stolen
 * password alone reached payments, coupons and orders through them. With the app's gate
 * registered, its decision is final (trusted devices and the email factor included). Without
 * it, fail closed: an enrolled account passes only as a TOTP session already at aal2.
 */
async function secondFactorSatisfied(supabase: ClientLike, userId: string): Promise<boolean> {
  const gate = (globalThis as Record<symbol, unknown>)[SECOND_FACTOR_GATE_KEY];
  if (typeof gate === 'function') {
    return Boolean(await (gate as () => Promise<boolean>)());
  }

  const { data: settings } = await supabase
    .from('user_security_settings')
    .select('mfa_enabled, mfa_type')
    .eq('user_id', userId)
    .maybeSingle();
  if (!settings?.mfa_enabled || !settings?.mfa_type) return true;
  if (settings.mfa_type === 'totp') {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return aal?.currentLevel === 'aal2';
  }
  return false;
}

async function resolveActorRole(): Promise<EcomActorRole | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const role = profile?.role;
  if (role !== 'ADMIN' && role !== 'WRITER') return null;
  if (!(await secondFactorSatisfied(supabase, user.id))) return null;
  return role;
}

/**
 * Require an authenticated ADMIN. Returns a service-role client for the privileged write.
 * Use for commerce *configuration* (inventory levels, shipping, taxes, payments, external
 * sync) — matching the ADMIN-only gate the repo already applies to coupons/taxes/payments
 * and `updateInventoryTrackingAction`.
 */
export async function requireEcomAdmin() {
  const role = await resolveActorRole();
  if (!role) throw new Error('Unauthorized');
  if (role !== 'ADMIN') throw new Error('Forbidden');
  return getServiceRoleSupabaseClient();
}

/**
 * Require an authenticated staff member (ADMIN or WRITER). Returns a service-role client.
 * Use for *content* authoring surfaces (product taxonomy: categories, attributes, terms)
 * that `/cms` already exposes to WRITER through the proxy.
 */
export async function requireEcomStaff() {
  const role = await resolveActorRole();
  if (!role) throw new Error('Unauthorized');
  return getServiceRoleSupabaseClient();
}
