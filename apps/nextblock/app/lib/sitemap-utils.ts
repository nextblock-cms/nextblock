import { getSsgSupabaseClient } from '@nextblock-cms/db/server';
import { AFFILIATE_PARTNERS_PATH } from '@nextblock-cms/affiliates';
import { buildPublishedAtOrFilter } from '@nextblock-cms/utils';
import { listPublishedAffiliateStorefronts } from '../../lib/affiliates/storefront-data';
import { getHomepageTranslationGroupId } from './homepage';

/**
 * A single, language-aware entry destined for the XML sitemap.
 *
 * Paths are kept site-root-relative (e.g. "/about", "/article/my-post"); the
 * `app/sitemap.ts` route prefixes the absolute origin so the base URL lives in
 * exactly one place.
 */
export interface SitemapEntry {
  /** Root-relative path for this row, e.g. "/about" or "/article/hello". */
  path: string;
  /** ISO-8601 timestamp mapped from the row's `updated_at`. */
  lastModified: string;
  /**
   * hreflang map of `languageCode -> root-relative path` covering every
   * published translation that shares this row's `translation_group_id`, plus
   * an `x-default` key pointing at the default-language version. Left
   * `undefined` for content that only exists in a single language.
   *
   * NextBlock's i18n model gives each language its own slug (there is no
   * `/en` `/fr` path prefix), so alternates are resolved by grouping sibling
   * rows on `translation_group_id` rather than by swapping a locale segment.
   */
  alternates?: Record<string, string>;
}

/**
 * Page slugs that are rendered by their own canonical route and must not be
 * re-advertised under the generic `/{slug}` catch-all:
 *  - `product-template` backs the product layout (app/product/[slug]); it is
 *    not a public page.
 *
 * The homepage and its translations are excluded separately, by translation
 * group (see `getHomepageTranslationGroupId`), because every language variation
 * of the homepage is served at "/" regardless of the slug it uses — listing it
 * under `/{slug}` would duplicate the canonical "/" entry.
 */
const EXCLUDED_PAGE_SLUGS = new Set(['product-template']);

type SupabaseLikeClient = ReturnType<typeof getSsgSupabaseClient>;

/** Minimal shape every content table exposes for sitemap purposes. */
interface ContentRow {
  slug: string | null;
  updated_at: string | null;
  created_at?: string | null;
  language_id: number | null;
  translation_group_id: string | null;
}

function toIsoDate(value: string | null | undefined): string {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date().toISOString();
}

/**
 * Loads the language set once so callers can resolve a row's `language_id` to
 * its BCP-47 `code` and identify the default language used for `x-default`.
 */
async function fetchLanguageMap(
  supabase: SupabaseLikeClient,
): Promise<{ codeById: Map<number, string>; defaultCode: string | null }> {
  const codeById = new Map<number, string>();
  let defaultCode: string | null = null;

  const { data, error } = await supabase
    .from('languages')
    .select('id, code, is_default');

  if (error) {
    console.error('Error fetching languages for sitemap alternates:', error);
    return { codeById, defaultCode };
  }

  for (const lang of data ?? []) {
    if (lang.code) {
      codeById.set(lang.id, lang.code);
      if (lang.is_default) {
        defaultCode = lang.code;
      }
    }
  }

  return { codeById, defaultCode };
}

/**
 * Turns raw content rows into language-aware sitemap entries. Rows that share a
 * `translation_group_id` are emitted as sibling URLs that cross-link to one
 * another via `alternates`.
 */
