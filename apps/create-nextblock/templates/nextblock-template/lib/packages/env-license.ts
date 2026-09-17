import 'server-only';
// Environment-seeded package activation.
//
// `create-nextblock --non-interactive` provisions a Cortex AI trial key from the vendor
// and writes it to the project's `.env` / `.env.local` as NEXTBLOCK_LICENSE_KEY, because at
// scaffold time there is no running app to hand it to. The app then activates that key
// itself, the first time something that needs the package looks (`/api/setup/status`,
// `/api/mcp`, the bootstrap route). Activation goes through the same Freemius call and
// the same `package_activations` row as a pasted key, so expiry, daily revalidation and
// the packages page all behave exactly as for a checkout-issued license.
//
// This module is deliberately NOT gated on NEXT_PUBLIC_IS_SANDBOX: the Docker sandbox
// sets that flag too, and an operator who put a key in the environment wants it used.
// The shared demo sandbox never sets NEXTBLOCK_LICENSE_KEY.

import { createHash } from 'node:crypto';
import { getServiceRoleSupabaseClient, verifyPackageOnline } from '@nextblock-cms/db/server';
import { getPackageById } from '@nextblock-cms/utils';
import {
  activateLicenseKeyWithFreemius,
  buildPackageActivationInstance,
  packageActivationInstanceFromUrl,
  type PackageActivationOwner,
} from './activate-license';

export const NEXTBLOCK_LICENSE_KEY_VAR = 'NEXTBLOCK_LICENSE_KEY';
/** Optional: `trial` or `paid`. Only affects how the packages page labels the activation. */
export const NEXTBLOCK_LICENSE_KIND_VAR = 'NEXTBLOCK_LICENSE_KIND';
/** Optional: which package the key unlocks. Defaults to Cortex AI. */
export const NEXTBLOCK_LICENSE_PACKAGE_VAR = 'NEXTBLOCK_LICENSE_PACKAGE';

const DEFAULT_PACKAGE_ID = 'cortex-ai';

/** A failed Freemius call is not retried more often than this (per process). */
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;

export type EnvLicenseKind = 'paid' | 'trial';

export type EnvLicenseConfig = {
  key: string;
  kind: EnvLicenseKind | null;
  packageId: string;
};

export type EnvLicenseState =
  /** Activated during this call. */
  | 'activated'
  /** The package is already active (from this key or any other activation). */
  | 'active'
  /** The last activation attempt failed; `error` says why. */
  | 'failed'
  /** NEXTBLOCK_LICENSE_KEY is unset or blank. */
  | 'not_configured'
  /** NEXTBLOCK_LICENSE_PACKAGE names a package that does not exist. */
  | 'unknown_package';

export type EnvLicenseStatus = {
  attemptedAt: string | null;
  configured: boolean;
  error: string | null;
  kind: EnvLicenseKind | null;
  packageId: string;
  state: EnvLicenseState;
};

export function readEnvLicenseConfig(
  env: Record<string, string | undefined> = process.env
): EnvLicenseConfig | null {
  const key = env[NEXTBLOCK_LICENSE_KEY_VAR]?.trim();

  if (!key) {
    return null;
  }

  const rawKind = env[NEXTBLOCK_LICENSE_KIND_VAR]?.trim().toLowerCase();
  const kind: EnvLicenseKind | null = rawKind === 'trial' || rawKind === 'paid' ? rawKind : null;
  const packageId = env[NEXTBLOCK_LICENSE_PACKAGE_VAR]?.trim() || DEFAULT_PACKAGE_ID;

  return { key, kind, packageId };
}

type Memo = {
  attemptedAt: number;
  fingerprint: string;
  status: EnvLicenseStatus;
};

let memo: Memo | null = null;
let inFlight: Promise<EnvLicenseStatus> | null = null;

/** Identifies the configured key without keeping the plaintext around in the memo. */
function fingerprintOf(config: EnvLicenseConfig): string {
  return createHash('sha256').update(`${config.packageId}:${config.key}`).digest('hex').slice(0, 16);
}

