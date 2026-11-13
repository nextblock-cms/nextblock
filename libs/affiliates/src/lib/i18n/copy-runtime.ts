/**
 * The copy runtime shared by the server (`createAffiliatesCopy`) and the client hook
 * (`useAffiliatesCopy`). Pure: no React, no dictionary import (callers pass the dictionary of
 * their area), so a client island only ships the strings it uses.
 *
 * Resolution order for `t(key)`: operator override for the locale → the dictionary in the
 * locale's language (`fr` for any `fr*` locale) → an English override (for locales the
 * dictionary has no language for) → the English dictionary entry → the key itself.
 */
import type { AffiliateLocale } from '../core/types';
import type {
  AffiliatesCopyArea,
  AffiliatesCopyDictionary,
  AffiliatesCopyOptions,
  AffiliatesCopyOverrides,
  AffiliatesCopyTranslate,
  AffiliatesCopyValues,
} from './types';

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;
const EMPTY_OVERRIDES: AffiliatesCopyOverrides = Object.freeze({});

/** `fr` for any locale starting with `fr` (`fr`, `fr-CA`, `FR`), else `en`. */
export function resolveAffiliatesLocale(locale: unknown): AffiliateLocale {
  return typeof locale === 'string' && locale.trim().toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/**
 * Replace every `{name}` with `values.name` in one pass. Unknown placeholders stay as written
 * (a missing value shows up instead of vanishing); `null`/`undefined` render as ''. Values are
 * inserted literally: `$&` and nested `{other}` in a value are never expanded.
 */
export function interpolateAffiliatesCopy(template: string, values?: AffiliatesCopyValues | null): string {
  if (!values || typeof template !== 'string' || !template.includes('{')) {
    return typeof template === 'string' ? template : '';
  }

  return template.replace(PLACEHOLDER, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) return match;
    const value = values[name];
    return value === null || value === undefined ? '' : String(value);
  });
}

/** What {@link splitAffiliatesCopyAtPlaceholder} returns. */
export interface AffiliatesCopySplit {
  /** The text before the placeholder (the whole template when it is absent). */
  before: string;
  /** The text after it (`''` when it is absent). */
  after: string;
  /** Whether the template carried `{name}`. */
  found: boolean;
}

const PLACEHOLDER_NAME = /^[A-Za-z0-9_]+$/;

/**
 * Split a copy template (as `t(key)` returns it without values, placeholders intact) around its
 * first `{name}`, so a component can render an element there: the signup checkbox's terms link
 * (`"I accept the {terms}. …"`). Copy stays plain text and React builds the markup, so no string
 * is ever rendered as HTML. Pure. A template without the placeholder (an operator override that
 * dropped it) comes back whole in `before` with `found: false`, and the caller decides where the
 * element goes; a second `{name}` stays in `after` as written. A name that is not a valid
 * placeholder name is never found.
 */
export function splitAffiliatesCopyAtPlaceholder(template: string, name: string): AffiliatesCopySplit {
  const text = typeof template === 'string' ? template : '';
  if (typeof name !== 'string' || !PLACEHOLDER_NAME.test(name)) return { before: text, after: '', found: false };

  const token = `{${name}}`;
  const index = text.indexOf(token);
  if (index === -1) return { before: text, after: '', found: false };
  return { before: text.slice(0, index), after: text.slice(index + token.length), found: true };
}

function localeCandidates(locale: string | null | undefined): string[] {
  const normalized = typeof locale === 'string' ? locale.trim().toLowerCase() : '';
  if (!normalized) return [];
  const base = normalized.split(/[-_]/)[0] ?? '';
  return base && base !== normalized ? [normalized, base] : [normalized];
}

function overrideText(overrides: AffiliatesCopyOverrides, key: string, locales: readonly string[]): string | null {
  if (!Object.prototype.hasOwnProperty.call(overrides, key)) return null;
  const entry = overrides[key];
  if (!entry || typeof entry !== 'object') return null;

  for (const locale of locales) {
    const text = Object.prototype.hasOwnProperty.call(entry, locale) ? entry[locale] : undefined;
    if (typeof text === 'string' && text.trim()) return text;
  }

  return null;
}

