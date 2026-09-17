'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@nextblock-cms/ui/select';

import { useTranslations } from '@nextblock-cms/utils';

import { useCurrency } from '../CurrencyProvider';

export function CurrencySwitcher() {
  const {
    activeCurrencyCode,
    currencies,
    setActiveCurrencyCode,
  } = useCurrency();
  const { t } = useTranslations();
  const currencyLabel = t('ecommerce.currency') === 'ecommerce.currency' ? 'Currency' : t('ecommerce.currency');

  if (currencies.length <= 1) {
    return null;
  }

  return (
    <Select value={activeCurrencyCode} onValueChange={setActiveCurrencyCode}>
      {/* Without a label the control's whole accessible name was "CAD". */}
      <SelectTrigger aria-label={currencyLabel} className="h-9 w-[88px] text-xs font-semibold">
        <SelectValue placeholder={activeCurrencyCode} />
      </SelectTrigger>
      <SelectContent>
        {currencies.map((currency) => (
          <SelectItem key={currency.code} value={currency.code}>
            {currency.code}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
