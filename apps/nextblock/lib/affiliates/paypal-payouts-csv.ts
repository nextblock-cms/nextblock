import { getCurrencyMinorUnitFactor } from '@nextblock-cms/utils';

/**
 * The "Download PayPal payouts file" of /cms/affiliates/payouts (02036): a CSV for PayPal's
 * Payouts web upload (PayPal Business → Pay & Get Paid → Payouts), built from the partners the
 * program pays by hand. Pure, so it is unit-tested without a database.
 *
 * Format, as PayPal documents its web upload (developer.paypal.com → Payouts → "Use Web UI",
 * checked 2026-11-11): no header row; one currency per file; at most 5,000 rows; every row the
 * same number of columns, in this order: recipient (a PayPal email), amount, currency (ISO 4217),
 * customer ID (optional, up to 30 characters, no spaces), note to the recipient (optional, up to
 * 400 characters), recipient wallet (`PAYPAL`). The further Venmo-only columns and the purpose are
 * left out (PayPal's own example row stops at the wallet). Amounts use a dot as the decimal
 * separator, except EUR and BRL, which PayPal's example writes with a comma inside quotes
 * (`"100,50"`). PayPal shows every payment before it sends anything.
 *
 * Spreadsheet safety: every text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage
 * return (after any leading spaces) gets a leading apostrophe, so a value a partner typed can never
 * run as a formula when the file is opened in Excel, Numbers or Sheets; cells holding a comma, a
 * quote or a line break are quoted. The recipient email is the exception: an apostrophe or quotes
 * there would make PayPal pay a different address, so a row whose email would need either is left
 * out and reported (`skipped`) instead of rewritten. The portal and the database refuse such an
 * address (no leading = + - @, no quote, comma or whitespace), so this is a backstop. Partner
 * storefront links never appear in the file.
 */

/** PayPal's limit on rows in one uploaded file. */
export const AFFILIATE_PAYPAL_PAYOUTS_MAX_ROWS = 5000;
/** PayPal's limit on the "note to recipient" column. */
export const AFFILIATE_PAYPAL_NOTE_MAX_LENGTH = 400;
/** PayPal's limit on the optional customer ID column. */
export const AFFILIATE_PAYPAL_CUSTOMER_ID_MAX_LENGTH = 30;

/** Currencies PayPal's upload example writes with a decimal comma. */
const COMMA_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(['EUR', 'BRL']);

/** Characters a spreadsheet may read as the start of a formula (OWASP's CSV injection list). */
const FORMULA_START = /^[\s]*[=+\-@\t\r]/;

/** One partner the file pays. */
export interface AffiliatePayPalPayoutRow {
  /** The partner's payout email (PayPal recipient). */
  email: string;
  /** Minor units of `currency`. */
  amountCents: number;
  /** Commissions the amount covers (for the note). */
  commissionCount: number;
  /** The partner's handle, as PayPal's customer ID (cut to 30 characters). */
  handle: string;
  /** The partner's language, for the note (`fr` or anything else, read as English). */
  locale: string;
}

/**
 * A text cell made safe for a spreadsheet: a leading apostrophe when it starts (after spaces) with
 * `=`, `+`, `-`, `@`, a tab or a carriage return.
 */
export function neutralizeAffiliateCsvFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** One CSV cell: neutralized, then quoted (inner quotes doubled) when it holds a comma, a quote or a line break. */
export function escapeAffiliateCsvCell(value: string): string {
  const safe = neutralizeAffiliateCsvFormula(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * The recipient email can go in the file exactly as typed: not empty, and nothing a spreadsheet
 * would read as a formula or the CSV would have to quote (so escaping never changes the address).
 */
export function isAffiliatePayPalRecipientSafe(email: string): boolean {
  const value = typeof email === 'string' ? email.trim() : '';
  return value !== '' && escapeAffiliateCsvCell(value) === value && !/\s/.test(value);
}

/** `12.50` (`12,50` for EUR and BRL; `1250` for a zero-decimal currency), from minor units. */
export function formatAffiliatePayPalAmount(amountCents: number, currency: string): string {
  const factor = getCurrencyMinorUnitFactor(currency);
  const minor = Math.max(0, Math.trunc(Number(amountCents) || 0));
  if (factor === 1) return String(minor);
  // The store records every other currency in hundredths (getCurrencyMinorUnitFactor: 1 or 100).
  const major = (minor / factor).toFixed(2);
  return COMMA_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? major.replace('.', ',') : major;
}

/** The note to the recipient, in the partner's language (plain text, no link). */
export function affiliatePayPalPayoutNote(siteName: string, commissionCount: number, locale: string): string {
  const name = siteName.replace(/\s+/g, ' ').trim();
  const count = Math.max(0, Math.trunc(commissionCount));
  const note =
    locale === 'fr'
      ? `Commissions de partenaire ${name} (${count} ${count === 1 ? 'commande' : 'commandes'})`
      : `${name} partner commissions (${count} ${count === 1 ? 'order' : 'orders'})`;
  return note.replace(/^\s+/, '').slice(0, AFFILIATE_PAYPAL_NOTE_MAX_LENGTH);
}

/**
 * The CSV for PayPal's Payouts web upload, for one currency: one row per payout (see the file
 * comment for the columns), CRLF line endings, at most 5,000 rows (`truncated` says when more were
 * given). Rows without an email or a positive amount are dropped; a row whose email would have to be
 * rewritten to be safe ({@link isAffiliatePayPalRecipientSafe}) is left out and its handle listed in
 * `skipped`.
 */
export function buildAffiliatePayPalPayoutsCsv(
  rows: readonly AffiliatePayPalPayoutRow[],
  options: { currency: string; siteName: string }
): { csv: string; count: number; truncated: boolean; skipped: string[] } {
  const currency = options.currency.trim().toUpperCase();
  const lines: string[] = [];
  const skipped: string[] = [];
  let skippedForLimit = false;
  for (const row of rows) {
    const email = typeof row.email === 'string' ? row.email.trim() : '';
    const amount = Math.trunc(Number(row.amountCents));
    if (!email || !Number.isFinite(amount) || amount <= 0) continue;
    if (!isAffiliatePayPalRecipientSafe(email)) {
      skipped.push(typeof row.handle === 'string' ? row.handle : '');
      continue;
    }
    if (lines.length >= AFFILIATE_PAYPAL_PAYOUTS_MAX_ROWS) {
      skippedForLimit = true;
      break;
    }
    const customerId = (typeof row.handle === 'string' ? row.handle : '').replace(/\s+/g, '').slice(0, AFFILIATE_PAYPAL_CUSTOMER_ID_MAX_LENGTH);
    lines.push(
      [
        email,
        formatAffiliatePayPalAmount(amount, currency),
        currency,
        customerId,
        affiliatePayPalPayoutNote(options.siteName, row.commissionCount, row.locale),
        'PAYPAL',
      ]
        .map(escapeAffiliateCsvCell)
        .join(',')
    );
  }
  return { csv: lines.length > 0 ? `${lines.join('\r\n')}\r\n` : '', count: lines.length, truncated: skippedForLimit, skipped };
}
