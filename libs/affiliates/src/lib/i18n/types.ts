import type { AffiliateLocale } from '../core/types';

/** One UI string in both public-site languages. CMS screens are English-only and do not use this. */
export interface AffiliatesCopyEntry {
  en: string;
  fr: string;
}

export type AffiliatesCopyDictionary = Record<string, AffiliatesCopyEntry>;

/** The copy areas; each owns `affiliates.<area>.*` keys in `i18n/copy/<area>.ts`. */
export type AffiliatesCopyArea =
  | 'common'
  | 'partners'
  | 'storefront'
  | 'portal'
  | 'editor'
  | 'copilot'
  | 'sandbox'
  | 'terms';

/**
 * Operator overrides from the `translations` table, keyed like its rows:
 * `{ "affiliates.portal.title": { "en": "…", "fr": "…" } }` (key → locale → text).
 */
export type AffiliatesCopyOverrides = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** `{name}` placeholder values. `null`/`undefined` render as an empty string. */
export type AffiliatesCopyValues = Readonly<Record<string, string | number | null | undefined>>;

/** `t(key, values?)`: the override for the locale, else the dictionary (fr | en), else the key. */
export type AffiliatesCopyTranslate = (key: string, values?: AffiliatesCopyValues) => string;

export interface AffiliatesCopyOptions {
  /** Any locale code (`en`, `fr`, `fr-CA`, `es`…). The dictionary has `fr` and `en`; overrides may have more. */
  locale: string | null | undefined;
  dictionary: Readonly<AffiliatesCopyDictionary>;
  overrides?: AffiliatesCopyOverrides | null;
}

/** What `useAffiliatesCopy()` returns. `locale` is the dictionary language in use. */
export interface AffiliatesCopyApi {
  t: AffiliatesCopyTranslate;
  locale: AffiliateLocale;
}
