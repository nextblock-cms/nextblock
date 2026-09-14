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
 * Dependency-free so the layout and its tests can import it without pulling in
 * Supabase types.
 */

export const TRANSLATION_FALLBACK_LOCALE = 'en';

export type ClientTranslationRow = {
  key: string;
  translations: Record<string, string>;
};

type TranslationSourceRow = {
  key: string;
  /** jsonb column: `{ [locale]: string }` in practice, but typed loosely upstream. */
  translations: unknown;
};

export function slimTranslationsForLocale(
  rows: readonly TranslationSourceRow[],
  locale: string,
  fallbackLocale: string = TRANSLATION_FALLBACK_LOCALE,
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