/** The raw (uninterpolated) string for `key`, following the module's resolution order. */
export function resolveAffiliatesCopyText(options: AffiliatesCopyOptions & { key: string }): string {
  const { key } = options;
  const overrides = options.overrides ?? EMPTY_OVERRIDES;
  const locales = localeCandidates(options.locale);
  const language = resolveAffiliatesLocale(options.locale);
  const dictionary = options.dictionary as Readonly<Record<string, AffiliatesCopyDictionary[string] | undefined>>;
  const entry = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : undefined;

  const override = overrideText(overrides, key, locales);
  if (override !== null) return override;

  if (language === 'fr' && typeof entry?.fr === 'string' && entry.fr) return entry.fr;

  const englishOverride = locales.includes('en') ? null : overrideText(overrides, key, ['en']);
  if (englishOverride !== null) return englishOverride;

  if (typeof entry?.en === 'string' && entry.en) return entry.en;

  return key;
}

/**
 * French typography for a copy template: a no-break space (U+00A0, the Québec espace insécable,
 * which `Intl` fr-CA also writes in `50 %`) instead of the plain space before ":", "%" and "»"
 * and after "«", so a rate never wraps away from its "%". The dictionaries, the 02031 seed and
 * CMS edits keep a plain space (the seed generator refuses invisible characters);
 * {@link createAffiliatesCopy} applies this to the resolved French text before interpolation, so
 * an inserted value (a name, a reason, a tier name) is never rewritten. The partner emails use
 * the same rule.
 */
export function applyAffiliatesFrenchTypography(text: string): string {
  return text.replace(/ ([:%»])/g, '\u00a0$1').replace(/« /g, '«\u00a0');
}

/**
 * A `t(key, values?)` for one locale, dictionary and set of overrides. Pure; safe on the server.
 * French output gets {@link applyAffiliatesFrenchTypography}.
 */
export function createAffiliatesCopy(options: AffiliatesCopyOptions): AffiliatesCopyTranslate {
  const { locale, dictionary } = options;
  const overrides = options.overrides ?? EMPTY_OVERRIDES;
  const french = resolveAffiliatesLocale(locale) === 'fr';

  return (key, values) => {
    const text = resolveAffiliatesCopyText({ key, locale, dictionary, overrides });
    return interpolateAffiliatesCopy(french ? applyAffiliatesFrenchTypography(text) : text, values);
  };
}

/** A row of the `translations` table (or the cached reader's shape). */
export interface AffiliatesTranslationRow {
  key: string;
  translations: unknown;
}

export interface AffiliatesCopyOverridesFromRowsOptions {
  /** Keep only these areas' keys (default: every `affiliates.` key). */
  areas?: readonly AffiliatesCopyArea[];
  /** Keep only these locales' strings (default: all). Pass the request locale to keep the payload small. */
  locales?: readonly string[];
}

/**
 * Overrides for `AffiliatesCopyProvider` / `createAffiliatesCopy` from `translations` rows:
 * only `affiliates.*` keys (narrowed to `areas`), only non-empty string values (narrowed to
 * `locales`). Rows outside the prefix are ignored, so the full table can be passed in.
 */
export function affiliatesCopyOverridesFromRows(
  rows: readonly AffiliatesTranslationRow[] | null | undefined,
  options: AffiliatesCopyOverridesFromRowsOptions = {}
): AffiliatesCopyOverrides {
  const prefixes = options.areas?.length ? options.areas.map((area) => `affiliates.${area}.`) : ['affiliates.'];
  const locales = options.locales?.length
    ? new Set(options.locales.map((locale) => String(locale).trim().toLowerCase()).filter(Boolean))
    : null;
  const result: Record<string, Record<string, string>> = {};

  for (const row of rows ?? []) {
    if (!row || typeof row.key !== 'string' || !prefixes.some((prefix) => row.key.startsWith(prefix))) continue;

    const source = row.translations;
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;

    const texts: Record<string, string> = {};

    for (const [locale, text] of Object.entries(source as Record<string, unknown>)) {
      const code = locale.trim().toLowerCase();
      if (!code || (locales && !locales.has(code))) continue;
      if (typeof text === 'string' && text.trim()) texts[code] = text;
    }

    if (Object.keys(texts).length > 0) result[row.key] = texts;
  }

  return result;
}
