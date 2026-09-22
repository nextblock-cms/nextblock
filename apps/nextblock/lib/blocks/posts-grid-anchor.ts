/**
 * The HTML id a posts grid renders, so a button or link can jump to it with `#id`.
 *
 * Defaults to `latest`: the seeded /articles hero ("Explore Articles" / "Explorer les articles")
 * links to `/articles#latest` on every install, so the default fixes that content with no data
 * migration. Two grids on one page need their own `anchor`, or both render id="latest" and the
 * fragment lands on the first.
 */
export const DEFAULT_POSTS_GRID_ANCHOR = 'latest';

/**
 * Lowercase slug (safe as an id and a URL fragment, never needs escaping), at most 64 chars.
 * Empty is allowed and means the default. The Cortex fallback schema restates this regex
 * (libs/cortex/src/lib/block-content-schemas.ts); keep the two in sync.
 */
export const POSTS_GRID_ANCHOR_PATTERN = /^([a-z][a-z0-9-]{0,63})?$/;

/** The id to render: the block's `anchor` when it is a valid slug, the default otherwise. */
export function resolvePostsGridAnchor(anchor: unknown): string {
  const value = typeof anchor === 'string' ? anchor.trim() : '';
  return value && POSTS_GRID_ANCHOR_PATTERN.test(value) ? value : DEFAULT_POSTS_GRID_ANCHOR;
}

/**
 * Coerces what an editor types into a value the pattern accepts, keystroke by keystroke:
 * lowercase, accents stripped (`Été` → `ete`), anything else outside `a-z 0-9 -` becomes a
 * hyphen, leading digits and hyphens are dropped (an id fragment must start with a letter
 * here), and the result is capped at 64.
 */
export function sanitizePostsGridAnchorInput(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 64);
}
