import { describe, expect, it } from 'vitest';
import {
  affiliateStripeErrorCode,
  classifyAffiliateStripeError,
  isAffiliateStripeAuthenticationError,
  isAffiliateStripeConnectionError,
  isAffiliateStripeError,
  isAffiliateStripeMissingResourceError,
  isAffiliateStripePermissionError,
} from './stripe-errors';
import {
  affiliatePayoutIdempotencyKey,
  affiliatePayoutTransferGroup,
  computeAffiliateNextPayoutAt,
  isAffiliatePayoutTransientFailureReason,
} from './payout-config';

/** The shape the Stripe SDK gives its errors (`type` = class name, `raw.type` = API type). */
function stripeError(type: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error('Stripe said no'), { type, ...extra });
}

describe('classifyAffiliateStripeError (ADDENDUM B1)', () => {
  it.each([
    ['balance_insufficient', 400],
    ['account_invalid', 400],
    ['transfers_not_allowed', 400],
    ['insufficient_capabilities_for_transfer', 400],
    ['amount_too_small', 400],
    ['resource_missing', 404],
  ])('treats an invalid request with code %s as definitive', (code, statusCode) => {
    expect(
      classifyAffiliateStripeError(stripeError('StripeInvalidRequestError', { code, statusCode, rawType: 'invalid_request_error' }))
    ).toBe('definitive');
  });

  it('treats permission and card errors as definitive', () => {
    expect(classifyAffiliateStripeError(stripeError('StripePermissionError', { statusCode: 403 }))).toBe('definitive');
    expect(classifyAffiliateStripeError(stripeError('StripeCardError', { statusCode: 402, rawType: 'card_error' }))).toBe('definitive');
  });

  it('treats a bare definitive code as definitive (fakes and raw API errors)', () => {
    expect(classifyAffiliateStripeError({ code: 'capability_not_active' })).toBe('definitive');
  });

  it.each([
    ['StripeConnectionError', {}],
    ['StripeAPIError', { statusCode: 500 }],
    ['StripeRateLimitError', { statusCode: 429, code: 'rate_limit' }],
    ['StripeIdempotencyError', { statusCode: 400, rawType: 'idempotency_error' }],
    ['StripeAuthenticationError', { statusCode: 401 }],
  ])('treats %s as transient', (type, extra) => {
    expect(classifyAffiliateStripeError(stripeError(type, extra))).toBe('transient');
  });

  it('keeps lock timeouts and in-use idempotency keys transient even on a 4xx', () => {
    expect(classifyAffiliateStripeError(stripeError('StripeInvalidRequestError', { code: 'lock_timeout', statusCode: 400 }))).toBe(
      'transient'
    );
    expect(
      classifyAffiliateStripeError(stripeError('StripeInvalidRequestError', { code: 'idempotency_key_in_use', statusCode: 409 }))
    ).toBe('transient');
  });

  it('treats non-Stripe errors and garbage as transient (the outcome is unknown)', () => {
    expect(classifyAffiliateStripeError(new Error('socket hang up'))).toBe('transient');
    expect(classifyAffiliateStripeError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe('transient');
    expect(classifyAffiliateStripeError(null)).toBe('transient');
    expect(classifyAffiliateStripeError('boom')).toBe('transient');
  });

  it('reads the fields from `raw` as well', () => {
    expect(classifyAffiliateStripeError({ raw: { type: 'invalid_request_error', code: 'amount_too_small', statusCode: 400 } })).toBe(
      'definitive'
    );
  });
});

describe('affiliateStripeErrorCode', () => {
  it("uses Stripe's code, else the SDK class, else unknown — never the message", () => {
    expect(affiliateStripeErrorCode(stripeError('StripeInvalidRequestError', { code: 'balance_insufficient' }))).toBe(
      'balance_insufficient'
    );
    expect(affiliateStripeErrorCode(stripeError('StripeConnectionError'))).toBe('stripe_connection');
    expect(affiliateStripeErrorCode(stripeError('StripeAPIError', { code: 'Not A Code <script>' }))).toBe('stripe_api_error');
    expect(affiliateStripeErrorCode(new Error('secret sk_live_123 leaked'))).toBe('unknown');
  });
});

describe('error predicates', () => {
  it('recognises authentication, missing-resource and Stripe errors', () => {
    expect(isAffiliateStripeAuthenticationError(stripeError('StripeAuthenticationError', { statusCode: 401 }))).toBe(true);
    expect(isAffiliateStripeAuthenticationError(stripeError('StripeAPIError'))).toBe(false);
    expect(isAffiliateStripeMissingResourceError(stripeError('StripeInvalidRequestError', { code: 'resource_missing' }))).toBe(true);
    expect(isAffiliateStripeMissingResourceError({ statusCode: 404 })).toBe(true);
    expect(isAffiliateStripeMissingResourceError(stripeError('StripeAPIError', { statusCode: 500 }))).toBe(false);
    expect(isAffiliateStripeError(stripeError('StripeConnectionError'))).toBe(true);
    expect(isAffiliateStripeError(Object.assign(new Error('db'), { code: '23505' }))).toBe(false);
  });
});

describe('payout ids and schedule', () => {
  it('builds the B1 transfer group and per-attempt idempotency key', () => {
    expect(affiliatePayoutTransferGroup('p-1')).toBe('affiliate_payout_p-1');
    expect(affiliatePayoutIdempotencyKey('p-1', 3)).toBe('affiliate-payout-p-1-3');
  });

  it('knows the transient failure reasons', () => {
    expect(isAffiliatePayoutTransientFailureReason('stale')).toBe(true);
    expect(isAffiliatePayoutTransientFailureReason('balance_insufficient')).toBe(true);
    expect(isAffiliatePayoutTransientFailureReason('account_invalid')).toBe(false);
    expect(isAffiliatePayoutTransientFailureReason(null)).toBe(false);
  });

  it('computes the next 06:00 UTC run', () => {
    expect(computeAffiliateNextPayoutAt(new Date('2026-10-27T05:59:00Z')).toISOString()).toBe('2026-10-27T06:00:00.000Z');
    expect(computeAffiliateNextPayoutAt(new Date('2026-10-27T06:00:00Z')).toISOString()).toBe('2026-10-28T06:00:00.000Z');
    expect(computeAffiliateNextPayoutAt(new Date('2026-12-31T23:00:00Z'), 2).toISOString()).toBe('2027-01-01T02:00:00.000Z');
  });
});

describe('permission and connection errors (the CMS connection test wording)', () => {
  it('recognizes a restricted key without the permission, and nothing else', () => {
    expect(isAffiliateStripePermissionError(stripeError('StripePermissionError', { statusCode: 403 }))).toBe(true);
    expect(isAffiliateStripePermissionError({ statusCode: 403 })).toBe(true);
    expect(isAffiliateStripePermissionError(stripeError('StripeAuthenticationError', { statusCode: 401 }))).toBe(false);
    expect(isAffiliateStripePermissionError(stripeError('StripeInvalidRequestError', { statusCode: 400 }))).toBe(false);
    expect(isAffiliateStripePermissionError(new Error('boom'))).toBe(false);
  });

  it('recognizes a request Stripe never answered, and nothing else', () => {
    expect(isAffiliateStripeConnectionError(stripeError('StripeConnectionError'))).toBe(true);
    expect(isAffiliateStripeConnectionError(stripeError('StripeAPIError', { statusCode: 500 }))).toBe(false);
    expect(isAffiliateStripeConnectionError(new TypeError('fetch failed'))).toBe(false);
    expect(isAffiliateStripeConnectionError(null)).toBe(false);
  });
});
