import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { AFFILIATE_HANDLE_PATTERN } from '@nextblock-cms/affiliates';
import { resolveSupabaseServiceKey } from '../setup/service-key';

/**
 * Signed storefront attribution tokens (ADDENDUM B9).
 *
 * A partner storefront (`/partners/<handle>`) mints one token per render and hands it to its
 * product cards; "Add to cart" stores it as the cart's `affiliateRef` and checkout sends it back.
 * The server trusts the handle inside ONLY when the signature verifies, so a shopper cannot
 * attribute a sale to an arbitrary partner by editing the cart, and the token carries a handle
 * and a timestamp, never an affiliate id. Checkout additionally accepts it only within the
 * partner tier's `cookie_duration_days` of `issuedAt` (the lib's attribution resolver).
 *
 *   v1.<handle>.<issuedAtSeconds>.<base64url HMAC-SHA256(key, "v1.<handle>.<issuedAtSeconds>")>
 *
 * The key is derived from the service-role key the way lib/app-secrets.ts derives its secrets
 * (one-way HMAC with a fixed label), so a one-click deploy needs no extra env and a leaked token
 * reveals nothing about the service key. Rotating the service key invalidates outstanding tokens;
 * attribution then falls back to the referral cookie.
 */

const TOKEN_VERSION = 'v1';
const KEY_LABEL = 'nextblock:affiliate-storefront-token';

/** 32-byte HMAC-SHA256 digest, base64url without padding. */
const SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;
/** Unix seconds: no leading zero, no sign, at most 12 digits. */
const ISSUED_AT_RE = /^[1-9][0-9]{0,11}$/;

/** Longest token accepted (a 32-char handle makes a ~95 character token). */
export const AFFILIATE_STOREFRONT_TOKEN_MAX_LENGTH = 160;

/** Hard ceiling on a token's age: the longest referral window a tier may set (365 days). */
export const AFFILIATE_STOREFRONT_TOKEN_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Tolerated clock difference between the instance that minted and the one verifying. */
const CLOCK_SKEW_SECONDS = 5 * 60;

export interface AffiliateStorefrontTokenPayload {
  /** The partner handle the storefront was served for (lowercase, pattern-valid). */
  handle: string;
  /** When the storefront was rendered, in Unix seconds. */
  issuedAt: number;
}

export interface VerifyAffiliateStorefrontTokenOptions {
  /** Clock override (milliseconds), for tests and replays. */
  now?: number;
  /** Refuse tokens older than this. Default and ceiling: {@link AFFILIATE_STOREFRONT_TOKEN_MAX_AGE_SECONDS}. */
  maxAgeSeconds?: number;
}

function deriveTokenKey(): Buffer | null {
  const master = resolveSupabaseServiceKey()?.trim();
  if (!master) return null;
  return createHmac('sha256', master).update(KEY_LABEL).digest();
}

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

/**
 * A token for `handle`, or null when the handle is not a valid partner handle or no service key
 * is configured (attribution then relies on the referral cookie alone).
 */
export function mintAffiliateStorefrontToken(handle: string, options: { now?: number } = {}): string | null {
  if (typeof handle !== 'string') return null;
  const normalized = handle.trim().toLowerCase();
  if (!AFFILIATE_HANDLE_PATTERN.test(normalized)) return null;

  const key = deriveTokenKey();
  if (!key) return null;

  const issuedAt = Math.floor((options.now ?? Date.now()) / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) return null;

  const payload = `${TOKEN_VERSION}.${normalized}.${issuedAt}`;
  return `${payload}.${sign(key, payload)}`;
}

/**
 * The handle and issue time of a genuine, unexpired token, or null for anything else: a forged
 * or altered signature, another version, a malformed handle or timestamp, a token from the
 * future (beyond a five-minute skew), one older than `maxAgeSeconds`, or no configured key.
 * The signature comparison is constant-time. Never throws.
 */
export function verifyAffiliateStorefrontToken(
  token: unknown,
  options: VerifyAffiliateStorefrontTokenOptions = {},
): AffiliateStorefrontTokenPayload | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > AFFILIATE_STOREFRONT_TOKEN_MAX_LENGTH) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, handle, issuedAtText, signature] = parts;
  if (version !== TOKEN_VERSION) return null;
  if (!AFFILIATE_HANDLE_PATTERN.test(handle)) return null;
  if (!ISSUED_AT_RE.test(issuedAtText)) return null;
  if (!SIGNATURE_RE.test(signature)) return null;

  const key = deriveTokenKey();
  if (!key) return null;

  const expected = Buffer.from(sign(key, `${version}.${handle}.${issuedAtText}`), 'utf8');
  const provided = Buffer.from(signature, 'utf8');
  // Both are 43 ASCII characters here (the regex and the digest size guarantee it).
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;

  const issuedAt = Number(issuedAtText);
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const requestedMaxAge = options.maxAgeSeconds;
  const maxAge =
    typeof requestedMaxAge === 'number' && Number.isFinite(requestedMaxAge) && requestedMaxAge >= 0
      ? Math.min(requestedMaxAge, AFFILIATE_STOREFRONT_TOKEN_MAX_AGE_SECONDS)
      : AFFILIATE_STOREFRONT_TOKEN_MAX_AGE_SECONDS;

  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) return null;
  if (nowSeconds - issuedAt > maxAge) return null;

  return { handle, issuedAt };
}

/**
 * True while a token issued at `issuedAt` (Unix seconds) is inside a referral window of
 * `windowDays` days (the partner tier's `cookie_duration_days`). Non-positive or non-finite
 * windows never match.
 */
export function isAffiliateStorefrontTokenWithinWindow(
  issuedAt: number,
  windowDays: number,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(issuedAt) || !Number.isFinite(windowDays) || windowDays <= 0) return false;
  const nowSeconds = Math.floor(now / 1000);
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) return false;
  return nowSeconds - issuedAt <= Math.min(windowDays, 365) * 24 * 60 * 60;
}
