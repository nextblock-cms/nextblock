'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { normalizeCurrencyCode } from '@nextblock-cms/utils';

import {
  type CurrencyRecord,
  getDefaultCurrency,
  inferCurrencyCodeFromLocale,
  normalizeCurrencyRecord,
  sortCurrencies,
} from './currency';
import {
  useCurrencyPreferenceStore,
} from './currency-store';
import { CURRENCY_COOKIE_NAME } from './currency-constants';

interface CurrencyContextValue {
  currencies: CurrencyRecord[];
  defaultCurrency: CurrencyRecord;
  activeCurrency: CurrencyRecord;
  activeCurrencyCode: string;
  isHydrated: boolean;
  setActiveCurrencyCode: (currencyCode: string) => void;
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

function getActiveCurrencies(currencies: CurrencyRecord[]) {
  return sortCurrencies(
    currencies.filter((currency) => currency.is_active !== false)
  );
}

function resolvePreferredCurrencyCode(params: {
  currencies: CurrencyRecord[];
  storedCurrencyCode: string | null;
  hasHydrated: boolean;
  initialCurrencyCode?: string | null;
  locale?: string | null;
}) {
  const { currencies, storedCurrencyCode, hasHydrated, initialCurrencyCode, locale } = params;
  const activeCodes = new Set(
    currencies.map((currency) => normalizeCurrencyCode(currency.code))
  );
  const defaultCurrency = getDefaultCurrency(currencies);
  const initialCode = initialCurrencyCode
    ? normalizeCurrencyCode(initialCurrencyCode)
    : null;
  const normalizedStoredCode = storedCurrencyCode
    ? normalizeCurrencyCode(storedCurrencyCode)
    : null;

  if (hasHydrated && normalizedStoredCode && activeCodes.has(normalizedStoredCode)) {
    return normalizedStoredCode;
  }

  if (initialCode && activeCodes.has(initialCode)) {
    return initialCode;
  }

  const inferredCode = inferCurrencyCodeFromLocale(locale, currencies);
  if (activeCodes.has(inferredCode)) {
    return inferredCode;
  }

  return defaultCurrency.code;
}

export function CurrencyProvider({
  children,
  initialCurrencies,
  initialCurrencyCode,
  locale,
}: {
  children: ReactNode;
  initialCurrencies: CurrencyRecord[];
  initialCurrencyCode?: string | null;
  locale?: string | null;
}) {
  const [currencies, setCurrencies] = useState<CurrencyRecord[]>(() =>
    getActiveCurrencies(initialCurrencies)
  );
  const storedCurrencyCode = useCurrencyPreferenceStore(
    (state) => state.activeCurrencyCode
  );
  const hasHydrated = useCurrencyPreferenceStore((state) => state.hasHydrated);
  const setStoredCurrencyCode = useCurrencyPreferenceStore(
    (state) => state.setActiveCurrencyCode
  );

  useEffect(() => {
    void useCurrencyPreferenceStore.persist.rehydrate();
  }, []);

  useEffect(() => {
    if (initialCurrencies.length > 0) {
      setCurrencies(getActiveCurrencies(initialCurrencies));
    }
  }, [initialCurrencies]);

  useEffect(() => {
    if (initialCurrencies.length > 0) {
      return;
    }

    async function refreshCurrencies() {
      const { fetchActiveCurrenciesFromRest } = await import('./currency-rest-client');
      const data = await fetchActiveCurrenciesFromRest();

      if (data.length > 0) {
        setCurrencies(
          getActiveCurrencies(data.map((currency) => normalizeCurrencyRecord(currency)))
        );
      }
    }

    void refreshCurrencies();
  }, [initialCurrencies.length]);

  const preferredCurrencyCode = useMemo(
    () =>
      resolvePreferredCurrencyCode({
        currencies,
        storedCurrencyCode,
        hasHydrated,
        initialCurrencyCode,
        locale,
      }),
    [currencies, storedCurrencyCode, hasHydrated, initialCurrencyCode, locale]
  );

  useEffect(() => {
    // Not before the store has hydrated. `rehydrate()` above is synchronous, so on the first
    // pass this effect still holds its pre-hydration closure (nothing stored yet, preferred =
    // the cookie or locale guess) and used to write that guess over the visitor's saved
    // choice whenever the two differed.
    if (!hasHydrated || !preferredCurrencyCode) {
      return;
    }

    if (storedCurrencyCode !== preferredCurrencyCode) {
      setStoredCurrencyCode(preferredCurrencyCode);
    }
  }, [hasHydrated, preferredCurrencyCode, setStoredCurrencyCode, storedCurrencyCode]);

  useEffect(() => {
    if (!preferredCurrencyCode || typeof document === 'undefined') {
      return;
    }

    document.cookie = `${CURRENCY_COOKIE_NAME}=${preferredCurrencyCode}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }, [preferredCurrencyCode]);

  const defaultCurrency = useMemo(
    () => getDefaultCurrency(currencies),
    [currencies]
  );
  const activeCurrency = useMemo(
    () =>
      currencies.find((currency) => currency.code === preferredCurrencyCode) ??
      defaultCurrency,
    [currencies, defaultCurrency, preferredCurrencyCode]
  );

  const contextValue = useMemo<CurrencyContextValue>(
    () => ({
      currencies,
      defaultCurrency,
      activeCurrency,
      activeCurrencyCode: activeCurrency.code,
      isHydrated: hasHydrated,
      setActiveCurrencyCode: (currencyCode: string) => {
        const normalizedCode = normalizeCurrencyCode(currencyCode);
        const exists = currencies.some((currency) => currency.code === normalizedCode);

        if (!exists) {
          return;
        }

        setStoredCurrencyCode(normalizedCode);
      },
    }),
    [activeCurrency, currencies, defaultCurrency, hasHydrated, setStoredCurrencyCode]
  );

  return (
    <CurrencyContext.Provider value={contextValue}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency() {
  const context = useContext(CurrencyContext);

  if (!context) {
    throw new Error('useCurrency must be used inside a CurrencyProvider');
  }

  return context;
}
