import 'server-only';

import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createClient,
  getServiceRoleSupabaseClient,
} from '@nextblock-cms/db/server';
import {
  AFFILIATE_PARTNERS_PATH,
  AFFILIATE_PORTAL_PATH,
  AFFILIATE_RETAILER_ROLE,
  type AffiliatePageRow,
  type AffiliateProfileRow,
} from '@nextblock-cms/affiliates';
import { evaluateTwoFactor } from '../auth/twoFactor';
import { isSafeInternalPath } from '../auth-redirects';
import { isAffiliatesProgramActive } from './package-state';

/**
 * Who is calling a partner-portal page, server action or route, resolved the same way as
 * `lib/auth/cms-actor.ts`: the cookie session names the user, an enrolled second factor must be
 * satisfied, and the role comes from the caller's OWN `profiles` row through the cookie client
 * (the owner branch of the read policy, which no aal check touches). Only then does the
 * service-role client load the affiliate account and hand it out.
 *
 * Why the service role: the portal writes `affiliate_profiles` / `affiliate_pages` columns that
 * the column grants pin (02030), and the money tables are service-role-write only. Under the
 * service role RLS is not a boundary, so the checks below ARE the authorization. A server action
 * is a public POST reachable from any route, so every portal action calls `requireRetailer()`
 * before it reads or writes anything.
 *
 * Roles are compared as strings: the generated `user_role` type predates migration 02029's `RTL`
 * value (`npm run db:types` has not run against a migrated project), so `String(role)` is the only
 * comparison that both type-checks and matches (ADDENDUM C10).
 */

export type RetailerActorRole = typeof AFFILIATE_RETAILER_ROLE | 'ADMIN';

export type RetailerActor = {
  userId: string;
  email: string | null;
  role: RetailerActorRole;
  affiliate: AffiliateProfileRow | null;
  page: AffiliatePageRow | null;
};

export type RetailerServiceRoleClient = ReturnType<typeof getServiceRoleSupabaseClient>;

export interface RequireRetailerOptions {
  /** Admit a SUSPENDED partner (the portal shell shows the suspension notice). Default false. */
  allowSuspended?: boolean;
  /** Admit an ADMIN as well (support and preview). Default false: the portal is for partners. */
  allowAdmin?: boolean;
}

/** The `Error.message` values `requireRetailer()` throws. */
export type RetailerAccessError = 'Unauthorized' | 'Forbidden' | 'Suspended' | 'PackageInactive';

type RetailerSession =
  | { kind: 'anonymous' }
  | { kind: 'factor_pending'; userId: string }
  | { kind: 'signed_in'; userId: string; email: string | null; role: string };

type RetailerDenialReason =
  | 'anonymous'
  | 'factor_pending'
  | 'customer'
  | 'staff'
  | 'no_affiliate'
  | 'suspended'
  | 'package_inactive';

type RetailerAccessDecision =
  | { ok: true; actor: RetailerActor }
  | { ok: false; error: RetailerAccessError; reason: RetailerDenialReason };

const STAFF_ROLES: ReadonlySet<string> = new Set(['ADMIN', 'WRITER']);

/**
 * The cookie-scope half: session, second factor and the caller's own role. Never touches the
 * service-role client, so every refusal that depends only on identity happens before it exists.
 * Memoised per request (React `cache`); a plain pass-through outside a React request.
 */
const getRetailerSession = cache(async (): Promise<RetailerSession> => {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: 'anonymous' };

  const twoFactor = await evaluateTwoFactor();
  if (twoFactor.status === 'totp_required' || twoFactor.status === 'email_required') {
    return { kind: 'factor_pending', userId: user.id };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  // A missing profile row (or a NULL role) is a customer, exactly as in getCmsActor().
  const role = profile?.role == null ? 'USER' : String(profile.role);
  return { kind: 'signed_in', userId: user.id, email: user.email ?? null, role };
});

function retailerRoleOf(role: string): RetailerActorRole | null {
  if (role === AFFILIATE_RETAILER_ROLE) return AFFILIATE_RETAILER_ROLE;
  if (role === 'ADMIN') return 'ADMIN';
  return null;
}

/**
 * The service-role half, run only after the session passed: the caller's own affiliate profile
 * and storefront page. The page is matched on both the affiliate id and the user id, so a row
 * can only ever be the caller's (the composite foreign key enforces the same pairing).
 */
const loadRetailerAccount = cache(
  async (userId: string): Promise<{ affiliate: AffiliateProfileRow | null; page: AffiliatePageRow | null }> => {
    // The generated Database type learns the affiliates tables only after `npm run db:types`.
    const supabase = getServiceRoleSupabaseClient() as unknown as SupabaseClient<any>;

    const { data: affiliate, error: affiliateError } = await supabase
      .from('affiliate_profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (affiliateError) {
      // Fail closed without leaking the database message to a caller that prints errors.
      console.error('[affiliates] Retailer account lookup failed:', affiliateError.message);
      throw new Error('AffiliateLookupFailed');
    }
    if (!affiliate) return { affiliate: null, page: null };

    const profileRow = affiliate as AffiliateProfileRow;
    const { data: page, error: pageError } = await supabase
      .from('affiliate_pages')
      .select('*')
      .eq('affiliate_id', profileRow.id)
      .eq('user_id', userId)
      .maybeSingle();
    if (pageError) {
      console.error('[affiliates] Retailer page lookup failed:', pageError.message);
      throw new Error('AffiliateLookupFailed');
    }

    return { affiliate: profileRow, page: (page ?? null) as AffiliatePageRow | null };
  },
);

