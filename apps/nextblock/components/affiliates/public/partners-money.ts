import { formatAffiliateMoney } from '@nextblock-cms/affiliates';
import { getCurrencyMinorUnitFactor, normalizeCurrencyCode } from '@nextblock-cms/utils';

/**
 * Money on the `/partners` page, shared by the server-rendered hero card and the calculator island
 * (pure, client-safe). Amounts are minor units of the store base currency, converted with the
 * app's own minor-unit factor (`getCurrencyMinorUnitFactor`, the one `formatPrice`, checkout and
 * the commission SQL use), never with Intl's fraction digits, which differ for ISK, KWD and others.
 * The page language picks the format (`fr` → `fr-CA`, anything else → `en-US`).
 *
 * The calculator re-renders on every animation frame of its sweep, so the Intl formatters are
 * built once per (locale, currency, form) and reused.
 */

const FORMATTERS = new Map<string, Intl.NumberFormat>();

function intlLocaleOf(locale: string): 'fr-CA' | 'en-US' {
  return typeof locale === 'string' && locale.trim().toLowerCase().startsWith('fr') ? 'fr-CA' : 'en-US';
}

function formatterFor(intlLocale: string, currency: string, whole: boolean): Intl.NumberFormat {
  const key = `${intlLocale}|${currency}|${whole ? 'whole' : 'cents'}`;
  let formatter = FORMATTERS.get(key);
  if (!formatter) {
    formatter = whole
      ? new Intl.NumberFormat(intlLocale, { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 0 })
      : new Intl.NumberFormat(intlLocale, { style: 'currency', currency });
    FORMATTERS.set(key, formatter);
  }
  return formatter;
}

/** Cents included (`$62.50`, `62,50 $ US`): exactly `formatAffiliateMoney`'s output, as the results show money. */
export function formatPartnersMoney(amountMinor: number, currency: string, locale: string): string {
  const code = normalizeCurrencyCode(currency);
  const amount = Number.isFinite(Number(amountMinor)) ? Number(amountMinor) : 0;
  try {
    return formatterFor(intlLocaleOf(locale), code, false).format(amount / getCurrencyMinorUnitFactor(code));
  } catch {
    return formatAffiliateMoney(amount, code, locale);
  }
}

/**
 * Without the cents when the amount is whole (`$1,250`, `1 250 $ US`), with them otherwise: the
 * headline figures and product prices.
 */
export function formatPartnersWholeMoney(amountMinor: number, currency: string, locale: string): string {
  const code = normalizeCurrencyCode(currency);
  const factor = getCurrencyMinorUnitFactor(code);
  const minor = Math.round(Number(amountMinor) || 0);
  if (minor % factor !== 0) return formatPartnersMoney(minor, code, locale);
  try {
    return formatterFor(intlLocaleOf(locale), code, true).format(minor / factor);
  } catch {
    return formatPartnersMoney(minor, code, locale);
  }
}
