/**
 * Pure path rules of the language switcher (components/LanguageSwitcher.tsx).
 *
 * CMS documents live at exactly three shapes: a page at `/<slug>`, a post at `/article/<slug>` and a
 * product at `/product/<slug>`. Only those paths may be looked up as a document slug when the page
 * did not register itself in CurrentContentContext. Every other path (a partner storefront at
 * `/partners/<handle>`, the partner portal, checkout, a customer order...) is a code route: the
 * switcher refreshes it in place, so a storefront handle that happens to equal a page slug (`home`,
 * `contact`) never sends the visitor to that page's translation.
 */

export type LanguageSwitcherContentType = 'pages' | 'posts' | 'products';

export interface LanguageSwitcherContentLookup {
  slug: string;
  type: LanguageSwitcherContentType;
}

/** The CMS document a path addresses, or null for any other route (refresh in place). */
export function contentLookupForPath(pathname: unknown): LanguageSwitcherContentLookup | null {
  if (typeof pathname !== 'string') return null;
  const segments = pathname.split('?')[0].split('#')[0].split('/').filter(Boolean);
  if (segments.length === 1) return { slug: segments[0], type: 'pages' };
  if (segments.length === 2 && segments[0] === 'product') return { slug: segments[1], type: 'products' };
  if (segments.length === 2 && segments[0] === 'article') return { slug: segments[1], type: 'posts' };
  return null;
}

/**
 * Where to go from a page that declared its own address per language (CurrentContent.localePaths):
 * the exact language code, then its base language (`fr-CA` → `fr`), then `x-default`. Null when the
 * page declared none or nothing matches. Only a site-relative path is ever returned.
 */
export function resolveLocalePathTarget(
  localePaths: Readonly<Record<string, string | undefined>> | null | undefined,
  localeCode: unknown,
): string | null {
  if (!localePaths || typeof localeCode !== 'string') return null;
  const code = localeCode.trim().toLowerCase();
  const base = code.split(/[-_]/)[0] ?? '';
  for (const key of [code, base, 'x-default']) {
    const path = key ? localePaths[key] : undefined;
    if (typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')) return path;
  }
  return null;
}
