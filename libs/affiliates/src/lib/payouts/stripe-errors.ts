/**
 * How a failed Stripe call is treated when money is moving (ADDENDUM B1).
 *
 * DEFINITIVE: Stripe answered and refused the request (4xx: invalid request, permission, card
 * error). No transfer was created, and replaying the same request fails the same way, so the
 * payout may be marked FAILED (`fail_affiliate_payout`).
 *
 * TRANSIENT: anything else (connection drop, timeout, 5xx, rate limit, idempotency conflict,
 * authentication, a non-Stripe error). The request may or may not have reached Stripe, so the
 * payout stays PROCESSING and the next cycle reconciles it against Stripe's transfer list.
 */

export type AffiliateStripeErrorClass = 'definitive' | 'transient';

/**
 * Error codes of a refused transfer (examples from B1 plus the other refusals Stripe documents
 * for transfers). Every StripeInvalidRequestError / StripePermissionError / StripeCardError is
 * definitive anyway; the list also covers error objects that carry only a code.
 */
export const AFFILIATE_STRIPE_DEFINITIVE_ERROR_CODES = [
  'balance_insufficient',
  'account_invalid',
  'account_closed',
  'transfers_not_allowed',
  'capability_not_active',
  'insufficient_capabilities_for_transfer',
  'amount_too_small',
  'amount_too_large',
  'resource_missing',
  'parameter_invalid_integer',
  'parameter_missing',
] as const;

/** Codes that mean "try again later" even on a 4xx status. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['rate_limit', 'lock_timeout', 'idempotency_key_in_use']);

const DEFINITIVE_CODES: ReadonlySet<string> = new Set(AFFILIATE_STRIPE_DEFINITIVE_ERROR_CODES);

/** SDK error class names (`error.type`) whose request Stripe refused. */
const DEFINITIVE_TYPES: ReadonlySet<string> = new Set([
  'StripeInvalidRequestError',
  'StripePermissionError',
  'StripeCardError',
]);

/** SDK error class names that leave the outcome open. */
const TRANSIENT_TYPES: ReadonlySet<string> = new Set([
  'StripeConnectionError',
  'StripeAPIError',
  'StripeRateLimitError',
  'StripeIdempotencyError',
  'StripeAuthenticationError',
]);

/** API error types (`raw.type`) whose request Stripe refused. */
const DEFINITIVE_RAW_TYPES: ReadonlySet<string> = new Set(['invalid_request_error', 'card_error']);

const REFUSED_STATUS_CODES: ReadonlySet<number> = new Set([400, 402, 403, 404]);

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const TYPE_CODES: Readonly<Record<string, string>> = {
  StripeInvalidRequestError: 'stripe_invalid_request',
  StripePermissionError: 'stripe_permission',
  StripeCardError: 'stripe_card_error',
  StripeConnectionError: 'stripe_connection',
  StripeAPIError: 'stripe_api_error',
  StripeRateLimitError: 'stripe_rate_limit',
  StripeIdempotencyError: 'stripe_idempotency',
  StripeAuthenticationError: 'stripe_authentication',
};

interface StripeErrorFields {
  type: string | null;
  rawType: string | null;
  code: string | null;
  statusCode: number | null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The fields the SDK sets on its errors (`type`, `rawType`, `code`, `statusCode`), also read from `raw`. */
function readStripeErrorFields(error: unknown): StripeErrorFields | null {
  if (!error || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  const rawValue = record['raw'];
  const raw = rawValue && typeof rawValue === 'object' ? (rawValue as Record<string, unknown>) : null;

  const statusValue = record['statusCode'] ?? raw?.['statusCode'];
  const fields: StripeErrorFields = {
    type: stringField(record['type']),
    rawType: stringField(record['rawType']) ?? stringField(raw?.['type']),
    code: stringField(record['code']) ?? stringField(raw?.['code']),
    statusCode: typeof statusValue === 'number' && Number.isInteger(statusValue) ? statusValue : null,
  };
  if (!fields.type && !fields.rawType && !fields.code && fields.statusCode === null) return null;
  return fields;
}

/**
 * `definitive` only when Stripe refused the request (B1); `transient` for everything that leaves
 * the outcome unknown, including errors that are not Stripe errors at all.
 */
export function classifyAffiliateStripeError(error: unknown): AffiliateStripeErrorClass {
  const fields = readStripeErrorFields(error);
  if (!fields) return 'transient';
  if (fields.code && TRANSIENT_CODES.has(fields.code)) return 'transient';
  if (fields.rawType === 'idempotency_error') return 'transient';
  if (fields.type && TRANSIENT_TYPES.has(fields.type)) return 'transient';
  if (fields.statusCode === 401 || fields.statusCode === 429 || (fields.statusCode !== null && fields.statusCode >= 500)) {
    return 'transient';
  }
  if (fields.code && DEFINITIVE_CODES.has(fields.code)) return 'definitive';
  if (fields.type && DEFINITIVE_TYPES.has(fields.type)) return 'definitive';
  if (fields.rawType && DEFINITIVE_RAW_TYPES.has(fields.rawType)) return 'definitive';
  if (fields.statusCode !== null && REFUSED_STATUS_CODES.has(fields.statusCode)) return 'definitive';
  return 'transient';
}

/**
 * A short machine code for logs, run summaries and `affiliate_payouts.failure_reason`: Stripe's
 * own error code when it has one (`balance_insufficient`), else one derived from the SDK error
 * class, else `unknown`. Never the error message (it can quote request details).
 */
export function affiliateStripeErrorCode(error: unknown): string {
  const fields = readStripeErrorFields(error);
  if (!fields) return 'unknown';
  if (fields.code && CODE_PATTERN.test(fields.code)) return fields.code;
  if (fields.type && TYPE_CODES[fields.type]) return TYPE_CODES[fields.type];
  if (fields.rawType && CODE_PATTERN.test(fields.rawType)) return fields.rawType;
  return 'unknown';
}

/** An error the Stripe SDK (or a fake of it) raised, as opposed to a database or programming error. */
export function isAffiliateStripeError(error: unknown): boolean {
  const fields = readStripeErrorFields(error);
  if (!fields) return false;
  return Boolean((fields.type && fields.type.startsWith('Stripe')) || fields.rawType || fields.statusCode !== null);
}

/** A rejected or expired API key: every further call fails the same way, so a cycle stops early. */
export function isAffiliateStripeAuthenticationError(error: unknown): boolean {
  const fields = readStripeErrorFields(error);
  return Boolean(fields && (fields.type === 'StripeAuthenticationError' || fields.statusCode === 401));
}

/** Stripe refused the call for lack of permission: a restricted key without that resource, or a 403. */
export function isAffiliateStripePermissionError(error: unknown): boolean {
  const fields = readStripeErrorFields(error);
  return Boolean(fields && (fields.type === 'StripePermissionError' || fields.statusCode === 403));
}

/** The request got no answer from Stripe (network, DNS, TLS or a timeout). */
export function isAffiliateStripeConnectionError(error: unknown): boolean {
  const fields = readStripeErrorFields(error);
  return Boolean(fields && fields.type === 'StripeConnectionError');
}

/**
 * Stripe does not know the object (a connected account deleted, or created with the other key
 * mode): `resource_missing`, `account_invalid`, or a 404.
 */
export function isAffiliateStripeMissingResourceError(error: unknown): boolean {
  const fields = readStripeErrorFields(error);
  if (!fields) return false;
  return fields.code === 'resource_missing' || fields.code === 'account_invalid' || fields.statusCode === 404;
}
