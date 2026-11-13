/**
 * Commission money math in integer minor units, mirroring the SQL in migration 02030
 * (`private.affiliate_record_commission`), plus display formatting. Pure and client-safe.
 */
import { formatPrice, getCurrencyMinorUnitFactor } from '@nextblock-cms/utils';

import type { AffiliateCommissionRow } from './types';

function nonNegativeFinite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function currencyCode(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export interface AffiliateCommissionComputationInput {
  /** Net order amount in base-currency minor units. */
  netMinor: number;
  /** Tier rate, `numeric(5,2)` (e.g. 35.5 for 35.50 %). */
  ratePercent: number;
}

/**
 * `round(net_base * commission_percentage / 100)`, computed exactly: the rate has two decimals,
 * so it is scaled to basis points and the division is done on integers with half-up rounding
 * (what Postgres `round()` does for non-negative numerics). Floating point would round
 * `x.5` cases the wrong way now and then.
 */
export function computeAffiliateCommissionMinor(input: AffiliateCommissionComputationInput): number {
  const netMinor = Math.round(nonNegativeFinite(input.netMinor));
  const rateBasisPoints = Math.round(Math.min(nonNegativeFinite(input.ratePercent), 100) * 100);

  if (netMinor === 0 || rateBasisPoints === 0) {
    return 0;
  }

  return Math.floor((netMinor * rateBasisPoints + 5000) / 10000);
}

export interface AffiliateCurrencyConversionInput {
  /** Amount in `fromCurrency` minor units. */
  amountMinor: number;
  fromCurrency: string;
  /** The store base currency the commission is recorded in. */
  toCurrency: string;
  /**
   * `orders.exchange_rate_at_purchase`: units of the order currency per unit of the store
   * default currency (always > 0; the column has a CHECK).
   */
  exchangeRate: number;
}

/**
 * The order's net amount in base-currency minor units, with the formula the SQL uses:
 * same currency → the amount unchanged; else
 * `round((amount / factor(from)) / exchange_rate * factor(to))`. A non-positive or missing
 * amount is 0 (the SQL clamps the net with `GREATEST(…, 0)` first).
 *
 * @throws RangeError when the currencies differ and `exchangeRate` is not a positive number.
 */
export function convertAffiliateAmountToBaseMinor(input: AffiliateCurrencyConversionInput): number {
  const amountMinor = nonNegativeFinite(input.amountMinor);

  if (amountMinor === 0) {
    return 0;
  }

  const from = currencyCode(input.fromCurrency);
  const to = currencyCode(input.toCurrency);

  if (from === to) {
    return Math.round(amountMinor);
  }

  const rate = Number(input.exchangeRate);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError('convertAffiliateAmountToBaseMinor: exchangeRate must be a positive number');
  }

  return Math.round(
    (amountMinor / getCurrencyMinorUnitFactor(from)) / rate * getCurrencyMinorUnitFactor(to)
  );
}

/** What a commission is worth after partial refunds: `commission_amount_cents − refunded_amount_cents` (never negative). */
export function affiliateCommissionNetMinor(
  row: Pick<AffiliateCommissionRow, 'commission_amount_cents' | 'refunded_amount_cents'>
): number {
  return Math.max(
    0,
    Math.round(nonNegativeFinite(row.commission_amount_cents)) - Math.round(nonNegativeFinite(row.refunded_amount_cents))
  );
}

/** `formatPrice` in the partner's language: `fr` → `fr-CA`, anything else → `en-US`. */
export function formatAffiliateMoney(amountMinor: number, currency: string, locale: string): string {
  const intlLocale = typeof locale === 'string' && locale.trim().toLowerCase().startsWith('fr') ? 'fr-CA' : 'en-US';
  const amount = Number.isFinite(Number(amountMinor)) ? Number(amountMinor) : 0;

  return formatPrice(amount, currency, intlLocale);
}
