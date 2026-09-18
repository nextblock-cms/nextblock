'use client';

import { useMemo, useState } from 'react';
import { Button } from '@nextblock-cms/ui/button';
import { Input } from '@nextblock-cms/ui/input';
import { Label } from '@nextblock-cms/ui/label';
import { Truck, Calculator, Loader2 } from 'lucide-react';
import { countries } from '../countries';
import { getShippingEstimates } from '../server-actions/shipping-actions';
import { ResolvedShippingMethod } from '../shipping/resolver';
import { useTranslations } from '@nextblock-cms/utils';
import { usePriceFormatter } from '../use-price-formatter';
import { countryUsesStructuredStates, getStatesForCountry, getSubdivisionLabel } from '../states';
import { useCurrency } from '../CurrencyProvider';

interface ShippingEstimatorProps {
  physicalSubtotal: number;
}

export const ShippingEstimator = ({ physicalSubtotal }: ShippingEstimatorProps) => {
  // Locale-aware: see use-price-formatter.ts.
  const formatPrice = usePriceFormatter();
  const [country, setCountry] = useState('CA');
  const [state, setState] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [isCalculating, setIsCalculating] = useState(false);
  const [rates, setRates] = useState<ResolvedShippingMethod[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t, lang } = useTranslations();
  const { activeCurrencyCode } = useCurrency();
  const translateOrFallback = (key: string, fallback: string) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
  };
  const availableStates = getStatesForCountry(country);
  const usesStructuredStates = countryUsesStructuredStates(country);
  // Country names in the visitor's language. The estimator only renders inside the cart,
  // after the store hydrates in the browser, so there is no server HTML to mismatch.
  const regionNames = useMemo(() => {
    try {
      return new Intl.DisplayNames([lang], { type: 'region' });
    } catch {
      return null;
    }
  }, [lang]);
  const selectOptionLabel = translateOrFallback('select_an_option', 'Select an option');
  const statePlaceholder = translateOrFallback('state_province', 'State / Province');

  const handleCalculate = async () => {
    setIsCalculating(true);
    setError(null);
    setRates(null);

    // try/finally: a rejected server action (offline, a deploy in progress) used to leave
    // `isCalculating` true, so the button stayed disabled for the rest of the visit.
    try {
      const result = await getShippingEstimates(
        physicalSubtotal,
        {
          country,
          state: state || undefined,
          postal_code: postalCode,
        },
        lang,
        activeCurrencyCode
      );

      if (result.success && result.methods) {
        setRates(result.methods);
      } else {
        setError(
          result.errorKey
            ? translateOrFallback(
                result.errorKey,
                result.error || t('ecommerce.no_rates_found')
              )
            : result.error || t('ecommerce.no_rates_found')
        );
      }
    } catch (estimateError) {
      console.error('[ShippingEstimator] Failed to load rates:', estimateError);
      setError(
        translateOrFallback(
          'ecommerce.shipping_calculation_failed',
          "We couldn't calculate shipping right now. Please try again."
        )
      );
    } finally {
      setIsCalculating(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 p-4 mt-6">
      <div className="flex items-center gap-2 font-semibold text-sm">
        <Truck className="h-4 w-4" />
        <span>{t('ecommerce.estimate_shipping')}</span>
      </div>

      <div className="grid gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="estimate-country" className="text-xs uppercase tracking-wider text-muted-foreground">
            {t('ecommerce.country')}
          </Label>
          <select
            id="estimate-country"
            name="estimate-country"
            autoComplete="shipping country"
            value={country}
            onChange={(event) => {
              const nextCountry = event.target.value;
              const nextStates = getStatesForCountry(nextCountry);
              setCountry(nextCountry);
              setState(
                nextStates.some((entry) => entry.code === state) ? state : ''
              );
            }}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {countries.map((c: { code: string; name: string }) => (
              <option key={c.code} value={c.code}>
                {regionNames?.of(c.code) ?? c.name}
              </option>
            ))}
          </select>
        </div>

        {usesStructuredStates && (
          <div className="space-y-1.5">
            <Label htmlFor="estimate-state" className="text-xs uppercase tracking-wider text-muted-foreground">
              {t('state_province')}
            </Label>
            <select
              id="estimate-state"
              name="estimate-state"
              autoComplete="shipping address-level1"
              value={state}
              onChange={(event) => setState(event.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">{`${selectOptionLabel}: ${statePlaceholder}`}</option>
              {availableStates.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {getSubdivisionLabel(country, entry, lang)}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="estimate-postal" className="text-xs uppercase tracking-wider text-muted-foreground">
            {t('ecommerce.postal_code')}
          </Label>
          <div className="flex gap-2">
            <Input
              id="estimate-postal"
              name="estimate-postal"
              autoComplete="shipping postal-code"
              // The Canadian pattern only where it applies.
              placeholder={country === 'CA' ? 'A1A 1A1' : undefined}
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !isCalculating) {
                  event.preventDefault();
                  void handleCalculate();
                }
              }}
              className="h-9 text-sm bg-background"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={handleCalculate}
              disabled={isCalculating}
              className="shrink-0"
            >
              {isCalculating ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Calculator className="h-4 w-4 mr-1.5" />}
              {t('ecommerce.calculate')}
            </Button>
          </div>
        </div>
      </div>

      {error && <p role="alert" className="text-xs text-destructive mt-2">{error}</p>}

      {/* Always mounted, so results that arrive later are announced. */}
      <div aria-live="polite">
      {rates && rates.length > 0 && (
        <div className="mt-4 space-y-2 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground uppercase">{t('ecommerce.available_rates')}:</p>
          {rates.map((rate) => (
            <div key={rate.id} className="flex justify-between items-center p-3 border rounded-lg bg-muted/30">
              <div className="flex items-center gap-2">
                <Truck className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{rate.name}</span>
              </div>
              <span className="text-sm font-bold tabular-nums">
                {rate.amount === 0 ? t('ecommerce.free') : formatPrice(rate.amount, activeCurrencyCode)}
              </span>
            </div>
          ))}
        </div>
      )}

      {rates && rates.length === 0 && !error && (
        <p className="text-xs text-muted-foreground mt-2 italic">{t('ecommerce.no_rates_found')}</p>
      )}
      </div>
    </div>
  );
};
