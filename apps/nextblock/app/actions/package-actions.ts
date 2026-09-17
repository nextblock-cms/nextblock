'use server';

import { createClient } from '@supabase/supabase-js';
import { getPackageById } from '@nextblock-cms/utils';
import { createClient as createCookieClient } from '@nextblock-cms/db/server';
import { headers } from 'next/headers';
import {
  resolveSupabaseAnonKey,
  resolveSupabaseServiceKey,
  resolveSupabaseUrl,
} from '../../lib/setup/env-status';
import {
  activateLicenseKeyWithFreemius,
  buildPackageActivationInstance,
  revalidatePackageSurfaces,
  type PackageActivationProvenance,
} from '../../lib/packages/activate-license';

export type { PackageActivationProvenance } from '../../lib/packages/activate-license';

// Freemius handles both Sandbox and Production keys on the same API domain.
// The key itself determines the environment.
const FM_API_URL = 'https://api.freemius.com/v1';

/**
 * Where a CMS asks for the key of a license it just bought through the in-dashboard
 * checkout. The vendor deployment (nextblock.dev) answers when it has
 * NEXTBLOCK_LICENSE_CLAIM_ENABLED=true; see app/api/packages/claim-license/route.ts.
 */
const DEFAULT_LICENSE_SERVICE_URL = 'https://nextblock.dev';
const LICENSE_CLAIM_TIMEOUT_MS = 20_000;

const isSandbox = () => process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';

const ADMIN_ONLY_MESSAGE = 'Only an administrator can activate or deactivate packages.';

/**
 * Server actions are callable by any signed-in user who can reach the app, and the
 * activation row is written with the service role, so the caller's CMS role is checked
 * here rather than relied upon from the (admin-only) packages page.
 */
async function requireAdminActor(): Promise<{ error: string } | null> {
  try {
    const supabase = createCookieClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return { error: 'You must be signed in to manage packages.' };
    }

    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();

    return profile?.role === 'ADMIN' ? null : { error: ADMIN_ONLY_MESSAGE };
  } catch {
    return { error: 'Could not verify your permissions.' };
  }
}

// Helper to get service role client
const getServiceRoleClient = () => {
    const supabaseUrl = resolveSupabaseUrl();
    const supabaseServiceKey = resolveSupabaseServiceKey();

    if (!supabaseUrl || !supabaseServiceKey) {
        console.error('Missing Supabase credentials');
        throw new Error('Missing Supabase credentials (Service Key required for activation).');
    }

    if (supabaseServiceKey === resolveSupabaseAnonKey()) {
        console.warn('CRITICAL WARNING: SUPABASE_SERVICE_ROLE_KEY matches NEXT_PUBLIC_SUPABASE_ANON_KEY. This will likely cause Permission Denied errors as RLS cannot be bypassed.');
    }

    return createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
};

/**
 * The install identity Freemius sees, derived from the request host (a server action
 * always runs inside a request). Headless callers derive the same shape from
 * NEXT_PUBLIC_URL instead — see lib/packages/env-license.ts.
 */
async function resolveInstanceIdentity() {
  const headerList = await headers();
  // instance_name is usually the domain, for local dev use 'localhost' or actual host
  const instanceName = headerList.get('host') || 'nextblock-instance';
  const forwardedProto = headerList.get('x-forwarded-proto')?.split(',')[0]?.trim();

  return buildPackageActivationInstance({
    host: instanceName,
    protocol: forwardedProto === 'http' || forwardedProto === 'https' ? forwardedProto : undefined,
  });
}

type ActivatePackageOptions = {
  /** Try this package's Freemius product first (the key is known to belong to it). */
  packageId?: string;
  provenance?: Partial<PackageActivationProvenance>;
};

export type ActivatePackageResult =
  | { error: string }
  | { package: string; packageId: string; success: true };

/**
 * Activate a license key against Freemius and record it locally.
 *
 * `options.packageId` orders the product attempts; without it every known product is
 * tried, since a key alone does not say which package it unlocks.
 */
export async function activatePackage(key: string, options?: ActivatePackageOptions): Promise<ActivatePackageResult> {
  const denied = await requireAdminActor();

  if (denied) {
    return denied;
  }

  return activateLicenseKey(key, options);
}

async function activateLicenseKey(key: string, options?: ActivatePackageOptions): Promise<ActivatePackageResult> {
  if (isSandbox()) {
    return { error: 'License activation is disabled in Sandbox mode. To purchase a real license, visit nextblock.dev' };
  }

  // The Freemius call, the activation row and the cache purge live in
  // lib/packages/activate-license.ts, shared with the headless (env-seeded) path.
  const result = await activateLicenseKeyWithFreemius({
    instance: await resolveInstanceIdentity(),
    licenseKey: key,
    packageId: options?.packageId,
    provenance: options?.provenance,
    supabase: getServiceRoleClient(),
  });

  if ('success' in result) {
    return { success: true, package: result.package, packageId: result.packageId };
  }

  return { error: result.error };
}

