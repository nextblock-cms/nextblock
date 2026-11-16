import {
  formatPrice,
  getCurrencyMinorUnitFactor,
  majorUnitAmountToMinor,
  minorUnitAmountToMajor,
  normalizeCurrencyCode,
} from '@nextblock-cms/utils/utils';

export const CURRENCY_ROUNDING_MODES = [
  'none',
  'nearest',
  'up',
  'down',
  'charm',
] as const;

export type CurrencyRoundingMode = (typeof CURRENCY_ROUNDING_MODES)[number];

export interface CurrencyRecord {
  code: string;
  symbol: string;
  exchange_rate: number;
  is_default: boolean;
  is_active: boolean;
  auto_sync_product_prices?: boolean | null;
  rounding_mode?: CurrencyRoundingMode | null;
  rounding_increment?: number | null;
  rounding_charm_amount?: number | null;
  auto_update_exchange_rate?: boolean | null;
  exchange_rate_source?: string | null;
  exchange_rate_updated_at?: string | null;
}

export type PriceMap = Record<string, number>;
export type SalePriceMap = Record<string, number | null>;

const LOCALE_TO_CURRENCY: Record<string, string> = {
  AU: 'AUD',
  CA: 'CAD',
  CH: 'CHF',
  CZ: 'CZK',
  DE: 'EUR',
  DK: 'DKK',
  ES: 'EUR',
  EU: 'EUR',
  FI: 'EUR',
  FR: 'EUR',
  GB: 'GBP',
  IE: 'EUR',
  IN: 'INR',
  IT: 'EUR',
  JP: 'JPY',
  MX: 'MXN',
  NL: 'EUR',
  NO: 'NOK',
  NZ: 'NZD',
  PL: 'PLN',
  PT: 'EUR',
  SE: 'SEK',
  SG: 'SGD',
  US: 'USD',
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizePositiveInteger(value: unknown, fallback = 1) {
  const normalizedValue =
    typeof value === 'string' ? Number.parseInt(value, 10) : value;

  if (
    typeof normalizedValue === 'number' &&
    Number.isFinite(normalizedValue) &&
    normalizedValue > 0
  ) {
    return Math.max(1, Math.round(normalizedValue));
  }

  return fallback;
}

function normalizeNonNegativeInteger(value: unknown) {
  const normalizedValue =
    typeof value === 'string' ? Number.parseInt(value, 10) : value;

  if (
    typeof normalizedValue === 'number' &&
    Number.isFinite(normalizedValue) &&
    normalizedValue >= 0
  ) {
    return Math.round(normalizedValue);
  }

  return null;
}

export function normalizeCurrencyRoundingMode(value: unknown): CurrencyRoundingMode {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();

    if (CURRENCY_ROUNDING_MODES.includes(normalized as CurrencyRoundingMode)) {
      return normalized as CurrencyRoundingMode;
    }
  }

  return 'none';
}

export function normalizeCurrencyRecord(
  value: Partial<CurrencyRecord> | Record<string, unknown> | null | undefined
): CurrencyRecord {
  const record = (value || {}) as Record<string, unknown>;
  const normalizedCode = normalizeCurrencyCode(
    typeof record.code === 'string' ? record.code : null
  );
  const isDefault = record.is_default === true;

  return {
    code: normalizedCode,
    symbol:
      typeof record.symbol === 'string' && record.symbol.trim()
        ? record.symbol.trim()
        : normalizedCode,
    exchange_rate:
      isDefault
        ? 1
        : isFiniteNumber(record.exchange_rate) && record.exchange_rate > 0
          ? record.exchange_rate
          : 1,
    is_default: isDefault,
    is_active: record.is_active !== false,
    auto_sync_product_prices:
      isDefault ? false : record.auto_sync_product_prices === true,
    rounding_mode: normalizeCurrencyRoundingMode(record.rounding_mode),
    rounding_increment: normalizePositiveInteger(record.rounding_increment, 1),
    rounding_charm_amount: normalizeNonNegativeInteger(record.rounding_charm_amount),
    auto_update_exchange_rate: isDefault ? false : record.auto_update_exchange_rate !== false,
    exchange_rate_source:
      typeof record.exchange_rate_source === 'string' && record.exchange_rate_source.trim()
        ? record.exchange_rate_source.trim()
        : null,
    exchange_rate_updated_at:
      typeof record.exchange_rate_updated_at === 'string' &&
      record.exchange_rate_updated_at.trim()
        ? record.exchange_rate_updated_at
        : null,
  };
}

