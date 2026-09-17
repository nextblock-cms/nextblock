'use client';

import { Badge } from '@nextblock-cms/ui/badge';
import { Button } from '@nextblock-cms/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@nextblock-cms/ui/card';
import { Checkbox } from '@nextblock-cms/ui/checkbox';
import { Input } from '@nextblock-cms/ui/input';
import { Label } from '@nextblock-cms/ui/label';
import { Separator } from '@nextblock-cms/ui/separator';
import { RadioGroup, RadioGroupItem } from '@nextblock-cms/ui/radio-group';
import { Checkout as FreemiusCheckout } from '@freemius/checkout';
import { getCartItemActivePrice } from '../cart-store';
import { useCart } from '../use-cart';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  FlaskConical,
  X,
  CreditCard,
  ChevronRight,
  MapPin,
  Package,
  Download,
} from 'lucide-react';
import { useTranslations } from '@nextblock-cms/utils';
import { usePriceFormatter } from '../use-price-formatter';
import { countries, normalizeCountryCode } from '../countries';
import { usePaymentReadiness } from '../PaymentReadinessProvider';
import { getShippingEstimates } from '../server-actions/shipping-actions';
import { getTaxEstimate } from '../server-actions/tax-actions';
import { ResolvedShippingMethod } from '../shipping/resolver';
import { type CartItem, isDigitalItem } from '../types';
import { countryUsesStructuredStates, getStatesForCountry } from '../states';
import {
  addressesMatch,
  CheckoutCustomerDefaults,
  CustomerAddressInput,
  emptyCustomerAddress,
  isCustomerAddressComplete,
  normalizeCustomerAddress,
} from '../customer';
import { useCurrency } from '../CurrencyProvider';
import { getTrialSummary } from '../trials';
import { CouponForm } from './CouponForm';
import type { CouponQuote } from '../coupons';

const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
const CHECKOUT_DRAFT_STORAGE_KEY = 'nextblock-checkout-draft-v1';

interface CheckoutProps {
  initialCustomer?: CheckoutCustomerDefaults;
}

type AddressState = ReturnType<typeof buildAddressState>;
type ProviderName = 'stripe' | 'freemius';

function buildAddressState(address?: CustomerAddressInput | null, fallbackName?: string | null) {
  return {
    ...emptyCustomerAddress(),
    company_name: address?.company_name || '',
    recipient_name: address?.recipient_name || fallbackName || '',
    line1: address?.line1 || '',
    line2: address?.line2 || '',
    city: address?.city || '',
    state: address?.state || '',
    postal_code: address?.postal_code || '',
    country_code: normalizeCountryCode(address?.country_code) || 'CA',
  };
}

function isAddressReadyForShippingRates(address?: CustomerAddressInput | null) {
  const normalized = normalizeCustomerAddress(address);

  if (!normalized?.country_code || !normalized.postal_code) {
    return false;
  }

  if (countryUsesStructuredStates(normalized.country_code) && !normalized.state) {
    return false;
  }

  return true;
}

function calculateCartSubtotal(
  items: CartItem[],
  currencyCode: string,
  currencies: ReturnType<typeof useCurrency>['currencies']
) {
  return items.reduce((accumulator, item) => {
    const { price, sale_price } = getCartItemActivePrice(item, {
      currencyCode,
      currencies,
    });

    return accumulator + (sale_price ?? price) * item.quantity;
  }, 0);
}

