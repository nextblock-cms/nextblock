'use client';

import { useMemo } from 'react';
import { useOptionalTranslations } from '@nextblock-cms/utils';

import type { AffiliateLocale } from '../core/types';
import { useAffiliatesCopyContext } from './affiliates-copy-provider';
import { createAffiliatesCopy, resolveAffiliatesLocale } from './copy-runtime';
import type { AffiliatesCopyApi, AffiliatesCopyDictionary, AffiliatesCopyOverrides } from './types';

const EMPTY_OVERRIDES: AffiliatesCopyOverrides = Object.freeze({});

/**
 * The raw locale in effect: the nearest `AffiliatesCopyProvider`, else the site's
 * `TranslationsProvider` language, else `en`.
 */
function useRawAffiliatesLocale(): { locale: string; overrides: AffiliatesCopyOverrides } {
  const context = useAffiliatesCopyContext();
  const translations = useOptionalTranslations();

  return {
    locale: context?.locale ?? (typeof translations?.lang === 'string' && translations.lang ? translations.lang : 'en'),
    overrides: context?.overrides ?? EMPTY_OVERRIDES,
  };
}

/**
 * `t(key, values?)` for one area's dictionary (pass a module-level constant such as
 * `AFFILIATES_PORTAL_COPY`, or a merge of a few, so `t` keeps its identity across renders).
 * Overrides from the nearest `AffiliatesCopyProvider` win; the global translations payload is
 * never read for `affiliates.*` keys (the root layout filters them out).
 */
export function useAffiliatesCopy(dictionary: Readonly<AffiliatesCopyDictionary>): AffiliatesCopyApi {
  const { locale, overrides } = useRawAffiliatesLocale();

  return useMemo(
    () => ({ t: createAffiliatesCopy({ locale, dictionary, overrides }), locale: resolveAffiliatesLocale(locale) }),
    [locale, dictionary, overrides]
  );
}

/** The dictionary language in effect (`fr` | `en`), for money and date formatting. */
export function useAffiliatesLocale(): AffiliateLocale {
  return resolveAffiliatesLocale(useRawAffiliatesLocale().locale);
}
