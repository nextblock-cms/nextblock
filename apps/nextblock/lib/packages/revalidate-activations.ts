import 'server-only';

import {
  PACKAGE_ACTIVATION_CACHE_TAG,
  getServiceRoleSupabaseClient,
  isPackageActivationRowValid,
  isTrialActivation,
  parseLicenseTimestamp,
  resolvePackageActivationExpiry,
} from '@nextblock-cms/db/server';
import { getPackageById } from '@nextblock-cms/utils';
import { revalidateTag } from 'next/cache';
import {
  FREEMIUS_CREDENTIAL_FIELDS,
  checkInstallLicense,
  readFreemiusId,
  type FreemiusInstall,
  type LicenseVerdict,
} from './freemius-license';

/**
 * Daily re-validation of activated packages against Freemius.
 *
 * `verifyPackageOnline` reads only the local `package_activations` row; this is what keeps
 * that row honest. It runs from the root layout via `after()`, on any request, because a
 * store has to survive its renewal date while nobody opens the CMS. Each row is asked once a
 * day (sooner the moment it stops counting, see `isRevalidationDue`) which license is active
 * on its install (`checkInstallLicense`). A cancelled or lapsed license marks the row
 * `expired`; a valid one marks it `active` and refreshes its expiration. Network trouble, a
 * 5xx, a rate limit or any other answer that is not a verdict on the license leaves the row's
 * status and meta as they are. The sweep stamps `last_validated_at` before it asks (so
 * concurrent requests do not repeat the call), so an inconclusive answer waits for the next
 * daily check, or less if the row stops counting in the meantime.
 *
 * It used to re-issue `licenses/activate.json`, which Freemius answers with
 * `license_activated` for an install that already holds the license (and whose success
 * body carries no expiration), so cancellations, refunds and renewals never reached the row.
 */

const REVALIDATE_INTERVAL_MS = 24 * 60 * 60_000;

/** The root layout calls this on every request; one process reads the table at most this often. */
const SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * How far past the recorded trial end a license must run before the trial counts as
 * converted. Absorbs the gap between the checkout's `trial_ends_at` and the license's
 * `expiration`; a paid period adds far more.
 */
const TRIAL_CONVERSION_SLACK_MS = 24 * 60 * 60_000;

type ActivationRow = {
  id: string;
  last_validated_at: string | null;
  license_key: string;
  meta: Record<string, any> | null;
  package_id: string;
  status: string;
};

let lastSweepAt: number | null = null;

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function readFreemiusInstall(row: ActivationRow): FreemiusInstall | null {
  const meta = row.meta ?? {};
  const productId = readFreemiusId(meta['fm_product_id']) ?? readFreemiusId(getPackageById(row.package_id)?.fm_product_id);
  const installId = readFreemiusId(meta['fm_install_id']);
  const uid = typeof meta['fm_uid'] === 'string' ? meta['fm_uid'].trim() : '';

  // Sandbox-seeded rows and pre-activation rows carry no Freemius handle; nothing to ask.
  return productId && installId && uid && row.license_key ? { installId, productId, uid } : null;
}

/**
 * A day since Freemius was last asked, or a row that has stopped counting since then: it
 * just switched a package off, so Freemius gets the last word now instead of within a day.
 */
function isRevalidationDue(row: ActivationRow, now: number) {
  const last = parseLicenseTimestamp(row.last_validated_at);

  if (last === null || last < now - REVALIDATE_INTERVAL_MS) {
    return true;
  }

  return isPackageActivationRowValid(row, last) && !isPackageActivationRowValid(row, now);
}

/** The date that ends the activation here: none when features outlive the license. */
function readStoredExpiration(verdict: LicenseVerdict) {
  return verdict.valid && verdict.keepsFeatures ? null : verdict.expiration;
}

/**
 * Fold the verdict into the provenance the activation recorded (`meta.nextblock`).
 * `resolvePackageActivationExpiry` honours the earliest date it finds there, so the
 * expiration is replaced rather than merged, and a checkout trial's `trial_ends_at` is
 * dropped once Freemius reports the license running well past it (or for life): a paid
 * period followed the trial, and the old trial end would otherwise lock a paying customer
 * out and keep the packages page saying "Trial".
 */
function settleProvenance(provenance: Record<string, any>, verdict: LicenseVerdict, now: string) {
  const settled: Record<string, any> = { ...provenance };
  const expiration = readStoredExpiration(verdict);

  if (expiration !== undefined) {
    settled['expiration'] = expiration;
  }

  if (!verdict.valid) {
    return { ...settled, invalidated_at: provenance['invalidated_at'] ?? now, invalidation_reason: verdict.reason };
  }

  delete settled['invalidated_at'];
  delete settled['invalidation_reason'];

  const trialEnd = parseLicenseTimestamp(provenance['trial_ends_at']);
  const expiry = parseLicenseTimestamp(verdict.expiration);
  const outlivesTrial =
    trialEnd !== null && (verdict.expiration === null || (expiry !== null && expiry > trialEnd + TRIAL_CONVERSION_SLACK_MS));

  return outlivesTrial ? { ...settled, is_trial: false, trial_ends_at: null } : settled;
}