/**
 * The signed-in partner (or ADMIN) with their affiliate account, or null without a session, with
 * a second factor still owed, or for any other role. ADMIN is reported so the require helpers can
 * admit it on `{ allowAdmin: true }`; on its own this never authorizes anything — callers that
 * act use `requireRetailer()` / `requireRetailerPage()`.
 */
export const getRetailerActor = cache(async (): Promise<RetailerActor | null> => {
  const session = await getRetailerSession();
  if (session.kind !== 'signed_in') return null;

  const role = retailerRoleOf(session.role);
  if (!role) return null;

  const { affiliate, page } = await loadRetailerAccount(session.userId);
  return { userId: session.userId, email: session.email, role, affiliate, page };
});

async function isAffiliatesPackageActive(): Promise<boolean> {
  try {
    return await isAffiliatesProgramActive();
  } catch {
    return false;
  }
}

function deny(error: RetailerAccessError, reason: RetailerDenialReason): RetailerAccessDecision {
  return { ok: false, error, reason };
}

/**
 * Every check in one place, cheapest and identity-only first. The service-role client is first
 * built by the affiliate lookup (`loadRetailerAccount`), which runs only once the session, the
 * second factor, the role and the package activation have all passed.
 */
async function evaluateRetailerAccess(options: RequireRetailerOptions): Promise<RetailerAccessDecision> {
  const session = await getRetailerSession();
  if (session.kind === 'anonymous') return deny('Unauthorized', 'anonymous');
  if (session.kind === 'factor_pending') return deny('Unauthorized', 'factor_pending');

  const role = String(session.role);
  const isRetailer = role === AFFILIATE_RETAILER_ROLE;
  const isAdmittedAdmin = role === 'ADMIN' && options.allowAdmin === true;
  if (!isRetailer && !isAdmittedAdmin) {
    return deny('Forbidden', STAFF_ROLES.has(role) ? 'staff' : 'customer');
  }

  if (!(await isAffiliatesPackageActive())) return deny('PackageInactive', 'package_inactive');

  const actor = await getRetailerActor();
  if (!actor) return deny('Unauthorized', 'anonymous');
  if (isRetailer && !actor.affiliate) return deny('Forbidden', 'no_affiliate');
  if (actor.affiliate && actor.affiliate.status !== 'ACTIVE' && options.allowSuspended !== true) {
    return deny('Suspended', 'suspended');
  }

  return { ok: true, actor };
}

/**
 * Require a signed-in partner (role `RTL` with an affiliate account; ADMIN only with
 * `allowAdmin`). Returns the service-role client for the privileged read or write, plus the actor.
 *
 * Throws `Unauthorized` (no session, or an enrolled second factor not yet passed), `Forbidden`
 * (any other role, or an RTL without an affiliate row), `PackageInactive` (the Affiliates package
 * is not activated) or `Suspended` (unless `allowSuspended`). Server actions catch and return a
 * generic `{ ok: false }`; Next masks thrown messages from the client anyway.
 */
export async function requireRetailer(
  options: RequireRetailerOptions = {},
): Promise<{ supabase: RetailerServiceRoleClient; actor: RetailerActor }> {
  const decision = await evaluateRetailerAccess(options);
  if (!decision.ok) throw new Error(decision.error);
  return { supabase: getServiceRoleSupabaseClient(), actor: decision.actor };
}

function safeReturnPath(path: string): string {
  return typeof path === 'string' && isSafeInternalPath(path) ? path : AFFILIATE_PORTAL_PATH;
}

/**
 * `requireRetailer()` for portal pages and layouts: the same checks, answered with a navigation
 * instead of an error. No session → sign-in; a second factor owed → the 2FA screen; a customer
 * (or an RTL without an affiliate account) → the public partner program page; staff →
 * `/unauthorized`; a suspended partner → `/unauthorized` (unless `allowSuspended`); the package
 * inactive → the home page (only a signed-in partner gets this far, and every sign-in sends a
 * partner to the portal: they shop on, rather than land on a 404). An unknown reason → 404.
 * `path` is where to come back to, and must be a site-relative path.
 */
export async function requireRetailerPage(
  path: string,
  options: RequireRetailerOptions = {},
): Promise<{ supabase: RetailerServiceRoleClient; actor: RetailerActor }> {
  const decision = await evaluateRetailerAccess(options);
  if (decision.ok) {
    return { supabase: getServiceRoleSupabaseClient(), actor: decision.actor };
  }

  // `redirect()` and `notFound()` throw (they return `never`); nothing below them runs.
  const returnTo = encodeURIComponent(safeReturnPath(path));
  switch (decision.reason) {
    case 'anonymous':
      return redirect(`/sign-in?redirect=${returnTo}`);
    case 'factor_pending':
      return redirect(`/two-factor?redirect_to=${returnTo}`);
    case 'customer':
    case 'no_affiliate':
      return redirect(AFFILIATE_PARTNERS_PATH);
    case 'staff':
      return redirect('/unauthorized?reason=retailer_only');
    case 'suspended':
      return redirect('/unauthorized?reason=retailer_suspended');
    case 'package_inactive':
      return redirect('/');
    default:
      return notFound();
  }
}
