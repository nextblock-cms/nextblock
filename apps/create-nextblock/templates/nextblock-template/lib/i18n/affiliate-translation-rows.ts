/**
 * Split the `translations` table between the site-wide UI strings and the Affiliates package.
 *
 * Migration 02031 seeds every affiliates string (`affiliates.<area>.<key>`, EN + FR) into the
 * same `translations` table the root layout reads. The root layout ships its rows to the
 * client `TranslationsProvider` on EVERY public page, so without a filter each page would
 * carry hundreds of partner-portal strings it never shows. The root layout drops them
 * ({@link excludeAffiliateTranslationRows}); the partner layouts load only their own areas as
 * overrides for the package's built-in dictionaries ({@link selectAffiliateTranslationOverrides}).
 *
 * Dependency-free (like ./slim-translations) so the layout, the server copy reader and the
 * tests can import it without Supabase or Next.
 */

/** Every key the Affiliates package owns starts with this. */
export const AFFILIATE_TRANSLATION_KEY_PREFIX = 'affiliates.';

/** `{ key → { locale → string } }`: the override map `createAffiliatesCopy()` takes. */
export type AffiliateTranslationOverrides = Record<string, Record<string, string>>;

type TranslationKeyRow = {
  key: string;
};

type TranslationSourceRow = {
  key: string;
  /** jsonb column: `{ [locale]: string }` in practice, but typed loosely upstream. */
  translations: unknown;
};

/** The built-in strings an override competes with (structurally `AffiliatesCopyDictionary`). */
export type AffiliateTranslationDictionary = Readonly<Record<string, Readonly<{ en?: string; fr?: string }>>>;

export interface SelectAffiliateTranslationOverridesOptions {
  /** Keep only these locales (for example the visitor's). Default: every locale on the row. */
  locales?: readonly string[];
  /** Keep only keys this predicate accepts (for example keys present in a dictionary). */
  includeKey?: (key: string) => boolean;
  /**
   * Drop overrides that repeat this dictionary's string for the same language (`en`, or `fr` for
   * any `fr…` locale). Migration 02031 seeds the dictionaries verbatim, so without this every
   * seeded row would travel to the browser as an override that changes nothing.
   */
  dictionary?: AffiliateTranslationDictionary;
}

function dictionaryText(
  dictionary: AffiliateTranslationDictionary | undefined,
  key: string,
  locale: string,
): string | undefined {
  if (!dictionary || !Object.prototype.hasOwnProperty.call(dictionary, key)) return undefined;
  const entry = dictionary[key];
  if (locale === 'en' || locale.startsWith('en-')) return entry?.en;
  if (locale === 'fr' || locale.startsWith('fr-')) return entry?.fr;
  return undefined;
}

export function isAffiliateTranslationKey(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith(AFFILIATE_TRANSLATION_KEY_PREFIX);
}

/**
 * The rows the root layout may ship to the browser: everything except the affiliates keys.
 * Rows without a string key are dropped too (they could never be looked up).
 */
export function excludeAffiliateTranslationRows<T extends TranslationKeyRow>(rows: readonly T[]): T[] {
  const kept: T[] = [];
  for (const row of rows) {
    if (!row || typeof row.key !== 'string') continue;
    if (isAffiliateTranslationKey(row.key)) continue;
    kept.push(row);
  }
  return kept;
}

/**
 * Normalize the prefixes a caller asked for. Only prefixes inside the affiliates namespace
 * are honoured: this helper must never become a way to pull arbitrary site strings into a
 * partner page's payload.
 */
function normalizePrefixes(prefixes: readonly string[]): string[] {
  const result: string[] = [];
  for (const raw of prefixes) {
    if (typeof raw !== 'string') continue;
    const prefix = raw.trim();
    if (!prefix.startsWith(AFFILIATE_TRANSLATION_KEY_PREFIX)) continue;
    if (!result.includes(prefix)) result.push(prefix);
  }
  return result;
}

/**
 * The override map for the given affiliates areas, from the raw `translations` rows.
 *
 * `prefixes` are key prefixes such as `affiliates.partners.` or `affiliates.common.`; a prefix
 * outside `affiliates.` is ignored, and an empty (or all-ignored) list selects nothing. Locale
 * codes are lowercased (the copy runtime looks them up lowercase). Values that are not non-empty
 * strings are skipped, so a blank cell in the CMS falls back to the package dictionary instead
 * of rendering an empty label.
 */
export function selectAffiliateTranslationOverrides(
  rows: readonly TranslationSourceRow[],
  prefixes: readonly string[],
  options: SelectAffiliateTranslationOverridesOptions = {},
): AffiliateTranslationOverrides {
  const wantedPrefixes = normalizePrefixes(prefixes);
  const overrides: AffiliateTranslationOverrides = {};
  if (wantedPrefixes.length === 0 || !Array.isArray(rows)) return overrides;

  const locales = options.locales
    ? new Set(options.locales.map((locale) => String(locale).trim().toLowerCase()).filter(Boolean))
    : null;

  for (const row of rows) {
    if (!row || typeof row.key !== 'string') continue;
    const key = row.key;
    if (!wantedPrefixes.some((prefix) => key.startsWith(prefix))) continue;
    if (options.includeKey && !options.includeKey(key)) continue;

    const source = row.translations;
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;

    const picked: Record<string, string> = {};
    for (const [rawLocale, value] of Object.entries(source as Record<string, unknown>)) {
      const locale = rawLocale.trim().toLowerCase();
      if (!locale || (locales && !locales.has(locale))) continue;
      if (typeof value !== 'string' || value.trim() === '') continue;
      if (dictionaryText(options.dictionary, key, locale) === value) continue;
      picked[locale] = value;
    }

    if (Object.keys(picked).length > 0) overrides[key] = picked;
  }

  return overrides;
}