export function normalizePriceMap(value: unknown): PriceMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value as Record<string, unknown>).reduce<PriceMap>(
    (accumulator, [code, amount]) => {
      const normalizedCode = normalizeCurrencyCode(code);
      const normalizedAmount =
        typeof amount === 'string' ? Number.parseFloat(amount) : amount;

      if (isFiniteNumber(normalizedAmount) && normalizedAmount >= 0) {
        accumulator[normalizedCode] = Math.round(normalizedAmount);
      }

      return accumulator;
    },
    {}
  );
}

export function normalizeSalePriceMap(value: unknown): SalePriceMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value as Record<string, unknown>).reduce<SalePriceMap>(
    (accumulator, [code, amount]) => {
      const normalizedCode = normalizeCurrencyCode(code);
      const normalizedAmount =
        typeof amount === 'string' ? Number.parseFloat(amount) : amount;

      if (normalizedAmount === null) {
        accumulator[normalizedCode] = null;
        return accumulator;
      }

      if (isFiniteNumber(normalizedAmount) && normalizedAmount >= 0) {
        accumulator[normalizedCode] = Math.round(normalizedAmount);
      }

      return accumulator;
    },
    {}
  );
}

export function getDefaultCurrency(currencies: CurrencyRecord[]) {
  return (
    currencies.map(normalizeCurrencyRecord).find((currency) => currency.is_default) ??
    normalizeCurrencyRecord(currencies[0]) ??
    normalizeCurrencyRecord({
      code: 'USD',
      symbol: '$',
      exchange_rate: 1,
      is_default: true,
      is_active: true,
    })
  );
}

export function getCurrencyLookup(currencies: CurrencyRecord[]) {
  return currencies.reduce<Record<string, CurrencyRecord>>((accumulator, currency) => {
    const normalizedCurrency = normalizeCurrencyRecord(currency);
    accumulator[normalizedCurrency.code] = normalizedCurrency;
    return accumulator;
  }, {});
}

export function getExchangeRateForCurrency(
  currencies: CurrencyRecord[],
  currencyCode?: string | null
) {
  const normalizedCode = normalizeCurrencyCode(currencyCode);
  const defaultCurrency = getDefaultCurrency(currencies);
  const lookup = getCurrencyLookup(currencies);
  return lookup[normalizedCode]?.exchange_rate ?? (normalizedCode === defaultCurrency.code ? 1 : 1);
}

export function convertMinorUnitAmount(params: {
  amount: number;
  fromCurrencyCode?: string | null;
  toCurrencyCode?: string | null;
  currencies: CurrencyRecord[];
  applyRounding?: boolean;
}) {
  const { amount, currencies } = params;
  const fromCurrencyCode = normalizeCurrencyCode(params.fromCurrencyCode);
  const toCurrencyCode = normalizeCurrencyCode(params.toCurrencyCode);

  if (!Number.isFinite(amount)) {
    return 0;
  }

  if (fromCurrencyCode === toCurrencyCode) {
    return Math.round(amount);
  }

  const lookup = getCurrencyLookup(currencies);
  const defaultCurrency = getDefaultCurrency(currencies);
  const fromRate =
    lookup[fromCurrencyCode]?.exchange_rate ??
    (fromCurrencyCode === defaultCurrency.code ? 1 : defaultCurrency.exchange_rate);
  const toRate =
    lookup[toCurrencyCode]?.exchange_rate ??
    (toCurrencyCode === defaultCurrency.code ? 1 : defaultCurrency.exchange_rate);

  const fromMajorAmount = amount / getCurrencyMinorUnitFactor(fromCurrencyCode);
  const baseMajorAmount = fromMajorAmount / fromRate;
  const targetMajorAmount = baseMajorAmount * toRate;
  const convertedAmount = majorUnitAmountToMinor(targetMajorAmount, toCurrencyCode);

  if (params.applyRounding) {
    return applyCurrencyRounding({
      amount: convertedAmount,
      currencyCode: toCurrencyCode,
      currencies,
    });
  }

  return convertedAmount;
}

