import 'server-only';

import { PACKAGE_ACTIVATION_CACHE_TAG, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { getPackageById } from '@nextblock-cms/utils';
import { revalidateTag } from 'next/cache';

/**
 * Daily re-validation of activated packages against Freemius.
 *
 * `verifyPackageOnline` reads only the local `package_activations` row, and until now
 * nothing ever revisited that row: a free trial that Freemius expired, or a paid
 * license that was cancelled or refunded, stayed "active" on the buyer's CMS forever.
 * This runs from the CMS layout via `after()` (like the upstream-update check), at most
 * once per day per row, and re-issues the same idempotent `licenses/activate.json` call
 * the activation used (same uid, same key, so no extra activation is consumed). A
 * license Freemius no longer honours is marked `expired`; a valid one gets its
 * expiration refreshed. Network trouble leaves the row untouched.
 */

const FM_API_URL = 'https://api.freemius.com/v1';
const REVALIDATE_INTERVAL_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Freemius error codes that mean the license itself is no longer usable. */
const TERMINAL_LICENSE_ERROR_PATTERN = /expired|cancel|revoked|invalid_license|not_found|blocked|refund/i;

type ActivationRow = {
  id: string;
  last_validated_at: string | null;
  license_key: string;
  meta: Record<string, any> | null;
  package_id: string;
  status: string;
};

function parseTimestamp(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const parsed = Date.parse(hasZone ? trimmed : `${trimmed.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

async function revalidateRow(row: ActivationRow, supabase: ReturnType<typeof getServiceRoleSupabaseClient>) {
  const pkg = getPackageById(row.package_id);
  const meta = row.meta ?? {};
  const uid = typeof meta['fm_uid'] === 'string' ? meta['fm_uid'] : null;
  const productId = pkg?.fm_product_id ?? (typeof meta['fm_product_id'] === 'string' ? meta['fm_product_id'] : null);

  if (!productId || !uid) {
    // Sandbox-seeded rows and pre-activation rows carry no Freemius handle; nothing to ask.
    return;
  }

  let response: Response;

  try {
    response = await fetch(
      `${FM_API_URL}/products/${productId}/licenses/activate.json?uid=${uid}&license_key=${encodeURIComponent(row.license_key)}`,
      {
        cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
  } catch (error) {
    console.warn(`[Packages] Could not re-validate ${row.package_id}:`, error instanceof Error ? error.message : error);
    return;
  }

  const body = (await response.json().catch(() => null)) as Record<string, any> | null;
  const now = new Date().toISOString();

  if (response.ok && body?.install_id) {
    const expiration =
      typeof body['expiration'] === 'string'
        ? body['expiration']
        : typeof body['license_expiration'] === 'string'
          ? body['license_expiration']
          : null;
    const nextblock = { ...(meta['nextblock'] ?? {}), ...(expiration ? { expiration } : {}) };
    const expiry = parseTimestamp(expiration);
    const expired = expiry !== null && expiry <= Date.now();

    await supabase
      .from('package_activations')
      .update({
        last_validated_at: now,
        meta: { ...meta, ...body, fm_product_id: productId, fm_install_id: body.install_id, fm_uid: uid, nextblock },
        status: expired ? 'expired' : 'active',
      })
      .eq('id', row.id);

    return;
  }

  const code = String(body?.['error']?.['code'] ?? '');
  const message = String(body?.['error']?.['message'] ?? '');

  if (response.status < 500 && TERMINAL_LICENSE_ERROR_PATTERN.test(`${code} ${message}`)) {
    await supabase
      .from('package_activations')
      .update({
        last_validated_at: now,
        meta: { ...meta, nextblock: { ...(meta['nextblock'] ?? {}), invalidated_at: now, invalidation_reason: code || message } },
        status: 'expired',
      })
      .eq('id', row.id);

    console.info(`[Packages] ${row.package_id} license is no longer valid at Freemius (${code || message}); marked expired.`);
    return;
  }

  // Unknown answer (rate limit, 5xx): try again next time, keep the row as is.
  console.warn(`[Packages] Inconclusive re-validation for ${row.package_id}: ${response.status} ${code} ${message}`);
}

/**
 * Re-check every active activation whose last validation is older than a day.
 * Best-effort and silent: it runs after the response has been sent.
 */
export async function maybeRevalidatePackageActivations(): Promise<void> {
  if (process.env.NEXT_PUBLIC_IS_SANDBOX === 'true') {
    return;
  }

  try {
    const supabase = getServiceRoleSupabaseClient();
    const { data, error } = await supabase
      .from('package_activations')
      .select('id, package_id, license_key, status, meta, last_validated_at')
      .eq('status', 'active');

    if (error || !Array.isArray(data) || data.length === 0) {
      return;
    }

    const cutoff = Date.now() - REVALIDATE_INTERVAL_MS;
    const due = (data as ActivationRow[]).filter((row) => {
      const last = parseTimestamp(row.last_validated_at);
      return last === null || last < cutoff;
    });

    if (due.length === 0) {
      return;
    }

    // Stamp first so concurrent requests do not all re-validate the same rows.
    await supabase
      .from('package_activations')
      .update({ last_validated_at: new Date().toISOString() })
      .in(
        'id',
        due.map((row) => row.id)
      );

    let changed = false;

    for (const row of due) {
      const before = row.status;
      await revalidateRow(row, supabase);
      const { data: after } = await supabase.from('package_activations').select('status').eq('id', row.id).maybeSingle();

      if (after && after.status !== before) {
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
