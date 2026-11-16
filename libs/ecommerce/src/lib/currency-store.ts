import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { normalizeCurrencyCode } from '@nextblock-cms/utils/utils';

interface CurrencyPreferenceState {
  activeCurrencyCode: string | null;
  hasHydrated: boolean;
  setActiveCurrencyCode: (currencyCode: string) => void;
  setHasHydrated: (hasHydrated: boolean) => void;
}

export const useCurrencyPreferenceStore = create<CurrencyPreferenceState>()(
  persist(
    (set) => ({
      activeCurrencyCode: null,
      hasHydrated: false,
      setActiveCurrencyCode: (currencyCode) =>
        set({ activeCurrencyCode: normalizeCurrencyCode(currencyCode) }),
      setHasHydrated: (hasHydrated) => set({ hasHydrated }),
    }),
    {
      name: 'currency-preference-storage',
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: (state) => ({
        activeCurrencyCode: state.activeCurrencyCode,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);
