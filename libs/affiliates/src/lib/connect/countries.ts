/**
 * Countries a partner's Stripe Connect Express account can be opened in: the countries where
 * Stripe accounts are generally available (India and other invite-only markets excluded). A
 * partner in another country than the platform's gets the recipient service agreement
 * (ADDENDUM B3); whether the platform may pay out cross-border at all is Stripe's call, and an
 * account creation it refuses surfaces as "Connect unavailable".
 */
export const AFFILIATE_CONNECT_COUNTRY_CODES = [
  'AE',
  'AT',
  'AU',
  'BE',
  'BG',
  'BR',
  'CA',
  'CH',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GB',
  'GI',
  'GR',
  'HK',
  'HR',
  'HU',
  'IE',
  'IT',
  'JP',
  'LI',
  'LT',
  'LU',
  'LV',
  'MT',
  'MX',
  'MY',
  'NL',
  'NO',
  'NZ',
  'PL',
  'PT',
  'RO',
  'SE',
  'SG',
  'SI',
  'SK',
  'TH',
  'US',
] as const;

export type AffiliateConnectCountryCode = (typeof AFFILIATE_CONNECT_COUNTRY_CODES)[number];

const COUNTRY_SET: ReadonlySet<string> = new Set(AFFILIATE_CONNECT_COUNTRY_CODES);

/** A supported country code (uppercased), or null. */
export function normalizeAffiliateConnectCountry(value: unknown): AffiliateConnectCountryCode | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return COUNTRY_SET.has(code) ? (code as AffiliateConnectCountryCode) : null;
}

export function isAffiliateConnectCountry(value: unknown): value is AffiliateConnectCountryCode {
  return typeof value === 'string' && COUNTRY_SET.has(value);
}

/**
 * The region inside which Stripe transfers money to a connected account in another country than
 * the platform's: the US, Canada, the UK, the EEA (the 27 EU members, Iceland, Liechtenstein and
 * Norway) and Switzerland. A platform in this region can pay partners anywhere in it; a platform
 * elsewhere can only pay partners in its own country. Iceland has no Express accounts (it is not
 * in AFFILIATE_CONNECT_COUNTRY_CODES), so it is never offered.
 */
export const AFFILIATE_CONNECT_CROSS_BORDER_COUNTRY_CODES = [
  'AT',
  'BE',
  'BG',
  'CA',
  'CH',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GB',
  'GR',
  'HR',
  'HU',
  'IE',
  'IS',
  'IT',
  'LI',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'NO',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
  'US',
] as const;

const CROSS_BORDER_SET: ReadonlySet<string> = new Set(AFFILIATE_CONNECT_CROSS_BORDER_COUNTRY_CODES);

function upperCountry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** True for a country of the cross-border region (the US, Canada, the UK, the EEA and Switzerland). */
export function isAffiliateConnectCrossBorderCountry(value: unknown): boolean {
  const code = upperCountry(value);
  return code !== null && CROSS_BORDER_SET.has(code);
}

/**
 * Whether a partner may open their Connect account in `country` on a platform whose Stripe account
 * is in `platformCountry`:
 * - platform in the cross-border region: any supported country of that region;
 * - platform elsewhere: only the platform's own country, when it is a supported one;
 * - platform country unknown: any supported country (Stripe decides when the account is created).
 */
export function isAffiliateConnectCountryAllowedForPlatform(country: unknown, platformCountry: string | null | undefined): boolean {
  const code = normalizeAffiliateConnectCountry(country);
  if (!code) return false;
  const platform = upperCountry(platformCountry);
  if (!platform) return true;
  if (CROSS_BORDER_SET.has(platform)) return CROSS_BORDER_SET.has(code);
  return code === platform;
}

/** `options` limited to the countries {@link isAffiliateConnectCountryAllowedForPlatform} allows, order kept. */
export function filterAffiliateConnectCountriesForPlatform<T extends { code: string }>(
  options: readonly T[],
  platformCountry: string | null | undefined
): T[] {
  return options.filter((option) => isAffiliateConnectCountryAllowedForPlatform(option.code, platformCountry));
}

export interface AffiliateConnectCountryOption {
  code: AffiliateConnectCountryCode;
  /** Localized country name (`Intl.DisplayNames`), the code itself when the runtime has no names. */
  name: string;
}

/** The supported countries with localized names, sorted by name in `locale`. */
export function listAffiliateConnectCountryOptions(locale = 'en'): AffiliateConnectCountryOption[] {
  const language = typeof locale === 'string' && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(locale) ? locale : 'en';
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([language, 'en'], { type: 'region' });
  } catch {
    names = null;
  }
  const options = AFFILIATE_CONNECT_COUNTRY_CODES.map((code) => {
    let name: string = code;
    try {
      name = names?.of(code) ?? code;
    } catch {
      name = code;
    }
    return { code, name };
  });
  return options.sort((a, b) => a.name.localeCompare(b.name, language));
}