export function applyCurrencyRounding(params: {
  amount: number;
  currencyCode?: string | null;
  currencies: CurrencyRecord[];
}) {
  const normalizedAmount = Math.max(0, Math.round(params.amount));
  const currencyCode = normalizeCurrencyCode(params.currencyCode);
  const lookup = getCurrencyLookup(params.currencies);
  const currency =
    lookup[currencyCode] ?? normalizeCurrencyRecord(getDefaultCurrency(params.currencies));
  const roundingIncrement = normalizePositiveInteger(currency.rounding_increment, 1);

  if (currency.rounding_mode === 'nearest') {
    return Math.round(normalizedAmount / roundingIncrement) * roundingIncrement;
  }

  if (currency.rounding_mode === 'up') {
    return Math.ceil(normalizedAmount / roundingIncrement) * roundingIncrement;
  }

  if (currency.rounding_mode === 'down') {
    return Math.floor(normalizedAmount / roundingIncrement) * roundingIncrement;
  }

  if (currency.rounding_mode === 'charm') {
    const minorUnitFactor = getCurrencyMinorUnitFactor(currency.code);
    const normalizedCharmAmount = Math.min(
      Math.max(currency.rounding_charm_amount ?? 0, 0),
      Math.max(minorUnitFactor - 1, 0)
    );
    const roundedBaseAmount =
      Math.floor(normalizedAmount / minorUnitFactor) * minorUnitFactor;
    let candidateAmount = roundedBaseAmount + normalizedCharmAmount;

    if (candidateAmount < normalizedAmount) {
      candidateAmount += minorUnitFactor;
    }

    return candidateAmount;
  }

  return normalizedAmount;
}

export function describeCurrencyRoundingRule(currency: CurrencyRecord) {
  const normalizedCurrency = normalizeCurrencyRecord(currency);

  if (normalizedCurrency.rounding_mode === 'nearest') {
    return `Nearest ${formatPrice(
      normalizedCurrency.rounding_increment ?? 1,
      normalizedCurrency.code
    )}`;
  }

  if (normalizedCurrency.rounding_mode === 'up') {
    return `Round up to ${formatPrice(
      normalizedCurrency.rounding_increment ?? 1,
      normalizedCurrency.code
    )}`;
  }

  if (normalizedCurrency.rounding_mode === 'down') {
    return `Round down to ${formatPrice(
      normalizedCurrency.rounding_increment ?? 1,
      normalizedCurrency.code
    )}`;
  }

  if (normalizedCurrency.rounding_mode === 'charm') {
    const charmAmount = normalizedCurrency.rounding_charm_amount ?? 0;
    return `Charm ending ${formatPrice(charmAmount, normalizedCurrency.code)}`;
  }

  return `Exact conversion (${minorUnitAmountToMajor(1, normalizedCurrency.code).toFixed(
    getCurrencyMinorUnitFactor(normalizedCurrency.code) === 1 ? 0 : 2
  )} step)`;
}

function resolveFallbackCurrencyCode(priceMap: PriceMap, currencies: CurrencyRecord[]) {
  const defaultCurrency = getDefaultCurrency(currencies);

  if (priceMap[defaultCurrency.code] !== undefined) {
    return defaultCurrency.code;
  }

  return Object.keys(priceMap)[0] ?? defaultCurrency.code;
}

