import { describe, expect, it } from 'vitest';
import {
  activeThemeSlugs,
  buildThemeCss,
  darkSchemeSlugs,
  defaultThemeSlug,
  isValidThemeSlug,
  sanitizeExtraCss,
  themeColorFor,
  tripletToThemeColor,
  type SiteTheme,
} from './buildThemeCss';
import { isValidTokenValue } from './tokens';

function theme(overrides: Partial<SiteTheme> = {}): SiteTheme {
  return {
    id: 'id-1',
    slug: 'light',
    name: 'Light',
    description: null,
    icon: 'Sun',
    color_scheme: 'light',
    tokens: { background: '0 0% 100%', foreground: '222 47% 11%' },
    extra_css: null,
    is_system: true,
    is_default: true,
    is_active: true,
    sort_order: 10,
    ...overrides,
  };
}

describe('buildThemeCss', () => {
  it('emits the default theme on :root and every theme on :root.slug', () => {
    const css = buildThemeCss([theme(), theme({ id: 'id-2', slug: 'dark', color_scheme: 'dark', is_default: false })]);
    expect(css).toContain(':root {');
    expect(css).toContain(':root.light {');
    expect(css).toContain(':root.dark {');
    expect(css).toContain('--background: 0 0% 100%;');
  });

  it('sets color-scheme so native form controls follow the theme', () => {
    const css = buildThemeCss([theme({ slug: 'dark', color_scheme: 'dark' })]);
    expect(css).toContain('color-scheme: dark;');
  });

  it('skips inactive themes entirely', () => {
    const css = buildThemeCss([theme(), theme({ id: 'x', slug: 'retired', is_active: false, is_default: false })]);
    expect(css).not.toContain('retired');
  });

  it('returns empty string when there is nothing active', () => {
    expect(buildThemeCss([])).toBe('');
    expect(buildThemeCss([theme({ is_active: false })])).toBe('');
  });

  it('falls back to the first active theme when none is marked default', () => {
    const css = buildThemeCss([theme({ slug: 'aaa', is_default: false, tokens: { background: '1 2% 3%' } })]);
    expect(css).toContain(':root {\n  --background: 1 2% 3%;');
  });

  // --- Injection resistance -------------------------------------------------

  it('drops unknown token keys', () => {
    const css = buildThemeCss([theme({ tokens: { background: '0 0% 100%', 'evil-key': '0 0% 0%' } })]);
    expect(css).toContain('--background');
    expect(css).not.toContain('evil-key');
  });

  it('drops token values that try to close the declaration', () => {
    const css = buildThemeCss([
      theme({ tokens: { background: '0 0% 100%; } body { display: none' } }),
    ]);
    expect(css).not.toContain('display: none');
    expect(css).not.toContain('body {');
  });

  it('drops token values containing url() or markup', () => {
    for (const bad of ['url(https://evil.test/x)', '<script>', 'red', 'expression(alert(1))']) {
      const css = buildThemeCss([theme({ tokens: { background: bad } })]);
      expect(css).not.toContain(bad);
    }
  });

  it('rejects a slug that is not CSS-class safe', () => {
    expect(isValidThemeSlug('ok-slug')).toBe(true);
    expect(isValidThemeSlug('Bad Slug')).toBe(false);
    expect(isValidThemeSlug('a')).toBe(false);
    expect(isValidThemeSlug('-leading')).toBe(false);
    expect(isValidThemeSlug('trailing-')).toBe(false);
    expect(isValidThemeSlug('x{}')).toBe(false);
    const css = buildThemeCss([theme({ slug: 'evil { } body' })]);
    expect(css).toBe('');
  });
});