function rowsToEntries(
  rows: ContentRow[],
  pathForSlug: (slug: string) => string,
  codeById: Map<number, string>,
  defaultCode: string | null,
): SitemapEntry[] {
  // Bucket rows by their translation group so each URL can advertise its siblings.
  const groups = new Map<string, ContentRow[]>();
  for (const row of rows) {
    if (!row.slug) continue;
    const key = row.translation_group_id ?? `solo:${row.slug}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const entries: SitemapEntry[] = [];
  for (const group of groups.values()) {
    // languageCode -> path for every translated sibling in this group.
    const byCode: Record<string, string> = {};
    let defaultPath: string | undefined;
    for (const sibling of group) {
      if (!sibling.slug || sibling.language_id == null) continue;
      const code = codeById.get(sibling.language_id);
      if (!code) continue;
      const path = pathForSlug(sibling.slug);
      byCode[code] = path;
      if (code === defaultCode) {
        defaultPath = path;
      }
    }

    // hreflang is only meaningful when 2+ *distinct* URLs exist. NextBlock has no
    // locale path prefix, so two translations can share a slug (e.g. `/articles`
    // is the slug in both en and fr); that collapses to a single URL with nothing
    // to cross-link, so no alternates are emitted.
    const hasAlternates = new Set(Object.values(byCode)).size > 1;
    const alternates = hasAlternates
      ? { ...byCode, 'x-default': defaultPath ?? Object.values(byCode)[0] }
      : undefined;

    for (const row of group) {
      if (!row.slug) continue;
      entries.push({
        path: pathForSlug(row.slug),
        lastModified: toIsoDate(row.updated_at ?? row.created_at),
        alternates,
      });
    }
  }

  return entries;
}

/**
 * The page entries without the paths a code route answers instead (the partner program's
 * `/partners` and `/partenaires` while the Affiliates package is active): a CMS page with one of
 * those slugs is not served there, so it is not advertised either, and its translations stop
 * pointing at it. Alternates that collapse to a single URL are dropped; an `x-default` that pointed
 * at a removed path moves to the first remaining language. Pure; returns the same array when no
 * path is owned.
 */
export function excludeCodeRoutePaths(entries: SitemapEntry[], ownedPaths: Iterable<string>): SitemapEntry[] {
  const owned = new Set(ownedPaths);
  if (owned.size === 0) return entries;

  const kept: SitemapEntry[] = [];
  for (const entry of entries) {
    if (owned.has(entry.path)) continue;
    if (!entry.alternates) {
      kept.push(entry);
      continue;
    }

    const languages = Object.entries(entry.alternates).filter(
      ([code, path]) => code !== 'x-default' && !owned.has(path),
    );
    if (new Set(languages.map(([, path]) => path)).size < 2) {
      kept.push({ path: entry.path, lastModified: entry.lastModified });
      continue;
    }

    const xDefault = entry.alternates['x-default'];
    kept.push({
      ...entry,
      alternates: {
        ...Object.fromEntries(languages),
        'x-default': xDefault && !owned.has(xDefault) ? xDefault : languages[0][1],
      },
    });
  }
  return kept;
}

/**
 * Fetches all published pages from Supabase and formats them, with language
 * alternates, for the sitemap.
 */
export async function fetchAllPublishedPages(): Promise<SitemapEntry[]> {
  const supabase = getSsgSupabaseClient();
  try {
    const [{ data: pages, error }, languageMap, homepageGroupId] = await Promise.all([
      supabase
        .from('pages')
        .select('slug, updated_at, language_id, translation_group_id')
        .eq('status', 'published')
        .or(buildPublishedAtOrFilter()),
      fetchLanguageMap(supabase),
      getHomepageTranslationGroupId(supabase),
    ]);

    if (error) {
      console.error('Error fetching published pages:', error);
      return [];
    }

    const rows = (pages ?? []).filter(
      (page) =>
        page.slug &&
        !EXCLUDED_PAGE_SLUGS.has(page.slug) &&
        !(homepageGroupId && page.translation_group_id === homepageGroupId),
    );

    return rowsToEntries(
      rows,
      (slug) => `/${slug}`,
      languageMap.codeById,
      languageMap.defaultCode,
    );
  } catch (err) {
    console.error('An unexpected error occurred while fetching pages:', err);
    return [];
  }
}

/**
 * Fetches all published posts (respecting scheduled `published_at`) from
 * Supabase and formats them, with language alternates, for the sitemap.
 */
export async function fetchAllPublishedPosts(): Promise<SitemapEntry[]> {
  const supabase = getSsgSupabaseClient();
  try {
    const [{ data: posts, error }, languageMap] = await Promise.all([
      supabase
        .from('posts')
        .select('slug, updated_at, language_id, translation_group_id')
        .eq('status', 'published')
        .or(buildPublishedAtOrFilter()),
      fetchLanguageMap(supabase),
    ]);

    if (error) {
      console.error('Error fetching published posts:', error);
      return [];
    }

    return rowsToEntries(
      posts ?? [],
      (slug) => `/article/${slug}`,
      languageMap.codeById,
      languageMap.defaultCode,
    );
  } catch (err) {
    console.error('An unexpected error occurred while fetching posts:', err);
    return [];
  }
}

/**
 * Fetches all active storefront products from Supabase and formats them, with
 * language alternates, for the sitemap.
 */
export async function fetchAllActiveProducts(): Promise<SitemapEntry[]> {
  const supabase = getSsgSupabaseClient();
  try {
    const [{ data: products, error }, languageMap] = await Promise.all([
      supabase
        .from('products')
        .select('slug, updated_at, created_at, language_id, translation_group_id')
        .eq('status', 'active')
        .or(buildPublishedAtOrFilter()),
      fetchLanguageMap(supabase),
    ]);

    if (error) {
      console.error('Error fetching active products:', error);
      return [];
    }

    return rowsToEntries(
      products ?? [],
      (slug) => `/product/${slug}`,
      languageMap.codeById,
      languageMap.defaultCode,
    );
  } catch (err) {
    console.error('An unexpected error occurred while fetching products:', err);
    return [];
  }
}

/**
 * Every published partner storefront (`/partners/<handle>`, NextBlock Affiliates). One URL per
 * storefront: the page follows the visitor's language, so there are no alternates. `lastModified`
 * is the last approval (`list_affiliate_storefronts.updated_at`), never the partner profile's own
 * `updated_at`, so clicks and draft autosaves never move it. The caller gates on the package.
 */
export async function fetchAllPartnerStorefronts(): Promise<SitemapEntry[]> {
  try {
    const storefronts = await listPublishedAffiliateStorefronts();
    return storefronts.map((storefront) => ({
      path: `${AFFILIATE_PARTNERS_PATH}/${storefront.handle}`,
      lastModified: toIsoDate(storefront.updatedAt ?? storefront.publishedAt),
    }));
  } catch (err) {
    console.error('An unexpected error occurred while fetching partner storefronts:', err);
    return [];
  }
}
