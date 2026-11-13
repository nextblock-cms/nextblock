import 'server-only';

import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { headers } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSsgSupabaseClient } from '@nextblock-cms/db/server';
import { normalizeCurrencyRecord, resolveEffectivePriceForCurrency, type CurrencyRecord } from '@nextblock-cms/ecommerce';
import { buildPublishedAtOrFilter } from '@nextblock-cms/utils';
import {
  AFFILIATE_GATEWAYS,
  AFFILIATE_PARTNERS_PATH,
  affiliateCommissionNetMinor,
  affiliateGatewaysPaidByPayPal,
  affiliateGatewaysPaidByStripe,
  affiliateGatewaysPaidOutsideStripe,
  affiliatePayoutMethodForGateway,
  computeAffiliateOnboardingProgress,
  formatAffiliateMoney,
  isAffiliatePayPalPayoutReceiver,
  isStorefrontProductId,
  normalizeAffiliatePayoutEmailKind,
  normalizeAffiliatePayoutMethods,
  sanitizeStorefrontDoc,
  type AffiliateBalances,
  type AffiliateCommissionRow,
  type AffiliateGateway,
  type AffiliateLocale,
  type AffiliateOnboardingProgress,
  type AffiliatePageRow,
  type AffiliatePayoutEmailKind,
  type AffiliatePayoutMethod,
  type AffiliatePayoutRow,
  type AffiliateProfileRow,
  type AffiliatePublishedProfile,
  type AffiliatesPayoutMethods,
  type AffiliatesSettings,
  type AffiliateSocialLinks,
  type AffiliateTierRow,
  type StorefrontDoc,
  type StorefrontEditorProduct,
} from '@nextblock-cms/affiliates';
import {
  escapeAffiliateLikePattern,
  getAffiliateBalances,
  getAffiliateTierById,
  isAffiliatePayoutAutoRetryable,
  listAffiliateCommissions,
  listAffiliatePayouts,
  normalizeAffiliatePageRow,
  normalizeAffiliateProfileRow,
  type AffiliatePayoutAutoRetryContext,
} from '@nextblock-cms/affiliates/server';

import { resolveMediaUrl } from '../media/resolveMediaUrl';
import { hasExplicitSiteUrl, resolveSiteUrl } from '../site-url';
import { resolveMediaBaseUrl } from '../storage/provider';
import { getStorefrontImageOrigins } from './image-origins';
import type { RetailerActor, RetailerServiceRoleClient } from './retailer-actor';
import { isAffiliateConnectConfigured } from './connect-service';
import { getAffiliatePayPalCredentialStatus } from './paypal/credentials';
import { loadAffiliatePayPalBlockedReceivers } from './paypal/engine';
import { getAffiliatesSettings } from './settings';

/**
 * Server-side reads of the partner portal (`/portal/retailer/**`).
 *
 * Every loader takes the `{ supabase, actor }` pair `requireRetailerPage()` / `requireRetailer()`
 * returned: identity, second factor, role, package and ownership were established there, and the
 * ids used below come from that actor, never from the request. The ledger is read with the
 * service role (the money tables are service-role-write; reading through it keeps one client),
 * filtered by the actor's affiliate id. Catalog reads use the anon client, so only products the
 * public may see (`status = 'active'`, published) can ever be offered to a partner.
 */

type AnyClient = SupabaseClient<any>;

export interface RetailerPortalContext {
  supabase: RetailerServiceRoleClient;
  actor: RetailerActor;
}

export interface RetailerPortalAccount {
  profile: AffiliateProfileRow;
  page: AffiliatePageRow | null;
}

function anyClient(client: RetailerServiceRoleClient): AnyClient {
  return client as unknown as AnyClient;
}

/** The actor's affiliate profile and page, normalized to the contract, or null without a profile. */
export function readRetailerPortalAccount(actor: RetailerActor | null | undefined): RetailerPortalAccount | null {
  const profile = normalizeAffiliateProfileRow(actor?.affiliate ?? null);
  if (!profile) return null;
  return { profile, page: normalizeAffiliatePageRow(actor?.page ?? null) };
}

/* ------------------------------------------------------------- urls and media --- */

const HOST_PATTERN = /^[a-z0-9.-]+(?::\d{1,5})?$/;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'http://localhost:3000';
  }
}

/**
 * The site origin shown in share links. The configured site URL in production; in development
 * without a configured URL, the host the partner is browsing (the dev server runs on :4200, not
 * the resolver's :3000 fallback). The portal is rendered per request and never cached.
 */