/* -------------------------------------------------------------------------- */
/* Purchase from the dashboard                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The slice of a Freemius Checkout JS response the activation needs. The overlay
 * returns ids, never the key: `purchase.license_id` (paid purchase or paid trial) or
 * `trial.license_id` (free trial), plus the buyer.
 */
type CheckoutLicenseClaim = {
  email: string | null;
  /** Free trials return a `trial` object; paid trials return a `purchase` with `trial_ends`. */
  isTrial: boolean;
  kind: 'purchase' | 'trial';
  licenseId: string | null;
  resendEmailEndpoint: string | null;
  trialEndsAt: string | null;
  userId: string | null;
};

function readIdField(record: Record<string, unknown> | null, ...keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];

    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function extractCheckoutLicenseClaim(checkoutResponse: unknown): CheckoutLicenseClaim {
  const response = asRecord(checkoutResponse);
  const purchase = asRecord(response?.['purchase']);
  const trial = asRecord(response?.['trial']);
  const user = asRecord(response?.['user']);
  const licenseFromPurchase = readIdField(purchase, 'license_id', 'licenseId');
  const licenseFromTrial = readIdField(trial, 'license_id', 'licenseId');
  const email = typeof user?.['email'] === 'string' ? (user['email'] as string).trim() : null;
  const resend = typeof user?.['resend_email_endpoint'] === 'string' ? (user['resend_email_endpoint'] as string) : null;
  const trialEndsAt =
    (typeof trial?.['trial_ends_at'] === 'string' && (trial['trial_ends_at'] as string)) ||
    (typeof purchase?.['trial_ends'] === 'string' && (purchase['trial_ends'] as string)) ||
    null;

  return {
    email,
    isTrial: Boolean(licenseFromTrial) || Boolean(trialEndsAt),
    kind: licenseFromPurchase ? 'purchase' : 'trial',
    licenseId: licenseFromPurchase ?? licenseFromTrial,
    resendEmailEndpoint: resend,
    trialEndsAt,
    userId: readIdField(user, 'id') ?? readIdField(purchase, 'user_id', 'userId') ?? readIdField(trial, 'user_id', 'userId'),
  };
}

function resolveLicenseServiceUrl() {
  const configured = process.env.NEXTBLOCK_LICENSE_SERVICE_URL?.trim();
  return (configured || DEFAULT_LICENSE_SERVICE_URL).replace(/\/+$/, '');
}

export type ActivatePurchasedPackageResult =
  | {
      activated: true;
      expiration: string | null;
      isTrial: boolean;
      package: string;
      packageId: string;
      trialEndsAt: string | null;
    }
  | {
      activated: false;
      email: string | null;
      message: string;
      reason: 'claim_failed' | 'claim_unavailable' | 'no_license' | 'sandbox' | 'unknown_package';
      resendEmailEndpoint: string | null;
    };

/**
 * Finish an in-dashboard purchase: ask the vendor for the key of the license the
 * checkout just created, then activate it here. When the vendor cannot confirm the
 * claim the buyer still has the key by email, and the caller shows the paste-it-in path.
 */