/** Whatever Freemius answers next: older activations copied its credentials into `meta`. */
async function scrubStoredCredentials(row: ActivationRow, supabase: ReturnType<typeof getServiceRoleSupabaseClient>) {
  const meta = { ...(row.meta ?? {}) };
  const stored = FREEMIUS_CREDENTIAL_FIELDS.filter((field) => field in meta);

  if (stored.length === 0) {
    return meta;
  }

  stored.forEach((field) => delete meta[field]);

  const { error } = await supabase.from('package_activations').update({ meta }).eq('id', row.id);

  if (error) {
    console.warn(`[Packages] Could not remove stored credentials from ${row.package_id}: ${error.message}`);
  }

  return meta;
}

/** Ask Freemius about one row and record the verdict. True when package access may have changed. */
async function revalidateRow(
  row: ActivationRow,
  install: FreemiusInstall,
  supabase: ReturnType<typeof getServiceRoleSupabaseClient>
) {
  const meta = await scrubStoredCredentials(row, supabase);
  const { detail, verdict } = await checkInstallLicense(install, row.license_key, { isTrial: isTrialActivation(meta) });

  if (!verdict) {
    // Not a verdict on the license (network, rate limit, 5xx, a proxy page): status and meta stay
    // as they are, and the row is asked again at the next daily check (the sweep stamped it).
    console.warn(`[Packages] Inconclusive re-validation for ${row.package_id}: ${detail}`);
    return false;
  }

  const now = new Date().toISOString();
  const status = verdict.valid ? 'active' : 'expired';
  const expiration = readStoredExpiration(verdict);
  const nextMeta = {
    ...meta,
    // `resolvePackageActivationExpiry` also reads a top-level `expiration` (a Freemius field an
    // activation may have copied into meta); keep it in step so a stale date there cannot
    // outvote this answer.
    ...('expiration' in meta && expiration !== undefined ? { expiration } : {}),
    nextblock: settleProvenance(asRecord(meta['nextblock']) ?? {}, verdict, now),
  };

  const { error } = await supabase
    .from('package_activations')
    .update({ last_validated_at: now, meta: nextMeta, status })
    .eq('id', row.id);

  if (error) {
    console.warn(`[Packages] Could not record the re-validation of ${row.package_id}: ${error.message}`);
    return false;
  }

  if (status !== row.status) {
    console.info(
      verdict.valid
        ? `[Packages] ${row.package_id} license is valid again at Freemius; marked active.`
        : `[Packages] ${row.package_id} license is no longer valid at Freemius (${verdict.reason}); marked expired.`
    );
  }

  return status !== row.status || resolvePackageActivationExpiry(nextMeta) !== resolvePackageActivationExpiry(meta);
}

/**
 * Re-check every activation that is due (see `isRevalidationDue`), expired ones included:
 * Freemius renews a license under the same key, so the row flips back by itself.
 * Best-effort and silent: it runs after the response has been sent.
 */
export async function maybeRevalidatePackageActivations(): Promise<void> {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    return;
  }

  const now = Date.now();

  if (lastSweepAt !== null && now - lastSweepAt < SWEEP_INTERVAL_MS) {
    return;
  }

  lastSweepAt = now;

  try {
    const supabase = getServiceRoleSupabaseClient();
    const { data, error } = await supabase
      .from('package_activations')
      .select('id, package_id, license_key, status, meta, last_validated_at')
      .in('status', ['active', 'expired']);

    if (error || !Array.isArray(data) || data.length === 0) {
      return;
    }

    const due = (data as ActivationRow[]).flatMap((row) => {
      const install = readFreemiusInstall(row);
      return install && isRevalidationDue(row, now) ? [{ install, row }] : [];
    });

    if (due.length === 0) {
      return;
    }

    // Stamp first so concurrent requests do not all re-validate the same rows.
    await supabase
      .from('package_activations')
      .update({ last_validated_at: new Date(now).toISOString() })
      .in(
        'id',
        due.map(({ row }) => row.id)
      );

    let changed = false;

    for (const { install, row } of due) {
      if (await revalidateRow(row, install, supabase)) {
        changed = true;
      }
    }

    if (changed) {
      revalidateTag(PACKAGE_ACTIVATION_CACHE_TAG, 'max');
    }
  } catch (error) {
    console.warn('[Packages] Re-validation skipped:', error instanceof Error ? error.message : error);
  }
}

/** Test seam: forget the last sweep. */
export function resetPackageRevalidationThrottleForTests(): void {
  lastSweepAt = null;
}