function resolveAmountForCurrency(params: {
  amountMap: PriceMap;
  fallbackAmount?: number | null;
  currencyCode?: string | null;
  currencies: CurrencyRecord[];
}) {
  const { amountMap, fallbackAmount, currencies } = params;
  const currencyCode = normalizeCurrencyCode(params.currencyCode);
  const normalizedAmountMap = normalizePriceMap(amountMap);

  if (normalizedAmountMap[currencyCode] !== undefined) {
    return normalizedAmountMap[currencyCode];
  }

  if (Object.keys(normalizedAmountMap).length > 0) {
    const sourceCurrencyCode = resolveFallbackCurrencyCode(normalizedAmountMap, currencies);
    const sourceAmount = normalizedAmountMap[sourceCurrencyCode];

    if (sourceAmount !== undefined) {
      return convertMinorUnitAmount({
        amount: sourceAmount,
        fromCurrencyCode: sourceCurrencyCode,
        toCurrencyCode: currencyCode,
        currencies,
        applyRounding: true,
      });
    }
  }

  if (typeof fallbackAmount === 'number' && Number.isFinite(fallbackAmount)) {
    const defaultCurrency = getDefaultCurrency(currencies);
    return convertMinorUnitAmount({
      amount: fallbackAmount,
      fromCurrencyCode: defaultCurrency.code,
      toCurrencyCode: currencyCode,
      currencies,
      applyRounding: true,
    });
  }

  return 0;
}

export function resolvePriceForCurrency(params: {
  prices?: PriceMap | null;
  salePrices?: SalePriceMap | null;
  fallbackPrice?: number | null;
  fallbackSalePrice?: number | null;
  currencyCode?: string | null;
  currencies: CurrencyRecord[];
}) {
  const {
    prices = {},
    salePrices = {},
    fallbackPrice,
    fallbackSalePrice,
    currencies,
  } = params;
  const currencyCode = normalizeCurrencyCode(params.currencyCode);
  const normalizedPrices = normalizePriceMap(prices);
  const normalizedSalePrices = normalizeSalePriceMap(salePrices);
  const regularAmount = resolveAmountForCurrency({
    amountMap: normalizedPrices,
    fallbackAmount: fallbackPrice,
    currencyCode,
    currencies,
  });
  const saleAmount = resolveAmountForCurrency({
    amountMap: normalizePriceMap(normalizedSalePrices),
    fallbackAmount: fallbackSalePrice,
    currencyCode,
    currencies,
  });

  return {
    currencyCode,
    price: regularAmount,
    sale_price:
      saleAmount > 0 && saleAmount <= regularAmount ? saleAmount : null,
  };
}

/**
 * Returns whether a scheduled sale window is active at `now` (defaults to the
 * current instant). A null bound means "open ended"; both bounds null means the
 * sale is always-on (preserves the behaviour of pre-schedule static sales).
 * Window is [start, end): inclusive start, exclusive end. All comparisons are
 * absolute instants, so this is timezone-safe.
 */
export function isSaleWindowActive(params: {
  saleStartAt?: string | null;
  saleEndAt?: string | null;
  now?: Date;
}): boolean {
  const nowMs = (params.now ?? new Date()).getTime();

  if (params.saleStartAt) {
    const startMs = new Date(params.saleStartAt).getTime();
    if (Number.isFinite(startMs) && nowMs < startMs) {
      return false;
    }
  }

  if (params.saleEndAt) {
    const endMs = new Date(params.saleEndAt).getTime();
    if (Number.isFinite(endMs) && nowMs >= endMs) {
      return false;
    }
  }

  return true;
}

/**
 * Returns whether a pending regular-price change has reached its effective time.
 */
export function isScheduledPriceDue(params: {
  scheduledPriceAt?: string | null;
  now?: Date;
}): boolean {
  if (!params.scheduledPriceAt) {
    return false;
  }
  const dueMs = new Date(params.scheduledPriceAt).getTime();
  if (!Number.isFinite(dueMs)) {
    return false;
  }
  return (params.now ?? new Date()).getTime() >= dueMs;
}

/**
 * Window-aware wrapper around {@link resolvePriceForCurrency}. Resolves the
 * effective regular/sale price for a product or variant at `now`:
 *   - a due scheduled regular-price change replaces the regular price inputs;
 *   - the sale price only applies while its window is active.
 * The existing `sale_price <= regularPrice` guard is preserved by delegating to
 * `resolvePriceForCurrency`, so an out-of-window or invalid sale returns null.
 */
