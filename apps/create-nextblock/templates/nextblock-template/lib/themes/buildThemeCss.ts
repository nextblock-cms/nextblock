import { isThemeTokenKey, isValidTokenValue } from './tokens';

export interface SiteTheme {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string;
  color_scheme: 'light' | 'dark';
  tokens: Record<string, string>;
  extra_css: string | null;
  is_system: boolean;
  is_default: boolean;
  is_active: boolean;
  sort_order: number;
}

/** Matches the DB CHECK constraint on site_themes.slug. */
export const THEME_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;

export function isValidThemeSlug(slug: string): boolean {
  return THEME_SLUG_PATTERN.test(slug);
}

/**
 * Strip anything that could break out of the surrounding <style> element or
 * escape the theme's own nesting block. Author-supplied CSS is ADMIN-only, but
 * it is interpolated into `dangerouslySetInnerHTML`, so it is still untrusted.
 *
 * `<` is removed outright — no legitimate theme CSS needs it, and it is the only
 * way to write `</style>`. Unbalanced braces are dropped so a stray `}` cannot
 * close the theme rule and leak declarations into the global scope.
 */
export function sanitizeExtraCss(css: string): string {
  const withoutMarkup = css.replace(/[<>]/g, '');
  let depth = 0;
  let out = '';
  for (const char of withoutMarkup) {
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      if (depth === 0) continue; // Would close the theme rule — drop it.
      depth -= 1;
    }
    out += char;
  }
  // Close anything the author left open so the next rule is not swallowed.
  return out + '}'.repeat(depth);
}

function declarationsFor(theme: SiteTheme): string {
  const entries = Object.entries(theme.tokens ?? {})
    .filter(([key, value]) => isThemeTokenKey(key) && typeof value === 'string' && isValidTokenValue(key, value))
    .map(([key, value]) => `  --${key}: ${value.trim()};`);
  entries.push(`  color-scheme: ${theme.color_scheme === 'dark' ? 'dark' : 'light'};`);
  return entries.join('\n');
}

function ruleFor(selector: string, theme: SiteTheme): string {
  const body = declarationsFor(theme);
  const extra = theme.extra_css?.trim() ? `\n${sanitizeExtraCss(theme.extra_css.trim())}` : '';
  return `${selector} {\n${body}${extra}\n}`;
}

/**
 * Render every theme to CSS for injection into <head>.
 *
 * Emitted as `:root.<slug>` (specificity 0,2,0) rather than `.<slug>` (0,1,0) so
 * database themes always win over the fallback palette still shipped in
 * libs/ui/src/styles/theme.css for standalone consumers of @nextblock-cms/ui,
 * regardless of stylesheet order.
 *
 * The default theme is additionally emitted on bare `:root` so the very first
 * paint — before next-themes' blocking script adds the class — already uses the
 * right palette instead of flashing the library fallback.
 */
export function buildThemeCss(themes: SiteTheme[]): string {
  const active = themes.filter((theme) => theme.is_active && isValidThemeSlug(theme.slug));
  if (active.length === 0) return '';

  const blocks: string[] = [];
  const fallback = active.find((theme) => theme.is_default) ?? active[0];
  if (fallback) {
    blocks.push(ruleFor(':root', fallback));
  }
  for (const theme of active) {
    blocks.push(ruleFor(`:root.${theme.slug}`, theme));
  }
  return blocks.join('\n\n');
}

/**
 * Slugs whose palette is dark. Used for the CSS `color-scheme` declaration, and
 * exposed so the CMS can warn that a custom dark theme does not pick up
 * Tailwind's `dark:` utilities.
 *
 * NOTE — why there is no "also apply the .dark class" mapping here: next-themes
 * applies its value with a single `classList.add(value)`, and DOMTokenList.add
 * throws InvalidCharacterError on a string containing a space, so a `"vibrant
 * dark"` mapping crashes the switcher. Tailwind's dark variant is compiled to
 * `.dark`, and the set of dark themes is only known at runtime, so it cannot be
 * widened at build time either. Wiring `dark:` to a data attribute would need a
 * pre-hydration script mirroring next-themes' own; deliberately out of scope.
 * A custom dark theme therefore recolours every token but does not activate
 * `dark:` utilities — same as the shipped `.vibrant` theme has always behaved.
 */
export function darkSchemeSlugs(themes: SiteTheme[]): string[] {
  return themes
    .filter((theme) => theme.is_active && isValidThemeSlug(theme.slug) && theme.color_scheme === 'dark')
    .map((theme) => theme.slug);
}

/** Slugs offered to next-themes, in display order. */
export function activeThemeSlugs(themes: SiteTheme[]): string[] {
  return themes
    .filter((theme) => theme.is_active && isValidThemeSlug(theme.slug))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((theme) => theme.slug);
}

const FALLBACK_THEME_COLOR = '#ffffff';

/**
 * A stored HSL triplet (`"222 47% 11%"`) as a colour the `theme-color` meta tag accepts.
 * Emitted in the legacy comma form, which every browser's meta parser understands.
 */
export function tripletToThemeColor(triplet: string | null | undefined): string | null {
  if (typeof triplet !== 'string' || !isValidTokenValue('background', triplet)) return null;

  const [h, s, l] = triplet.match(/-?\d+(?:\.\d+)?/g) ?? [];

  return h !== undefined && s !== undefined && l !== undefined ? `hsl(${h}, ${s}%, ${l}%)` : null;
}

/**
 * `<meta name="theme-color">` for the first paint: the default theme's `--background`, so the
 * browser chrome (mobile address bar, installed-app title bar) matches the page. Falls back
 * to white, the background of the palette shipped in libs/ui/src/styles/theme.css.
 */
export function themeColorFor(themes: SiteTheme[]): string {
  const active = themes.filter((theme) => theme.is_active && isValidThemeSlug(theme.slug));
  const fallback = active.find((theme) => theme.is_default) ?? active[0];

  return tripletToThemeColor(fallback?.tokens?.background) ?? FALLBACK_THEME_COLOR;
}

export function defaultThemeSlug(themes: SiteTheme[]): string {
  const active = themes.filter((theme) => theme.is_active && isValidThemeSlug(theme.slug));
  return (active.find((theme) => theme.is_default) ?? active[0])?.slug ?? 'light';
}