function AddressForm({
  idPrefix,
  title,
  description,
  value,
  onChange,
}: {
  idPrefix: string;
  title: string;
  description: string;
  value: AddressState;
  onChange: (nextValue: AddressState) => void;
}) {
  const { t, lang } = useTranslations();
  // Country names in the visitor's language; the bundled list is English only. Checkout
  // renders after the cart store hydrates (client only), so there is no server HTML for an
  // ICU difference to mismatch.
  const regionNames = useMemo(() => {
    try {
      return new Intl.DisplayNames([lang], { type: 'region' });
    } catch {
      return null;
    }
  }, [lang]);
  const companyNameLabel =
    t('company_name') === 'company_name' ? 'Company name' : t('company_name');
  const selectOptionLabel =
    t('select_an_option') === 'select_an_option'
      ? 'Select an option'
      : t('select_an_option');
  const statePlaceholder =
    t('state_province') === 'state_province'
      ? 'State / Province'
      : t('state_province');
  const availableStates = getStatesForCountry(value.country_code);
  const usesStructuredStates = countryUsesStructuredStates(value.country_code);

  return (
    <Card>
      <CardHeader>
        {/* CardTitle is a <div>: without the role the page had one h1 and no section headings. */}
        <CardTitle role="heading" aria-level={2} className="flex items-center gap-2">
          <MapPin className="w-5 h-5" />
          {title}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-company`}>{companyNameLabel}</Label>
            <Input
              id={`${idPrefix}-company`}
              name={`${idPrefix}-company`}
              autoComplete={`${idPrefix} organization`}
              value={value.company_name}
              onChange={(e) => onChange({ ...value, company_name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-name`}>{t('full_name')}</Label>
            <Input
              id={`${idPrefix}-name`}
              name={`${idPrefix}-name`}
              autoComplete={`${idPrefix} name`}
              required
              value={value.recipient_name}
              onChange={(e) => onChange({ ...value, recipient_name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-country`}>{t('country')}</Label>
            <select
              id={`${idPrefix}-country`}
              name={`${idPrefix}-country`}
              autoComplete={`${idPrefix} country`}
              required
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={value.country_code}
              onChange={(e) => {
                const nextCountryCode = e.target.value;
                const nextStates = getStatesForCountry(nextCountryCode);
                onChange({
                  ...value,
                  country_code: nextCountryCode,
                  state: nextStates.some((entry) => entry.code === value.state) ? value.state : '',
                });
              }}
            >
              {countries.map((country) => (
                <option key={country.code} value={country.code}>
                  {regionNames?.of(country.code) ?? country.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-line1`}>{t('address_line_1')}</Label>
          <Input
            id={`${idPrefix}-line1`}
            name={`${idPrefix}-line1`}
            autoComplete={`${idPrefix} address-line1`}
            required
            value={value.line1}
            onChange={(e) => onChange({ ...value, line1: e.target.value })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-line2`}>{t('address_line_2')}</Label>
          <Input
            id={`${idPrefix}-line2`}
            name={`${idPrefix}-line2`}
            autoComplete={`${idPrefix} address-line2`}
            value={value.line2}
            onChange={(e) => onChange({ ...value, line2: e.target.value })}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-city`}>{t('city')}</Label>
            <Input
              id={`${idPrefix}-city`}
              name={`${idPrefix}-city`}
              autoComplete={`${idPrefix} address-level2`}
              required
              value={value.city}
              onChange={(e) => onChange({ ...value, city: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-state`}>{t('state_province')}</Label>
            {usesStructuredStates ? (
              <select
                id={`${idPrefix}-state`}
                name={`${idPrefix}-state`}
                autoComplete={`${idPrefix} address-level1`}
                required
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={value.state}
                onChange={(e) => onChange({ ...value, state: e.target.value })}
              >
                <option value="">{`${selectOptionLabel}: ${statePlaceholder}`}</option>
                {availableStates.map((state) => (
                  <option key={state.code} value={state.code}>
                    {state.name}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={`${idPrefix}-state`}
                name={`${idPrefix}-state`}
                autoComplete={`${idPrefix} address-level1`}
                value={value.state}
                onChange={(e) => onChange({ ...value, state: e.target.value })}
              />
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-postal`}>{t('postal_zip_code')}</Label>
            <Input
              id={`${idPrefix}-postal`}
              name={`${idPrefix}-postal`}
              autoComplete={`${idPrefix} postal-code`}
              required
              value={value.postal_code}
              onChange={(e) => onChange({ ...value, postal_code: e.target.value })}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CheckoutSection({
  title,
  description,
  badgeLabel,
  children,
}: {
  title: string;
  description: string;
  badgeLabel?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle role="heading" aria-level={2}>{title}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
          {badgeLabel ? <Badge variant="secondary">{badgeLabel}</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

export const Checkout = ({ initialCustomer }: CheckoutProps) => {
  // Locale-aware: see use-price-formatter.ts.
  const formatPrice = usePriceFormatter();
  const [trialPreferences, setTrialPreferences] = useState<Record<string, 'free' | 'paid'>>({});
  const [processingKey, setProcessingKey] = useState<string | null>(null);
  const [checkoutErrors, setCheckoutErrors] = useState<Partial<Record<ProviderName, string>>>({});
  const [email, setEmail] = useState(initialCustomer?.email || '');
  const [emailError, setEmailError] = useState('');
  const [phone, setPhone] = useState(initialCustomer?.phone || '');
  const [showSandboxModal, setShowSandboxModal] = useState(false);
  const [sandboxProvider, setSandboxProvider] = useState<ProviderName | null>(null);
  const [isLoadingRates, setIsLoadingRates] = useState(false);
  const [ratesFailed, setRatesFailed] = useState(false);
  const [isLoadingTaxes, setIsLoadingTaxes] = useState(false);
  const [shippingMethods, setShippingMethods] = useState<ResolvedShippingMethod[]>([]);
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null);
  const [taxEstimate, setTaxEstimate] = useState<Awaited<
    ReturnType<typeof getTaxEstimate>
  >['tax'] | null>(null);
  const [couponQuote, setCouponQuote] = useState<CouponQuote | null>(null);
  const [billingAddress, setBillingAddress] = useState(() =>
    buildAddressState(initialCustomer?.billingAddress, initialCustomer?.fullName)
  );
  const [shippingAddress, setShippingAddress] = useState(() =>
    buildAddressState(
      initialCustomer?.shippingAddress ?? initialCustomer?.billingAddress,
      initialCustomer?.fullName
    )
  );
  const [useBillingForShipping, setUseBillingForShipping] = useState(
    !initialCustomer?.shippingAddress ||
      addressesMatch(initialCustomer?.billingAddress, initialCustomer?.shippingAddress)
  );

  const store = useCart((state) => state);
  const { t, lang } = useTranslations();
  const { activeCurrencyCode, currencies } = useCurrency();
  const paymentReadiness = usePaymentReadiness();
  const items = store?.items ?? [];
  const stripeItems = useMemo(
    () => items.filter((item) => !isDigitalItem(item)),
    [items]
  );
  const freemiusItems = useMemo(
    () => items.filter((item) => isDigitalItem(item)),
    [items]
  );
  const isAuthenticated = initialCustomer?.isAuthenticated ?? false;

  const translateOrFallback = (
    key: string,
    fallback: string,
    params?: Record<string, string | number>
  ) => {
    const translated = t(key, params);
    if (translated !== key) {
      return translated;
    }

    if (!params) {
      return fallback;
    }

    let interpolatedFallback = fallback;

    Object.entries(params).forEach(([paramKey, value]) => {
      interpolatedFallback = interpolatedFallback.replace(
        new RegExp(`\\{${paramKey}\\}`, 'g'),
        String(value)
      );
    });

    return interpolatedFallback;
  };

  const hasPhysicalProducts = stripeItems.length > 0;
  const overallSubtotal = useMemo(
    () => calculateCartSubtotal(items, activeCurrencyCode, currencies),
    [activeCurrencyCode, currencies, items]
  );
  const stripeSubtotal = useMemo(
    () => calculateCartSubtotal(stripeItems, activeCurrencyCode, currencies),
    [activeCurrencyCode, currencies, stripeItems]
  );
  const freemiusSubtotal = useMemo(
    () => calculateCartSubtotal(freemiusItems, activeCurrencyCode, currencies),
    [activeCurrencyCode, currencies, freemiusItems]
  );
  const stripeDiscountTotal = couponQuote?.providerDiscounts.stripe ?? 0;
  const freemiusDiscountTotal = couponQuote?.providerDiscounts.freemius ?? 0;
  const discountedStripeSubtotal = Math.max(0, stripeSubtotal - stripeDiscountTotal);
  const discountedFreemiusSubtotal = Math.max(0, freemiusSubtotal - freemiusDiscountTotal);

  const shippingAddressForRates = useMemo(
    () => (useBillingForShipping ? billingAddress : shippingAddress),
    [billingAddress, shippingAddress, useBillingForShipping]
  );
  const taxAddress = useMemo(
    () => (hasPhysicalProducts ? shippingAddressForRates : billingAddress),
    [billingAddress, hasPhysicalProducts, shippingAddressForRates]
  );
  const isShippingAddressReadyForRates =
    !hasPhysicalProducts || isAddressReadyForShippingRates(shippingAddressForRates);

  const selectedMethod = useMemo(
    () => shippingMethods.find((method) => method.id === selectedMethodId),
    [shippingMethods, selectedMethodId]
  );

  const stripeTotal = useMemo(
    () =>
      discountedStripeSubtotal +
      (selectedMethod?.amount ?? 0) +
      (taxEstimate && !taxEstimate.isPendingExternalCalculation ? taxEstimate.amount : 0),
    [discountedStripeSubtotal, selectedMethod, taxEstimate]
  );
  const overallEstimatedTotal = stripeTotal + discountedFreemiusSubtotal;

  useEffect(() => {
    if (isAuthenticated || typeof window === 'undefined') {
      return;
    }

    try {
      const rawDraft = window.localStorage.getItem(CHECKOUT_DRAFT_STORAGE_KEY);
      if (!rawDraft) {
        return;
      }

      const draft = JSON.parse(rawDraft) as {
        email?: string;
        phone?: string;
        billingAddress?: CustomerAddressInput | null;
        shippingAddress?: CustomerAddressInput | null;
        useBillingForShipping?: boolean;
        selectedMethodId?: string | null;
      };

      if (draft.email) {
        setEmail(draft.email);
      }
      if (draft.phone) {
        setPhone(draft.phone);
      }
      if (draft.billingAddress) {
        setBillingAddress(buildAddressState(draft.billingAddress));
      }
      if (draft.shippingAddress) {
        setShippingAddress(buildAddressState(draft.shippingAddress));
      }
      if (typeof draft.useBillingForShipping === 'boolean') {
        setUseBillingForShipping(draft.useBillingForShipping);
      }
      if (typeof draft.selectedMethodId === 'string' || draft.selectedMethodId === null) {
        setSelectedMethodId(draft.selectedMethodId);
      }
    } catch (error) {
      console.error('[Checkout] Failed to restore checkout draft:', error);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    // Storage can be blocked or full (private mode, site-data settings). The read above was
    // guarded, these writes were not: a throw inside an effect unmounted the whole checkout.
    try {
      if (isAuthenticated) {
        window.localStorage.removeItem(CHECKOUT_DRAFT_STORAGE_KEY);
        return;
      }

      window.localStorage.setItem(
        CHECKOUT_DRAFT_STORAGE_KEY,
        JSON.stringify({
          email,
          phone,
          billingAddress,
          shippingAddress,
          useBillingForShipping,
          selectedMethodId,
        })
      );
    } catch {
      // The draft is a convenience; checkout works without it.
    }
  }, [
    billingAddress,
    email,
    isAuthenticated,
    phone,
    selectedMethodId,
    shippingAddress,
    useBillingForShipping,
  ]);

  useEffect(() => {
    if (!hasPhysicalProducts) {
      setShippingMethods([]);
      setSelectedMethodId(null);
      setIsLoadingRates(false);
      return;
    }

    if (!isShippingAddressReadyForRates) {
      setShippingMethods([]);
      setSelectedMethodId(null);
      setIsLoadingRates(false);
      return;
    }

    let isCancelled = false;

    const fetchRates = async () => {
      if (!shippingAddressForRates.country_code) {
        return;
      }

      setIsLoadingRates(true);
      setRatesFailed(false);

      try {
        const result = await getShippingEstimates(
          discountedStripeSubtotal,
          {
            country: shippingAddressForRates.country_code,
            state: shippingAddressForRates.state,
            postal_code: shippingAddressForRates.postal_code,
          },
          lang,
          activeCurrencyCode
        );

        if (isCancelled) {
          return;
        }

        if (result.success && result.methods) {
          const methods = result.methods;
          setShippingMethods(methods);
          // A functional update keeps the shopper's pick when it is still offered WITHOUT
          // listing `selectedMethodId` as a dependency. It used to be one, so every click on
          // a rate (and the auto-select below) re-ran this effect: the list flashed back to a
          // spinner, the pay button disabled, and each address change fetched twice.
          setSelectedMethodId((current) =>
            current && methods.some((method) => method.id === current)
              ? current
              : (methods[0]?.id ?? null)
          );
        } else {
          setShippingMethods([]);
          setSelectedMethodId(null);
        }
      } catch (error) {
        // A rejected server action (offline, a deploy in progress) used to leave
        // `isLoadingRates` true forever: endless spinner, pay button disabled for good.
        if (isCancelled) {
          return;
        }

        console.error('[Checkout] Failed to load shipping rates:', error);
        setShippingMethods([]);
        setSelectedMethodId(null);
        setRatesFailed(true);
      } finally {
        if (!isCancelled) {
          setIsLoadingRates(false);
        }
      }
    };

    const timer = setTimeout(fetchRates, 400);
    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [
    activeCurrencyCode,
    hasPhysicalProducts,
    isShippingAddressReadyForRates,
    lang,
    shippingAddressForRates.country_code,
    shippingAddressForRates.postal_code,
    shippingAddressForRates.state,
    discountedStripeSubtotal,
  ]);

  useEffect(() => {
    // Without this flag a slow response for an OLD address could land after a newer one and
    // overwrite it: wrong tax, wrong total. (The rates effect above always had one.)
    let isCancelled = false;

    const loadTaxes = async () => {
      if (!hasPhysicalProducts || !taxAddress.country_code) {
        setIsLoadingTaxes(false);
        setTaxEstimate(null);
        return;
      }

      if (countryUsesStructuredStates(taxAddress.country_code) && !taxAddress.state) {
        setIsLoadingTaxes(false);
        setTaxEstimate(null);
        return;
      }

      setIsLoadingTaxes(true);

      try {
        const result = await getTaxEstimate(
          stripeItems,
          {
            country_code: taxAddress.country_code,
            state: taxAddress.state,
          },
          activeCurrencyCode,
          couponQuote?.code ?? null,
          items
        );

        if (isCancelled) {
          return;
        }

        setTaxEstimate(result.success && result.tax ? result.tax : null);
      } catch (error) {
        if (isCancelled) {
          return;
        }

        // A rejected action used to leave the tax line on its placeholder forever.
        console.error('[Checkout] Failed to load the tax estimate:', error);
        setTaxEstimate(null);
      } finally {
        if (!isCancelled) {
          setIsLoadingTaxes(false);
        }
      }
    };

    const timer = setTimeout(loadTaxes, 300);
    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [
    activeCurrencyCode,
    hasPhysicalProducts,
    stripeItems,
    taxAddress.country_code,
    taxAddress.state,
    couponQuote?.code,
    items,
  ]);

  // Back from Stripe through the back/forward cache restores this page exactly as it was
  // left: `processingKey` still set, every pay button spinning and disabled, no way out.
  useEffect(() => {
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setProcessingKey(null);
      }
    };

    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, []);

  if (!store) {
    return null;
  }

  const closeSandboxModal = () => {
    setShowSandboxModal(false);
    setSandboxProvider(null);
  };

  const sandboxModal = showSandboxModal ? (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain bg-black/60 backdrop-blur-sm"
      onClick={closeSandboxModal}
      onKeyDown={(event) => {
        if (event.key === 'Escape') closeSandboxModal();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sandbox-checkout-title"
        className="relative bg-background border rounded-xl shadow-2xl p-8 max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* autoFocus: keyboard focus starts inside the dialog, where Escape is handled. */}
        <button
          type="button"
          autoFocus
          onClick={closeSandboxModal}
          aria-label={translateOrFallback('close', 'Close')}
          className="absolute top-4 right-4 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-full bg-amber-100 dark:bg-amber-900/20">
            <FlaskConical className="h-6 w-6 text-amber-600 dark:text-amber-400" />
          </div>
          <h2 id="sandbox-checkout-title" className="text-xl font-semibold">{t('ecommerce.checkout_successful')}</h2>
        </div>
        <p className="text-muted-foreground mb-2">{t('ecommerce.sandbox_notice')}</p>
        <p className="text-muted-foreground mb-2">
          {sandboxProvider === 'stripe'
            ? translateOrFallback(
                'ecommerce.sandbox_checkout_stripe_description',
                'This simulated step represents the Stripe checkout for physical products.'
              )
            : translateOrFallback(
                'ecommerce.sandbox_checkout_freemius_description',
                'This simulated step represents the Freemius checkout for digital products.'
              )}
        </p>
        <p className="text-muted-foreground mb-6">{t('ecommerce.license_notice')}</p>
        <a
          href="https://nextblock.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full text-center py-3 px-4 rounded-lg bg-primary text-primary-foreground font-semibold hover:opacity-90 transition-opacity"
        >
          {t('ecommerce.purchase_at')}
        </a>
      </div>
    </div>
  ) : null;

  // Validation answers inline, in the error box beside the button that was pressed, and
  // moves focus to the field that needs attention. It used to call `alert()`, and the email
  // error only appeared in a field that on a phone sits several screens above the pay
  // button, so the press looked dead.
  const failValidation = (provider: ProviderName, message: string, focusId?: string) => {
    setCheckoutErrors((current) => ({ ...current, [provider]: message }));
    if (focusId) {
      document.getElementById(focusId)?.focus();
    }
    return null;
  };
  const firstMissingAddressFieldId = (prefix: string, address: AddressState) => {
    if (!address.recipient_name.trim()) return `${prefix}-name`;
    if (!address.line1.trim()) return `${prefix}-line1`;
    if (!address.city.trim()) return `${prefix}-city`;
    if (countryUsesStructuredStates(address.country_code) && !address.state) return `${prefix}-state`;
    if (!address.postal_code.trim()) return `${prefix}-postal`;
    return `${prefix}-line1`;
  };

  const validateSharedFields = (provider: ProviderName) => {
    if (!isAuthenticated && (!email || !/^\S+@\S+\.\S+$/.test(email))) {
      setEmailError(t('ecommerce.invalid_email'));
      return failValidation(provider, t('ecommerce.invalid_email'), 'checkout-email');
    }

    const normalizedBillingAddress = normalizeCustomerAddress(billingAddress);
    if (!isCustomerAddressComplete(normalizedBillingAddress)) {
      return failValidation(
        provider,
        t('checkout_complete_billing_address'),
        firstMissingAddressFieldId('billing', billingAddress)
      );
    }

    const normalizedShippingAddress = hasPhysicalProducts
      ? normalizeCustomerAddress(useBillingForShipping ? billingAddress : shippingAddress)
      : null;

    if (provider === 'stripe') {
      if (!isCustomerAddressComplete(normalizedShippingAddress)) {
        return failValidation(
          provider,
          t('checkout_complete_shipping_address'),
          useBillingForShipping
            ? firstMissingAddressFieldId('billing', billingAddress)
            : firstMissingAddressFieldId('shipping', shippingAddress)
        );
      }

      if (!selectedMethodId) {
        return failValidation(
          provider,
          translateOrFallback(
            'ecommerce.shipping_method_required',
            'Please select a shipping method before continuing.'
          )
        );
      }
    }

    setEmailError('');

    return {
      normalizedBillingAddress,
      normalizedShippingAddress,
    };
  };

  const handlePay = async (
    provider: ProviderName,
    checkoutItems: CartItem[],
    checkoutKey: string
  ) => {
    setCheckoutErrors((current) => ({
      ...current,
      [provider]: '',
    }));

    const normalizedAddresses = validateSharedFields(provider);
    if (!normalizedAddresses) {
      return;
    }

    if (isSandbox) {
      const checkoutItemIds = new Set(checkoutItems.map((item) => item.id));
      const remainingItems = items.filter((item) => !checkoutItemIds.has(item.id));

      store.setItems(remainingItems);
      if (remainingItems.length === 0) {
        store.removeCoupon();
      }
      setSandboxProvider(provider);
      setShowSandboxModal(true);

      if (typeof window !== 'undefined' && remainingItems.length === 0) {
        try {
          window.localStorage.removeItem(CHECKOUT_DRAFT_STORAGE_KEY);
        } catch {
          // Blocked storage must not stop the sandbox confirmation.
        }
      }

      return;
    }

    setProcessingKey(checkoutKey);

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: checkoutItems,
          customerEmail: isAuthenticated ? undefined : email,
          customerPhone: phone || null,
          billingAddress: normalizedAddresses.normalizedBillingAddress,
          shippingAddress:
            provider === 'stripe' ? normalizedAddresses.normalizedShippingAddress : null,
          shippingMethodId: provider === 'stripe' ? selectedMethodId : null,
          locale: lang,
          currencyCode: activeCurrencyCode,
          couponCode: couponQuote?.code ?? store.appliedCoupon?.code ?? null,
          couponContextItems: items,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        const translatedError =
          data?.errorKey && typeof data.errorKey === 'string'
            ? translateOrFallback(
                data.errorKey,
                data?.error || translateOrFallback('ecommerce.generic_error', 'Something went wrong.'),
                data.errorParams
              )
            : data?.error || t('ecommerce.generic_error');

        setCheckoutErrors((current) => ({
          ...current,
          [provider]: translatedError,
        }));
        setProcessingKey(null);
        return;
      }

      if (data.customProps && data.customProps.provider === 'freemius') {
        const cp = data.customProps;
        let checkoutSyncPromise: Promise<void> | null = null;
        const redirectToFreemiusSuccess = () => {
          window.location.href = `/checkout/success?session_id=${cp.order_id}`;
        };
        const syncFreemiusCheckout = (checkoutResponse: any) => {
          if (!checkoutSyncPromise) {
            checkoutSyncPromise = fetch('/api/checkout/freemius/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                orderId: cp.order_id,
                checkoutResponse,
              }),
            }).then(async (syncResponse) => {
              if (!syncResponse.ok) {
                const syncPayload = await syncResponse.json().catch(() => null);
                console.error('Freemius checkout sync failed:', syncPayload);
              }
            });
          }

          return checkoutSyncPromise;
        };
        const checkoutConfig = {
          product_id: cp.plugin_id,
          public_key: cp.public_key,
          sandbox: cp.sandbox,
        };
        const openConfig = {
          name: t('ecommerce.checkout_overlay_title'),
          plan_id: cp.plan_id,
          ...(cp.billing_cycle ? { billing_cycle: cp.billing_cycle } : {}),
          ...(cp.trial ? { trial: cp.trial } : {}),
          ...(cp.coupon ? { coupon: cp.coupon } : {}),
          user_email: cp.user_email,
          user_firstname: cp.user_firstname,
          user_lastname: cp.user_lastname,
          sandbox: cp.sandbox,
          purchaseCompleted: function (checkoutResponse: any) {
            void syncFreemiusCheckout(checkoutResponse);
          },
          success: function (checkoutResponse: any) {
            void (async () => {
              try {
                await syncFreemiusCheckout(checkoutResponse);
              } finally {
                redirectToFreemiusSuccess();
              }
            })();
          },
        };

        try {
          const handler = new FreemiusCheckout(checkoutConfig);
          handler.open(openConfig);
          setProcessingKey(null);
        } catch (error) {
          // Shown in the error box, without the raw (English) exception text.
          console.error('[Checkout] Freemius overlay failed to open:', error);
          setCheckoutErrors((current) => ({
            ...current,
            [provider]: t('ecommerce.checkout_popup_blocked'),
          }));
          if (data.url) {
            window.location.href = data.url;
          }
          setProcessingKey(null);
        }
      } else if (data.url) {
        window.location.href = data.url;
      } else {
        setCheckoutErrors((current) => ({
          ...current,
          [provider]:
            t('ecommerce.checkout_failed') +
            (data.error ||
              translateOrFallback('ecommerce.unknown_error', 'Unknown error')),
        }));
        setProcessingKey(null);
      }
    } catch (error) {
      console.error(error);
      setCheckoutErrors((current) => ({
        ...current,
        [provider]: t('ecommerce.generic_error'),
      }));
      setProcessingKey(null);
    }
  };

  if (items.length === 0) {
    return (
      <>
        {sandboxModal}
        <div className="container mx-auto flex min-h-[50vh] flex-col items-center justify-center p-8 text-center">
          <h1 className="mb-4 text-2xl font-bold">{t('ecommerce.cart_empty')}</h1>
          <p className="mb-8 text-muted-foreground">{t('ecommerce.cart_empty_description')}</p>
          <Button asChild>
            {/* `/shop` for every language: the page redirects to its translation when one
                exists, and a translated slug here would 404 on installs without that page. */}
            <a href="/shop">{t('ecommerce.go_to_shop')}</a>
          </Button>
        </div>
      </>
    );
  }

  // A cart can outlive the store's ability to charge for it — items added before the
  // keys were removed, or a /checkout deep link minted by the UCP agent surface. The
  // /api/checkout preflight refuses these server-side; disabling the buttons here just
  // means the shopper is told before they click rather than after.
  //
  // Resolved per provider, not once for the store: a Stripe-only shop must keep its
  // physical checkout fully working while its digital section explains itself.
  const paymentsUnavailableMessage = translateOrFallback(
    'ecommerce.checkout_payments_unavailable',
    'This store is not able to take payments right now. Please contact the seller to complete your purchase.'
  );
  const stripeUnavailableMessage = paymentReadiness.stripe ? null : paymentsUnavailableMessage;
  const freemiusUnavailableMessage = paymentReadiness.freemius ? null : paymentsUnavailableMessage;

  const stripeCheckoutDisabledMessage = stripeUnavailableMessage
    ? stripeUnavailableMessage
    : hasPhysicalProducts
    ? !isShippingAddressReadyForRates
      ? translateOrFallback(
          'ecommerce.waiting_on_address_info',
          'Complete your shipping address to view available shipping options.'
        )
      : isLoadingRates
        ? translateOrFallback(
            'ecommerce.calculating_shipping',
            'Calculating shipping...'
          )
        : !selectedMethodId
          ? shippingMethods.length > 0
            ? t('ecommerce.select_rate')
            : t('ecommerce.no_rates_for_region')
          : null
    : null;
  const isStripeCheckoutDisabled =
    processingKey !== null || stripeCheckoutDisabledMessage !== null;
  const stripeItemCountLabel =
    stripeItems.length === 1
      ? translateOrFallback('ecommerce.item_count_one', '{count} item', {
          count: stripeItems.length,
        })
      : translateOrFallback('ecommerce.item_count_other', '{count} items', {
          count: stripeItems.length,
        });
  const freemiusLicenseCountLabel =
    freemiusItems.length === 1
      ? translateOrFallback('ecommerce.license_count_one', '{count} license', {
          count: freemiusItems.length,
        })
      : translateOrFallback('ecommerce.license_count_other', '{count} licenses', {
          count: freemiusItems.length,
        });
  const productTypeBadgeLabel = (item: CartItem) =>
    isDigitalItem(item)
      ? translateOrFallback('ecommerce.digital_label', 'Digital')
      : translateOrFallback('ecommerce.physical_label', 'Physical');
  const checkoutBillingCycleLabel = (billingCycle: CartItem['billing_cycle']) => {
    if (billingCycle === 'monthly') {
      return translateOrFallback(
        'ecommerce.checkout_billing_cycle_monthly',
        'Monthly subscription'
      );
    }

    if (billingCycle === 'annual') {
      return translateOrFallback(
        'ecommerce.checkout_billing_cycle_annual',
        'Annual subscription'
      );
    }

    if (billingCycle === 'lifetime') {
      return translateOrFallback(
        'ecommerce.checkout_billing_cycle_lifetime',
        'Lifetime subscription'
      );
    }

    return null;
  };

  return (
    <div className="container mx-auto px-4 py-12 md:px-6">
      {sandboxModal}

      <div className="mx-auto max-w-6xl">
        <h1 className="mb-8 text-3xl font-bold">{t('ecommerce.checkout')}</h1>

        <div className="grid gap-8 lg:grid-cols-12 lg:items-start">
          <div className="lg:col-span-8 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={2} className="flex items-center gap-2">
                  <CreditCard className="w-5 h-5" />
                  {t('ecommerce.contact_information')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {isAuthenticated ? (
                  <div className="rounded-xl border bg-muted/20 p-4 text-sm text-muted-foreground">
                    {t('checkout_prefill_notice', { email: initialCustomer?.email || '' })}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="checkout-email">
                      {t('ecommerce.email_address')} <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="checkout-email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      spellCheck={false}
                      aria-invalid={emailError ? true : undefined}
                      aria-describedby={emailError ? 'checkout-email-error' : undefined}
                      placeholder={t('ecommerce.email_placeholder')}
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        if (emailError) {
                          setEmailError('');
                        }
                      }}
                      required
                    />
                    {emailError ? (
                      <p id="checkout-email-error" role="alert" className="text-xs text-destructive mt-1">
                        {emailError}
                      </p>
                    ) : null}
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="checkout-phone">{t('phone_number')}</Label>
                  <Input
                    id="checkout-phone"
                    name="phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder={t('optional')}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
              </CardContent>
            </Card>

            <AddressForm
              idPrefix="billing"
              title={t('billing_address')}
              description={t('checkout_billing_address_help')}
              value={billingAddress}
              onChange={setBillingAddress}
            />

            {hasPhysicalProducts ? (
              <div className="flex items-center space-x-3 rounded-xl border bg-muted/20 p-4">
                <Checkbox
                  id="use-billing-for-shipping"
                  checked={useBillingForShipping}
                  onCheckedChange={(checked) => setUseBillingForShipping(Boolean(checked))}
                />
                <div className="space-y-1">
                  <Label htmlFor="use-billing-for-shipping" className="cursor-pointer">
                    {t('use_billing_for_shipping')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('checkout_use_billing_for_shipping_help')}
                  </p>
                </div>
              </div>
            ) : null}

            {hasPhysicalProducts && !useBillingForShipping ? (
              <AddressForm
                idPrefix="shipping"
                title={t('shipping_address')}
                description={t('checkout_shipping_address_help')}
                value={shippingAddress}
                onChange={setShippingAddress}
              />
            ) : null}

            {hasPhysicalProducts ? (
              <Card>
                <CardHeader>
                  <CardTitle role="heading" aria-level={2} className="flex items-center gap-2">
                    <ChevronRight className="w-5 h-5 text-primary" />
                    {t('ecommerce.shipping_method')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {isLoadingRates ? (
                    <div role="status" className="flex items-center justify-center py-6">
                      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                      <span className="sr-only">
                        {translateOrFallback('ecommerce.calculating_shipping', 'Calculating shipping…')}
                      </span>
                    </div>
                  ) : ratesFailed ? (
                    <div role="alert" className="rounded-lg bg-destructive/10 px-4 py-3 text-center text-sm text-destructive">
                      {translateOrFallback(
                        'ecommerce.shipping_calculation_failed',
                        "We couldn't calculate shipping right now. Please try again."
                      )}
                    </div>
                  ) : shippingMethods.length > 0 ? (
                    // A real radio group. These rows used to be <div onClick>: no role, no
                    // tab stop, no keys, so a keyboard user could not change the shipping method.
                    <RadioGroup
                      value={selectedMethodId ?? ''}
                      onValueChange={setSelectedMethodId}
                      aria-label={t('ecommerce.shipping_method')}
                      className="space-y-3"
                    >
                      {shippingMethods.map((method) => (
                        <Label
                          key={method.id}
                          htmlFor={`shipping-method-${method.id}`}
                          className={`flex items-center justify-between gap-3 p-4 rounded-lg border-2 cursor-pointer transition-colors ${
                            selectedMethodId === method.id
                              ? 'border-primary bg-primary/5'
                              : 'border-border hover:border-muted-foreground/40'
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-3">
                            <RadioGroupItem id={`shipping-method-${method.id}`} value={method.id} />
                            <span className="font-medium break-words">{method.name}</span>
                          </span>
                          <span className="font-bold tabular-nums">
                            {formatPrice(method.amount, activeCurrencyCode)}
                          </span>
                        </Label>
                      ))}
                    </RadioGroup>
                  ) : (
                    <div className="py-4 text-center text-muted-foreground bg-muted/30 rounded-lg italic">
                      {isShippingAddressReadyForRates
                        ? t('ecommerce.no_rates_for_region')
                        : translateOrFallback(
                            'ecommerce.waiting_on_address_info',
                            'Complete your shipping address to view available shipping options.'
                          )}
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : null}
          </div>

          <div className="lg:col-span-4 space-y-6">
            <Card className="top-6">
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>{t('ecommerce.order_summary')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3 max-h-[260px] overflow-y-auto pr-2">
                  {items.map((item) => {
                    const activePrice = getCartItemActivePrice(item, {
                      currencyCode: activeCurrencyCode,
                      currencies,
                    });
                    const trialSummary = getTrialSummary(item, t);

                    return (
                      <div key={`${item.id}-${item.variant_id || 'base'}`} className="flex items-start justify-between gap-4">
                        <div className="flex gap-3">
                          {item.image_url ? (
                            <div className="h-10 w-10 shrink-0 overflow-hidden rounded border bg-neutral-100">
                              <img src={item.image_url} alt={item.title} className="h-full w-full object-cover" />
                            </div>
                          ) : null}
                          <div className="grid gap-0.5">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-xs line-clamp-1">{item.title}</span>
                              <Badge variant="outline" className="text-[9px] uppercase">
                                {productTypeBadgeLabel(item)}
                              </Badge>
                            </div>
                            {item.variant_label ? (
                              <span className="text-[10px] text-muted-foreground line-clamp-1">
                                {item.variant_label}
                              </span>
                            ) : null}
                            <span className="text-[10px] text-muted-foreground">
                              {t('ecommerce.qty')}: {item.quantity}
                            </span>
                            {trialSummary ? (
                              <span className="text-[10px] font-medium text-emerald-700">
                                {trialSummary.label} - {trialSummary.paymentRequirementLabel}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-0.5 shrink-0">
                          <span className="font-medium text-xs">
                            {formatPrice(
                              (activePrice.sale_price ?? activePrice.price) * item.quantity,
                              activeCurrencyCode
                            )}
                          </span>
                          {activePrice.sale_price ? (
                            <span className="text-[9px] text-muted-foreground line-through">
                              {formatPrice(activePrice.price * item.quantity, activeCurrencyCode)}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <Separator />

                <CouponForm
                  items={items}
                  currencyCode={activeCurrencyCode}
                  onQuoteChange={setCouponQuote}
                />

                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span>{t('ecommerce.subtotal')}</span>
                    <span>{formatPrice(overallSubtotal, activeCurrencyCode)}</span>
                  </div>
                  {stripeItems.length > 0 ? (
                    <div className="flex justify-between text-muted-foreground">
                      <span>
                        {translateOrFallback(
                          'ecommerce.physical_products',
                          'Physical products'
                        )}
                      </span>
                      <span>{formatPrice(stripeSubtotal, activeCurrencyCode)}</span>
                    </div>
                  ) : null}
                  {freemiusItems.length > 0 ? (
                    <div className="flex justify-between text-muted-foreground">
                      <span>
                        {translateOrFallback(
                          'ecommerce.digital_products',
                          'Digital products'
                        )}
                      </span>
                      <span>{formatPrice(freemiusSubtotal, activeCurrencyCode)}</span>
                    </div>
                  ) : null}
                  {couponQuote ? (
                    <div className="flex justify-between text-emerald-600">
                      <span>
                        {translateOrFallback('ecommerce.discount', 'Discount')} ({couponQuote.code})
                      </span>
                      <span>-{formatPrice(couponQuote.discountTotal, activeCurrencyCode)}</span>
                    </div>
                  ) : null}
                  {(stripeItems.length > 0 || freemiusItems.length > 0) && (
                    <div className="flex justify-between font-bold text-lg pt-2 border-t mt-2">
                      <span>
                        {translateOrFallback(
                          'ecommerce.estimated_total',
                          'Estimated total'
                        )}
                      </span>
                      <span className="text-primary">
                        {formatPrice(overallEstimatedTotal, activeCurrencyCode)}
                      </span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {stripeItems.length > 0 ? (
              <CheckoutSection
                title={translateOrFallback(
                  'ecommerce.stripe_checkout_title',
                  'Stripe Checkout'
                )}
                description={translateOrFallback(
                  'ecommerce.stripe_checkout_description',
                  'Pay for physical products in one Stripe checkout session.'
                )}
                badgeLabel={stripeItemCountLabel}
              >
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span>
                      {translateOrFallback(
                        'ecommerce.physical_subtotal',
                        'Physical subtotal'
                      )}
                    </span>
                    <span>{formatPrice(stripeSubtotal, activeCurrencyCode)}</span>
                  </div>
                  {stripeDiscountTotal > 0 ? (
                    <div className="flex justify-between text-emerald-600">
                      <span>
                        {translateOrFallback('ecommerce.discount', 'Discount')}
                      </span>
                      <span>-{formatPrice(stripeDiscountTotal, activeCurrencyCode)}</span>
                    </div>
                  ) : null}
                  <div className="flex justify-between">
                    <span>{t('ecommerce.shipping')}</span>
                    <span>{selectedMethod ? formatPrice(selectedMethod.amount, activeCurrencyCode) : '-'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{translateOrFallback('ecommerce.tax', 'Tax')}</span>
                    <span>
                      {isLoadingTaxes ? (
                        '...'
                      ) : taxEstimate?.isPendingExternalCalculation ? (
                        translateOrFallback(
                          'ecommerce.tax_calculated_on_stripe',
                          'Calculated on Stripe'
                        )
                      ) : taxEstimate ? (
                        formatPrice(taxEstimate.amount, activeCurrencyCode)
                      ) : (
                        '-'
                      )}
                    </span>
                  </div>
                  {taxEstimate && taxEstimate.lines.length > 0 ? (
                    <div className="rounded-lg bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                      {taxEstimate.lines.map((line) => (
                        <div key={line.id || `${line.name}-${line.rate}`} className="flex justify-between gap-3">
                          <span>
                            {line.name} ({line.rate.toFixed(4)}%)
                          </span>
                          <span>{formatPrice(line.amount, activeCurrencyCode)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex justify-between font-semibold pt-2 border-t">
                    <span>
                      {translateOrFallback(
                        'ecommerce.total_on_stripe',
                        'Total on Stripe'
                      )}
                    </span>
                    <span>{formatPrice(stripeTotal, activeCurrencyCode)}</span>
                  </div>
                </div>

                <Button
                  className="w-full"
                  size="lg"
                  onClick={() => handlePay('stripe', stripeItems, 'stripe')}
                  disabled={isStripeCheckoutDisabled}
                >
                  {processingKey === 'stripe' ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Package className="mr-2 h-4 w-4" />
                  )}
                  {processingKey === 'stripe'
                    ? t('ecommerce.processing')
                    : translateOrFallback(
                        'ecommerce.checkout_physical_products',
                        'Checkout Physical Products'
                      )}
                </Button>

                {stripeCheckoutDisabledMessage && processingKey === null ? (
                  <p className="text-[11px] text-muted-foreground">
                    {stripeCheckoutDisabledMessage}
                  </p>
                ) : null}

                {checkoutErrors.stripe ? (
                  <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {checkoutErrors.stripe}
                  </div>
                ) : null}

                <p className="text-[11px] text-muted-foreground">
                  {taxEstimate?.isPendingExternalCalculation
                    ? translateOrFallback(
                        'checkout_stripe_tax_finalized_notice',
                        'Tax will be finalized by Stripe Tax on the payment step.'
                      )
                    : translateOrFallback(
                        'ecommerce.shipping_taxes_collected_on_stripe',
                        'Shipping and taxes are only collected during the Stripe step for physical products.'
                      )}
                </p>
              </CheckoutSection>
            ) : null}

            {freemiusItems.length > 0 ? (
              <CheckoutSection
                title={translateOrFallback(
                  'ecommerce.freemius_checkout_title',
                  'Freemius Checkout'
                )}
                description={translateOrFallback(
                  'ecommerce.freemius_checkout_description',
                  'Digital products use the Freemius checkout flow.'
                )}
                badgeLabel={freemiusLicenseCountLabel}
              >
                <div className="space-y-3">
                  {freemiusItems.map((item) => {
                    const activePrice = getCartItemActivePrice(item, {
                      currencyCode: activeCurrencyCode,
                      currencies,
                    });
                    const trialSummary = getTrialSummary(item, t);
                    const itemKey = `freemius:${item.id}`;
                    const selectedTrialPreference = trialSummary
                      ? trialPreferences[itemKey] || 'paid'
                      : undefined;

                    return (
                      <div key={itemKey} className="rounded-lg border p-3 space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-medium">{item.title}</p>
                            {item.billing_cycle ? (
                              <p className="text-xs text-muted-foreground capitalize">
                                {checkoutBillingCycleLabel(item.billing_cycle)}
                              </p>
                            ) : null}
                            {trialSummary ? (
                              <p className="text-xs font-medium text-emerald-700">
                                {trialSummary.label} - {trialSummary.paymentRequirementLabel}
                              </p>
                            ) : null}
                          </div>
                          <span className="font-medium">
                            {formatPrice(activePrice.sale_price ?? activePrice.price, activeCurrencyCode)}
                          </span>
                        </div>
                        
                        {trialSummary && !item.trial_requires_payment_method && (
                          <div className="bg-muted/30 p-3 rounded-md border text-sm mt-2 mb-3">
                            <p className="font-medium mb-3">
                              {translateOrFallback(
                                'ecommerce.freemius_trial_preference_title',
                                'How would you like to start your trial?'
                              )}
                            </p>
                            <RadioGroup
                              value={trialPreferences[itemKey] || 'paid'}
                              onValueChange={(val: 'free' | 'paid') => setTrialPreferences(prev => ({ ...prev, [itemKey]: val }))}
                              className="gap-3"
                            >
                              <div className="flex items-start space-x-3">
                                <RadioGroupItem value="paid" id={`${itemKey}-paid`} className="mt-1" />
                                <div className="grid gap-1.5">
                                  <Label htmlFor={`${itemKey}-paid`} className="font-medium leading-none cursor-pointer">
                                    {translateOrFallback(
                                      'ecommerce.freemius_trial_with_card',
                                      'Enter Payment Details Now (Still get full trial length free)'
                                    )}
                                  </Label>
                                  <p className="text-xs text-muted-foreground">
                                    {translateOrFallback(
                                      'ecommerce.freemius_trial_with_card_help',
                                      'You will not be billed until the trial ends. Cancel anytime.'
                                    )}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-start space-x-3">
                                <RadioGroupItem value="free" id={`${itemKey}-free`} className="mt-1" />
                                <div className="grid gap-1.5">
                                  <Label htmlFor={`${itemKey}-free`} className="font-medium leading-none cursor-pointer">
                                    {translateOrFallback(
                                      'ecommerce.freemius_trial_no_card',
                                      'Start Free Trial (No card required)'
                                    )}
                                  </Label>
                                </div>
                              </div>
                            </RadioGroup>
                          </div>
                        )}

                        <Button
                          className="w-full h-auto min-h-[2.75rem] py-2"
                          onClick={() =>
                            handlePay(
                              'freemius',
                              [
                                {
                                  ...item,
                                  ...(selectedTrialPreference
                                    ? { trial_preference: selectedTrialPreference }
                                    : {}),
                                },
                              ],
                              itemKey
                            )
                          }
                          disabled={processingKey !== null || freemiusUnavailableMessage !== null}
                        >
                          {processingKey === itemKey ? (
                            <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin" />
                          ) : (
                            <Download className="mr-2 h-4 w-4 shrink-0" />
                          )}
                          <span className="whitespace-normal text-left">
                            {processingKey === itemKey
                              ? t('ecommerce.processing')
                              : freemiusItems.length > 1
                                ? translateOrFallback(
                                    'ecommerce.checkout_product',
                                    'Checkout {title}',
                                    { title: item.title }
                                  )
                                : translateOrFallback(
                                    'ecommerce.checkout_digital_product',
                                    'Checkout Digital Product'
                                  )}
                          </span>
                        </Button>
                      </div>
                    );
                  })}
                </div>

                <div className="flex justify-between text-sm font-semibold border-t pt-3">
                  <span>
                    {translateOrFallback(
                      'ecommerce.digital_subtotal',
                      'Digital subtotal'
                    )}
                  </span>
                  <span>{formatPrice(freemiusSubtotal, activeCurrencyCode)}</span>
                </div>
                {freemiusDiscountTotal > 0 ? (
                  <div className="flex justify-between text-sm font-semibold text-emerald-600">
                    <span>{translateOrFallback('ecommerce.discount', 'Discount')}</span>
                    <span>-{formatPrice(freemiusDiscountTotal, activeCurrencyCode)}</span>
                  </div>
                ) : null}

                {freemiusUnavailableMessage ? (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                    {freemiusUnavailableMessage}
                  </div>
                ) : null}

                {checkoutErrors.freemius ? (
                  <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {checkoutErrors.freemius}
                  </div>
                ) : null}

                <p className="text-[11px] text-muted-foreground">
                  {freemiusItems.length > 1
                    ? translateOrFallback(
                        'ecommerce.freemius_multi_checkout_notice',
                        'Freemius licenses are completed one at a time, so each digital product gets its own checkout action.'
                      )
                    : translateOrFallback(
                        'ecommerce.freemius_tax_notice',
                        'Taxes and compliance for digital products are handled inside the Freemius checkout.'
                      )}
                </p>
              </CheckoutSection>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};
