import 'server-only';
// What Freemius says about a license already active on an install, read through the
// validation call it documents for license-key integrations:
// `GET /products/{product}/installs/{install}/license.json` with the uid and key, no
// Authorization header. Shared by the daily re-validation (revalidate-activations.ts) and
// the recovery of a key Freemius reports as already activated (activate-license.ts).

import { PACKAGE_RENEWAL_GRACE_MS, parseLicenseTimestamp } from '@nextblock-cms/db/server';

// Freemius handles both Sandbox and Production keys on the same API domain.
// The key itself determines the environment.
export const FREEMIUS_API_URL = 'https://api.freemius.com/v1';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Credentials `licenses/activate.json` answers with. Nothing here uses them, and
 * `user_secret_key` signs Freemius API calls as the buyer, so they are never stored.
 * Rows activated before this was the rule lose them on their next re-validation.
 */
export const FREEMIUS_CREDENTIAL_FIELDS = [
  'install_api_token',
  'install_public_key',
  'install_secret_key',
  'user_public_key',
  'user_secret_key',
] as const;

/**
 * Freemius error codes that are a verdict on the license or on its activation here: the
 * key is invalid, the license expired or was cancelled, the license or install is gone.
 * Matched on the JSON error code only. A non-JSON answer (Freemius' nginx serves a bare
 * 403 page for an install id it does not know, and a proxy can do the same) or another
 * 4xx (malformed request, missing argument, `license_activated`) says nothing about the
 * license itself.
 */
const TERMINAL_LICENSE_ERROR_PATTERN = /expired|cancel|revoked|refund|invalid_license|not_found/i;

/** The install Freemius knows an activation by. */
export type FreemiusInstall = {
  installId: string;
  productId: string;
  uid: string;
};

/**
 * What Freemius said about the license. `expiration` is null for a lifetime license and
 * undefined when the answer carried no readable one. `keepsFeatures` is the plan's
 * `is_block_features: false`: past `expiration` only updates and support stop.
 */
export type LicenseVerdict =
  | { expiration?: string | null; keepsFeatures: boolean; valid: true }
  | { expiration?: string | null; reason: string; valid: false };

export type InstallLicenseCheck = {
  /** Status and error, for the log. */
  detail: string;
  /** The License object, when Freemius returned one. */
  license: Record<string, any> | null;
  /** Null when the answer is not a verdict on the license: try again later. */
  verdict: LicenseVerdict | null;
};

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

/** Freemius ids are int64, sent as strings or numbers; nothing else goes into a URL path. */
export function readFreemiusId(value: unknown) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^\d+$/.test(text) ? text : null;
}

/**
 * Read Freemius' answer as a verdict, or null when it is not one. A 2xx carries the License
 * object: invalid when `is_cancelled`, or once its `expiration` (null means a lifetime
 * license) is more than `graceMs` behind us. A plan that keeps features after expiry has no
 * such date, but a trial ends on its own whatever the plan does afterwards.
 */
function readLicenseVerdict(
  response: Response,
  body: Record<string, any> | null,
  { graceMs, isTrial }: { graceMs: number; isTrial: boolean }
): LicenseVerdict | null {
  if (response.ok) {
    if (!body || readFreemiusId(body['id']) === null) {
      return null;
    }

    const expiration: string | null | undefined =
      body['expiration'] === null ? null : parseLicenseTimestamp(body['expiration']) === null ? undefined : body['expiration'];

    if (body['is_cancelled'] === true) {
      return { expiration, reason: 'license_cancelled', valid: false };
    }

    if (expiration === undefined) {
      // Without a readable expiration there is no telling whether it has passed.
      return null;
    }

    const expiry = parseLicenseTimestamp(expiration);
    const keepsFeatures = body['is_block_features'] === false && !isTrial;
    const lapsed = expiry !== null && expiry + (isTrial ? 0 : graceMs) <= Date.now();

    return lapsed && !keepsFeatures
      ? { expiration, reason: 'license_expired', valid: false }
      : { expiration, keepsFeatures, valid: true };
  }

  const code = typeof body?.['error']?.['code'] === 'string' ? (body['error']['code'] as string) : '';
  const isClientError = response.status >= 400 && response.status < 500 && response.status !== 429;

  return isClientError && TERMINAL_LICENSE_ERROR_PATTERN.test(code) ? { reason: code, valid: false } : null;
}

/**
 * Ask Freemius for the license active on an install. Never throws; a failure is no verdict.
 * `graceMs` defaults to the renewal grace, which keeps an activation alive through a renewal
 * and has no business starting one.
 */
export async function checkInstallLicense(
  install: FreemiusInstall,
  licenseKey: string,
  { graceMs = PACKAGE_RENEWAL_GRACE_MS, isTrial = false }: { graceMs?: number; isTrial?: boolean } = {}
): Promise<InstallLicenseCheck> {
  const query = new URLSearchParams({ license_key: licenseKey, uid: install.uid });
  let response: Response;

  try {
    response = await fetch(
      `${FREEMIUS_API_URL}/products/${install.productId}/installs/${install.installId}/license.json?${query}`,
      {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        method: 'GET',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
  } catch (error) {
    return { detail: error instanceof Error ? error.message : String(error), license: null, verdict: null };
  }

  const body = asRecord(await response.json().catch(() => null));
  const code = String(body?.['error']?.['code'] ?? '');
  const message = String(body?.['error']?.['message'] ?? '');

  return {
    detail: `${response.status} ${code} ${message}`.trim(),
    license: response.ok ? body : null,
    verdict: readLicenseVerdict(response, body, { graceMs, isTrial }),
  };
}
