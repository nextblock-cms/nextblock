import 'server-only';

import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import type { Json } from '@nextblock-cms/db';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import {
  AFFILIATE_MIN_PAYOUT_CENTS_DEFAULT,
  AFFILIATE_PROGRAM_SETTINGS_CACHE_TAG,
  AFFILIATE_SETTINGS_KEY,
  defaultAffiliatePayoutMethods,
  normalizeAffiliatePayoutMethods,
  type AffiliatesPayoutMethods,
  type AffiliatesSettings,
} from '@nextblock-cms/affiliates';
import { isSafeInternalPath } from '../auth-redirects';
import { requireCmsAdmin } from '../auth/cms-actor';
import { resolveSiteUrl } from '../site-url';
import { isBuiltInPartnersTermsPath, isBuiltInPartnersTermsTarget } from './partners-paths';

/**
 * The `affiliates_settings` site setting: who hears about partner lifecycle events, the minimum
 * automated payout, whether the daily payout run is on, the operator's own partner terms pages
 * (which replace the built-in terms at `/partners/terms` and `/partenaires/conditions`), and how
 * the commissions of each sale gateway are paid (`payoutMethods`, 02036: Stripe Connect, the
 * default, or by hand outside Stripe; an unknown stored value reads as the default).
 *
 * The key is in no allow-list of `site_settings`' policies (02021/02023/02028), so it sits in the
 * top tier: readable and writable only by an ADMIN with a satisfied second factor. The app reads
 * and writes it with the service role — the notifier and the payout runner run in `after()` and
 * cron contexts without a session — and the save path verifies the ADMIN itself first. The public
 * partner pages read only {@link getPublicAffiliatesProgramSettings}: the terms links, the minimum
 * payout and the payout switch, never the notification addresses.
 *
 * On the public sandbox (published admin login, second factor always satisfied) a terms link would
 * send every later visitor, and the partner sign-up form, to an address a visitor chose: every read
 * drops the overrides there ({@link normalizeAffiliateTermsUrl}), whatever wrote the row, and the
 * CMS action refuses to save one.
 */

export const AFFILIATES_SETTINGS_LIMITS = {
  /** Admin recipients kept (extra addresses are dropped). */
  maxNotificationEmails: 10,
  /** RFC 5321 path limit. */
  maxEmailLength: 254,
  /** Minimum automated payout, base-currency minor units. Stripe refuses tiny transfers. */
  minPayoutCents: 50,
  maxPayoutCents: 1_000_000,
  /** A partner terms override (site path or https URL), in characters. */
  maxTermsUrlLength: 2048,
} as const;

/** The public partner pages' cached settings read lives this long between evictions. */
const AFFILIATES_PUBLIC_SETTINGS_REVALIDATE_SECONDS = 300;

/** A fresh copy of the defaults (never hand out a shared mutable array). */
export function defaultAffiliatesSettings(): AffiliatesSettings {
  return {
    notificationEmails: [],
    minPayoutCents: AFFILIATE_MIN_PAYOUT_CENTS_DEFAULT,
    autoPayoutsEnabled: true,
    termsUrlEn: '',
    termsUrlFr: '',
    payoutMethods: defaultAffiliatePayoutMethods(),
  };
}

/** The public sandbox (its admin login is published). Exactly `'true'`. */
function isAffiliatesSandbox(): boolean {
  return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
}

/** Whitespace, C0 and C1 control characters, DEL and backslashes: none belongs in a link or redirect target. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is being rejected
const TERMS_URL_FORBIDDEN_CHARACTERS = /[\s\u0000-\u001f\u007f-\u009f\\]/;

/** Base for resolving a site path with the URL parser (never requested). */
const TERMS_PATH_BASE = 'https://site.invalid';

/** A path segment the URL parser reads as `.` or `..` (`%2e` is a dot to it, in any case). */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * A site path → its stored form, or null. It must pass the app's shared redirect-target rule
 * (`isSafeInternalPath`: one leading `/`, no backslash, whitespace or control character, no encoded
 * leading slash) and hold whole, plain segments: no empty segment (`//`, which Next answers with a
 * 308 to the collapsed path), no `.` / `..` segment (browsers resolve them), no encoded slash or
 * backslash. Stored percent-encoded as a browser requests it (`’` → `%E2%80%99`): ASCII only, so it
 * fits the `Location` header of the terms page's redirect (Node refuses a character above U+00FF).
 */