/**
 * The person the license should be registered to when Freemius has to create the
 * user (a headless trial key is minted without one). The first ADMIN is the operator
 * who ran the scaffold, so that is the right default when the caller has nothing better.
 */
async function resolveOwnerFromFirstAdmin(): Promise<PackageActivationOwner | null> {
  try {
    const admin = getServiceRoleSupabaseClient();
    const { data: profile } = await admin
      .from('profiles')
      .select('id, full_name')
      .eq('role', 'ADMIN')
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!profile?.id) {
      return null;
    }

    const { data } = await admin.auth.admin.getUserById(profile.id);
    const email = data?.user?.email ?? null;
    const metadataName = data?.user?.user_metadata?.['full_name'];

    if (!email) {
      return null;
    }

    return {
      email,
      fullName: profile.full_name ?? (typeof metadataName === 'string' ? metadataName : null),
    };
  } catch {
    return null;
  }
}

function resolveInstance() {
  return (
    packageActivationInstanceFromUrl(process.env['NEXT_PUBLIC_URL']) ??
    buildPackageActivationInstance({ host: 'localhost:3000', protocol: 'http' })
  );
}

/**
 * Make sure the package named by the environment license is active, activating the key
 * against Freemius when it is not. Cheap when there is nothing to do: one cached
 * `verifyPackageOnline` read. Concurrent callers share one in-flight activation, and a
 * failure is remembered for a while so a polling client cannot hammer Freemius.
 */
export async function ensureEnvLicenseActivation(
  options: { force?: boolean; owner?: PackageActivationOwner | null } = {}
): Promise<EnvLicenseStatus> {
  const config = readEnvLicenseConfig();

  if (!config) {
    return {
      attemptedAt: null,
      configured: false,
      error: null,
      kind: null,
      packageId: DEFAULT_PACKAGE_ID,
      state: 'not_configured',
    };
  }

  const base = {
    configured: true,
    kind: config.kind,
    packageId: config.packageId,
  };

  if (!getPackageById(config.packageId)) {
    return {
      ...base,
      attemptedAt: null,
      error: `Unknown package "${config.packageId}".`,
      state: 'unknown_package',
    };
  }

  if (await verifyPackageOnline(config.packageId)) {
    return { ...base, attemptedAt: memo?.status.attemptedAt ?? null, error: null, state: 'active' };
  }

  const fingerprint = fingerprintOf(config);

  if (
    !options.force &&
    memo &&
    memo.fingerprint === fingerprint &&
    memo.status.state === 'failed' &&
    Date.now() - memo.attemptedAt < RETRY_AFTER_FAILURE_MS
  ) {
    return memo.status;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = (async (): Promise<EnvLicenseStatus> => {
    const attemptedAt = new Date().toISOString();

    try {
      const owner = options.owner ?? (await resolveOwnerFromFirstAdmin());
      const result = await activateLicenseKeyWithFreemius({
        instance: resolveInstance(),
        licenseKey: config.key,
        owner: owner ?? undefined,
        packageId: config.packageId,
        provenance: {
          is_trial: config.kind === 'trial',
          source: 'env',
        },
        supabase: getServiceRoleSupabaseClient(),
      });

      const status: EnvLicenseStatus =
        'success' in result
          ? { ...base, attemptedAt, error: null, state: 'activated' }
          : { ...base, attemptedAt, error: result.error, state: 'failed' };

      if (status.state === 'failed') {
        console.warn(`[env license] activation of ${config.packageId} failed: ${status.error}`);
      }

      memo = { attemptedAt: Date.now(), fingerprint, status };
      return status;
    } catch (caught) {
      const status: EnvLicenseStatus = {
        ...base,
        attemptedAt,
        error: caught instanceof Error ? caught.message : 'Unexpected activation error.',
        state: 'failed',
      };
      memo = { attemptedAt: Date.now(), fingerprint, status };
      return status;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Test seam: forget the memoized attempt. */
export function resetEnvLicenseMemoForTests(): void {
  memo = null;
  inFlight = null;
}
