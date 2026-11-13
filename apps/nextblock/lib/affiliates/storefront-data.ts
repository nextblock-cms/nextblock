import 'server-only';

import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { getSsgSupabaseClient } from '@nextblock-cms/db/server';
import {
  AFFILIATE_BADGE_COLORS,
  AFFILIATE_STOREFRONT_CACHE_TAG,
  AFFILIATE_TIERS_CACHE_TAG,
  normalizeAffiliateHandle,
  sanitizeAffiliateSocialLinks,
  type AffiliateBadgeColor,
  type AffiliatePublishedProfile,
  type AffiliateTierRow,
} from '@nextblock-cms/affiliates';
import { listAffiliateTiers } from '@nextblock-cms/affiliates/server';
import { SITE_SETTINGS_CACHE_TAG } from '../../app/lib/site-settings';

/**
 * Cross-request cached reads behind the public partner pages (`/partners`, `/partners/<handle>`,
 * its Open Graph card and the sitemap). Every read goes through the ANON client
 * (`getSsgSupabaseClient()`): the storefront RPCs are anon-callable definers that return only the
 * approved snapshot of an ACTIVE, approved partner, and anon reads only active tiers. Nothing here
 * touches cookies, so the entries are shared by every visitor.
 *
 * Shape (ADDENDUM C7): React `cache()` around `unstable_cache(fn, [key], { revalidate: 300, tags })`.
 * `unstable_cache` keys on the arguments too, so the storefront entry is per handle. Writers evict
 * with `evictAffiliateStorefrontCache()` / `evictAffiliateTiersCache()` (lib/affiliates/cache.ts):
 * approvals, change requests, suspensions, tier CRUD and every signup.
 *
 * A failed read throws INSIDE the cached function, so an error is never cached; the exported
 * readers decide what a failure means for their page.
 */

export const AFFILIATE_PUBLIC_READ_REVALIDATE_SECONDS = 300;

/** Mirrors the `affiliate_profiles.avatar_object_key` CHECK of migration 02030 (plus A21). */
const AVATAR_OBJECT_KEY_PATTERN = /^(?:affiliates\/avatars\/|images\/)[A-Za-z0-9._/-]+$/;
const AVATAR_OBJECT_KEY_MAX_LENGTH = 512;
const DISPLAY_NAME_MAX_LENGTH = 80;
const BIO_MAX_LENGTH = 2000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const DEFAULT_STORE_CURRENCY = 'USD';
const MAX_FEATURED_PRODUCTS = 24;
const STOREFRONT_LIST_LIMIT = 5000;

/** The public tier an approved storefront is shown with (no member counts, no rates). */
export interface AffiliatePublicStorefrontTier {
  name: string;
  nameTranslations: Record<string, string>;
  badgeColor: AffiliateBadgeColor;
  isLimitedTimePromo: boolean;
}

/** One approved storefront, as `get_affiliate_storefront` returns it (normalized, JSON-safe). */
export interface AffiliatePublicStorefront {
  affiliateId: string;
  handle: string;
  tier: AffiliatePublicStorefrontTier;
  /** The profile snapshot taken at approval (never the live, unreviewed profile). */
  profile: AffiliatePublishedProfile;
  title: string | null;
  metaDescription: string | null;
  /** UNTRUSTED until `sanitizeStorefrontDoc()` runs with this deployment's image origins. */
  content: unknown;
  featuredProductIds: string[];
  publishedAt: string | null;
  /** The last approval (`COALESCE(published_at, updated_at)`): a draft autosave never moves it. */
  updatedAt: string | null;
}

export interface AffiliatePublicStorefrontListing {
  handle: string;
  publishedAt: string | null;
  updatedAt: string | null;
}

export interface AffiliatePublicBotProtection {
  provider: 'none' | 'turnstile' | 'recaptcha';
  siteKey: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string' && entry.trim()) result[key] = entry;
  }
  return result;
}

/** The server-set avatar key, re-checked against the column CHECK (a key, never a URL). */
export function normalizeAffiliateAvatarObjectKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (!key || key.length > AVATAR_OBJECT_KEY_MAX_LENGTH) return null;
  if (!AVATAR_OBJECT_KEY_PATTERN.test(key) || key.includes('..') || key.includes('//')) return null;
  return key;
}

