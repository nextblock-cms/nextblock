import { formatAffiliateMoney } from '@nextblock-cms/affiliates';

import type { PortalLocale } from './portal-types';

/**
 * Formatting shared by the portal's server components and client islands. Dates are formatted in
 * UTC on both sides, so the server render and the hydrated client agree (the ledger dates are
 * calendar days: clearance and payout dates).
 */

export function portalIntlLocale(locale: PortalLocale): string {
  return locale === 'fr' ? 'fr-CA' : 'en-US';
}

/** `Oct 27, 2026` / `27 oct. 2026`; '' for a missing or invalid date. A bare `YYYY-MM-DD` is a UTC day. */
export function formatPortalDate(value: string | null | undefined, locale: PortalLocale): string {
  if (typeof value !== 'string' || !value) return '';
  const time = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(time)) return '';
  return new Intl.DateTimeFormat(portalIntlLocale(locale), { dateStyle: 'medium', timeZone: 'UTC' }).format(time);
}

/** A machine-readable date for `<time dateTime>`; '' when invalid. */
export function portalDateTimeAttribute(value: string | null | undefined): string {
  if (typeof value !== 'string' || !value) return '';
  const time = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : '';
}

export function formatPortalMoney(amountMinor: number, currency: string, locale: PortalLocale): string {
  return formatAffiliateMoney(amountMinor, currency, locale);
}

/** `50%` / `50 %` (a commission rate stored as a percentage, e.g. 12.5). */
export function formatPortalPercent(rate: number, locale: PortalLocale): string {
  const value = Number(rate);
  if (!Number.isFinite(value)) return '';
  return new Intl.NumberFormat(portalIntlLocale(locale), { style: 'percent', maximumFractionDigits: 2 }).format(value / 100);
}

export function formatPortalNumber(value: number, locale: PortalLocale): string {
  return new Intl.NumberFormat(portalIntlLocale(locale)).format(Number.isFinite(value) ? value : 0);
}

/** The first 8 characters of an order id, upper-cased (`#1A2B3C4D`), or null. */
export function shortPortalOrderRef(orderId: string | null | undefined): string | null {
  if (typeof orderId !== 'string') return null;
  const compact = orderId.replace(/[^0-9a-z]/gi, '').slice(0, 8).toUpperCase();
  return compact ? `#${compact}` : null;
}
