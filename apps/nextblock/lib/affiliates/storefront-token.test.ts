import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  serviceKey: 'test-service-role-key' as string | undefined,
  timingSafeEqual: vi.fn(),
}));

// The constants and handle modules only, via vi.importActual (an import() would mark the lib
// lazy-loaded for Nx's boundary rule).
vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/constants')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/handle')),
}));

vi.mock('../setup/service-key', () => ({
  resolveSupabaseServiceKey: () => mocks.serviceKey,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  mocks.timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, default: actual, timingSafeEqual: mocks.timingSafeEqual };
});

import {
  AFFILIATE_STOREFRONT_TOKEN_MAX_AGE_SECONDS,
  isAffiliateStorefrontTokenWithinWindow,
  mintAffiliateStorefrontToken,
  verifyAffiliateStorefrontToken,
} from './storefront-token';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

function mint(handle = 'jane-doe', now = NOW): string {
  const token = mintAffiliateStorefrontToken(handle, { now });
  if (!token) throw new Error('expected a token');
  return token;
}

/** Replace one character of the signature with a different base64url character. */
function flipSignatureChar(token: string, index = 5): string {
  const parts = token.split('.');
  const signature = parts[3];
  const replacement = signature[index] === 'A' ? 'B' : 'A';
  parts[3] = `${signature.slice(0, index)}${replacement}${signature.slice(index + 1)}`;
  return parts.join('.');
}

beforeEach(() => {
  mocks.serviceKey = 'test-service-role-key';
  mocks.timingSafeEqual.mockClear();
});