/**
 * The approval snapshot `{ display_name, bio, avatar_object_key, social_links, locale }`, normalized.
 * `locale` is kept only when it is `en` or `fr` (absent otherwise: the page follows the visitor).
 */
export function normalizeAffiliatePublishedProfile(value: unknown, handle: string): AffiliatePublishedProfile {
  const record = asRecord(value) ?? {};
  const locale = record['locale'];
  return {
    display_name: cleanText(record['display_name'], DISPLAY_NAME_MAX_LENGTH) ?? handle,
    bio: cleanText(record['bio'], BIO_MAX_LENGTH),
    avatar_object_key: normalizeAffiliateAvatarObjectKey(record['avatar_object_key']),
    social_links: sanitizeAffiliateSocialLinks(record['social_links']),
    ...(locale === 'en' || locale === 'fr' ? { locale } : {}),
  };
}

function badgeColor(value: unknown): AffiliateBadgeColor {
  return typeof value === 'string' && (AFFILIATE_BADGE_COLORS as readonly string[]).includes(value)
    ? (value as AffiliateBadgeColor)
    : 'violet';
}

function productIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !UUID_PATTERN.test(entry)) continue;
    const id = entry.toLowerCase();
    if (!ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_FEATURED_PRODUCTS) break;
  }
  return ids;
}

/** A `get_affiliate_storefront` row as the pages use it, or null when it is not one. */
export function normalizeAffiliatePublicStorefront(raw: unknown): AffiliatePublicStorefront | null {
  const row = asRecord(raw);
  if (!row || typeof row['affiliate_id'] !== 'string') return null;
  const handle = normalizeAffiliateHandle(row['handle']);
  if (!handle) return null;

  return {
    affiliateId: row['affiliate_id'],
    handle,
    tier: {
      name: cleanText(row['tier_name'], 80) ?? '',
      nameTranslations: stringRecord(row['tier_name_translations']),
      badgeColor: badgeColor(row['tier_badge_color']),
      isLimitedTimePromo: row['tier_is_limited_time_promo'] === true,
    },
    profile: normalizeAffiliatePublishedProfile(row['published_profile'], handle),
    title: cleanText(row['published_title'], 120),
    metaDescription: cleanText(row['published_meta_description'], 300),
    content: row['published_content'] ?? null,
    featuredProductIds: productIdList(row['published_featured_product_ids']),
    publishedAt: timestamp(row['published_at']),
    updatedAt: timestamp(row['updated_at']),
  };
}

const getCachedAffiliateStorefront = unstable_cache(
  async (handle: string): Promise<AffiliatePublicStorefront | null> => {
    const { data, error } = await getSsgSupabaseClient().rpc('get_affiliate_storefront', { p_handle: handle });
    if (error) {
      // Thrown, so the failure is not cached; the generic message never echoes the database text.
      console.error('[affiliates] Storefront read failed:', error.message);
      throw new Error('AffiliateStorefrontReadFailed');
    }
    const row = Array.isArray(data) ? data[0] : data;
    return row ? normalizeAffiliatePublicStorefront(row) : null;
  },
  ['affiliates-public-storefront'],
  { revalidate: AFFILIATE_PUBLIC_READ_REVALIDATE_SECONDS, tags: [AFFILIATE_STOREFRONT_CACHE_TAG] },
);

/**
 * The approved storefront published at `/partners/<handle>`, or null (unknown, reserved or
 * malformed handle, suspended or not-yet-approved partner, nothing published). A malformed handle
 * never reaches the database or the cache. Throws on a database error (a transient outage must
 * not answer 404 and get the page dropped from search results).
 */
export const getPublishedAffiliateStorefront = cache(
  async (handle: string): Promise<AffiliatePublicStorefront | null> => {
    const normalized = normalizeAffiliateHandle(handle);
    if (!normalized) return null;
    return getCachedAffiliateStorefront(normalized);
  },
);