export const resolvePortalSiteOrigin = cache(async (): Promise<string> => {
  const configured = originOf(resolveSiteUrl());
  if (hasExplicitSiteUrl() || process.env.NODE_ENV !== 'development') return configured;
  try {
    const headerList = await headers();
    const host = (headerList.get('x-forwarded-host') ?? headerList.get('host') ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
    if (host && HOST_PATTERN.test(host)) {
      const proto = (headerList.get('x-forwarded-proto') ?? '').split(',')[0]?.trim().toLowerCase();
      return `${proto === 'https' ? 'https' : 'http'}://${host}`;
    }
  } catch {
    // Outside a request scope.
  }
  return configured;
});

/** `https://shop.example/partners/<handle>`. */
export function buildAffiliateStorefrontUrl(siteOrigin: string, handle: string): string {
  return `${siteOrigin.replace(/\/+$/, '')}${AFFILIATE_PARTNERS_PATH}/${encodeURIComponent(handle)}`;
}

/** The public URL of a stored avatar key, or null (no key, or no media base URL to serve it from). */
export function resolveAffiliateAvatarUrl(objectKey: string | null | undefined): string | null {
  if (typeof objectKey !== 'string' || !objectKey.trim()) return null;
  const key = objectKey.trim();
  if (key.startsWith('images/')) return resolveMediaUrl(key);
  let base = '';
  try {
    base = resolveMediaBaseUrl();
  } catch {
    base = '';
  }
  return base ? resolveMediaUrl(key, base) : null;
}

const STRIPE_REDIRECT_HOSTS = ['stripe.com'];

/**
 * The Stripe-hosted URL a Connect helper returned (a string, or `{ url }` / `{ ok: true, url }`),
 * accepted only when it is https on a stripe.com host without credentials: the portal navigates
 * the partner there, so it must never become an open redirect.
 */
export function readAffiliateStripeRedirectUrl(result: unknown): string | null {
  let candidate: unknown = result;
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (record['ok'] === false) return null;
    candidate = record['url'] ?? record['href'] ?? null;
  }
  if (typeof candidate !== 'string' || candidate.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const allowed = STRIPE_REDIRECT_HOSTS.some((root) => host === root || host.endsWith(`.${root}`));
  return allowed ? url.toString() : null;
}

/* ------------------------------------------------------------------- catalog --- */

interface CatalogLanguage {
  id: number;
  code: string;
}

interface CatalogContext {
  baseCurrency: string;
  currencies: CurrencyRecord[];
  languages: CatalogLanguage[];
}

const DEFAULT_CATALOG_CONTEXT: CatalogContext = { baseCurrency: 'USD', currencies: [], languages: [] };

// Languages and currencies change about never; five minutes, like the public layout.
const getCachedCatalogContext = unstable_cache(
  async (): Promise<CatalogContext> => {
    const client = getSsgSupabaseClient();
    const [currencyResult, languageResult] = await Promise.all([
      client
        .from('currencies')
        .select('code, symbol, exchange_rate, is_default, is_active, rounding_mode, rounding_increment, rounding_charm_amount')
        .eq('is_active', true),
      client.from('languages').select('id, code'),
    ]);
    const currencies = Array.isArray(currencyResult.data)
      ? (currencyResult.data as Array<Record<string, unknown>>).map((row) => normalizeCurrencyRecord(row))
      : [];
    const languages = Array.isArray(languageResult.data)
      ? (languageResult.data as Array<{ id: unknown; code: unknown }>)
          .filter((row) => typeof row.id === 'number' && typeof row.code === 'string')
          .map((row) => ({ id: row.id as number, code: String(row.code).trim().toLowerCase() }))
      : [];
    const base = currencies.find((currency) => currency.is_default)?.code ?? 'USD';
    return { baseCurrency: base, currencies, languages };
  },
  ['affiliates-portal-catalog-context'],
  { revalidate: 300 },
);

async function readCatalogContext(): Promise<CatalogContext> {
  try {
    return await getCachedCatalogContext();
  } catch {
    return DEFAULT_CATALOG_CONTEXT;
  }
}

/** The store base currency code (`currencies.is_default`), `USD` when unknown. */
export async function getPortalBaseCurrency(): Promise<string> {
  return (await readCatalogContext()).baseCurrency;
}

const CATALOG_COLUMNS =
  'id, title, price, prices, sale_price, sale_prices, sale_start_at, sale_end_at, scheduled_price, scheduled_prices, scheduled_price_at, language_id, translation_group_id, product_media(sort_order, media(object_key, file_path))';

export const AFFILIATE_CATALOG_SEARCH_LIMIT = 50;
export const AFFILIATE_CATALOG_RESOLVE_LIMIT = 48;
export const AFFILIATE_CATALOG_QUERY_MAX_LENGTH = 100;

interface CatalogRow {
  id?: unknown;
  title?: unknown;
  price?: unknown;
  prices?: unknown;
  sale_price?: unknown;
  sale_prices?: unknown;
  sale_start_at?: unknown;
  sale_end_at?: unknown;
  scheduled_price?: unknown;
  scheduled_prices?: unknown;
  scheduled_price_at?: unknown;
  language_id?: unknown;
  translation_group_id?: unknown;
  product_media?: unknown;
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function catalogImageUrl(productMedia: unknown): string | null {
  if (!Array.isArray(productMedia) || productMedia.length === 0) return null;
  const sorted = [...productMedia].sort(
    (a, b) => Number((a as { sort_order?: unknown })?.sort_order ?? 0) - Number((b as { sort_order?: unknown })?.sort_order ?? 0),
  );
  const media = firstRelation((sorted[0] as { media?: unknown } | undefined)?.media as
    | { object_key?: unknown; file_path?: unknown }
    | Array<{ object_key?: unknown; file_path?: unknown }>
    | null
    | undefined);
  const key =
    typeof media?.object_key === 'string' && media.object_key
      ? media.object_key
      : typeof media?.file_path === 'string' && media.file_path
        ? media.file_path
        : null;
  if (!key) return null;
  let base = '';
  try {
    base = resolveMediaBaseUrl();
  } catch {
    base = '';
  }
  return resolveMediaUrl(key, base || undefined);
}

function asNumberOrNull(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function asRecordOrNull(value: unknown): Record<string, number> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, number>) : null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function catalogPriceLabel(row: CatalogRow, context: CatalogContext, locale: AffiliateLocale): string | null {
  const fallbackPrice = asNumberOrNull(row.price);
  if (fallbackPrice === null) return null;
  try {
    const resolved = resolveEffectivePriceForCurrency({
      prices: asRecordOrNull(row.prices),
      salePrices: asRecordOrNull(row.sale_prices),
      fallbackPrice,
      fallbackSalePrice: asNumberOrNull(row.sale_price),
      saleStartAt: asStringOrNull(row.sale_start_at),
      saleEndAt: asStringOrNull(row.sale_end_at),
      scheduledPrice: asNumberOrNull(row.scheduled_price),
      scheduledPrices: asRecordOrNull(row.scheduled_prices),
      scheduledPriceAt: asStringOrNull(row.scheduled_price_at),
      currencyCode: context.baseCurrency,
      currencies: context.currencies,
    });
    const amount = resolved.sale_price ?? resolved.price;
    return Number.isFinite(amount) ? formatAffiliateMoney(amount, context.baseCurrency, locale) : null;
  } catch {
    return formatAffiliateMoney(fallbackPrice, context.baseCurrency, locale);
  }
}

function toEditorProduct(row: CatalogRow, context: CatalogContext, locale: AffiliateLocale): StorefrontEditorProduct | null {
  if (!isStorefrontProductId(row.id) || typeof row.title !== 'string' || !row.title.trim()) return null;
  return {
    id: row.id.toLowerCase(),
    title: row.title.trim().slice(0, 300),
    imageUrl: catalogImageUrl(row.product_media),
    priceLabel: catalogPriceLabel(row, context, locale),
  };
}

/**
 * One product per translation group, the visitor's language first: the catalog holds a row per
 * language, and a picker listing "T-shirt" twice (EN and FR rows) helps nobody.
 */
function preferLocaleRows(rows: CatalogRow[], context: CatalogContext, locale: AffiliateLocale): CatalogRow[] {
  const languageId = context.languages.find((language) => language.code === locale)?.id ?? null;
  const ordered =
    languageId === null
      ? rows
      : [...rows.filter((row) => row.language_id === languageId), ...rows.filter((row) => row.language_id !== languageId)];
  const seen = new Set<string>();
  const result: CatalogRow[] = [];
  for (const row of ordered) {
    const group = typeof row.translation_group_id === 'string' && row.translation_group_id ? row.translation_group_id : `id:${String(row.id)}`;
    if (seen.has(group)) continue;
    seen.add(group);
    result.push(row);
  }
  // Keep the database order (newest first) among the kept rows.
  const kept = new Set(result);
  return rows.filter((row) => kept.has(row));
}

/** Whitespace collapsed, control characters dropped, at most 100 characters. */
export function normalizeAffiliateCatalogQuery(query: unknown): string {
  if (typeof query !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  return query.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, AFFILIATE_CATALOG_QUERY_MAX_LENGTH);
}

/**
 * Active, published products whose title contains `query` (case-insensitive), newest first, for
 * the storefront product picker. The query is escaped (`%`, `_`, `\`, and PostgREST's `*`) before
 * it becomes an ILIKE pattern, and only ever reaches `.ilike()`, never an `.or()` string.
 * Throws on a database error (the caller answers with a generic failure).
 */
export async function searchAffiliateCatalogProducts(options: {
  query: string;
  locale: AffiliateLocale;
  limit?: number;
}): Promise<StorefrontEditorProduct[]> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? AFFILIATE_CATALOG_SEARCH_LIMIT), 1), AFFILIATE_CATALOG_SEARCH_LIMIT);
  const term = normalizeAffiliateCatalogQuery(options.query);
  const context = await readCatalogContext();

  let request = getSsgSupabaseClient()
    .from('products')
    .select(CATALOG_COLUMNS)
    .eq('status', 'active')
    // Server-built (a timestamp), never user input.
    .or(buildPublishedAtOrFilter());
  if (term) request = request.ilike('title', `%${escapeAffiliateLikePattern(term)}%`);

  const { data, error } = await request.order('updated_at', { ascending: false }).limit(limit * 2);
  if (error) throw new Error('affiliate_catalog_search_failed');

  const rows = preferLocaleRows(Array.isArray(data) ? (data as CatalogRow[]) : [], context, options.locale);
  const products: StorefrontEditorProduct[] = [];
  for (const row of rows) {
    const product = toEditorProduct(row, context, options.locale);
    if (product) products.push(product);
    if (products.length >= limit) break;
  }
  return products;
}

/** Lowercase uuids, de-duplicated, in order, at most `max`. */
export function normalizeAffiliateProductIdList(ids: unknown, max: number): string[] {
  const result: string[] = [];
  if (!Array.isArray(ids)) return result;
  for (const raw of ids) {
    if (!isStorefrontProductId(raw)) continue;
    const id = raw.toLowerCase();
    if (!result.includes(id)) result.push(id);
    if (result.length >= max) break;
  }
  return result;
}