describe('sanitizeExtraCss', () => {
  it('strips markup so the <style> element cannot be closed', () => {
    expect(sanitizeExtraCss('& h1 { color: red }</style><script>alert(1)</script>')).not.toContain('<');
  });

  it('drops a stray closing brace that would escape the theme rule', () => {
    const out = sanitizeExtraCss('} body { display: none }');
    expect(out.startsWith('}')).toBe(false);
    // The `body` rule survives as a NESTED selector, which is inert, but it must
    // not have escaped to the top level.
    expect(out).toBe(' body { display: none }');
  });

  it('closes braces the author left open', () => {
    expect(sanitizeExtraCss('& h1 { color: red')).toBe('& h1 { color: red}');
  });

  it('passes through legitimate nested css untouched', () => {
    const css = '& h1 { text-shadow: 0 0 5px hsl(var(--primary)); }';
    expect(sanitizeExtraCss(css)).toBe(css);
  });

  it('is applied by buildThemeCss', () => {
    const css = buildThemeCss([theme({ extra_css: '& h1 { color: red }</style>' })]);
    expect(css).not.toContain('</style>');
    expect(css).toContain('& h1 { color: red }');
  });
});

describe('isValidTokenValue', () => {
  it('accepts hsl triplets for colours and lengths for radius', () => {
    expect(isValidTokenValue('background', '222 47% 11%')).toBe(true);
    expect(isValidTokenValue('background', '211.55, 50.26%, 37.84%')).toBe(true);
    expect(isValidTokenValue('radius', '0.75rem')).toBe(true);
    expect(isValidTokenValue('radius', '0px')).toBe(true);
    expect(isValidTokenValue('radius', '0')).toBe(true);
  });

  it('rejects the wrong shape for the token kind', () => {
    expect(isValidTokenValue('background', '#ffffff')).toBe(false);
    expect(isValidTokenValue('radius', '222 47% 11%')).toBe(false);
    expect(isValidTokenValue('unknown-token', '222 47% 11%')).toBe(false);
  });
});

describe('theme wiring helpers', () => {
  const themes = [
    theme({ id: '1', slug: 'light', sort_order: 10, is_default: true }),
    theme({ id: '2', slug: 'dark', color_scheme: 'dark', sort_order: 20, is_default: false }),
    theme({ id: '3', slug: 'vibrant', color_scheme: 'dark', sort_order: 30, is_default: false, is_system: false }),
  ];

  it('reports which slugs use a dark palette', () => {
    // Deliberately NOT a "slug + .dark class" map: next-themes applies its value
    // with a single classList.add(), and DOMTokenList.add throws
    // InvalidCharacterError on a string containing a space.
    expect(darkSchemeSlugs(themes)).toEqual(['dark', 'vibrant']);
  });

  it('orders slugs by sort_order', () => {
    expect(activeThemeSlugs(themes)).toEqual(['light', 'dark', 'vibrant']);
  });

  it('reports the default slug and falls back safely', () => {
    expect(defaultThemeSlug(themes)).toBe('light');
    expect(defaultThemeSlug([])).toBe('light');
    expect(defaultThemeSlug([theme({ slug: 'only', is_default: false })])).toBe('only');
  });
});

describe('theme-color', () => {
  it('uses the default theme background, in the comma form every meta parser accepts', () => {
    const themes = [
      theme({ id: 'id-2', slug: 'dark', color_scheme: 'dark', is_default: true, tokens: { background: '222 47% 4%' } }),
      theme({ is_default: false }),
    ];

    expect(themeColorFor(themes)).toBe('hsl(222, 47%, 4%)');
  });

  it('falls back to the first active theme, then to white', () => {
    expect(themeColorFor([theme({ is_default: false, tokens: { background: '10 20% 30%' } })])).toBe('hsl(10, 20%, 30%)');
    expect(themeColorFor([theme({ is_active: false })])).toBe('#ffffff');
    expect(themeColorFor([])).toBe('#ffffff');
  });

  it('never forwards a value that is not an HSL triplet', () => {
    expect(tripletToThemeColor('red; } body { display:none')).toBeNull();
    expect(tripletToThemeColor('')).toBeNull();
    expect(tripletToThemeColor(undefined)).toBeNull();
    expect(themeColorFor([theme({ tokens: { background: 'url(x)' } })])).toBe('#ffffff');
  });

  it('accepts the decimal and comma spellings the token validator allows', () => {
    expect(tripletToThemeColor(' 222.2 47.4% 11.2% ')).toBe('hsl(222.2, 47.4%, 11.2%)');
    expect(tripletToThemeColor('0, 0%, 100%')).toBe('hsl(0, 0%, 100%)');
  });
});
