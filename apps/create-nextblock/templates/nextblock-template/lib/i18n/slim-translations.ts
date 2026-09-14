/**
 * Trim the `translations` table for the browser.
 *
 * The root layout hands the UI strings to a client provider, so whatever it passes is
 * serialized into the RSC payload of every public page. The raw rows carry every
 * locale plus `created_at`/`updated_at`, which came to ~88 KB on the home page — the
 * single largest item in the payload, ahead of the page content itself. The client
 * only ever reads the active locale, falling back to `en` (see
 * `TranslationsProvider` in libs/utils), and a language switch goes through
 * `router.refresh()`, which re-runs the layout for the new locale. So ship just those.
 *
 * Two shapes exist:
 * - {@link slimTranslationsForLocale}: the provider's row shape, one object per key.
 * - {@link compactTranslationsForLocale}: the wire shape — plain `[key, value]` tuples.
 *   Rows cost ~30 bytes of JSON scaffolding each (`{"key":…,"translations":{"en":…}}`);
 *   for ~385 keys that is another ~12 KB inside the parser-blocking inline payload.
 *   {@link expandCompactTranslations} rebuilds the rows on the client.
 *
 * Dependency-free so the layout, the providers and their tests can import it without
 * pulling in Supabase types.
 */

export const TRANSLATION_FALLBACK_LOCALE = 'en';

export type ClientTranslationRow = {
  key: string;
  translations: Record<string, string>;
};

/** Wire shape passed from the root layout to the client providers. */
export type CompactTranslations = {
  /** Active locale; `entries` are its strings. */
  lang: string;
  /** Locale used when a key has no string in `lang` (always `en` today). */
  fallbackLang: string;
  /** `[key, value]` for every key that has a string in `lang`. */
  entries: [string, string][];
  /** `[key, value]` for keys that only exist in the fallback locale. */
  fallbackEntries: [string, string][];
};

type TranslationSourceRow = {
  key: string;
  /** jsonb column: `{ [locale]: string }` in practice, but typed loosely upstream. */
  translations: unknown;
};

function pickLocales(
  rows: readonly TranslationSourceRow[],
  locale: string,
  fallbackLocale: string,
): ClientTranslationRow[] {
  const wanted = locale === fallbackLocale ? [locale] : [locale, fallbackLocale];
  const result: ClientTranslationRow[] = [];

  for (const row of rows) {
    if (!row || typeof row.key !== 'string') continue;
    const source = row.translations;
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;

    const picked: Record<string, string> = {};
    for (const code of wanted) {
      const value = (source as Record<string, unknown>)[code];
      if (typeof value === 'string') picked[code] = value;
    }

    // A row with nothing for this locale or the fallback would only make the
    // provider return the key anyway — same result without the bytes.
    if (Object.keys(picked).length === 0) continue;
    result.push({ key: row.key, translations: picked });
  }

  return result;
}

export function slimTranslationsForLocale(
  rows: readonly TranslationSourceRow[],
  locale: string,
  fallbackLocale: string = TRANSLATION_FALLBACK_LOCALE,
): ClientTranslationRow[] {
  return pickLocales(rows, locale, fallbackLocale);
}

export function compactTranslationsForLocale(
  rows: readonly TranslationSourceRow[],
  locale: string,
  fallbackLocale: string = TRANSLATION_FALLBACK_LOCALE,
): CompactTranslations {
  const entries: [string, string][] = [];
  const fallbackEntries: [string, string][] = [];

  for (const row of pickLocales(rows, locale, fallbackLocale)) {
    const own = row.translations[locale];
    if (typeof own === 'string') {
      entries.push([row.key, own]);
      continue;
    }
    const fallback = row.translations[fallbackLocale];
    if (typeof fallback === 'string') fallbackEntries.push([row.key, fallback]);
  }

  return { lang: locale, fallbackLang: fallbackLocale, entries, fallbackEntries };
}

/** Inverse of {@link compactTranslationsForLocale}: the provider's row shape. */
export function expandCompactTranslations(compact: CompactTranslations): ClientTranslationRow[] {
  const rows: ClientTranslationRow[] = [];
  for (const [key, value] of compact.entries) {
    rows.push({ key, translations: { [compact.lang]: value } });
  }
  for (const [key, value] of compact.fallbackEntries) {
    rows.push({ key, translations: { [compact.fallbackLang]: value } });
  }
  return rows;
}

export function isCompactTranslations(value: unknown): value is CompactTranslations {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as CompactTranslations).entries) &&
    typeof (value as CompactTranslations).lang === 'string'
  );
}