function canonicalTermsPath(url: string): string | null {
  if (!isSafeInternalPath(url)) return null;
  const path = url.split(/[?#]/, 1)[0] ?? '';
  if (path.includes('//') || /%2f|%5c/i.test(path) || path.split('/').some((segment) => DOT_SEGMENT.test(segment))) return null;
  let resolved: URL;
  try {
    resolved = new URL(url, TERMS_PATH_BASE);
  } catch {
    return null;
  }
  if (resolved.origin !== TERMS_PATH_BASE) return null;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/**
 * An https URL → its stored form, or null: written as it is read (`https://` then a host; the URL
 * parser would also accept `https:/host`), no credentials, then serialized the way a browser requests
 * it: lowercase scheme and host, an IDN host in punycode, the default port dropped, `.` / `..`
 * resolved, everything else percent-encoded (ASCII only).
 */
function canonicalTermsHttpsUrl(url: string): string | null {
  if (!/^https:\/\/[^/]/i.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;
  return parsed.href;
}

/**
 * A partner terms override as an admin typed it → its stored form, or null when it is not one.
 * Accepted, trimmed: `''` (the built-in terms; `null`/`undefined` count as empty), a site path that
 * starts with exactly one `/` (`/legal/partners`, never `//host`) made of whole plain segments, or an
 * absolute `https:` URL with a host and no credentials. No whitespace, control character or
 * backslash anywhere, and at most 2048 characters as typed and once stored. The stored form is
 * canonical (percent-encoded ASCII, see {@link canonicalTermsPath} / {@link canonicalTermsHttpsUrl})
 * and parses to itself, so a read normalizes a stored value to the same string. Pure: the sandbox
 * rule and the built-in addresses are applied by {@link normalizeAffiliateTermsUrl}.
 */
export function parseAffiliateTermsUrl(value: unknown): string | null {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url) return '';
  if (url.length > AFFILIATES_SETTINGS_LIMITS.maxTermsUrlLength || TERMS_URL_FORBIDDEN_CHARACTERS.test(url)) return null;
  const canonical = url.startsWith('/') ? canonicalTermsPath(url) : canonicalTermsHttpsUrl(url);
  return canonical !== null && canonical.length <= AFFILIATES_SETTINGS_LIMITS.maxTermsUrlLength ? canonical : null;
}

/** The host of this site's canonical URL (`resolveSiteUrl()`), or null. Never throws. */
function canonicalSiteHost(): string | null {
  try {
    return new URL(resolveSiteUrl()).host;
  } catch {
    return null;
  }
}

/**
 * Whether a parsed, non-empty terms override names the built-in terms on this site, however it is
 * spelled: a built-in terms path, or an https URL on the site's own host (`resolveSiteUrl()`, `www.`
 * ignored) whose path is one (`isBuiltInPartnersTermsTarget`). Following it would bring the visitor
 * back to the terms page, so the CMS action refuses it and every read drops it: the terms route,
 * the sign-up and portal links and the sitemap then all apply the same rule.
 */
export function isAffiliateTermsUrlBuiltIn(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('/')) return isBuiltInPartnersTermsPath(url);
  return isBuiltInPartnersTermsTarget(url, [canonicalSiteHost()]);
}

/**
 * A stored partner terms override as every reader must see it: `''` on the public sandbox, for
 * anything {@link parseAffiliateTermsUrl} refuses, and for a built-in terms address on this site
 * ({@link isAffiliateTermsUrlBuiltIn}: it would redirect the terms page to itself); otherwise the
 * canonical value.
 */
export function normalizeAffiliateTermsUrl(value: unknown): string {
  if (isAffiliatesSandbox()) return '';
  const url = parseAffiliateTermsUrl(value);
  if (!url || isAffiliateTermsUrlBuiltIn(url)) return '';
  return url;
}

// HTML's "valid e-mail address" grammar (lowercased first): no whitespace, quotes, commas,
// angle brackets or CR/LF, so a stored address can never smuggle a second recipient or a header
// into the `to` field `sendEmail()` builds.
const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A deliverable-looking recipient address, trimmed and lowercased, or null. */
export function normalizeAffiliateNotificationEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > AFFILIATES_SETTINGS_LIMITS.maxEmailLength) return null;
  return EMAIL_RE.test(email) ? email : null;
}

