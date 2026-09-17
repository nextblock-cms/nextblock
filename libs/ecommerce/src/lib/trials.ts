export type FreemiusTrialMode = 'free' | 'paid';

type TrialCarrier = {
  trial_period_days?: number | string | null;
  trial_requires_payment_method?: boolean | null;
};

export function getTrialPeriodDays(value: TrialCarrier | null | undefined) {
  const parsed = Number(value?.trial_period_days ?? 0);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return Math.round(parsed);
}

export function getTrialCheckoutMode(
  value: TrialCarrier | null | undefined
): FreemiusTrialMode | null {
  const trialPeriodDays = getTrialPeriodDays(value);

  if (trialPeriodDays === 0) {
    return null;
  }

  return value?.trial_requires_payment_method ? 'paid' : 'free';
}

/** The `t` of `useTranslations()`. It answers an unseeded key with the key itself. */
export type TrialTranslate = (key: string, params?: Record<string, string | number>) => string;

function translateTrialCopy(
  t: TrialTranslate | undefined,
  key: string,
  fallback: string,
  params?: Record<string, string | number>
) {
  if (!t) return fallback;

  const translated = t(key, params);
  return translated === key ? fallback : translated;
}

/**
 * Pass `t` from a component to get the label in the visitor's language. Without it the copy
 * is English: these helpers used to return English only, so every product card, the cart
 * and the checkout showed "14-day free trial" on French pages.
 */
export function getTrialLabel(value: TrialCarrier | number | null | undefined, t?: TrialTranslate) {
  const trialPeriodDays =
    typeof value === 'number'
      ? getTrialPeriodDays({ trial_period_days: value })
      : getTrialPeriodDays(value);

  return trialPeriodDays > 0
    ? translateTrialCopy(t, 'ecommerce.trial_days', `${trialPeriodDays}-day free trial`, {
        count: trialPeriodDays,
      })
    : null;
}

export function getTrialPaymentRequirementLabel(
  value: TrialCarrier | null | undefined,
  t?: TrialTranslate
) {
  return value?.trial_requires_payment_method
    ? translateTrialCopy(t, 'ecommerce.trial_payment_required', 'Payment method required')
    : translateTrialCopy(t, 'ecommerce.trial_no_card', 'No credit card required');
}

export function getTrialSummary(value: TrialCarrier | null | undefined, t?: TrialTranslate) {
  const trialLabel = getTrialLabel(value, t);

  if (!trialLabel) {
    return null;
  }

  return {
    label: trialLabel,
    paymentRequirementLabel: getTrialPaymentRequirementLabel(value, t),
    checkoutMode: getTrialCheckoutMode(value),
  };
}
