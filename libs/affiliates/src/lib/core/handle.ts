/**
 * Partner handles: the `/partners/<handle>` slug, the `?ref=<handle>` value and the referral
 * cookie payload. Pure and client-safe.
 */

/**
 * Same regex as the `affiliate_profiles.handle` CHECK in migration 02030: 3 to 32 characters,
 * lowercase letters, digits and hyphens, starting and ending with a letter or digit.
 */
export const AFFILIATE_HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

export const AFFILIATE_HANDLE_MIN_LENGTH = 3;
export const AFFILIATE_HANDLE_MAX_LENGTH = 32;

/**
 * Handles nobody may claim: route segments under `/partners` (`apply`, `opengraph-image`,
 * `sitemap`, `terms` (the partner terms page), ...), `conditions` (the French terms address's
 * segment), and names that would impersonate the store or its staff. The proxy keeps a
 * dependency-free copy (`apps/nextblock/lib/affiliates/referral-cookie.ts`) with a parity test.
 */
export const RESERVED_AFFILIATE_HANDLES = [
  'admin',
  'api',
  'apply',
  'cms',
  'conditions',
  'dashboard',
  'help',
  'join',
  'login',
  'logout',
  'new',
  'nextblock',
  'opengraph-image',
  'partner',
  'partners',
  'portal',
  'retailer',
  'settings',
  'signin',
  'signup',
  'sign-in',
  'sign-up',
  'sitemap',
  'store',
  'support',
  'terms',
  'twitter-image',
  'www',
] as const;

const RESERVED_HANDLE_SET: ReadonlySet<string> = new Set(RESERVED_AFFILIATE_HANDLES);

/** Inputs longer than this are refused before any string work (a handle is at most 32 chars). */
const MAX_RAW_HANDLE_INPUT = 256;

/** Suffix used when a suggested handle is too short or reserved. */
const SUGGESTION_SUFFIX = 'picks';

/** Suggestion when the display name has no usable characters at all. */
const SUGGESTION_FALLBACK = 'my-picks';

export function isReservedAffiliateHandle(handle: string): boolean {
  return RESERVED_HANDLE_SET.has(String(handle).trim().toLowerCase());
}

/**
 * The canonical handle, or null when the input cannot be one: trimmed, lowercased, matching
 * {@link AFFILIATE_HANDLE_PATTERN} and not reserved. Never throws.
 */
export function normalizeAffiliateHandle(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_HANDLE_INPUT) {
    return null;
  }

  const handle = raw.trim().toLowerCase();

  if (!AFFILIATE_HANDLE_PATTERN.test(handle) || RESERVED_HANDLE_SET.has(handle)) {
    return null;
  }

  return handle;
}

/** ASCII slug of a display name: accents stripped, every other run of characters a hyphen. */
function slugifyDisplayName(displayName: string): string {
  return displayName
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function trimToMaxLength(slug: string): string {
  return slug.slice(0, AFFILIATE_HANDLE_MAX_LENGTH).replace(/-+$/g, '');
}

/**
 * A valid, non-reserved handle derived from a display name ("Émilie Côté" → "emilie-cote"), for
 * prefilling the signup form. It is a suggestion only: availability is checked by the database.
 */
export function suggestAffiliateHandle(displayName: string): string {
  const slug = trimToMaxLength(slugifyDisplayName(String(displayName ?? '').slice(0, MAX_RAW_HANDLE_INPUT)));

  if (!slug) {
    return SUGGESTION_FALLBACK;
  }

  if (slug.length < AFFILIATE_HANDLE_MIN_LENGTH || RESERVED_HANDLE_SET.has(slug)) {
    const padded = trimToMaxLength(`${slug}-${SUGGESTION_SUFFIX}`);
    return AFFILIATE_HANDLE_PATTERN.test(padded) && !RESERVED_HANDLE_SET.has(padded) ? padded : SUGGESTION_FALLBACK;
  }

  return AFFILIATE_HANDLE_PATTERN.test(slug) ? slug : SUGGESTION_FALLBACK;
}