describe('mintAffiliateStorefrontToken', () => {
  it('produces v1.<handle>.<issuedAtSeconds>.<base64url HMAC>', () => {
    const token = mint('Jane-Doe');
    expect(token).toMatch(/^v1\.jane-doe\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(token.split('.')[2]).toBe(String(Math.floor(NOW / 1000)));
  });

  it('is deterministic for the same handle, time and key, and key-dependent', () => {
    expect(mint()).toBe(mint());
    const first = mint();
    mocks.serviceKey = 'rotated-service-role-key';
    expect(mint()).not.toBe(first);
  });

  it('refuses handles the database would refuse', () => {
    for (const bad of ['ab', '-jane', 'jane-', 'Jane Doe', 'jane.doe', 'a'.repeat(33), '', 'jane/../admin']) {
      expect(mintAffiliateStorefrontToken(bad, { now: NOW })).toBeNull();
    }
    expect(mintAffiliateStorefrontToken(42 as unknown as string)).toBeNull();
  });

  it('returns null without a service key (attribution falls back to the cookie)', () => {
    mocks.serviceKey = undefined;
    expect(mintAffiliateStorefrontToken('jane-doe', { now: NOW })).toBeNull();
    mocks.serviceKey = '   ';
    expect(mintAffiliateStorefrontToken('jane-doe', { now: NOW })).toBeNull();
  });
});

describe('verifyAffiliateStorefrontToken', () => {
  it('round-trips a genuine token, comparing the signature in constant time', () => {
    const token = mint();
    expect(verifyAffiliateStorefrontToken(token, { now: NOW + 60_000 })).toEqual({
      handle: 'jane-doe',
      issuedAt: Math.floor(NOW / 1000),
    });
    expect(mocks.timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it('refuses a tampered signature', () => {
    expect(verifyAffiliateStorefrontToken(flipSignatureChar(mint()), { now: NOW })).toBeNull();
    expect(verifyAffiliateStorefrontToken(flipSignatureChar(mint(), 42), { now: NOW })).toBeNull();
  });

  it('refuses a token whose handle or timestamp was edited', () => {
    const [version, , issuedAt, signature] = mint().split('.');
    expect(verifyAffiliateStorefrontToken(`${version}.someone-else.${issuedAt}.${signature}`, { now: NOW })).toBeNull();
    const [, handle] = mint().split('.');
    const later = String(Number(issuedAt) + 1);
    expect(verifyAffiliateStorefrontToken(`${version}.${handle}.${later}.${signature}`, { now: NOW })).toBeNull();
  });

  it('refuses a token signed with another key (rotation)', () => {
    const token = mint();
    mocks.serviceKey = 'rotated-service-role-key';
    expect(verifyAffiliateStorefrontToken(token, { now: NOW })).toBeNull();
    mocks.serviceKey = undefined;
    expect(verifyAffiliateStorefrontToken(token, { now: NOW })).toBeNull();
  });

  it('refuses malformed input before doing any crypto', () => {
    const token = mint();
    const [, handle, issuedAt, signature] = token.split('.');
    for (const bad of [
      null,
      undefined,
      42,
      {},
      '',
      'v1.jane-doe',
      `${token}.extra`,
      `v2.${handle}.${issuedAt}.${signature}`,
      `v1.${handle.toUpperCase()}.${issuedAt}.${signature}`,
      `v1.${handle}.0${issuedAt}.${signature}`,
      `v1.${handle}.-${issuedAt}.${signature}`,
      `v1.${handle}.${issuedAt}.${signature}=`,
      `v1.${handle}.${issuedAt}.${signature.slice(1)}`,
      `v1.${handle}.${issuedAt}.${signature.replace(/./, '+')}`,
      'x'.repeat(500),
    ]) {
      expect(verifyAffiliateStorefrontToken(bad, { now: NOW })).toBeNull();
    }
    expect(mocks.timingSafeEqual).not.toHaveBeenCalled();
  });

  it('expires after the default ceiling (365 days)', () => {
    const token = mint();
    const ceilingMs = AFFILIATE_STOREFRONT_TOKEN_MAX_AGE_SECONDS * 1000;
    expect(verifyAffiliateStorefrontToken(token, { now: NOW + ceilingMs })).not.toBeNull();
    expect(verifyAffiliateStorefrontToken(token, { now: NOW + ceilingMs + 1000 })).toBeNull();
  });

  it('honours a shorter maxAgeSeconds and never a longer one than the ceiling', () => {
    const token = mint();
    const thirtyDays = 30 * 24 * 60 * 60;
    expect(verifyAffiliateStorefrontToken(token, { now: NOW + 29 * DAY_MS, maxAgeSeconds: thirtyDays })).not.toBeNull();
    expect(verifyAffiliateStorefrontToken(token, { now: NOW + 31 * DAY_MS, maxAgeSeconds: thirtyDays })).toBeNull();
    expect(
      verifyAffiliateStorefrontToken(token, { now: NOW + 400 * DAY_MS, maxAgeSeconds: 10 * AFFILIATE_STOREFRONT_TOKEN_MAX_AGE_SECONDS }),
    ).toBeNull();
    expect(verifyAffiliateStorefrontToken(token, { now: NOW + 1000, maxAgeSeconds: 0 })).toBeNull();
  });

  it('refuses tokens from the future beyond a small clock skew', () => {
    const token = mint('jane-doe', NOW + 2 * 60_000);
    expect(verifyAffiliateStorefrontToken(token, { now: NOW })).not.toBeNull();
    const farFuture = mint('jane-doe', NOW + 10 * 60_000);
    expect(verifyAffiliateStorefrontToken(farFuture, { now: NOW })).toBeNull();
  });
});

describe('isAffiliateStorefrontTokenWithinWindow', () => {
  const issuedAt = Math.floor(NOW / 1000);

  it('matches inside the tier window and not after it', () => {
    expect(isAffiliateStorefrontTokenWithinWindow(issuedAt, 30, NOW + 29 * DAY_MS)).toBe(true);
    expect(isAffiliateStorefrontTokenWithinWindow(issuedAt, 30, NOW + 30 * DAY_MS)).toBe(true);
    expect(isAffiliateStorefrontTokenWithinWindow(issuedAt, 30, NOW + 30 * DAY_MS + 1000)).toBe(false);
  });

  it('never matches a non-positive window, a future token or garbage', () => {
    expect(isAffiliateStorefrontTokenWithinWindow(issuedAt, 0, NOW)).toBe(false);
    expect(isAffiliateStorefrontTokenWithinWindow(issuedAt, -5, NOW)).toBe(false);
    expect(isAffiliateStorefrontTokenWithinWindow(issuedAt, Number.NaN, NOW)).toBe(false);
    expect(isAffiliateStorefrontTokenWithinWindow(Number.NaN, 30, NOW)).toBe(false);
    expect(isAffiliateStorefrontTokenWithinWindow(issuedAt + 3600, 30, NOW)).toBe(false);
  });

  it('caps the window at the 365-day tier maximum', () => {
    expect(isAffiliateStorefrontTokenWithinWindow(issuedAt, 10_000, NOW + 366 * DAY_MS)).toBe(false);
  });
});