function normalizeEmailList(value: unknown): string[] {
  // The CMS form may post one textarea ("a@x.com, b@y.com") or an array.
  const candidates: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,;]+/)
      : [];

  const result: string[] = [];
  for (const candidate of candidates) {
    const email = normalizeAffiliateNotificationEmail(candidate);
    if (!email || result.includes(email)) continue;
    result.push(email);
    if (result.length >= AFFILIATES_SETTINGS_LIMITS.maxNotificationEmails) break;
  }
  return result;
}

function normalizeMinPayout(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(numeric)) return AFFILIATE_MIN_PAYOUT_CENTS_DEFAULT;
  return Math.min(
    AFFILIATES_SETTINGS_LIMITS.maxPayoutCents,
    Math.max(AFFILIATES_SETTINGS_LIMITS.minPayoutCents, Math.round(numeric)),
  );
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'on' || normalized === '1') return true;
    if (normalized === 'false' || normalized === 'off' || normalized === '0') return false;
  }
  return fallback;
}

/**
 * Any stored or submitted value → a valid `AffiliatesSettings`. Unknown keys are dropped, bad
 * values fall back to the defaults: at most 10 valid, de-duplicated addresses; the minimum payout
 * clamped to 50–1,000,000 minor units; auto payouts on unless explicitly off; each partner terms
 * override through {@link normalizeAffiliateTermsUrl} (`''` when invalid, and always on the sandbox);
 * each gateway's payout method `stripe_connect` unless it is exactly `manual`.
 */
export function normalizeAffiliatesSettings(value: unknown): AffiliatesSettings {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const defaults = defaultAffiliatesSettings();
  return {
    notificationEmails: normalizeEmailList(raw['notificationEmails']),
    minPayoutCents: normalizeMinPayout(raw['minPayoutCents']),
    autoPayoutsEnabled: normalizeBoolean(raw['autoPayoutsEnabled'], defaults.autoPayoutsEnabled),
    termsUrlEn: normalizeAffiliateTermsUrl(raw['termsUrlEn']),
    termsUrlFr: normalizeAffiliateTermsUrl(raw['termsUrlFr']),
    payoutMethods: normalizeAffiliatePayoutMethods(raw['payoutMethods']),
  };
}

/**
 * The settings as the payout runner needs them, read with the service role: the defaults only
 * when no row was ever saved, otherwise the normalized row, and null when they cannot be known
 * (a read error, a throwing client, or a stored value that is not an object). The automatic
 * payouts switch and the minimum are money controls: an admin who turned payouts off (say, during
 * a fraud review) must never see one transient read error pay every partner at the default
 * minimum. Never throws.
 */
