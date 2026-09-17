import 'server-only';
// The Freemius activation core shared by the admin server action (`activatePackage` in
// app/actions/package-actions.ts) and the headless paths that have no cookie session:
// environment-seeded activation (lib/packages/env-license.ts) and the setup bootstrap
// route. It takes the instance identity as an argument instead of reading `headers()`,
// so it can run wherever a service-role client exists.

import { createHash } from 'node:crypto';
import { revalidatePath, updateTag } from 'next/cache';
import { NEXTBLOCK_PACKAGES, getPackageById, type PackageDef } from '@nextblock-cms/utils';
import { PACKAGE_ACTIVATION_CACHE_TAG } from '@nextblock-cms/db/server';

// Freemius handles both Sandbox and Production keys on the same API domain.
// The key itself determines the environment.
export const FREEMIUS_API_URL = 'https://api.freemius.com/v1';

export type PackageActivationSource = 'checkout' | 'env' | 'manual';

/** What the activation records about where the key came from, for the packages page. */
export type PackageActivationProvenance = {
  activated_at: string;
  expiration?: string | null;
  is_trial?: boolean;
  plan_id?: string | null;
  source: PackageActivationSource;
  trial_ends_at?: string | null;
};

/** How this install introduces itself to Freemius. `uid` must be stable per host. */
export type PackageActivationInstance = {
  instanceName: string;
  siteUrl: string;
  uid: string;
};

/**
 * Who owns the license. Freemius only needs this when the key was minted without a
 * user (a headless trial); for a checkout-issued key it is ignored. Names are split
 * on the API side, so a single display name is fine here.
 */
export type PackageActivationOwner = {
  email?: string | null;
  fullName?: string | null;
};

type ServiceRoleClientLike = {
  from: (table: string) => any;
};

export type ActivateLicenseKeyInput = {
  /** Try this package's Freemius product first (the key is known to belong to it). */
  packageId?: string;
  instance: PackageActivationInstance;
  licenseKey: string;
  owner?: PackageActivationOwner;
  provenance?: Partial<PackageActivationProvenance>;
  /** Service-role client: the activation row is written past RLS. */
  supabase: ServiceRoleClientLike;
};

export type ActivateLicenseKeyResult =
  | {
      code: 'db_error' | 'freemius_error' | 'invalid_key' | 'missing_key';
      error: string;
    }
  | {
      expiration: string | null;
      package: string;
      packageId: string;
      planId: string | null;
      success: true;
    };

/**
 * Freemius requires a 32-char unique identifier for the install. Hashing the host means
 * reactivations on the same domain reuse the same UID, which is what lets the daily
 * revalidation ping the same install instead of consuming another activation.
 */
export function buildPackageActivationInstance(input: {
  host: string;
  protocol?: 'http' | 'https';
}): PackageActivationInstance {
  const instanceName = input.host.trim() || 'nextblock-instance';
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(instanceName);
  const protocol = input.protocol ?? (isLocal ? 'http' : 'https');

  return {
    instanceName,
    siteUrl: `${protocol}://${instanceName}`,
    uid: createHash('md5').update(instanceName).digest('hex'),
  };
}

/** Identity derived from a configured public URL (NEXT_PUBLIC_URL), for headless callers. */
export function packageActivationInstanceFromUrl(
  url: string | null | undefined
): PackageActivationInstance | null {
  const trimmed = url?.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);

    return buildPackageActivationInstance({
      host: parsed.host,
      protocol: parsed.protocol === 'http:' ? 'http' : 'https',
    });
  } catch {
    return null;
  }
}

/**
 * Every surface that shows package state reads through `verifyPackageOnline`, which is
 * cached for 60 s. Purge that cache and the CMS routes so the dashboard, the CMS
 * layout (which mounts the Cortex chat) and the packages page reflect the change on
 * the very next request.
 */
export function revalidatePackageSurfaces() {
  updateTag(PACKAGE_ACTIVATION_CACHE_TAG);
  revalidatePath('/cms', 'layout');
  revalidatePath('/cms/settings/packages');
  revalidatePath('/cms/dashboard');
}

function splitOwnerName(fullName: string | null | undefined): { first: string; last: string } | null {
  const trimmed = fullName?.trim().replace(/\s+/g, ' ');

  if (!trimmed) {
    return null;
  }

  const [first, ...rest] = trimmed.split(' ');

  // Freemius requires both names when it has to create the user; a single-word name
  // is repeated rather than dropped so the activation is never refused over it.
  return { first, last: rest.length > 0 ? rest.join(' ') : first };
}

