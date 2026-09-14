import { revalidateTag } from 'next/cache';

/**
 * Cache tags and lifetime for the public content reads (`getPageDataBySlug`,
 * `getPostDataBySlug`, the translated-slug lookups, the bot-protection site key).
 *
 * Every public route renders per request (the CSP nonce and the locale cookie make the
 * root layout dynamic), so before these reads were cached each request paid the full
 * Supabase round trips — measured at 0.5 s to 6 s of body time on the home page. The
 * reads are wrapped in `unstable_cache`, the same mechanism the root layout already
 * uses for navigation, translations and themes, with the same 60 s lifetime.
 *
 * Invalidation is two-fold:
 *
 * 1. `revalidatePath('/<slug>')`, which every CMS writer already calls, reaches these
 *    entries through Next's implicit route tags (the entry is stale once its route was
 *    revalidated after it was written). That is what keeps Cortex / MCP tool mutations
 *    honest too: they call `revalidatePath` on the public path they changed.
 * 2. `revalidatePublicContent()` below evicts every cached page (or post) read at once.
 *    The CMS writers call it as well, because one page is served from more than one
 *    path — any language variant of the homepage is also `/` — and a path-based call
 *    cannot know about aliases. It is cheap: the next request for each page refills it.
 *
 * Draft mode bypasses `unstable_cache` entirely (Next checks `isDraftMode`), so the
 * Live Draft preview always reads the live tables.
 *
 * Do NOT set `fetchCache = 'force-no-store'` on a public route segment: Next disables
 * `unstable_cache` under it, for the layout's reads as well as these.
 *
 * Lifetime: five minutes. Every CMS writer evicts explicitly (see above), so the TTL
 * only bounds staleness for edits made directly in the database. A short TTL was
 * costing more than it bought: on Vercel a cold entry means a sequential Supabase
 * round trip during the request, and Lighthouse happened to measure exactly such a
 * refill (633 ms body delay against a ~200 ms norm) — the remaining LCP points.
 */
export const PUBLIC_CONTENT_REVALIDATE_SECONDS = 300;

export const PUBLIC_PAGES_CACHE_TAG = 'public-pages';
export const PUBLIC_POSTS_CACHE_TAG = 'public-posts';

export type PublicContentKind = 'pages' | 'posts';

const TAG_BY_KIND: Record<PublicContentKind, string> = {
  pages: PUBLIC_PAGES_CACHE_TAG,
  posts: PUBLIC_POSTS_CACHE_TAG,
};

/**
 * Evict the cached public reads for one content kind. Call it from any server action
 * or route handler that changes what a published page or post looks like: publish,
 * unpublish, restore a revision, import, delete, rename a slug.
 */
export function revalidatePublicContent(kind: PublicContentKind): void {
  try {
    revalidateTag(TAG_BY_KIND[kind], 'max');
  } catch (error) {
    // Never let cache housekeeping fail the write that triggered it; the entry
    // expires on its own within PUBLIC_CONTENT_REVALIDATE_SECONDS anyway.
    console.warn(`[public-content-cache] Failed to revalidate ${kind}.`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