export function resolveEffectivePriceForCurrency(params: {
  prices?: PriceMap | null;
  salePrices?: SalePriceMap | null;
  fallbackPrice?: number | null;
  fallbackSalePrice?: number | null;
  saleStartAt?: string | null;
  saleEndAt?: string | null;
  scheduledPrice?: number | null;
  scheduledPrices?: PriceMap | null;
  scheduledPriceAt?: string | null;
  currencyCode?: string | null;
  currencies: CurrencyRecord[];
  now?: Date;
}) {
  const now = params.now ?? new Date();

  const priceChangeDue = isScheduledPriceDue({
    scheduledPriceAt: params.scheduledPriceAt,
    now,
  });
  const effectivePrices = priceChangeDue ? params.scheduledPrices : params.prices;
  const effectiveFallbackPrice = priceChangeDue
    ? params.scheduledPrice
    : params.fallbackPrice;

  const saleActive = isSaleWindowActive({
    saleStartAt: params.saleStartAt,
    saleEndAt: params.saleEndAt,
    now,
  });

  return resolvePriceForCurrency({
    prices: effectivePrices,
    salePrices: saleActive ? params.salePrices : null,
    fallbackPrice: effectiveFallbackPrice,
    fallbackSalePrice: saleActive ? params.fallbackSalePrice : null,
    currencyCode: params.currencyCode,
    currencies: params.currencies,
  });
}

export function resolvePriceRangeForCurrency(params: {
  entries: Array<{
    price: number;
    prices?: PriceMap | null;
    sale_price?: number | null;
    sale_prices?: SalePriceMap | null;
    sale_start_at?: string | null;
    sale_end_at?: string | null;
    scheduled_price?: number | null;
    scheduled_prices?: PriceMap | null;
    scheduled_price_at?: string | null;
  }>;
  currencyCode?: string | null;
  currencies: CurrencyRecord[];
  now?: Date;
}) {
  const effectivePrices = params.entries
    .map((entry) =>
      resolveEffectivePriceForCurrency({
        prices: entry.prices,
        salePrices: entry.sale_prices,
        fallbackPrice: entry.price,
        fallbackSalePrice: entry.sale_price,
        saleStartAt: entry.sale_start_at,
        saleEndAt: entry.sale_end_at,
        scheduledPrice: entry.scheduled_price,
        scheduledPrices: entry.scheduled_prices,
        scheduledPriceAt: entry.scheduled_price_at,
        currencyCode: params.currencyCode,
        currencies: params.currencies,
        now: params.now,
      })
    )
    .map((entry) => entry.sale_price ?? entry.price)
    .filter((amount) => Number.isFinite(amount));

  if (!effectivePrices.length) {
    return null;
  }

  return {
    min: Math.min(...effectivePrices),
    max: Math.max(...effectivePrices),
  };
}

export function inferCurrencyCodeFromLocale(
  locale: string | null | undefined,
  currencies: CurrencyRecord[]
) {
  const defaultCurrency = getDefaultCurrency(currencies);
  const normalizedLocale = locale?.trim();

  if (!normalizedLocale) {
    return defaultCurrency.code;
  }

  const localeParts = normalizedLocale
    .replace('_', '-')
    .split('-')
    .map((part) => part.toUpperCase());
  const region = localeParts[1];

  if (!region) {
    return defaultCurrency.code;
  }

  const inferredCode = LOCALE_TO_CURRENCY[region];

  if (!inferredCode) {
    return defaultCurrency.code;
  }

  const activeCodes = new Set(currencies.map((currency) => normalizeCurrencyCode(currency.code)));
  return activeCodes.has(inferredCode) ? inferredCode : defaultCurrency.code;
}

export function sortCurrencies(currencies: CurrencyRecord[]) {
  return currencies.map(normalizeCurrencyRecord).sort((left, right) => {
    if (left.is_default !== right.is_default) {
      return left.is_default ? -1 : 1;
    }

    return normalizeCurrencyCode(left.code).localeCompare(normalizeCurrencyCode(right.code));
  });
}