export async function activatePurchasedPackage(input: {
  checkoutResponse: unknown;
  packageId: string;
}): Promise<ActivatePurchasedPackageResult> {
  const claim = extractCheckoutLicenseClaim(input.checkoutResponse);
  const failure = (reason: Exclude<ActivatePurchasedPackageResult, { activated: true }>['reason'], message: string) =>
    ({ activated: false as const, email: claim.email, message, reason, resendEmailEndpoint: claim.resendEmailEndpoint });

  if (isSandbox()) {
    return failure('sandbox', 'License activation is disabled in Sandbox mode.');
  }

  const denied = await requireAdminActor();

  if (denied) {
    return failure('claim_failed', denied.error);
  }

  const pkg = getPackageById(input.packageId);

  if (!pkg) {
    return failure('unknown_package', 'Unknown package.');
  }

  if (!claim.licenseId || !claim.email || !claim.userId) {
    return failure(
      'no_license',
      'The checkout did not report a license. If the payment went through, the key is in your email — paste it below to activate.'
    );
  }

  let claimResponse: Response;

  try {
    claimResponse = await fetch(`${resolveLicenseServiceUrl()}/api/packages/claim-license`, {
      body: JSON.stringify({
        email: claim.email,
        kind: claim.kind,
        licenseId: claim.licenseId,
        productId: pkg.fm_product_id,
        userId: claim.userId,
      }),
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(LICENSE_CLAIM_TIMEOUT_MS),
    });
  } catch (error) {
    console.error('License claim request failed:', error);

    return failure(
      'claim_unavailable',
      'The purchase went through, but the license service could not be reached to fetch your key automatically. Paste the key from your email below.'
    );
  }

  const claimBody = (await claimResponse.json().catch(() => null)) as Record<string, unknown> | null;
  const licenseKey = typeof claimBody?.['licenseKey'] === 'string' ? (claimBody['licenseKey'] as string) : null;

  if (!claimResponse.ok || !licenseKey) {
    const detail = typeof claimBody?.['error'] === 'string' ? ` (${claimBody['error']})` : '';

    return failure(
      'claim_failed',
      `The purchase went through, but the key could not be fetched automatically${detail}. It is in your email — paste it below to activate.`
    );
  }

  const activation = await activateLicenseKey(licenseKey, {
    packageId: pkg.id,
    provenance: {
      expiration: typeof claimBody?.['expiration'] === 'string' ? (claimBody['expiration'] as string) : null,
      is_trial: claim.isTrial,
      plan_id: typeof claimBody?.['planId'] === 'string' ? (claimBody['planId'] as string) : null,
      source: 'checkout',
      trial_ends_at: claim.trialEndsAt,
    },
  });

  if ('error' in activation) {
    return failure('claim_failed', `Your key was fetched but activation failed: ${activation.error}`);
  }

  return {
    activated: true,
    expiration: typeof claimBody?.['expiration'] === 'string' ? (claimBody['expiration'] as string) : null,
    isTrial: claim.isTrial,
    package: activation.package,
    packageId: activation.packageId,
    trialEndsAt: claim.trialEndsAt,
  };
}

/**
 * Ask Freemius to re-send the license email, using the tokenized endpoint the checkout
 * handed back (valid for 24 h). Only Freemius hosts are ever called.
 */
export async function resendPurchasedLicenseEmail(endpoint: string): Promise<{ ok: boolean; error?: string }> {
  const denied = await requireAdminActor();

  if (denied) {
    return { error: denied.error, ok: false };
  }

  let url: URL;

  try {
    url = new URL(endpoint);
  } catch {
    return { error: 'Invalid resend endpoint.', ok: false };
  }

  if (url.protocol !== 'https:' || !(url.hostname === 'freemius.com' || url.hostname.endsWith('.freemius.com'))) {
    return { error: 'Invalid resend endpoint.', ok: false };
  }

  try {
    const response = await fetch(url.toString(), {
      cache: 'no-store',
      method: 'POST',
      signal: AbortSignal.timeout(LICENSE_CLAIM_TIMEOUT_MS),
    });

    return response.ok ? { ok: true } : { error: `Freemius answered ${response.status}.`, ok: false };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Request failed.', ok: false };
  }
}

export async function deactivatePackage(packageId: string) {
    if (isSandbox()) {
        return { error: 'License deactivation is disabled in Sandbox mode.' };
    }

    const denied = await requireAdminActor();

    if (denied) {
        return denied;
    }

    const supabase = getServiceRoleClient();

    // 1. Get current activation (newest first: a stale second row must not block this)
    const { data: activations, error: fetchError } = await supabase
        .from('package_activations')
        .select('id, license_key, instance_name, meta')
        .eq('package_id', packageId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1);

    const activation = Array.isArray(activations) ? activations[0] : null;

    if (fetchError || !activation) {
        return { error: 'No active license found for this package.' };
    }

    // 2. Deactivate at Freemius
    try {
        const meta = (activation.meta ?? {}) as Record<string, any>;
        const fmProductId = meta?.fm_product_id;
        const uid = meta?.fm_uid;
        const installId = meta?.fm_install_id;

        if (fmProductId && uid && installId) {
          await fetch(`${FM_API_URL}/products/${fmProductId}/licenses/deactivate.json?uid=${uid}&install_id=${installId}&license_key=${encodeURIComponent(activation.license_key)}`, {
              method: 'POST',
              headers: {
                  'Accept': 'application/json',
              }
          });
        }
    } catch (err) {
        console.warn('Freemius Deactivation failed (network?), removing locally anyway.', err);
    }

    // 3. Remove/Update local DB (every row for the package, so nothing stale survives)
    const { error: deleteError } = await supabase
        .from('package_activations')
        .delete()
        .eq('package_id', packageId);

    if (deleteError) {
        return { error: 'Failed to remove local activation record.' };
    }

    revalidatePackageSurfaces();
    return { success: true };
}