/** The given products that are active and published, in the order asked. Throws on a database error. */
export async function resolveAffiliateCatalogProducts(options: {
  ids: readonly string[];
  locale: AffiliateLocale;
}): Promise<StorefrontEditorProduct[]> {
  const ids = normalizeAffiliateProductIdList(options.ids, AFFILIATE_CATALOG_RESOLVE_LIMIT);
  if (ids.length === 0) return [];
  const context = await readCatalogContext();
  const { data, error } = await getSsgSupabaseClient()
    .from('products')
    .select(CATALOG_COLUMNS)
    .in('id', ids)
    .eq('status', 'active')
    .or(buildPublishedAtOrFilter());
  if (error) throw new Error('affiliate_catalog_resolve_failed');

  const byId = new Map<string, StorefrontEditorProduct>();
  for (const row of Array.isArray(data) ? (data as CatalogRow[]) : []) {
    const product = toEditorProduct(row, context, options.locale);
    if (product) byId.set(product.id, product);
  }
  return ids.map((id) => byId.get(id)).filter((product): product is StorefrontEditorProduct => Boolean(product));
}

/** The subset of `ids` that are active, published products, in order. Throws on a database error. */
export async function filterActiveAffiliateCatalogProductIds(ids: readonly string[], max = 24): Promise<string[]> {
  const normalized = normalizeAffiliateProductIdList(ids, max);
  if (normalized.length === 0) return [];
  const { data, error } = await getSsgSupabaseClient()
    .from('products')
    .select('id')
    .in('id', normalized)
    .eq('status', 'active')
    .or(buildPublishedAtOrFilter());
  if (error) throw new Error('affiliate_catalog_filter_failed');
  const active = new Set(
    (Array.isArray(data) ? (data as Array<{ id?: unknown }>) : [])
      .map((row) => (typeof row.id === 'string' ? row.id.toLowerCase() : null))
      .filter((id): id is string => Boolean(id)),
  );
  return normalized.filter((id) => active.has(id));
}

/* ------------------------------------------------------------- next payout --- */

export interface AffiliateNextPayoutInput {
  now: Date;
  autoPayoutsEnabled: boolean;
  /** Minimum automated payout, minor units of the payout currency. */
  minPayoutCents: number;
  /** CLEARED and not yet attached to a payout, net of refunds. */
  clearedCents: number;
  /** PENDING_CLEARANCE commissions (net amounts) in the payout currency. */
  pending: ReadonlyArray<{ amountCents: number; clearsAt: string | null }>;
  /** UTC date (`YYYY-MM-DD`) of the latest daily payout run, if known. */
  lastRunDate: string | null;
  /** Stripe Connect onboarding is complete (payouts can be transferred). */
  payoutsReady: boolean;
  /** ACTIVE and approved (the first storefront approval): only then are payouts claimed. */
  eligible: boolean;
}

export type AffiliateNextPayoutEstimate =
  | { kind: 'scheduled'; date: string }
  | { kind: 'paused' }
  | { kind: 'not_eligible' }
  | { kind: 'connect_required' }
  | { kind: 'below_minimum'; remainingCents: number }
  | { kind: 'no_balance' };

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function addUtcDays(day: string, days: number): string {
  return utcDay(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS);
}

/**
 * When the daily payout run should next pay this partner (an estimate, as a UTC date).
 *
 * The run happens once per UTC day (cron, or the first CMS/portal visit of the day): it promotes
 * commissions whose clearance date has passed, then pays a partner whose cleared balance reaches
 * the minimum. So: paused when automated payouts are off; nothing for a partner who is not
 * approved yet or has no bank account connected; the next run when the cleared balance already
 * reaches the minimum; otherwise the run after the clearance date of the pending commission that
 * brings the balance to the minimum (commissions clear in `clears_at` order).
 */
export function computeAffiliateNextPayout(input: AffiliateNextPayoutInput): AffiliateNextPayoutEstimate {
  if (!input.autoPayoutsEnabled) return { kind: 'paused' };
  if (!input.eligible) return { kind: 'not_eligible' };
  if (!input.payoutsReady) return { kind: 'connect_required' };

  const nowMs = input.now.getTime();
  const today = utcDay(nowMs);
  const ranToday = typeof input.lastRunDate === 'string' && input.lastRunDate >= today;
  const nextRun = ranToday ? addUtcDays(today, 1) : today;
  const minimum = Math.max(1, Math.round(Number(input.minPayoutCents) || 0));

  let total = Math.max(0, Math.round(Number(input.clearedCents) || 0));
  if (total >= minimum) return { kind: 'scheduled', date: nextRun };

  const pending = input.pending
    .map((entry) => ({ amount: Math.max(0, Math.round(Number(entry.amountCents) || 0)), clearsAt: Date.parse(String(entry.clearsAt ?? '')) }))
    .filter((entry) => entry.amount > 0 && Number.isFinite(entry.clearsAt))
    .sort((a, b) => a.clearsAt - b.clearsAt);

  for (const entry of pending) {
    total += entry.amount;
    if (total < minimum) continue;
    if (entry.clearsAt <= nowMs) return { kind: 'scheduled', date: nextRun };
    const dayAfterClearing = addUtcDays(utcDay(entry.clearsAt), 1);
    return { kind: 'scheduled', date: dayAfterClearing > nextRun ? dayAfterClearing : nextRun };
  }

  return total > 0 ? { kind: 'below_minimum', remainingCents: minimum - total } : { kind: 'no_balance' };
}

/* ------------------------------------------------------------------ loaders --- */

function isApproved(profile: AffiliateProfileRow): boolean {
  return Boolean(profile.first_published_at);
}

function isLive(account: RetailerPortalAccount): boolean {
  return account.profile.status === 'ACTIVE' && isApproved(account.profile) && account.page?.published_content != null;
}