function buildActivationQuery(input: ActivateLicenseKeyInput): string {
  const params = new URLSearchParams({
    license_key: input.licenseKey,
    uid: input.instance.uid,
    url: input.instance.siteUrl,
  });

  const email = input.owner?.email?.trim().toLowerCase();

  if (email) {
    params.set('user_email', email);

    const names = splitOwnerName(input.owner?.fullName);

    if (names) {
      params.set('first_name', names.first);
      params.set('last_name', names.last);
    }
  }

  return params.toString();
}

/**
 * Activate a license key against Freemius and record it locally.
 *
 * `packageId` orders the product attempts; without it every known product is tried,
 * since a key alone does not say which package it unlocks. On success one row per
 * package remains (a re-purchase or a trial-to-paid conversion replaces the previous
 * key) and the package caches are purged.
 */
export async function activateLicenseKeyWithFreemius(
  input: ActivateLicenseKeyInput
): Promise<ActivateLicenseKeyResult> {
  const licenseKey = (input.licenseKey ?? '').trim();

  if (!licenseKey) {
    return { code: 'missing_key', error: 'License key is required.' };
  }

  const query = buildActivationQuery({ ...input, licenseKey });

  try {
    let data: Record<string, any> | null = null;
    let pkg: PackageDef | null = null;
    let hasLicenseError = false;
    let specificErrorMsg: string | null = null;

    const hinted = input.packageId ? getPackageById(input.packageId) : undefined;
    const packages = [
      ...(hinted ? [hinted] : []),
      ...Object.values(NEXTBLOCK_PACKAGES).filter((p) => p.id !== hinted?.id),
    ];

    for (const p of packages) {
      if (!p.fm_product_id) continue;

      const response = await fetch(
        `${FREEMIUS_API_URL}/products/${p.fm_product_id}/licenses/activate.json?${query}`,
        {
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          method: 'POST',
        }
      );

      const responseData = await response.json();

      // Freemius returns the license object directly if successful, or an error/api_response
      if (response.ok && responseData.install_id) {
        data = responseData;
        pkg = p;
        break;
      }

      const errorCode = responseData?.error?.code;
      if (errorCode === 'not_found' || errorCode === 'invalid_license_key') {
        hasLicenseError = true;
      } else if (responseData?.error?.message) {
        specificErrorMsg = responseData.error.message;
      }
    }

    if (!data || !pkg) {
      if (hasLicenseError && !specificErrorMsg) {
        return {
          code: 'invalid_key',
          error: 'Sorry, this is a sandbox key. Please purchase the real key at nextblock.dev',
        };
      }

      return {
        code: 'freemius_error',
        error: specificErrorMsg || 'Activation failed. Invalid key, wrong product, or limit reached.',
      };
    }

    const provenance: PackageActivationProvenance = {
      activated_at: new Date().toISOString(),
      source: 'manual',
      ...(input.provenance ?? {}),
      ...(input.provenance?.plan_id === undefined && data.license_plan_id !== undefined
        ? { plan_id: String(data.license_plan_id) }
        : {}),
      ...(input.provenance?.expiration === undefined && typeof data.expiration === 'string'
        ? { expiration: data.expiration }
        : {}),
    };

    const { error: dbError } = await input.supabase.from('package_activations').upsert(
      {
        instance_name: input.instance.instanceName,
        last_validated_at: new Date().toISOString(),
        license_key: licenseKey,
        meta: {
          ...data,
          fm_install_id: data.install_id,
          fm_product_id: pkg.fm_product_id,
          fm_uid: input.instance.uid,
          nextblock: provenance,
        },
        package_id: pkg.id,
        status: 'active',
      },
      { onConflict: 'license_key, package_id' }
    );

    if (dbError) {
      console.error('DB Error activating package:', dbError);
      return {
        code: 'db_error',
        error: 'Activation successful, but local saving failed: ' + dbError.message,
      };
    }

    // One row per package: a re-purchase or a trial-to-paid conversion replaces the
    // previous key. Done AFTER the new row is saved so a failed save never leaves the
    // package with no row at all.
    const { error: cleanupError } = await input.supabase
      .from('package_activations')
      .delete()
      .eq('package_id', pkg.id)
      .neq('license_key', licenseKey);

    if (cleanupError) {
      console.warn('Could not remove the previous activation row:', cleanupError.message);
    }

    revalidatePackageSurfaces();

    return {
      expiration: typeof data.expiration === 'string' ? data.expiration : null,
      package: pkg.name,
      packageId: pkg.id,
      planId:
        data.license_plan_id !== undefined && data.license_plan_id !== null
          ? String(data.license_plan_id)
          : null,
      success: true,
    };
  } catch (err: any) {
    console.error('Activation Action Error:', err);
    return { code: 'freemius_error', error: err?.message || 'An unexpected error occurred.' };
  }
}
