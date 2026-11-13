import 'server-only';

import {
  createAffiliatesCopy,
  type AffiliatesCopyDictionary,
  type AffiliatesCopyTranslate,
} from '@nextblock-cms/affiliates';
import { getRequestCachedAffiliateTranslations } from '../i18n/cached-translations';
import {
  AFFILIATE_TRANSLATION_KEY_PREFIX,
  selectAffiliateTranslationOverrides,
  type AffiliateTranslationOverrides,
} from '../i18n/affiliate-translation-rows';
import { getRequestLocale } from './request-locale';

/**
 * Server-side affiliates copy: the package's built-in EN/FR dictionaries, with the operator's
 * edits from the `translations` table on top (CMS → Extra translations; seeded by 02031).
 *
 * The rows come from the cross-request cached read of the `affiliates.*` keys
 * (`getCachedAffiliateTranslations` in `lib/i18n/cached-translations.ts`, paged, evicted by every
 * translation edit), narrowed to the affiliates areas a page renders. The root layout's own read
 * never fetches an `affiliates.*` row, so partner layouts mount `AffiliatesCopyProvider` with
 * {@link getAffiliateCopyOverrides} and server components translate with {@link getServerAffiliatesCopy}.
 */

export interface AffiliateCopyOverridesOptions {
  /** The site locale (`fr`, `fr-CA`, `es`…). */
  locale: string;
  /**
   * Key prefixes to load, e.g. `['affiliates.partners.', 'affiliates.common.']`. Only prefixes
   * inside `affiliates.` count. Default: the area prefixes of `dictionary`'s keys, or every
   * affiliates key when no dictionary is given.
   */
  prefixes?: readonly string[];
  /**
   * The dictionary the overrides apply to. When given, keys it does not contain and overrides
   * that merely repeat its strings are left out (smaller client payloads).
   */
  dictionary?: Readonly<AffiliatesCopyDictionary>;
}

export interface ServerAffiliatesCopyOptions {
  /** Site locale; default: the request's (`getRequestLocale()`). */
  locale?: string | null;
  /** The area dictionary (or `AFFILIATES_COPY` for everything). */
  dictionary: Readonly<AffiliatesCopyDictionary>;
  /** Override key prefixes; default: derived from the dictionary. */
  prefixes?: readonly string[];
}

const AREA_PREFIX_RE = /^(affiliates\.[a-z0-9_]+\.)/;

/** `affiliates.<area>.` for every area the dictionary's keys belong to. */
function prefixesOf(dictionary: Readonly<AffiliatesCopyDictionary> | undefined): string[] {
  if (!dictionary) return [AFFILIATE_TRANSLATION_KEY_PREFIX];
  const prefixes = new Set<string>();
  for (const key of Object.keys(dictionary)) {
    const match = AREA_PREFIX_RE.exec(key);
    if (match) prefixes.add(match[1]);
  }
  return [...prefixes];
}

/**
 * The locales an override can be read in for `locale`, mirroring the copy runtime: the locale
 * itself and its base language, plus English for a language the dictionaries do not carry
 * (the runtime falls back to an English override before the English dictionary).
 */
function overrideLocalesFor(locale: string): string[] {
  const normalized = locale.trim().toLowerCase() || 'en';
  const base = normalized.split(/[-_]/)[0] || normalized;
  const locales = new Set([normalized, base]);
  if (base !== 'en' && base !== 'fr') locales.add('en');
  return [...locales];
}

/**
 * Operator overrides for the given areas and locale, ready for `AffiliatesCopyProvider` or
 * `createAffiliatesCopy`. Never throws: an unreadable table means no overrides.
 */
export async function getAffiliateCopyOverrides(
  options: AffiliateCopyOverridesOptions,
): Promise<AffiliateTranslationOverrides> {
  try {
    const rows = await getRequestCachedAffiliateTranslations();
    const dictionary = options.dictionary;
    return selectAffiliateTranslationOverrides(rows, options.prefixes ?? prefixesOf(dictionary), {
      locales: overrideLocalesFor(typeof options.locale === 'string' ? options.locale : 'en'),
      ...(dictionary
        ? {
            includeKey: (key: string) => Object.prototype.hasOwnProperty.call(dictionary, key),
            dictionary,
          }
        : {}),
    });
  } catch {
    return {};
  }
}

/**
 * A `t(key, values?)` for server components, route handlers and metadata: operator override for
 * the locale → the dictionary (`fr` for any `fr…` locale, else `en`) → the key. Never throws.
 */
export async function getServerAffiliatesCopy(options: ServerAffiliatesCopyOptions): Promise<AffiliatesCopyTranslate> {
  let locale = typeof options.locale === 'string' && options.locale.trim() ? options.locale.trim() : null;
  if (!locale) {
    try {
      locale = await getRequestLocale();
    } catch {
      locale = 'en';
    }
  }

  const overrides = await getAffiliateCopyOverrides({
    locale,
    dictionary: options.dictionary,
    ...(options.prefixes ? { prefixes: options.prefixes } : {}),
  });

  return createAffiliatesCopy({ locale, dictionary: options.dictionary, overrides });
}