export async function readAffiliatesSettingsStrict(): Promise<AffiliatesSettings | null> {
  try {
    const supabase = getServiceRoleSupabaseClient();
    const { data, error } = await supabase
      .from('site_settings')
      .select('value')
      .eq('key', AFFILIATE_SETTINGS_KEY)
      .maybeSingle();
    if (error) {
      console.warn('[affiliates] Could not read affiliates_settings:', error.message);
      return null;
    }
    if (!data) return defaultAffiliatesSettings();
    const value = (data as { value?: unknown }).value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      console.warn('[affiliates] The stored affiliates_settings value is not an object.');
      return null;
    }
    return normalizeAffiliatesSettings(value);
  } catch (error) {
    console.warn('[affiliates] Could not read affiliates_settings:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * The normalized settings for display and notifications, read with the service role. Memoised
 * per request (React `cache`; a pass-through outside a request, e.g. in `after()` or a cron run).
 * Never throws: an unreadable row (unconfigured instance, transient error) yields the defaults.
 * The payout runner uses `readAffiliatesSettingsStrict()` instead, which refuses to guess.
 */
export const getAffiliatesSettings = cache(
  async (): Promise<AffiliatesSettings> => (await readAffiliatesSettingsStrict()) ?? defaultAffiliatesSettings()
);

/**
 * What the public partner pages may know of the settings (`/partners`, the terms pages, the
 * sitemap, the portal's terms link): the terms overrides, the minimum payout, the payout switch and
 * how each gateway's commissions are paid (the terms and the portal say how partners get paid).
 * Never the notification addresses.
 */
export interface AffiliatesPublicProgramSettings {
  termsUrlEn: string;
  termsUrlFr: string;
  minPayoutCents: number;
  autoPayoutsEnabled: boolean;
  payoutMethods: AffiliatesPayoutMethods;
}

/** The public projection of normalized settings (a fresh object holding only those five fields). */
export function toAffiliatesPublicProgramSettings(settings: AffiliatesSettings): AffiliatesPublicProgramSettings {
  return {
    termsUrlEn: settings.termsUrlEn,
    termsUrlFr: settings.termsUrlFr,
    minPayoutCents: settings.minPayoutCents,
    autoPayoutsEnabled: settings.autoPayoutsEnabled,
    payoutMethods: normalizeAffiliatePayoutMethods(settings.payoutMethods),
  };
}

/** One service-role read of the row, projected. A failure throws, so `unstable_cache` never stores it. */
async function readPublicProgramSettings(): Promise<AffiliatesPublicProgramSettings> {
  const { data, error } = await getServiceRoleSupabaseClient()
    .from('site_settings')
    .select('value')
    .eq('key', AFFILIATE_SETTINGS_KEY)
    .maybeSingle();
  if (error) throw new Error('AffiliatesPublicSettingsReadFailed');
  const value = (data as { value?: unknown } | null)?.value;
  if (data && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('AffiliatesPublicSettingsMalformed');
  }
  return toAffiliatesPublicProgramSettings(normalizeAffiliatesSettings(value));
}

/**
 * The cross-request cached read, built on first use rather than at import: many test suites load
 * this module through others with a partial `next/cache` mock, and nothing at import may need it.
 */
let cachedPublicProgramSettings: (() => Promise<AffiliatesPublicProgramSettings>) | null = null;

/**
 * The public projection of the settings, cached across requests (`unstable_cache`, 5 minutes, tag
 * `AFFILIATE_PROGRAM_SETTINGS_CACHE_TAG`, evicted by `evictAffiliateProgramSettingsCache()` after
 * a save) and memoised per request. Read with the service role (the row is ADMIN-only), so only
 * the projection ever leaves this module. The defaults when no row was ever saved; null when the
 * settings cannot be read (the pages then link the built-in terms and leave the payout details
 * out rather than show defaults as if they were the store's). The terms overrides are always `''`
 * on the public sandbox. Never throws.
 */
export const getPublicAffiliatesProgramSettings = cache(async (): Promise<AffiliatesPublicProgramSettings | null> => {
  let settings: AffiliatesPublicProgramSettings;
  try {
    cachedPublicProgramSettings ??= unstable_cache(readPublicProgramSettings, ['affiliates-public-program-settings'], {
      revalidate: AFFILIATES_PUBLIC_SETTINGS_REVALIDATE_SECONDS,
      tags: [AFFILIATE_PROGRAM_SETTINGS_CACHE_TAG],
    });
    settings = await cachedPublicProgramSettings();
  } catch (error) {
    console.warn('[affiliates] Could not read the public program settings:', error instanceof Error ? error.message : String(error));
    return null;
  }
  return isAffiliatesSandbox() ? { ...settings, termsUrlEn: '', termsUrlFr: '' } : settings;
});

/**
 * Persist the settings (a partial update merges over the stored row) and return what was saved.
 * Verifies an ADMIN with a satisfied second factor itself (`requireCmsAdmin()`, throws
 * `Unauthorized` / `Forbidden`) before the service-role write, so it is safe even if a caller
 * forgot to; the CMS action still authorizes first and validates its input. Allowed in the
 * sandbox (nothing secret is stored), where the normalization stores the terms overrides as `''`
 * (the CMS action refuses a non-empty one there first). Throws a generic error when the write fails.
 */
export async function saveAffiliatesSettings(input: Partial<AffiliatesSettings>): Promise<AffiliatesSettings> {
  const { supabase } = await requireCmsAdmin();

  const { data: existing, error: readError } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', AFFILIATE_SETTINGS_KEY)
    .maybeSingle();
  if (readError) {
    console.error('[affiliates] Could not read affiliates_settings before saving:', readError.message);
    throw new Error('Failed to save affiliate settings.');
  }

  const current = normalizeAffiliatesSettings(existing?.value);
  // An omitted field (or one explicitly `undefined`) keeps the stored value.
  const patch: Record<string, unknown> = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) patch[key] = value;
    }
  }
  const next = normalizeAffiliatesSettings({ ...current, ...patch });

  const { error } = await supabase
    .from('site_settings')
    .upsert({ key: AFFILIATE_SETTINGS_KEY, value: next as unknown as Json });
  if (error) {
    console.error('[affiliates] Could not save affiliates_settings:', error.message);
    throw new Error('Failed to save affiliate settings.');
  }

  return next;
}