const getCachedAffiliateStorefrontList = unstable_cache(
  async (): Promise<AffiliatePublicStorefrontListing[]> => {
    const { data, error } = await getSsgSupabaseClient().rpc('list_affiliate_storefronts', {
      p_limit: STOREFRONT_LIST_LIMIT,
    });
    if (error) {
      console.error('[affiliates] Storefront list read failed:', error.message);
      throw new Error('AffiliateStorefrontListReadFailed');
    }
    const listings: AffiliatePublicStorefrontListing[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(data) ? data : []) {
      const row = asRecord(raw);
      const handle = row ? normalizeAffiliateHandle(row['handle']) : null;
      if (!row || !handle || seen.has(handle)) continue;
      seen.add(handle);
      listings.push({ handle, publishedAt: timestamp(row['published_at']), updatedAt: timestamp(row['updated_at']) });
    }
    return listings;
  },
  ['affiliates-public-storefront-list'],
  { revalidate: AFFILIATE_PUBLIC_READ_REVALIDATE_SECONDS, tags: [AFFILIATE_STOREFRONT_CACHE_TAG] },
);

/** Every published storefront (at most 5000, by handle), for the sitemap. Throws on a database error. */
export const listPublishedAffiliateStorefronts = cache(
  async (): Promise<AffiliatePublicStorefrontListing[]> => getCachedAffiliateStorefrontList(),
);

const getCachedPublicAffiliateTiers = unstable_cache(
  async (): Promise<AffiliateTierRow[]> =>
    // Anon reads only `is_active` tiers (RLS); the filter is repeated by the repository.
    listAffiliateTiers(getSsgSupabaseClient(), { includeInactive: false }),
  ['affiliates-public-tiers'],
  { revalidate: AFFILIATE_PUBLIC_READ_REVALIDATE_SECONDS, tags: [AFFILIATE_TIERS_CACHE_TAG] },
);

/**
 * The active tiers by `sort_order` (the `/partners` ladder, offer and calculator). Never throws:
 * an unreadable table means no tiers, and the page renders its tier-less copy.
 */
export const getPublicAffiliateTiers = cache(async (): Promise<AffiliateTierRow[]> => {
  try {
    const tiers = await getCachedPublicAffiliateTiers();
    return Array.isArray(tiers) ? tiers.filter((tier) => tier.is_active) : [];
  } catch (error) {
    console.error('[affiliates] Tier read failed:', error instanceof Error ? error.message : String(error));
    return [];
  }
});

const getCachedStoreBaseCurrency = unstable_cache(
  async (): Promise<string> => {
    const { data, error } = await getSsgSupabaseClient()
      .from('currencies')
      .select('code')
      .eq('is_default', true)
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw new Error('AffiliateStoreCurrencyReadFailed');
    const code = typeof data?.code === 'string' ? data.code.trim().toUpperCase() : '';
    return CURRENCY_CODE_PATTERN.test(code) ? code : DEFAULT_STORE_CURRENCY;
  },
  ['affiliates-store-base-currency'],
  { revalidate: AFFILIATE_PUBLIC_READ_REVALIDATE_SECONDS },
);

/**
 * The store base (default) currency: commissions are recorded and paid in it, so the calculator
 * shows it. Never throws (USD when the table is unreadable).
 */
export const getAffiliateStoreBaseCurrency = cache(async (): Promise<string> => {
  try {
    return await getCachedStoreBaseCurrency();
  } catch {
    return DEFAULT_STORE_CURRENCY;
  }
});

const getCachedBotProtectionPublic = unstable_cache(
  async (): Promise<AffiliatePublicBotProtection> => {
    const { data, error } = await getSsgSupabaseClient()
      .from('site_settings')
      .select('value')
      .eq('key', 'bot_protection_public')
      .maybeSingle();
    if (error) throw new Error('AffiliateBotProtectionReadFailed');
    const value = asRecord(data?.value) ?? {};
    const provider = value['provider'] === 'turnstile' || value['provider'] === 'recaptcha' ? value['provider'] : 'none';
    const siteKey = typeof value['siteKey'] === 'string' ? value['siteKey'].trim().slice(0, 200) : '';
    return { provider, siteKey };
  },
  ['affiliates-public-bot-protection'],
  // The bot-protection settings action revalidates the root layout, whose implicit tag covers this.
  { revalidate: AFFILIATE_PUBLIC_READ_REVALIDATE_SECONDS, tags: [SITE_SETTINGS_CACHE_TAG] },
);

/**
 * The public half of the bot-protection settings (provider + site key; the same value every visitor
 * receives) for the signup form, read like `components/BlockRenderer.tsx` does. Never throws.
 */
export const getPartnersBotProtectionPublic = cache(async (): Promise<AffiliatePublicBotProtection> => {
  try {
    return await getCachedBotProtectionPublic();
  } catch {
    return { provider: 'none', siteKey: '' };
  }
});
