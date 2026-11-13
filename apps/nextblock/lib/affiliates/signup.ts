import 'server-only';

import { headers } from 'next/headers';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { createClient, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import {
  AFFILIATE_PARTNERS_PATH,
  AFFILIATE_RETAILER_ROLE,
  affiliateTierHasCapacity,
  buildStorefrontStarterDoc,
  buildStorefrontStarterMetaDescription,
  buildStorefrontStarterTitle,
  isReservedAffiliateHandle,
  normalizeAffiliateHandle,
  type AffiliateAccountErrorCode,
  type AffiliateTierRow,
  type CreateAffiliateAccountResult,
} from '@nextblock-cms/affiliates';
import { createAffiliateAccountViaRpc, mapAffiliateRpcError } from '@nextblock-cms/affiliates/server';
import { evaluateTwoFactor } from '../auth/twoFactor';
import { verifyBotProtection } from '../botProtection/verify';
import { getSystemConfiguration } from '../setup/system-config';
import { evictAffiliateTiersCache } from './cache';
import { scheduleAffiliateLifecycleNotification } from './notify';
import { maskAffiliateVisitorIp } from './referral-cookie';
import { getRequestLocale, toAffiliatesLocale } from './request-locale';
import { isAffiliatesProgramActive } from './package-state';

/**
 * Partner signup (`/partners`, SPEC M2 / ADDENDUM B9): the service behind the public
 * `submitPartnerSignup` server action and the handle availability check.
 *
 * The action is a public, unauthenticated POST, so this module is its gatekeeper, in this order:
 * package activation → bot protection (honeypot + Turnstile/reCAPTCHA) → handle shape → identity
 * (the cookie session: a signed-in customer is UPGRADED and no auth user is created; a partner gets
 * "already a partner"; staff are refused; a pending second factor is refused) → masked-IP throttle →
 * handle pre-check → a tier with room → auth user creation exactly like `signUpAction`
 * (app/actions.ts) → the service-role RPC `create_affiliate_account`, which locks the profile, picks
 * the tier under a row lock and promotes USER → RTL in one transaction.
 *
 * The RPC runs only for a visitor with a session: a signed-in customer, an auto-accepted signup, or
 * a project without email confirmation. While the address is unconfirmed nothing but the auth user
 * exists (the handle waits in its `user_metadata`): an abandoned or scripted signup must never hold
 * a capped tier seat or a handle. The confirmation link lands on `/partners`, where the upgrade form,
 * prefilled with that handle, creates the partner account under the new session.
 *
 * Nothing the browser sends names who is acting: the user id is the session's, or the id of the auth
 * user created in this very request. An auth user created here is deleted again when the RPC refuses
 * the signup, and only that one: an account that already existed is never attached to a partner
 * profile from an anonymous request, never deleted, and gets the same "check your email" answer as a
 * new one (no account enumeration).
 *
 * The public sandbox (`NEXT_PUBLIC_IS_SANDBOX=true`) runs the same gates, the anonymous credentials'
 * shape included, and answers `sandbox_demo` right after the last of them: no starter page, auth
 * user, partner account, sign-in, alert or email, on every path (upgrade, auto-accept, confirmation).
 * Its demo logins are public, so an account created there would belong to anyone, and its emails
 * would go to whatever address a visitor typed.
 */

export type AffiliateSignupErrorCode =
  | AffiliateAccountErrorCode
  | 'handle_reserved'
  | 'package_inactive'
  | 'captcha'
  | 'throttled'
  | 'account_exists'
  | 'factor_pending'
  | 'rate_limited'
  | 'email_invalid'
  | 'password_invalid'
  | 'name_invalid';

export type AffiliateSignupOutcome =
  /** A session exists (customer upgrade, auto-accepted signup, or a project without email confirmation). */
  | { kind: 'signed_in'; account: CreateAffiliateAccountResult }
  /**
   * Check your email: a confirmation was sent (only the auth user exists until it is confirmed), or
   * the honeypot / an existing account (nothing created).
   */
  | { kind: 'confirm_email' }
  /** The account exists but signing in failed: the visitor signs in by hand. */
  | { kind: 'sign_in' }
  /**
   * The public sandbox: every check passed and nothing was written or sent. `handle` is the
   * normalized handle the signup would have claimed.
   */
  | { kind: 'sandbox_demo'; handle: string }
  | { kind: 'error'; code: AffiliateSignupErrorCode };

export interface AffiliateSignupInput {
  handle: string;
  displayName: string;
  /** Required for an anonymous visitor; ignored when a session exists. */
  email: string | null;
  /** Required for an anonymous visitor; ignored when a session exists. */
  password: string | null;
}

/** What the signup form shows the visitor (their own session only; no ids). */
export type PartnerSignupViewer =
  | { kind: 'anonymous' }
  | {
      kind: 'customer';
      email: string | null;
      fullName: string | null;
      /**
       * The handle chosen at signup, kept in `user_metadata` until the confirmed visitor claims it
       * (normalized; null when missing or no longer valid). A prefill only: the account owner can
       * rewrite their metadata, and the RPC validates the handle again.
       */
      pendingHandle: string | null;
    }
  | { kind: 'partner' }
  | { kind: 'staff' }
  | { kind: 'factor_pending' };

export type AffiliateHandleAvailability = 'available' | 'taken' | 'invalid' | 'reserved' | 'unknown';

/** Partner accounts one masked address may create per window. */
export const AFFILIATE_SIGNUP_THROTTLE_MAX = 5;
export const AFFILIATE_SIGNUP_THROTTLE_WINDOW_MS = 60 * 60_000;
/** An auth user created at most this long before the request started counts as created by it. */
const BRAND_NEW_USER_WINDOW_MS = 30_000;
/** The bucket `maskAffiliateVisitorIp` gives every address it cannot read. */
const UNKNOWN_IP_BUCKET = 'unknown';
const STAFF_ROLES: ReadonlySet<string> = new Set(['ADMIN', 'WRITER']);

type UntypedClient = SupabaseClient<any>;

function fail(code: AffiliateSignupErrorCode): AffiliateSignupOutcome {
  return { kind: 'error', code };
}

/** The public sandbox, where a signup writes nothing (see the module comment). Exactly `'true'`. */
function isSandboxSignup(): boolean {
  return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

// ---------------------------------------------------------------------------------------------
// Client address (the pattern of app/actions/formActions.ts)
// ---------------------------------------------------------------------------------------------

function firstHop(headerValue: string | null): string | null {
  const [first] = (headerValue ?? '').split(',');
  const trimmed = first?.trim() ?? '';
  return trimmed || null;
}

/**
 * Platform-set headers first; the client can prepend to `x-forwarded-for` on an appending proxy.
 * `x-vercel-forwarded-for` counts only on Vercel, which sets it. Anywhere else a client can send it
 * and pick its own throttle bucket, so the proxy's `x-real-ip` comes first there.
 */
export function resolveAffiliateSignupClientIp(requestHeaders: Pick<Headers, 'get'>): string | null {
  const vercelHop = process.env.VERCEL === '1' ? firstHop(requestHeaders.get('x-vercel-forwarded-for')) : null;
  return vercelHop ?? firstHop(requestHeaders.get('x-real-ip')) ?? firstHop(requestHeaders.get('x-forwarded-for'));
}

/**
 * The throttle bucket and the stored `signup_ip_masked` (CHECK <= 64): the visitor's network, never
 * the address. IPv4 keeps its /24 (`203.0.113.0/24`), IPv6 its /48 (`2001:db8:85a3::/48`), and an
 * IPv4-mapped IPv6 address counts as IPv4; ports, brackets and zone ids are dropped (the referral
 * fingerprint's masker, bounded input and output). Addresses that cannot be read share ONE bucket,
 * so "unknown" is throttled together, never exempt.
 */
export function maskAffiliateSignupIp(ip: string | null): string {
  return maskAffiliateVisitorIp(ip);
}

async function readSignupIpBucket(): Promise<string> {
  try {
    return maskAffiliateSignupIp(resolveAffiliateSignupClientIp(await headers()));
  } catch {
    return UNKNOWN_IP_BUCKET;
  }
}

// ---------------------------------------------------------------------------------------------
// Handle availability (best-effort, per-process limiter like app/api/packages/claim-license)
// ---------------------------------------------------------------------------------------------

const HANDLE_CHECK_WINDOW_MS = 5 * 60_000;
const HANDLE_CHECK_MAX_REQUESTS = 40;
/** Callers whose address cannot be read share one bucket, so it gets more room, not a free pass. */
const HANDLE_CHECK_MAX_UNKNOWN_REQUESTS = 120;
const HANDLE_CHECK_MAX_BUCKETS = 10_000;
const handleCheckBuckets = new Map<string, { count: number; resetAt: number }>();

/**
 * True when `bucket` used up its handle checks. Not shared across serverless instances and reset on
 * a cold start: it only blunts enumeration from one address (the answer reveals whether a handle is
 * taken, which a signup reveals anyway). Expired buckets are pruned on every call.
 */
export function isAffiliateHandleCheckRateLimited(bucket: string, now = Date.now()): boolean {
  for (const [key, entry] of handleCheckBuckets) {
    if (entry.resetAt <= now) handleCheckBuckets.delete(key);
  }
  if (handleCheckBuckets.size >= HANDLE_CHECK_MAX_BUCKETS && !handleCheckBuckets.has(bucket)) return true;

  const entry = handleCheckBuckets.get(bucket);
  if (!entry) {
    handleCheckBuckets.set(bucket, { count: 1, resetAt: now + HANDLE_CHECK_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > (bucket === UNKNOWN_IP_BUCKET ? HANDLE_CHECK_MAX_UNKNOWN_REQUESTS : HANDLE_CHECK_MAX_REQUESTS);
}

/** Test hook: forget every bucket. */
export function resetAffiliateHandleCheckRateLimit(): void {
  handleCheckBuckets.clear();
}

async function isAffiliatesPackageActive(): Promise<boolean> {
  try {
    return await isAffiliatesProgramActive();
  } catch {
    return false;
  }
}

function untypedServiceClient(): UntypedClient {
  // The generated Database type learns the affiliates tables only after `npm run db:types`.
  return getServiceRoleSupabaseClient() as unknown as UntypedClient;
}

/** `true` / `false`, or null when the lookup failed (the RPC's unique constraint stays the arbiter). */
async function isHandleTaken(service: UntypedClient, handle: string): Promise<boolean | null> {
  const { count, error } = await service
    .from('affiliate_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('handle', handle);
  if (error) {
    console.error('[affiliates] Handle lookup failed:', error.message);
    return null;
  }
  return (count ?? 0) > 0;
}

/**
 * Whether `rawHandle` can be claimed. `rate_limited` and `unavailable` are refusals; `unknown`
 * means the lookup failed (the form still submits; the database decides).
 */
export async function checkAffiliateHandleAvailability(
  rawHandle: string,
): Promise<{ ok: true; status: AffiliateHandleAvailability } | { ok: false; error: 'rate_limited' | 'unavailable' }> {
  if (isAffiliateHandleCheckRateLimited(await readSignupIpBucket())) return { ok: false, error: 'rate_limited' };

  const handle = normalizeAffiliateHandle(rawHandle);
  if (!handle) return { ok: true, status: isReservedAffiliateHandle(rawHandle) ? 'reserved' : 'invalid' };
  if (!(await isAffiliatesPackageActive())) return { ok: false, error: 'unavailable' };

  try {
    const taken = await isHandleTaken(untypedServiceClient(), handle);
    return { ok: true, status: taken === null ? 'unknown' : taken ? 'taken' : 'available' };
  } catch (error) {
    console.error('[affiliates] Handle availability check failed:', describeError(error));
    return { ok: true, status: 'unknown' };
  }
}

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

type SignupIdentity =
  | { kind: 'anonymous' }
  | { kind: 'factor_pending' }
  | { kind: 'signed_in'; user: User; role: string; fullName: string | null };

async function readSignupIdentity(cookieClient: ReturnType<typeof createClient>): Promise<SignupIdentity> {
  const {
    data: { user },
  } = await cookieClient.auth.getUser();
  if (!user) return { kind: 'anonymous' };

  const twoFactor = await evaluateTwoFactor();
  if (twoFactor.status === 'totp_required' || twoFactor.status === 'email_required') return { kind: 'factor_pending' };

  // The caller's OWN row through the cookie client (owner branch of the read policy), as in
  // lib/auth/cms-actor.ts. A missing row or NULL role is a customer. Compared as strings: the
  // generated user_role type predates 02029's RTL (ADDENDUM C10).
  const { data: profile } = await cookieClient.from('profiles').select('role, full_name').eq('id', user.id).maybeSingle();
  const role = profile?.role == null ? 'USER' : String(profile.role);
  const fullName = typeof profile?.full_name === 'string' && profile.full_name.trim() ? profile.full_name.trim() : null;
  return { kind: 'signed_in', user, role, fullName };
}

/** The handle a signup chose (`user_metadata.affiliate_handle`), normalized; null when missing or invalid. */
function pendingHandleOf(user: Pick<User, 'user_metadata'>): string | null {
  const metadata: unknown = user.user_metadata;
  return metadata && typeof metadata === 'object'
    ? normalizeAffiliateHandle((metadata as Record<string, unknown>)['affiliate_handle'])
    : null;
}

/**
 * Which signup panel the visitor sees: anonymous → the full form; customer → the upgrade form (no
 * password; a confirmed signup finds the handle it chose prefilled); partner → "open your portal";
 * staff → refused; pending second factor → finish signing in. An RTL account without an affiliate
 * profile (role set by hand) is offered the upgrade form, so it can finish. Never throws (anonymous
 * on any failure).
 */
export async function resolvePartnerSignupViewer(): Promise<PartnerSignupViewer> {
  try {
    const identity = await readSignupIdentity(createClient());
    if (identity.kind !== 'signed_in') return identity;

    if (STAFF_ROLES.has(identity.role)) return { kind: 'staff' };
    if (identity.role === AFFILIATE_RETAILER_ROLE) {
      const { count, error } = await untypedServiceClient()
        .from('affiliate_profiles')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', identity.user.id);
      if (!error && (count ?? 0) > 0) return { kind: 'partner' };
    } else if (identity.role !== 'USER') {
      return { kind: 'staff' };
    }
    return {
      kind: 'customer',
      email: identity.user.email ?? null,
      fullName: identity.fullName,
      pendingHandle: pendingHandleOf(identity.user),
    };
  } catch (error) {
    console.error('[affiliates] Could not resolve the signup viewer:', describeError(error));
    return { kind: 'anonymous' };
  }
}

// ---------------------------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------------------------

async function isSignupThrottled(service: UntypedClient, ipBucket: string): Promise<boolean> {
  const since = new Date(Date.now() - AFFILIATE_SIGNUP_THROTTLE_WINDOW_MS).toISOString();
  const { count, error } = await service
    .from('affiliate_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('signup_ip_masked', ipBucket)
    .gte('created_at', since);
  if (error) console.error('[affiliates] Signup throttle lookup failed:', error.message);
  return (count ?? 0) >= AFFILIATE_SIGNUP_THROTTLE_MAX;
}

/**
 * Whether an active tier has a free spot, or null when the lookup failed (the RPC stays the arbiter).
 * Checked before any auth user exists: with email confirmation on, the RPC runs only once the
 * address is confirmed, so a full program must be refused here rather than after the email.
 */
async function hasTierWithRoom(service: UntypedClient): Promise<boolean | null> {
  const { data, error } = await service
    .from('affiliate_tiers')
    .select('max_ambassadors_cap, member_count')
    .eq('is_active', true);
  if (error || !Array.isArray(data)) {
    if (error) console.error('[affiliates] Tier capacity lookup failed:', error.message);
    return null;
  }
  return (data as Array<Pick<AffiliateTierRow, 'max_ambassadors_cap' | 'member_count'>>).some((tier) =>
    affiliateTierHasCapacity(tier),
  );
}

/** An anonymous visitor's email and password, and the refusal their shape earns (null when they will do). */
function readSignupCredentials(input: AffiliateSignupInput): {
  email: string;
  password: string;
  problem: 'email_invalid' | 'password_invalid' | null;
} {
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  return { email, password, problem: !email ? 'email_invalid' : password.length < 8 ? 'password_invalid' : null };
}

function authErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const record = error as { message?: unknown; code?: unknown };
  return `${typeof record.code === 'string' ? record.code : ''} ${typeof record.message === 'string' ? record.message : ''}`.toLowerCase();
}

function isAlreadyRegistered(error: unknown): boolean {
  const text = authErrorText(error);
  return text.includes('already') || text.includes('email_exists') || text.includes('user_already_exists');
}

function isRateLimited(error: unknown): boolean {
  const text = authErrorText(error);
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
  return text.includes('rate limit') || text.includes('rate_limit') || status === 429;
}

/** True when GoTrue created `user` during this request (not an older, unconfirmed account). */
export function isAffiliateSignupBrandNewUser(user: Pick<User, 'created_at'>, requestStartedAt: number): boolean {
  const createdAt = Date.parse(user.created_at);
  return Number.isFinite(createdAt) && createdAt >= requestStartedAt - BRAND_NEW_USER_WINDOW_MS;
}

/**
 * Where the confirmation email lands, chosen like `signUpAction`: NEXT_PUBLIC_URL, else the request
 * origin. The link returns to `/partners`, where the confirmed visitor claims the handle through the
 * upgrade form (the account does not exist before that).
 */
async function resolveEmailRedirectTo(): Promise<string> {
  const explicit = process.env.NEXT_PUBLIC_URL?.trim();
  let base = explicit ? (explicit.startsWith('http') ? explicit : `https://${explicit}`) : '';
  if (!base) {
    try {
      base = (await headers()).get('origin') ?? '';
    } catch {
      base = '';
    }
  }
  return `${base.replace(/\/+$/, '')}/auth/callback?redirect_to=${encodeURIComponent(AFFILIATE_PARTNERS_PATH)}`;
}

interface PreparedAccount {
  handle: string;
  displayName: string;
  locale: string;
  title: string;
  metaDescription: string;
  starterDoc: unknown;
  signupIpMasked: string;
}

async function prepareAccount(handle: string, displayName: string, ipBucket: string): Promise<PreparedAccount> {
  let locale: 'en' | 'fr' = 'en';
  try {
    locale = toAffiliatesLocale(await getRequestLocale());
  } catch {
    locale = 'en';
  }
  const starter = { locale, displayName };
  return {
    handle,
    displayName,
    locale,
    title: buildStorefrontStarterTitle(starter),
    metaDescription: buildStorefrontStarterMetaDescription(starter),
    starterDoc: buildStorefrontStarterDoc(starter),
    signupIpMasked: ipBucket,
  };
}

async function createAccount(
  service: UntypedClient,
  userId: string,
  prepared: PreparedAccount,
): Promise<{ ok: true; account: CreateAffiliateAccountResult } | { ok: false; code: AffiliateAccountErrorCode }> {
  try {
    const account = await createAffiliateAccountViaRpc(service, { userId, ...prepared });
    return { ok: true, account };
  } catch (error) {
    const code = mapAffiliateRpcError(error);
    if (code === 'unknown') console.error('[affiliates] create_affiliate_account failed:', describeError(error));
    return { ok: false, code };
  }
}

/** Remove the auth user THIS request created, after the RPC refused the signup. */
async function deleteCreatedAuthUser(service: UntypedClient, userId: string): Promise<void> {
  try {
    const { error } = await service.auth.admin.deleteUser(userId);
    if (error) console.error('[affiliates] Could not remove the auth user of a refused signup:', error.message);
  } catch (error) {
    console.error('[affiliates] Could not remove the auth user of a refused signup:', describeError(error));
  }
}

/** Admin alert + mail after the response, and the founding-spot count shown on /partners. */
function afterAccountCreated(account: CreateAffiliateAccountResult): void {
  scheduleAffiliateLifecycleNotification('SIGNED_UP', {
    affiliateId: account.affiliateId,
    tierName: account.tierName,
    spotsRemaining: account.spotsRemaining,
  });
  evictAffiliateTiersCache('action');
}

/**
 * Run a partner signup. Call it from the server action only, after zod validated `input` (the
 * service re-checks everything that decides an outcome). Never throws for an expected refusal.
 */
export async function submitAffiliateSignup(input: AffiliateSignupInput, formData: FormData): Promise<AffiliateSignupOutcome> {
  const startedAt = Date.now();

  if (!(await isAffiliatesPackageActive())) return fail('package_inactive');

  // Before any account work. A tripped honeypot gets the ordinary "check your email" answer, so a
  // bot learns nothing; a failed captcha is reported (the widget is re-mounted for another try).
  const botCheck = await verifyBotProtection(formData);
  if (!botCheck.ok) return botCheck.reason === 'honeypot' ? { kind: 'confirm_email' } : fail('captcha');

  const handle = normalizeAffiliateHandle(input.handle);
  if (!handle) return fail(isReservedAffiliateHandle(String(input.handle ?? '')) ? 'handle_reserved' : 'handle_invalid');

  const displayName = typeof input.displayName === 'string' ? input.displayName.trim().slice(0, 80) : '';
  if (!displayName) return fail('name_invalid');

  const cookieClient = createClient();
  const identity = await readSignupIdentity(cookieClient);
  if (identity.kind === 'factor_pending') return fail('factor_pending');
  if (identity.kind === 'signed_in') {
    if (identity.role !== 'USER' && identity.role !== AFFILIATE_RETAILER_ROLE) return fail('role_conflict');
  }

  const ipBucket = await readSignupIpBucket();
  const service = untypedServiceClient();
  if (await isSignupThrottled(service, ipBucket)) return fail('throttled');
  // Pre-checks, so a taken handle or a full program never creates an auth user (one that would
  // have to be removed again, or that could only claim a seat after its email is confirmed).
  if ((await isHandleTaken(service, handle)) === true) return fail('handle_taken');
  if ((await hasTierWithRoom(service)) === false) return fail('program_full');

  // The public sandbox stops here, after the last read-only check (an anonymous visitor's
  // credentials) and before the first write, on every path below.
  if (isSandboxSignup()) {
    const problem = identity.kind === 'signed_in' ? null : readSignupCredentials(input).problem;
    return problem ? fail(problem) : { kind: 'sandbox_demo', handle };
  }

  const prepared = await prepareAccount(handle, displayName, ipBucket);

  // Signed in: upgrade the visitor's own account (USER → RTL in the RPC). An RTL without a
  // profile finishes here; one with a profile gets `affiliate_exists` from the RPC.
  if (identity.kind === 'signed_in') {
    const created = await createAccount(service, identity.user.id, prepared);
    if (!created.ok) return fail(created.code);
    afterAccountCreated(created.account);
    return { kind: 'signed_in', account: created.account };
  }

  const { email, password, problem } = readSignupCredentials(input);
  if (problem) return fail(problem);

  // Auto-accept mode (system_configuration.auto_accept_signups), as in signUpAction: an already
  // confirmed account through the service role, then a normal password sign-in.
  const { auto_accept_signups: autoAcceptSignups } = await getSystemConfiguration();
  if (autoAcceptSignups) {
    const { data, error } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: displayName },
    });
    if (error || !data?.user) {
      if (error && isAlreadyRegistered(error)) return fail('account_exists');
      console.error('[affiliates] Auto-accepted signup could not create the auth user:', describeError(error));
      return fail('unknown');
    }

    const created = await createAccount(service, data.user.id, prepared);
    if (!created.ok) {
      await deleteCreatedAuthUser(service, data.user.id);
      return fail(created.code);
    }
    afterAccountCreated(created.account);

    const { error: signInError } = await cookieClient.auth.signInWithPassword({ email, password });
    if (signInError) {
      console.error('[affiliates] Signed-up partner could not be signed in:', signInError.message);
      return { kind: 'sign_in' };
    }
    return { kind: 'signed_in', account: created.account };
  }

  const { data, error } = await cookieClient.auth.signUp({
    email,
    password,
    // The handle waits in the metadata, a prefill for the upgrade form (validated again on claim).
    options: { data: { full_name: displayName, affiliate_handle: handle }, emailRedirectTo: await resolveEmailRedirectTo() },
  });
  if (error) {
    if (isRateLimited(error)) return fail('rate_limited');
    if (isAlreadyRegistered(error)) return fail('account_exists');
    console.error('[affiliates] Partner signup failed:', describeError(error));
    return fail('unknown');
  }

  const user = data?.user ?? null;
  if (!user) return fail('unknown');
  // Email confirmation on and the address already registered: GoTrue returns an obfuscated user
  // with no identities (enumeration protection). Answer like a new signup and create nothing.
  if (Array.isArray(user.identities) && user.identities.length === 0) return { kind: 'confirm_email' };
  // An older, still unconfirmed account (GoTrue re-sent its confirmation). An anonymous request
  // never attaches a partner profile to an account it did not create; once confirmed and signed in,
  // its owner claims a handle through the upgrade path.
  if (!isAffiliateSignupBrandNewUser(user, startedAt)) return { kind: 'confirm_email' };
  // Email confirmation on: only the auth user exists until its owner confirms the address. No tier
  // seat, handle, page or SIGNED_UP alert for an address nobody confirmed (an abandoned or scripted
  // signup would otherwise hold a capped seat for good). The link lands on /partners, where the
  // signed-in branch above creates the partner account.
  if (!data.session) return { kind: 'confirm_email' };

  // A session at once (a project without email confirmation): the partner account is created now.
  const created = await createAccount(service, user.id, prepared);
  if (!created.ok) {
    await deleteCreatedAuthUser(service, user.id);
    return fail(created.code);
  }
  afterAccountCreated(created.account);
  return { kind: 'signed_in', account: created.account };
}
