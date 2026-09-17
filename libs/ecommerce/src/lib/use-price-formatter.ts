'use client';

import { formatPrice as formatPriceForLocale, useTranslations } from '@nextblock-cms/utils';

/** The regional locale prices are formatted in, from the site language. */
export function getPriceLocale(lang?: string | null) {
  if (!lang) return 'en-US';
  if (lang === 'fr') return 'fr-CA';
  if (lang === 'en') return 'en-US';
  return lang;
}

/**
 * `formatPrice` bound to the visitor's language.
 *
 * The shared helper defaults to `en-US`, and no shop component passed a locale, so a French
 * page showed `$1,234.50` instead of `1 234,50 $`. Components take this hook and keep calling
 * `formatPrice(amount, currency)` as before. The language comes from the translations
 * provider, which is the same on the server and in the browser: no hydration mismatch.
 */
export function usePriceFormatter() {
  const { lang } = useTranslations();
  const locale = getPriceLocale(lang);

  return (amount: number, currencyCode?: string) => formatPriceForLocale(amount, currencyCode, locale);
}