async function readTier(ctx: RetailerPortalContext, tierId: string): Promise<AffiliateTierRow | null> {
  try {
    return await getAffiliateTierById(anyClient(ctx.supabase), tierId);
  } catch (error) {
    console.warn('[affiliates] Portal tier read failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

function emptyBalances(currency: string): AffiliateBalances {
  const primary = { currency, pendingCents: 0, clearedCents: 0, processingCents: 0, paidCents: 0, voidedCents: 0, nextClearsAt: null };
  return { primary, byCurrency: [] };
}

export interface RetailerOverviewData {
  account: RetailerPortalAccount;
  tier: AffiliateTierRow | null;
  progress: AffiliateOnboardingProgress;
  balances: AffiliateBalances;
  recentCommissions: AffiliateCommissionRow[];
  baseCurrency: string;
  siteOrigin: string;
  storefrontUrl: string;
  avatarUrl: string | null;
  isApproved: boolean;
  isLive: boolean;
  /** True when the earnings could not be read (the page says so instead of showing zeros). */
  ledgerError: boolean;
}

export async function loadRetailerOverviewData(
  ctx: RetailerPortalContext,
  account: RetailerPortalAccount,
): Promise<RetailerOverviewData> {
  const { profile, page } = account;
  // The settings say whether a payout email completes the payouts step (some gateway paid by hand).
  const [baseCurrency, siteOrigin, tier, settings] = await Promise.all([
    getPortalBaseCurrency(),
    resolvePortalSiteOrigin(),
    readTier(ctx, profile.tier_id),
    getAffiliatesSettings(),
  ]);

  let balances = emptyBalances(baseCurrency);
  let recentCommissions: AffiliateCommissionRow[] = [];
  let ledgerError = false;
  try {
    const [balanceResult, commissionResult] = await Promise.all([
      getAffiliateBalances(anyClient(ctx.supabase), profile.id, { baseCurrency }),
      listAffiliateCommissions(anyClient(ctx.supabase), { affiliateId: profile.id, limit: 5 }),
    ]);
    balances = balanceResult;
    recentCommissions = commissionResult.rows;
  } catch (error) {
    ledgerError = true;
    console.warn('[affiliates] Portal ledger read failed:', error instanceof Error ? error.message : String(error));
  }

  return {
    account,
    tier,
    progress: computeAffiliateOnboardingProgress({
      profile,
      page,
      payoutMethods: normalizeAffiliatePayoutMethods(settings?.payoutMethods),
    }),
    balances,
    recentCommissions,
    baseCurrency,
    siteOrigin,
    storefrontUrl: buildAffiliateStorefrontUrl(siteOrigin, profile.handle),
    avatarUrl: resolveAffiliateAvatarUrl(profile.avatar_object_key),
    isApproved: isApproved(profile),
    isLive: isLive(account),
    ledgerError,
  };
}

/** Did the live profile change since the approved snapshot (so a resubmission has something to review)? */
export function hasAffiliateProfileChangedSincePublish(
  profile: Pick<AffiliateProfileRow, 'display_name' | 'bio' | 'avatar_object_key' | 'social_links' | 'preferred_locale'>,
  published: AffiliatePublishedProfile | null,
): boolean {
  if (!published) return true;
  // The storefront declares the partner's language (finding T), so a language-only change must be
  // submittable. Snapshots approved before the field existed carry no locale and never differ.
  const locale = profile.preferred_locale === 'fr' ? 'fr' : 'en';
  if (published.locale !== undefined && published.locale !== locale) return true;
  const links = (value: AffiliateSocialLinks | null | undefined) =>
    JSON.stringify(
      Object.entries(value ?? {})
        .filter(([, url]) => typeof url === 'string' && url)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return (
    profile.display_name !== published.display_name ||
    (profile.bio ?? null) !== (published.bio ?? null) ||
    (profile.avatar_object_key ?? null) !== (published.avatar_object_key ?? null) ||
    links(profile.social_links) !== links(published.social_links)
  );
}

export interface RetailerStudioData {
  account: RetailerPortalAccount;
  siteOrigin: string;
  storefrontUrl: string;
  avatarUrl: string | null;
  allowedImageOrigins: string[];
  draftDoc: StorefrontDoc;
  featuredProducts: StorefrontEditorProduct[];
  isApproved: boolean;
  isLive: boolean;
  profileChangedSincePublish: boolean;
}

export async function loadRetailerStudioData(
  account: RetailerPortalAccount,
  locale: AffiliateLocale,
): Promise<RetailerStudioData> {
  const { profile, page } = account;
  const allowedImageOrigins = getStorefrontImageOrigins();
  const siteOrigin = await resolvePortalSiteOrigin();
  const draftDoc = sanitizeStorefrontDoc(page?.draft_content ?? null, { allowedImageOrigins, siteOrigin }).doc;

  let featuredProducts: StorefrontEditorProduct[] = [];
  try {
    featuredProducts = await resolveAffiliateCatalogProducts({ ids: page?.featured_product_ids ?? [], locale });
  } catch (error) {
    console.warn('[affiliates] Featured products read failed:', error instanceof Error ? error.message : String(error));
  }

  return {
    account,
    siteOrigin,
    storefrontUrl: buildAffiliateStorefrontUrl(siteOrigin, profile.handle),
    avatarUrl: resolveAffiliateAvatarUrl(profile.avatar_object_key),
    allowedImageOrigins,
    draftDoc,
    featuredProducts,
    isApproved: isApproved(profile),
    isLive: isLive(account),
    profileChangedSincePublish: hasAffiliateProfileChangedSincePublish(profile, page?.published_profile ?? null),
  };
}

/**
 * The partner's Connect card. `unavailable`: the store has no Stripe account set up yet, so bank
 * payouts cannot be connected at all (whatever the partner's own state).
 */
export type RetailerConnectState = 'not_connected' | 'incomplete' | 'ready' | 'unavailable';

export function retailerConnectStateOf(profile: AffiliateProfileRow): RetailerConnectState {
  if (!profile.stripe_connect_account_id) return 'not_connected';
  return profile.stripe_connect_onboarding_complete ? 'ready' : 'incomplete';
}

/**
 * Cleared commissions held by the partner's FAILED payouts (base currency, net of refunds). They
 * are part of `processingCents`, which counts every commission attached to a payout, so only the
 * rest of it is really on its way to the partner's bank.
 */
export interface RetailerFailedPayouts {
  /** Held by failed payouts the daily cycle retries by itself. */
  autoRetryCents: number;
  /** Held by failed payouts that wait for an admin's Retry or Release. */
  awaitingReviewCents: number;
  /** The failed payouts the daily cycle retries by itself (their history row says so). */
  autoRetryPayoutIds: string[];
}

/**
 * How the program pays this partner's commissions (`affiliates_settings.payoutMethods`, 02036):
 * every gateway through Stripe Connect (`stripe`, the default), every gateway by hand (`manual`:
 * the operator sends the money by PayPal or Interac e-Transfer and records it in the CMS), or some
 * of each (`mixed`).
 */
export type RetailerPayoutMode = 'stripe' | 'manual' | 'mixed';

/**
 * 02037: a gateway paid with PayPal Payouts counts as paid outside Stripe (`manual` here): the
 * partner needs a payout email for it, not Stripe Connect. Which way this partner's commissions
 * really go (PayPal automatically, or by hand to an Interac e-Transfer address) is
 * {@link RetailerPayoutRoutes}.
 */
export function retailerPayoutModeOf(settings: { payoutMethods?: unknown } | null | undefined): RetailerPayoutMode {
  if (affiliateGatewaysPaidOutsideStripe(settings).length === 0) return 'stripe';
  return affiliateGatewaysPaidByStripe(settings).length === 0 ? 'manual' : 'mixed';
}

/**
 * The ways this partner's commissions go, by the program's routing and the partner's payout email
 * (02037): `stripe` some gateway is paid through Stripe Connect; `paypal` some gateway is paid with
 * PayPal Payouts and PayPal can pay this partner automatically (a PayPal payout email PayPal can take,
 * whose last payout PayPal did not return); `manual` the store pays some gateway's commissions by
 * hand (a gateway routed to "manually", or a PayPal gateway for a partner PayPal cannot pay: an
 * Interac e-Transfer address, none, or one PayPal returned a payout from). With two gateways at most
 * two are true.
 */
export interface RetailerPayoutRoutes {
  stripe: boolean;
  paypal: boolean;
  manual: boolean;
}

/**
 * The routes of {@link RetailerPayoutRoutes} from the gateways paid through Stripe and those PayPal
 * pays this partner automatically (empty while PayPal cannot pay them): every other gateway is paid by hand.
 */
export function retailerPayoutRoutesOf(
  stripeGateways: readonly AffiliateGateway[],
  paypalAutoGateways: readonly AffiliateGateway[],
): RetailerPayoutRoutes {
  return {
    stripe: stripeGateways.length > 0,
    paypal: paypalAutoGateways.length > 0,
    manual: AFFILIATE_GATEWAYS.some((gateway) => !stripeGateways.includes(gateway) && !paypalAutoGateways.includes(gateway)),
  };
}

/** How many ways a partner's commissions go (1 or 2 with two gateways). */
export function countRetailerPayoutRoutes(routes: RetailerPayoutRoutes): number {
  return Number(routes.stripe) + Number(routes.paypal) + Number(routes.manual);
}

export interface RetailerPayPalPayoutInput {
  now: Date;
  /** Automatic payouts are on (the daily run sends PayPal payouts) and PayPal is configured. */
  autoPayoutsEnabled: boolean;
  /** Minimum payout, minor units of the payout currency. */
  minPayoutCents: number;
  /** CLEARED, unattached commissions PayPal pays this partner, net of refunds. */
  clearedCents: number;
  /** Their PENDING_CLEARANCE commissions (net amounts). */
  pending: ReadonlyArray<{ amountCents: number; clearsAt: string | null }>;
  /** UTC date (`YYYY-MM-DD`) of the latest daily payout run, if known. */
  lastRunDate: string | null;
  /** ACTIVE and approved: `claim_paypal_affiliate_payout` refuses anyone else. */
  eligible: boolean;
  /** PayPal payouts in flight (PROCESSING, the item not paid yet). Omitted or 0: none. */
  sendingCents?: number;
  /** Of those, the one waiting for the partner to claim it (UNCLAIMED), and where PayPal sent its claim email. */
  unclaimed?: { amountCents: number; email: string | null } | null;
}

/** What the partner can expect of the payouts PayPal sends automatically (02037). */
export type RetailerPayPalPayoutEstimate =
  /** PayPal holds a payout for the partner to claim (it returns it after 30 days). */
  | { kind: 'unclaimed'; amountCents: number; email: string | null }
  /** A PayPal payout is on its way. */
  | { kind: 'sending'; amountCents: number }
  | AffiliateNextPayoutEstimate;

/**
 * The automatic PayPal payouts (02037). A payout PayPal holds comes first: waiting to be claimed, else
 * on its way (one at a time per currency and mode: the next claim waits for it). Otherwise the
 * Stripe estimate's arithmetic, since the same daily run sends both: paused while automatic payouts
 * are off or PayPal is not configured, not eligible before the first approval, else the next daily
 * run once the cleared balance reaches the minimum, or the run after the pending commission that
 * brings it there clears.
 */
export function computeRetailerPayPalPayout(input: RetailerPayPalPayoutInput): RetailerPayPalPayoutEstimate {
  const unclaimed = Math.max(0, Math.round(Number(input.unclaimed?.amountCents) || 0));
  if (unclaimed > 0) return { kind: 'unclaimed', amountCents: unclaimed, email: input.unclaimed?.email ?? null };
  const sending = Math.max(0, Math.round(Number(input.sendingCents) || 0));
  if (sending > 0) return { kind: 'sending', amountCents: sending };
  return computeAffiliateNextPayout({
    now: input.now,
    autoPayoutsEnabled: input.autoPayoutsEnabled,
    minPayoutCents: input.minPayoutCents,
    clearedCents: input.clearedCents,
    pending: input.pending,
    lastRunDate: input.lastRunDate,
    // The payout email is a PayPal account PayPal can take (the caller only asks then).
    payoutsReady: true,
    eligible: input.eligible,
  });
}

export interface RetailerManualPayoutInput {
  now: Date;
  /** Minimum payout, minor units of the payout currency. */
  minPayoutCents: number;
  /** CLEARED, unattached commissions of the gateways paid by hand, net of refunds. */
  clearedCents: number;
  /** Their PENDING_CLEARANCE commissions (net amounts). */
  pending: ReadonlyArray<{ amountCents: number; clearsAt: string | null }>;
  /** ACTIVE and approved: `claim_manual_affiliate_payout` refuses anyone else. */
  eligible: boolean;
  /** The partner saved a payout email (where the operator sends the money). */
  hasPayoutEmail: boolean;
  /**
   * What the store's prepared manual payouts to this partner add up to (02036: PROCESSING, its
   * commissions reserved, not recorded as sent yet). Omitted or 0: none.
   */
  sendingCents?: number;
}

/** What the partner can expect of the payouts the operator sends by hand. */
export type RetailerManualPayoutEstimate =
  /** The store prepared a payout of this amount and is sending it. */
  | { kind: 'sending'; amountCents: number }
  | { kind: 'not_eligible' }
  | { kind: 'email_required' }
  /** The cleared balance reached the minimum: the operator sends it. */
  | { kind: 'ready' }
  /** Pending commissions bring the cleared balance to the minimum once they clear. */
  | { kind: 'clearing' }
  | { kind: 'below_minimum'; remainingCents: number }
  | { kind: 'no_balance' };

/**
 * The payouts the operator sends by hand (02036). No date and no Stripe: the operator decides when
 * to send them (the CMS "Pay manually" list says who reaches the minimum, and its PayPal file holds
 * only the payouts it prepared). A payout the store prepared comes first: it is being sent. Else not
 * eligible before the first approval or while suspended; then a payout email is needed; then ready
 * once the cleared balance reaches the minimum, clearing while pending commissions will bring it
 * there, else what is missing (pending commissions counted) or nothing.
 */
export function computeRetailerManualPayout(input: RetailerManualPayoutInput): RetailerManualPayoutEstimate {
  const sending = Math.max(0, Math.round(Number(input.sendingCents) || 0));
  if (sending > 0) return { kind: 'sending', amountCents: sending };
  if (!input.eligible) return { kind: 'not_eligible' };
  if (!input.hasPayoutEmail) return { kind: 'email_required' };
  const minimum = Math.max(1, Math.round(Number(input.minPayoutCents) || 0));
  const cleared = Math.max(0, Math.round(Number(input.clearedCents) || 0));
  if (cleared >= minimum) return { kind: 'ready' };
  // The automated estimate's arithmetic, with nothing else to wait for.
  const estimate = computeAffiliateNextPayout({
    now: input.now,
    autoPayoutsEnabled: true,
    minPayoutCents: minimum,
    clearedCents: cleared,
    pending: input.pending,
    lastRunDate: null,
    payoutsReady: true,
    eligible: true,
  });
  if (estimate.kind === 'scheduled') return { kind: 'clearing' };
  if (estimate.kind === 'below_minimum') return estimate;
  return { kind: 'no_balance' };
}

export interface RetailerPayoutsData {
  account: RetailerPortalAccount;
  tier: AffiliateTierRow | null;
  settings: AffiliatesSettings;
  balances: AffiliateBalances;
  baseCurrency: string;
  commissions: { rows: AffiliateCommissionRow[]; count: number };
  payouts: { rows: AffiliatePayoutRow[]; count: number };
  failedPayouts: RetailerFailedPayouts;
  /**
   * The next Stripe transfer, from the commissions of the gateways paid through Stripe only; null
   * while every gateway is paid by hand (`payoutMode` `manual`).
   */
  nextPayout: AffiliateNextPayoutEstimate | null;
  connect: RetailerConnectState;
  isSandbox: boolean;
  ledgerError: boolean;
  /** How the program pays this partner's commissions (02036). */
  payoutMode: RetailerPayoutMode;
  /** The method of each gateway (normalized settings). */
  payoutMethods: AffiliatesPayoutMethods;
  /** Where the operator sends the manual payouts (PayPal or Interac e-Transfer), or null. */
  payoutEmail: string | null;
  /** What the payout email is for (02037, `payout_email_kind`): a PayPal account (the default) or Interac e-Transfer. */
  payoutEmailKind: AffiliatePayoutEmailKind;
  /** The gateways the program pays with PayPal Payouts (02037; empty when none). */
  paypalGateways: AffiliateGateway[];
  /**
   * The partner's payout email when PayPal returned the last payout sent to it (02037): the PayPal run
   * does not send there again until the email changes, so the store pays them by hand meanwhile.
   */
  paypalReturnedTo: string | null;
  /** Which ways this partner's commissions go (see {@link RetailerPayoutRoutes}). */
  payoutRoutes: RetailerPayoutRoutes;
  /**
   * CLEARED, unattached commissions in the base currency (net of refunds), by how they are paid:
   * through Stripe, by PayPal automatically (02037) or by the store by hand.
   */
  clearedByMethod: { stripeCents: number; paypalCents: number; manualCents: number };
  /**
   * The payouts the operator sends by hand; null while no commission of this partner is paid by hand
   * and none is prepared.
   */
  manualPayout: RetailerManualPayoutEstimate | null;
  /**
   * What the store's prepared manual payouts to this partner add up to in the base currency (02036:
   * commissions reserved, the money being sent, not recorded yet); part of `processingCents`. PayPal
   * payouts in flight are `paypalSendingCents`.
   */
  manualSendingCents: number;
  /** The automatic PayPal payouts (02037); null while PayPal pays this partner nothing and holds no payout of theirs. */
  paypalPayout: RetailerPayPalPayoutEstimate | null;
  /** PayPal payouts in flight in the base currency (02037: PROCESSING, PayPal has not paid the item); part of `processingCents`. */
  paypalSendingCents: number;
  /** Of those, the one PayPal holds for the partner to claim (UNCLAIMED), and the address PayPal emailed. */
  paypalUnclaimed: { amountCents: number; email: string | null } | null;
  /**
   * How each listed commission is (or was) paid, by commission id, for the commissions table: only
   * while this partner's commissions go more than one way (two of `payoutRoutes`; empty otherwise).
   * A voided commission has no entry, nor does one whose payout could not be read.
   */
  commissionPayoutMethods: Record<string, AffiliatePayoutMethod>;
}

export const PORTAL_COMMISSIONS_PAGE_SIZE = 50;
export const PORTAL_PAYOUTS_PAGE_SIZE = 25;
/** Failed payouts read for the balance card and the history notes (a partner normally has one). */
const PORTAL_FAILED_PAYOUTS_LIMIT = 100;

function noFailedPayouts(): RetailerFailedPayouts {
  return { autoRetryCents: 0, awaitingReviewCents: 0, autoRetryPayoutIds: [] };
}

/**
 * What the "Cleared, awaiting payout" card says under its amount (cleared plus attached to a
 * payout). A failed transfer comes first, worded by whether the daily cycle retries it by itself;
 * money in a transfer that has not failed is on its way; otherwise the card names the minimum.
 */
export type RetailerClearedBalanceHint =
  | { kind: 'failed_auto_retry'; amountCents: number }
  | { kind: 'failed_awaiting_review'; amountCents: number }
  | { kind: 'on_its_way'; amountCents: number }
  /** A manual payout the store prepared (02036) is being sent: not through Stripe, not to a bank by us. */
  | { kind: 'on_its_way_manual'; amountCents: number }
  /** A PayPal payout PayPal has not paid yet (02037): on its way to the partner's PayPal account. */
  | { kind: 'on_its_way_paypal'; amountCents: number }
  /** A PayPal payout PayPal holds for the partner to claim (02037: the item is UNCLAIMED). */
  | { kind: 'waiting_claim_paypal'; amountCents: number }
  | { kind: 'minimum' };

/**
 * `manualSendingCents`: the part of `processingCents` held by the store's prepared manual payouts
 * (02036); `paypal`: the part held by PayPal payouts in flight (02037), and of it the part PayPal
 * holds for the partner to claim. The rest is a Stripe transfer on its way to the partner's bank,
 * which comes first; then a PayPal payout waiting to be claimed, one on its way, a manual one.
 */
export function retailerClearedBalanceHint(
  processingCents: number,
  failed: RetailerFailedPayouts,
  manualSendingCents = 0,
  paypal: { sendingCents?: number; unclaimedCents?: number } = {},
): RetailerClearedBalanceHint {
  const awaitingReview = Math.max(0, Math.round(Number(failed.awaitingReviewCents) || 0));
  const failedTotal = Math.max(0, Math.round(Number(failed.autoRetryCents) || 0)) + awaitingReview;
  if (failedTotal > 0) {
    return awaitingReview > 0
      ? { kind: 'failed_awaiting_review', amountCents: failedTotal }
      : { kind: 'failed_auto_retry', amountCents: failedTotal };
  }
  const inFlight = Math.max(0, Math.round(Number(processingCents) || 0));
  const manual = Math.min(inFlight, Math.max(0, Math.round(Number(manualSendingCents) || 0)));
  const paypalSending = Math.min(inFlight - manual, Math.max(0, Math.round(Number(paypal.sendingCents) || 0)));
  const paypalUnclaimed = Math.min(paypalSending, Math.max(0, Math.round(Number(paypal.unclaimedCents) || 0)));
  const stripe = inFlight - manual - paypalSending;
  if (stripe > 0) return { kind: 'on_its_way', amountCents: stripe };
  if (paypalUnclaimed > 0) return { kind: 'waiting_claim_paypal', amountCents: paypalUnclaimed };
  if (paypalSending > 0) return { kind: 'on_its_way_paypal', amountCents: paypalSending };
  return manual > 0 ? { kind: 'on_its_way_manual', amountCents: manual } : { kind: 'minimum' };
}

/** The partner's payouts on their way outside Stripe in one currency (see {@link readOutsideStripeInFlight}). */
interface RetailerOutsideStripeInFlight {
  /** Prepared manual payouts (02036: PROCESSING, not recorded yet). */
  manualCents: number;
  /** PayPal payouts PayPal has not settled (02037: PROCESSING). */
  paypalCents: number;
  /** Of those, the ones PayPal holds for the partner to claim (UNCLAIMED), and the address PayPal emailed. */
  unclaimed: { amountCents: number; email: string | null } | null;
}

/**
 * What the partner's payouts on their way outside Stripe add up to in `currency`: prepared manual
 * payouts (02036) and PayPal payouts PayPal has not settled (02037), the ones waiting to be claimed
 * apart (their `paypal_receiver` is where PayPal sent its claim email: the partner's own address).
 */
async function readOutsideStripeInFlight(client: AnyClient, affiliateId: string, currency: string): Promise<RetailerOutsideStripeInFlight> {
  const { data, error } = await client
    .from('affiliate_payouts')
    .select('amount_cents, method, paypal_item_status, paypal_receiver')
    .eq('affiliate_id', affiliateId)
    .in('method', ['manual', 'paypal'])
    .eq('status', 'PROCESSING')
    .eq('currency', currency)
    .limit(100);
  if (error) throw new Error('affiliate_manual_payouts_read_failed');
  const result: RetailerOutsideStripeInFlight = { manualCents: 0, paypalCents: 0, unclaimed: null };
  for (const row of Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []) {
    const amount = Math.trunc(Number(row['amount_cents']));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (row['method'] !== 'paypal') {
      result.manualCents += amount;
      continue;
    }
    result.paypalCents += amount;
    if (row['paypal_item_status'] === 'UNCLAIMED') {
      const receiver = typeof row['paypal_receiver'] === 'string' && row['paypal_receiver'].trim() ? row['paypal_receiver'].trim() : null;
      result.unclaimed = { amountCents: (result.unclaimed?.amountCents ?? 0) + amount, email: result.unclaimed?.email ?? receiver };
    }
  }
  return result;
}

/** The partner's failed payouts and the cleared commissions they hold, in `currency`. */
async function readFailedPayouts(
  client: AnyClient,
  affiliateId: string,
  currency: string,
  context: AffiliatePayoutAutoRetryContext,
): Promise<RetailerFailedPayouts> {
  const failed = await listAffiliatePayouts(client, { affiliateId, status: 'FAILED', limit: PORTAL_FAILED_PAYOUTS_LIMIT });
  if (failed.rows.length === 0) return noFailedPayouts();

  const autoRetry = new Set(failed.rows.filter((row) => isAffiliatePayoutAutoRetryable(row, context)).map((row) => row.id));
  const { data, error } = await client
    .from('affiliate_commissions')
    .select('payout_id, commission_amount_cents, refunded_amount_cents')
    .eq('affiliate_id', affiliateId)
    .eq('status', 'CLEARED')
    .eq('currency', currency)
    .in('payout_id', failed.rows.map((row) => row.id))
    .limit(1000);
  if (error) throw new Error('affiliate_failed_payouts_read_failed');

  const result = noFailedPayouts();
  for (const row of Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []) {
    const net = affiliateCommissionNetMinor({
      commission_amount_cents: Number(row['commission_amount_cents']) || 0,
      refunded_amount_cents: Number(row['refunded_amount_cents']) || 0,
    });
    if (autoRetry.has(String(row['payout_id']))) result.autoRetryCents += net;
    else result.awaitingReviewCents += net;
  }
  result.autoRetryPayoutIds = [...autoRetry];
  return result;
}

/** A commission not paid yet, as the next-payout estimates read it. */
interface RetailerOpenCommission {
  status: 'PENDING_CLEARANCE' | 'CLEARED';
  gateway: AffiliateGateway;
  /** Net of refunds, minor units. */
  amountCents: number;
  clearsAt: string | null;
  /** Attached to a payout (a Stripe transfer running or failed): not part of the cleared balance. */
  attached: boolean;
}

const OPEN_COMMISSIONS_PAGE_SIZE = 1000;
/** Hard stop for the paging loop (20k open commissions). */
const OPEN_COMMISSIONS_MAX_PAGES = 20;

/**
 * The partner's PENDING_CLEARANCE and CLEARED commissions in `currency`, with their gateway (the
 * estimates split them by how each gateway is paid), paged by id past PostgREST's 1000-row cap.
 */
async function readOpenCommissions(client: AnyClient, affiliateId: string, currency: string): Promise<RetailerOpenCommission[]> {
  const rows: RetailerOpenCommission[] = [];
  for (let page = 0; page < OPEN_COMMISSIONS_MAX_PAGES; page += 1) {
    const from = page * OPEN_COMMISSIONS_PAGE_SIZE;
    const { data, error } = await client
      .from('affiliate_commissions')
      .select('id, status, gateway, commission_amount_cents, refunded_amount_cents, clears_at, payout_id')
      .eq('affiliate_id', affiliateId)
      .eq('currency', currency)
      .in('status', ['PENDING_CLEARANCE', 'CLEARED'])
      .order('id', { ascending: true })
      .range(from, from + OPEN_COMMISSIONS_PAGE_SIZE - 1);
    if (error) throw new Error('affiliate_open_commissions_read_failed');
    const batch = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    for (const row of batch) {
      const rawStatus = row['status'];
      const status: RetailerOpenCommission['status'] | null =
        rawStatus === 'CLEARED' ? 'CLEARED' : rawStatus === 'PENDING_CLEARANCE' ? 'PENDING_CLEARANCE' : null;
      if (!status) continue;
      rows.push({
        status,
        gateway: row['gateway'] === 'FREEMIUS' ? 'FREEMIUS' : 'STRIPE',
        amountCents: affiliateCommissionNetMinor({
          commission_amount_cents: Number(row['commission_amount_cents']) || 0,
          refunded_amount_cents: Number(row['refunded_amount_cents']) || 0,
        }),
        clearsAt: typeof row['clears_at'] === 'string' ? row['clears_at'] : null,
        attached: typeof row['payout_id'] === 'string' && row['payout_id'] !== '',
      });
    }
    if (batch.length < OPEN_COMMISSIONS_PAGE_SIZE) break;
  }
  return rows;
}

interface RetailerRoutedOpenBalance {
  clearedCents: number;
  pending: Array<{ amountCents: number; clearsAt: string | null }>;
}

/**
 * The open commissions split by how their gateway is paid for this partner: through Stripe, by PayPal
 * automatically (`paypalGateways`: empty while PayPal cannot pay this partner, 02037), or by hand.
 */
function routeOpenCommissions(
  open: readonly RetailerOpenCommission[],
  stripeGateways: readonly AffiliateGateway[],
  paypalGateways: readonly AffiliateGateway[] = [],
): { stripe: RetailerRoutedOpenBalance; paypal: RetailerRoutedOpenBalance; manual: RetailerRoutedOpenBalance } {
  const stripe: RetailerRoutedOpenBalance = { clearedCents: 0, pending: [] };
  const paypal: RetailerRoutedOpenBalance = { clearedCents: 0, pending: [] };
  const manual: RetailerRoutedOpenBalance = { clearedCents: 0, pending: [] };
  for (const row of open) {
    const target = stripeGateways.includes(row.gateway) ? stripe : paypalGateways.includes(row.gateway) ? paypal : manual;
    if (row.status === 'PENDING_CLEARANCE') target.pending.push({ amountCents: row.amountCents, clearsAt: row.clearsAt });
    else if (!row.attached) target.clearedCents += row.amountCents;
  }
  return { stripe, paypal, manual };
}

/**
 * How each listed commission is (or was) paid, for the commissions table while this partner's
 * commissions go more than one way: one attached to a payout by that payout's method (a manual payout
 * holds CLEARED commissions while it is prepared and PAID ones once recorded; a Stripe one holds
 * CLEARED commissions while it runs or after it failed; a PayPal one while PayPal has it, 02037), an
 * open one by its gateway's current method (a PayPal gateway reads `manual` for a partner PayPal
 * cannot pay automatically: `paypalAutomatic` false), a voided one not at all. Payouts not on the page
 * are read in one query; when that read fails their commissions get no entry (the table shows a dash)
 * rather than a guess.
 */
async function readCommissionPayoutMethods(
  client: AnyClient,
  affiliateId: string,
  commissions: readonly AffiliateCommissionRow[],
  payouts: readonly AffiliatePayoutRow[],
  methods: AffiliatesPayoutMethods,
  paypalAutomatic = true,
): Promise<Record<string, AffiliatePayoutMethod>> {
  const methodOf = (value: unknown): AffiliatePayoutMethod => (value === 'manual' ? 'manual' : value === 'paypal' ? 'paypal' : 'stripe_connect');
  const byPayout = new Map<string, AffiliatePayoutMethod>(payouts.map((row) => [row.id, methodOf(row.method)]));
  const missing = [
    ...new Set(commissions.map((row) => row.payout_id).filter((id): id is string => typeof id === 'string' && id !== '' && !byPayout.has(id))),
  ];
  if (missing.length > 0) {
    try {
      const { data, error } = await client.from('affiliate_payouts').select('id, method').eq('affiliate_id', affiliateId).in('id', missing);
      if (error) throw new Error('affiliate_payout_methods_read_failed');
      for (const row of Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []) {
        if (typeof row['id'] === 'string') byPayout.set(row['id'], methodOf(row['method']));
      }
    } catch (error) {
      console.warn('[affiliates] Portal payout methods read failed:', error instanceof Error ? error.message : String(error));
    }
  }

  const result: Record<string, AffiliatePayoutMethod> = {};
  for (const row of commissions) {
    if (row.status === 'VOIDED_REFUND') continue;
    const routed = affiliatePayoutMethodForGateway({ payoutMethods: methods }, row.gateway);
    const method = row.payout_id ? byPayout.get(row.payout_id) : routed === 'paypal' && !paypalAutomatic ? 'manual' : routed;
    if (method) result[row.id] = method;
  }
  return result;
}

/**
 * Whether the PayPal Payouts credentials of the active environment resolve (02037): without them the
 * daily run sends no PayPal payout, so the estimate reads "paused". Booleans only leave the credentials
 * module (no secret, no client id); false on the public sandbox and on any error.
 */
async function isPayPalPayoutsConfigured(): Promise<boolean> {
  try {
    const status = await getAffiliatePayPalCredentialStatus();
    return !status.sandbox && status.active.configured;
  } catch {
    return false;
  }
}

async function readLastPayoutRunDate(ctx: RetailerPortalContext): Promise<string | null> {
  const { data, error } = await anyClient(ctx.supabase)
    .from('affiliate_payout_runs')
    .select('run_date')
    .order('run_date', { ascending: false })
    .limit(1);
  if (error) return null;
  const row = Array.isArray(data) ? (data[0] as { run_date?: unknown } | undefined) : undefined;
  return typeof row?.run_date === 'string' ? row.run_date.slice(0, 10) : null;
}

export async function loadRetailerPayoutsData(
  ctx: RetailerPortalContext,
  account: RetailerPortalAccount,
  now: Date = new Date(),
): Promise<RetailerPayoutsData> {
  const { profile } = account;
  const [baseCurrency, settings, tier, connectConfigured] = await Promise.all([
    getPortalBaseCurrency(),
    getAffiliatesSettings(),
    readTier(ctx, profile.tier_id),
    isAffiliateConnectConfigured(),
  ]);
  const connect: RetailerConnectState = connectConfigured ? retailerConnectStateOf(profile) : 'unavailable';
  const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
  const eligible = profile.status === 'ACTIVE' && isApproved(profile);
  // 02036: each gateway's commissions go through Stripe Connect or are sent by hand; 02037: or with
  // PayPal Payouts, automatically to a partner whose payout email is a PayPal account.
  const payoutMethods = normalizeAffiliatePayoutMethods(settings.payoutMethods);
  const stripeGateways = affiliateGatewaysPaidByStripe({ payoutMethods });
  const paypalGateways = affiliateGatewaysPaidByPayPal({ payoutMethods });
  const payoutMode = retailerPayoutModeOf({ payoutMethods });
  const payoutEmail = typeof profile.payout_email === 'string' && profile.payout_email.trim() ? profile.payout_email.trim() : null;
  const payoutEmailKind = normalizeAffiliatePayoutEmailKind(profile.payout_email_kind);
  // The PayPal run's own rule (claim_paypal_affiliate_payout): a PayPal account PayPal can take as is.
  const paypalReceiver =
    paypalGateways.length > 0 && payoutEmail !== null && isAffiliatePayPalPayoutReceiver(payoutEmail, payoutEmailKind);
  const paypalConfigured = paypalGateways.length > 0 ? await isPayPalPayoutsConfigured() : false;
  // The conditions under which the daily cycle retries a failed payout by itself: payouts run (on,
  // Stripe configured, not the sandbox, which never transfers, and some gateway still paid through
  // Stripe: with none, the daily run is the ledger repair alone) and this partner can be paid.
  const retryContext: AffiliatePayoutAutoRetryContext = {
    automatedPayoutsRunning: settings.autoPayoutsEnabled && connect !== 'unavailable' && !isSandbox && stripeGateways.length > 0,
    partnerPayable: eligible && Boolean(profile.stripe_connect_account_id),
  };

  let balances = emptyBalances(baseCurrency);
  let commissions: RetailerPayoutsData['commissions'] = { rows: [], count: 0 };
  let payouts: RetailerPayoutsData['payouts'] = { rows: [], count: 0 };
  let failedPayouts = noFailedPayouts();
  let open: RetailerOpenCommission[] = [];
  let lastRunDate: string | null = null;
  let inFlight: RetailerOutsideStripeInFlight = { manualCents: 0, paypalCents: 0, unclaimed: null };
  let paypalReturned = new Set<string>();
  let commissionPayoutMethods: Record<string, AffiliatePayoutMethod> = {};
  let ledgerError = false;

  try {
    const client = anyClient(ctx.supabase);
    [balances, commissions, payouts, failedPayouts, open, lastRunDate, inFlight, paypalReturned] = await Promise.all([
      getAffiliateBalances(client, profile.id, { baseCurrency }),
      listAffiliateCommissions(client, { affiliateId: profile.id, limit: PORTAL_COMMISSIONS_PAGE_SIZE }),
      listAffiliatePayouts(client, { affiliateId: profile.id, limit: PORTAL_PAYOUTS_PAGE_SIZE }),
      readFailedPayouts(client, profile.id, baseCurrency, retryContext),
      readOpenCommissions(client, profile.id, baseCurrency),
      readLastPayoutRunDate(ctx),
      readOutsideStripeInFlight(client, profile.id, baseCurrency),
      // 02037: PayPal returned the last payout sent to this same address, and the partner has not saved
      // it again since (the run's and the CMS's rule).
      paypalReceiver && payoutEmail
        ? loadAffiliatePayPalBlockedReceivers(client, [
            { affiliateId: profile.id, email: payoutEmail, emailSavedAt: profile.payout_email_saved_at ?? null },
          ])
        : Promise.resolve(new Set<string>()),
    ]);
    const automatic = paypalReceiver && !paypalReturned.has(profile.id);
    if (countRetailerPayoutRoutes(retailerPayoutRoutesOf(stripeGateways, automatic ? paypalGateways : [])) > 1) {
      commissionPayoutMethods = await readCommissionPayoutMethods(client, profile.id, commissions.rows, payouts.rows, payoutMethods, automatic);
    }
  } catch (error) {
    ledgerError = true;
    console.warn('[affiliates] Portal payouts read failed:', error instanceof Error ? error.message : String(error));
  }

  // PayPal pays this partner automatically (02037), or the store pays the PayPal gateways' commissions
  // by hand (an Interac e-Transfer address, none, or one PayPal returned a payout from).
  const paypalAutomatic = paypalReceiver && !paypalReturned.has(profile.id);
  const paypalAutoGateways = paypalAutomatic ? paypalGateways : [];
  const payoutRoutes = retailerPayoutRoutesOf(stripeGateways, paypalAutoGateways);

  // Each estimate sees only the commissions its method pays: a Stripe transfer never carries the
  // commissions paid by hand (claim_affiliate_payout's p_gateways), a PayPal payout only those of the
  // PayPal gateways (claim_paypal_affiliate_payout's), and the reverse.
  const routed = routeOpenCommissions(open, stripeGateways, paypalAutoGateways);
  const nextPayout =
    payoutMode === 'manual'
      ? null
      : computeAffiliateNextPayout({
          now,
          // Without Stripe on the store nothing is sent: shown as paused, not as "connect your bank".
          autoPayoutsEnabled: settings.autoPayoutsEnabled && connect !== 'unavailable',
          minPayoutCents: settings.minPayoutCents,
          clearedCents: routed.stripe.clearedCents,
          pending: routed.stripe.pending,
          lastRunDate,
          payoutsReady: connect === 'ready',
          eligible,
        });
  // A manual payout prepared before a gateway went back to Stripe Connect (or PayPal) is still being sent.
  const manualPayout =
    !payoutRoutes.manual && inFlight.manualCents === 0
      ? null
      : computeRetailerManualPayout({
          now,
          minPayoutCents: settings.minPayoutCents,
          clearedCents: routed.manual.clearedCents,
          pending: routed.manual.pending,
          eligible,
          hasPayoutEmail: payoutEmail !== null,
          sendingCents: inFlight.manualCents,
        });
  // The address PayPal emailed its claim link to is the payout's own snapshot (the partner's email then).
  const paypalUnclaimed = inFlight.unclaimed
    ? { amountCents: inFlight.unclaimed.amountCents, email: inFlight.unclaimed.email ?? payoutEmail }
    : null;
  // A PayPal payout sent before the partner chose Interac e-Transfer (or before PayPal returned one) is
  // still with PayPal: it is shown until PayPal settles it.
  const paypalPayout =
    !payoutRoutes.paypal && inFlight.paypalCents === 0
      ? null
      : computeRetailerPayPalPayout({
          now,
          // The same daily run sends PayPal payouts while automatic payouts are on; nothing goes out
          // without PayPal credentials (shown as paused, like a store without Stripe).
          autoPayoutsEnabled: settings.autoPayoutsEnabled && paypalConfigured,
          minPayoutCents: settings.minPayoutCents,
          clearedCents: routed.paypal.clearedCents,
          pending: routed.paypal.pending,
          lastRunDate,
          eligible,
          sendingCents: inFlight.paypalCents,
          unclaimed: paypalUnclaimed,
        });

  return {
    account,
    tier,
    settings,
    balances,
    baseCurrency,
    commissions,
    payouts,
    failedPayouts,
    nextPayout,
    connect,
    isSandbox,
    ledgerError,
    payoutMode,
    payoutMethods,
    payoutEmail,
    payoutEmailKind,
    paypalGateways,
    paypalReturnedTo: paypalReceiver && !paypalAutomatic ? payoutEmail : null,
    payoutRoutes,
    clearedByMethod: {
      stripeCents: routed.stripe.clearedCents,
      paypalCents: routed.paypal.clearedCents,
      manualCents: routed.manual.clearedCents,
    },
    manualPayout,
    manualSendingCents: inFlight.manualCents,
    paypalPayout,
    paypalSendingCents: inFlight.paypalCents,
    paypalUnclaimed,
    commissionPayoutMethods,
  };
}
