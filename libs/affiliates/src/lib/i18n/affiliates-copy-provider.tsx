'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { AffiliatesCopyOverrides } from './types';

/**
 * The locale and operator overrides for the affiliates copy below this point. Mounted by the
 * `/partners` and `/portal/retailer` layouts with only their areas' override rows (the root
 * layout keeps `affiliates.*` keys out of the global translations payload).
 */
export interface AffiliatesCopyContextValue {
  locale: string;
  overrides: AffiliatesCopyOverrides;
}

export interface AffiliatesCopyProviderProps {
  /** The request locale (`en`, `fr`, …). */
  locale: string;
  /** `translations` rows for this subtree, key → locale → text (see `affiliatesCopyOverridesFromRows`). */
  overrides?: AffiliatesCopyOverrides | null;
  children?: ReactNode;
}

const EMPTY_OVERRIDES: AffiliatesCopyOverrides = Object.freeze({});

const AffiliatesCopyContext = createContext<AffiliatesCopyContextValue | null>(null);

export function AffiliatesCopyProvider({ locale, overrides, children }: AffiliatesCopyProviderProps) {
  const value = useMemo<AffiliatesCopyContextValue>(
    () => ({ locale: typeof locale === 'string' && locale.trim() ? locale.trim() : 'en', overrides: overrides ?? EMPTY_OVERRIDES }),
    [locale, overrides]
  );

  return <AffiliatesCopyContext.Provider value={value}>{children}</AffiliatesCopyContext.Provider>;
}

/** The nearest provider's value, or null outside one. */
export function useAffiliatesCopyContext(): AffiliatesCopyContextValue | null {
  return useContext(AffiliatesCopyContext);
}
