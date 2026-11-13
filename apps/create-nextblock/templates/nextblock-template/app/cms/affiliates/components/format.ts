import { formatAffiliateMoney } from '@nextblock-cms/affiliates';

/**
 * Formatting for the /cms/affiliates server components. Values are formatted on the server (in
 * UTC, en-US) and handed to the page as text, so client islands never format money or dates
 * themselves (no locale or time-zone hydration mismatch, no lib code in the client bundle).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** `$1,234.56` style, in the given currency; never throws. */
export function formatAdminMoney(amountMinor: number | null | undefined, currency: string | null | undefined): string {
  const code = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency.trim()) ? currency.trim().toUpperCase() : 'USD';
  const amount = Number.isFinite(Number(amountMinor)) ? Math.round(Number(amountMinor)) : 0;
  try {
    return formatAffiliateMoney(amount, code, 'en');
  } catch {
    return `${code} ${amount}`;
  }
}

function toDate(value: string | null | undefined): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `Oct 27, 2026, 3:04 PM UTC`, or an em dash for no date. */
export function formatAdminDateTime(value: string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  return `${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`;
}

/** `Oct 27, 2026`, or an em dash. */
export function formatAdminDate(value: string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}

/** `2 days ago`, `in 12 days`, `in 5 hours`, `just now`: a coarse relative time for tables. */
export function formatAdminRelative(value: string | null | undefined, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return '—';
  const diff = date.getTime() - now;
  const abs = Math.abs(diff);
  const future = diff > 0;

  if (abs < HOUR_MS) return future ? 'within the hour' : 'just now';
  if (abs < DAY_MS) {
    const hours = Math.round(abs / HOUR_MS);
    const unit = hours === 1 ? 'hour' : 'hours';
    return future ? `in ${hours} ${unit}` : `${hours} ${unit} ago`;
  }
  const days = Math.round(abs / DAY_MS);
  const unit = days === 1 ? 'day' : 'days';
  return future ? `in ${days} ${unit}` : `${days} ${unit} ago`;
}

/** The clearance countdown of a PENDING_CLEARANCE commission (`clears in 12 days`, `due now`). */
export function formatAdminClearsIn(clearsAt: string | null | undefined, now: number = Date.now()): string {
  const date = toDate(clearsAt);
  if (!date) return '—';
  if (date.getTime() <= now) return 'Due now (next payout run)';
  return `Clears ${formatAdminRelative(clearsAt, now)}`;
}

/** `35%` / `12.5%` for a stored `numeric(5,2)` rate. */
export function formatAdminRate(rate: number | null | undefined): string {
  const value = Number(rate);
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value * 100) / 100}%`;
}

export function formatAdminCount(value: number | null | undefined): string {
  const number = Number(value);
  return new Intl.NumberFormat('en-US').format(Number.isFinite(number) ? Math.round(number) : 0);
}

/** A short form of a long id for tables (`3f2a…9c1d`); the full id goes in a `title`. */
export function shortAdminId(value: string | null | undefined): string {
  if (typeof value !== 'string' || !value) return '—';
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}
