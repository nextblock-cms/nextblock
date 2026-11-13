'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AFFILIATES_PARTNERS_CALCULATOR_COPY,
  compareAffiliateTierEarnings,
  projectAffiliateEarnings,
  useAffiliatesCopy,
} from '@nextblock-cms/affiliates';
import { formatPartnersMoney, formatPartnersWholeMoney } from './partners-money';

export interface PartnerRevenueCalculatorRange {
  min: number;
  max: number;
  step: number;
  initial: number;
}

/** One of the store's products, as the picker shows it (the model picks at most three). */
export interface PartnerRevenueCalculatorProduct {
  id: string;
  title: string;
  /** What one order pays, in minor units of `currency`. */
  orderValueMinor: number;
  /** A yearly license's monthly price, when its plan also bills monthly. */
  monthlyMinor: number | null;
  billing: 'year' | 'month' | 'once';
}

export interface PartnerRevenueCalculatorProps {
  /** Store base currency; amounts are minor units of it. */
  currency: string;
  compareRate: number;
  compareRateLabel: string;
  /** Null: one figure (the compared tier is the base tier). */
  baseRate: number | null;
  baseRateLabel: string | null;
  referrals: PartnerRevenueCalculatorRange;
  averageOrderValue: PartnerRevenueCalculatorRange;
  /** The product picker; empty (or absent) hides it. */
  products?: readonly PartnerRevenueCalculatorProduct[];
}

/** Announce the result this long after the last change (one announcement, not one per tick). */
const ANNOUNCE_DELAY_MS = 700;
/** The first-view sweep from the sliders' minimum up to their starting values. */
const INTRO_DURATION_MS = 1400;
/** A product pick glides the order value to its price. */
const PICK_DURATION_MS = 600;
/**
 * The sweep starts as soon as any of the calculator scrolls into view: a position, not a visible
 * ratio (the calculator can be taller than the screen), and no dead zone where the minimums would
 * sit on screen before it starts.
 */
const INTRO_ROOT_MARGIN = '0px';
/** The picker's "all of them together" option. */
const BUNDLE_KEY = 'all';

function clampToRange(value: number, range: PartnerRevenueCalculatorRange): number {
  if (!Number.isFinite(value)) return range.initial;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/** The slider's own position: the nearest step inside the range (a product price may sit between steps). */
function snapToStep(value: number, range: PartnerRevenueCalculatorRange): number {
  const step = range.step > 0 ? range.step : 1;
  return clampToRange(range.min + Math.round((value - range.min) / step) * step, range);
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

const RANGE_CLASS =
  'mt-3 h-6 w-full cursor-pointer rounded-full accent-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background';

/**
 * The selected and focused states are drawn with `outline`, plus a radio dot: a theme's own rules
 * may restyle `.border` and box-shadow rings (the seeded vibrant theme gives every `.border` its own
 * colour and glow), but never the outline, so the state shows in every theme.
 */
const OPTION_CLASS =
  'group flex h-full cursor-pointer flex-col rounded-lg border border-border bg-background p-4 text-left transition-colors hover:bg-muted/40 has-[:checked]:bg-primary/5 has-[:checked]:outline has-[:checked]:outline-2 has-[:checked]:outline-primary has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-ring motion-reduce:transition-none';

const OPTION_DOT_CLASS =
  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-muted-foreground group-has-[:checked]:border-primary';

/** The money a sale pays: emerald, with its light shade on dark themes (the vibrant theme is dark without `.dark`). */
const EARN_TEXT_CLASS = 'text-emerald-700 dark:text-emerald-400 [.vibrant_&]:text-emerald-400';

interface Values {
  referrals: number;
  averageOrderValue: number;
}

interface PickerOption {
  key: string;
  title: string;
  /** The order value the option sets, inside the slider's range. */
  value: number;
  /** Its price as listed (not clamped). */
  priceMinor: number;
  billing: PartnerRevenueCalculatorProduct['billing'] | 'bundle';
  monthlyMinor: number | null;
}

function pickerOptions(products: readonly PartnerRevenueCalculatorProduct[], range: PartnerRevenueCalculatorRange): PickerOption[] {
  const options: PickerOption[] = products.map((product) => ({
    key: product.id,
    title: product.title,
    value: clampToRange(product.orderValueMinor, range),
    priceMinor: product.orderValueMinor,
    billing: product.billing,
    monthlyMinor: product.monthlyMinor,
  }));
  if (products.length > 1) {
    const total = products.reduce((sum, product) => sum + product.orderValueMinor, 0);
    options.push({ key: BUNDLE_KEY, title: '', value: clampToRange(total, range), priceMinor: total, billing: 'bundle', monthlyMinor: null });
  }
  return options;
}

/**
 * The `/partners` revenue calculator: an optional product picker (the store's priciest products and
 * their sum), two native range inputs (monthly referrals, average order value in the store base
 * currency) and the income at the offered rate, per month and per year, next to the standard rate
 * with the difference. Each slider speaks its value through `aria-valuetext`; the result is
 * announced once, after the visitor stops changing it.
 *
 * Motion: a calculator that starts off screen sweeps once from the sliders' minimum up to their
 * starting values as it scrolls into view, and a product pick glides the order value to the price.
 * Both are skipped with `prefers-reduced-motion` (the values change at once) and stop the moment
 * the visitor drags a slider. The server render shows the starting values.
 */
export function PartnerRevenueCalculator(props: PartnerRevenueCalculatorProps) {
  const { t, locale } = useAffiliatesCopy(AFFILIATES_PARTNERS_CALCULATOR_COPY);
  const id = useId();
  const { referrals: referralsRange, averageOrderValue: averageOrderRange } = props;
  const options = useMemo(() => pickerOptions(props.products ?? [], averageOrderRange), [props.products, averageOrderRange]);
  const startReferrals = clampToRange(referralsRange.initial, referralsRange);
  const startAverageOrderValue = clampToRange(averageOrderRange.initial, averageOrderRange);

  const [referrals, setReferrals] = useState(startReferrals);
  const [averageOrderValue, setAverageOrderValue] = useState(startAverageOrderValue);
  // The picked option (two products can share a price, so it is tracked, not derived).
  const [selectedKey, setSelectedKey] = useState<string | null>(
    () => options.find((option) => option.value === startAverageOrderValue)?.key ?? null
  );
  const [announcement, setAnnouncement] = useState('');
  const touched = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const latest = useRef<Values>({ referrals: startReferrals, averageOrderValue: startAverageOrderValue });
  const frame = useRef<number | null>(null);
  /** Where the running tween is heading. */
  const tweenTarget = useRef<Values | null>(null);
  /**
   * Where the armed first-view sweep will head: the sliders sit at their minimum (off screen) until
   * it starts. A visitor who acts before then gets these values for whatever they did not touch,
   * never the hidden minimum.
   */
  const introTarget = useRef<Values | null>(null);

  useEffect(() => {
    latest.current = { referrals, averageOrderValue };
  }, [referrals, averageOrderValue]);

  const cancelTween = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    tweenTarget.current = null;
  }, []);

  const glideTo = useCallback(
    (target: Values, duration: number) => {
      cancelTween();
      if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
        setReferrals(target.referrals);
        setAverageOrderValue(target.averageOrderValue);
        return;
      }
      const from = { ...latest.current };
      // The clock starts on the first frame, in the frames' own time base: a frame's timestamp can
      // precede a performance.now() read just before it, which would make the progress negative.
      let startedAt: number | null = null;
      tweenTarget.current = target;
      const step = (now: number) => {
        if (startedAt === null) startedAt = now;
        const progress = Math.min(1, Math.max(0, (now - startedAt) / duration));
        const eased = 1 - (1 - progress) ** 3;
        setReferrals(Math.round(from.referrals + (target.referrals - from.referrals) * eased));
        setAverageOrderValue(Math.round(from.averageOrderValue + (target.averageOrderValue - from.averageOrderValue) * eased));
        if (progress < 1) {
          frame.current = requestAnimationFrame(step);
        } else {
          frame.current = null;
          tweenTarget.current = null;
        }
      };
      frame.current = requestAnimationFrame(step);
    },
    [cancelTween]
  );

  // The first-view sweep. The observer's first report says where the calculator is: entirely below
  // the screen arms the sweep (the sliders drop to their minimum where nobody sees them); anywhere
  // else (on screen after a #calculator link, a short page, or above after a scroll restore) leaves
  // the figures alone. Armed, it glides up as soon as any part of the calculator comes into view.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof IntersectionObserver !== 'function' || prefersReducedMotion()) return undefined;
    let armed: boolean | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        if (armed === null) {
          armed = !entry.isIntersecting && entry.boundingClientRect.top >= window.innerHeight && !touched.current;
          if (!armed) {
            observer.disconnect();
            return;
          }
          introTarget.current = { referrals: startReferrals, averageOrderValue: startAverageOrderValue };
          latest.current = { referrals: referralsRange.min, averageOrderValue: averageOrderRange.min };
          setReferrals(referralsRange.min);
          setAverageOrderValue(averageOrderRange.min);
          return;
        }
        if (!entry.isIntersecting) return;
        observer.disconnect();
        const target = introTarget.current;
        introTarget.current = null;
        if (target && !touched.current) glideTo(target, INTRO_DURATION_MS);
      },
      { rootMargin: INTRO_ROOT_MARGIN, threshold: 0 }
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelTween();
    };
  }, [referralsRange.min, averageOrderRange.min, startReferrals, startAverageOrderValue, glideTo, cancelTween]);

  const results = useMemo(() => {
    const projection = projectAffiliateEarnings({
      monthlyReferrals: referrals,
      averageOrderValueMinor: averageOrderValue,
      ratePercent: props.compareRate,
    });
    if (props.baseRate === null) {
      return { monthly: projection.monthlyMinor, compare: projection.annualMinor, base: null, bonus: null };
    }
    const comparison = compareAffiliateTierEarnings({
      monthlyReferrals: referrals,
      averageOrderValueMinor: averageOrderValue,
      promoRatePercent: props.compareRate,
      baseRatePercent: props.baseRate,
    });
    return {
      monthly: projection.monthlyMinor,
      compare: comparison.promoAnnualMinor,
      base: comparison.baseAnnualMinor,
      bonus: comparison.bonusAnnualMinor,
    };
  }, [referrals, averageOrderValue, props.compareRate, props.baseRate]);

  const money = (minor: number) => formatPartnersMoney(minor, props.currency, locale);

  const referralsText =
    referrals === 1
      ? t('affiliates.partners.calculator_referrals_value_one')
      : t('affiliates.partners.calculator_referrals_value_other', { count: referrals });
  const averageOrderText = t('affiliates.partners.calculator_aov_value', { amount: money(averageOrderValue) });
  const monthlyText = money(results.monthly);
  const compareText = money(results.compare);
  const baseText = results.base === null ? null : money(results.base);
  const bonusText = results.bonus === null ? null : money(results.bonus);

  const summary =
    baseText !== null && bonusText !== null && props.baseRateLabel !== null
      ? t('affiliates.partners.calculator_summary_monthly', {
          compare_rate: props.compareRateLabel,
          monthly: monthlyText,
          compare: compareText,
          base_rate: props.baseRateLabel,
          base: baseText,
          bonus: bonusText,
        })
      : t('affiliates.partners.calculator_summary_single_monthly', {
          rate: props.compareRateLabel,
          monthly: monthlyText,
          amount: compareText,
        });

  useEffect(() => {
    if (!touched.current) return undefined;
    const timer = setTimeout(() => setAnnouncement(summary), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [summary]);

  // The picker's strings depend on the products, the rate and the language, never on the sliders:
  // built once, not on every frame of a sweep or a glide.
  const { currency, compareRate } = props;
  const optionViews = useMemo(
    () =>
      options.map((option) => {
        const whole = (minor: number) => formatPartnersWholeMoney(minor, currency, locale);
        const price = whole(option.priceMinor);
        const earned = whole(Math.round((option.priceMinor * compareRate) / 100));
        const title =
          option.billing !== 'bundle'
            ? option.title
            : options.length - 1 === 2
              ? t('affiliates.partners.calculator_product_bundle_two')
              : t('affiliates.partners.calculator_product_bundle', { count: options.length - 1 });
        const priceLine =
          option.billing === 'year'
            ? option.monthlyMinor !== null
              ? t('affiliates.partners.calculator_product_price_year_month', { price, monthly: whole(option.monthlyMinor) })
              : t('affiliates.partners.calculator_product_price_year', { price })
            : option.billing === 'month'
              ? t('affiliates.partners.calculator_product_price_month', { price })
              : price;
        // A yearly license says what a yearly sale pays (its monthly plan earns one month only).
        const earnLine =
          option.billing === 'year'
            ? t('affiliates.partners.calculator_product_earn_yearly', { amount: earned })
            : t('affiliates.partners.calculator_product_earn', { amount: earned });
        return { key: option.key, value: option.value, title, priceLine, earnLine };
      }),
    [options, currency, compareRate, locale, t]
  );

  // Only an order's first payment earns: say so wherever a subscription is on offer.
  const productsNote = options.some((option) => option.billing === 'year')
    ? t('affiliates.partners.calculator_products_note_yearly')
    : options.some((option) => option.billing === 'month')
      ? t('affiliates.partners.calculator_products_note_monthly')
      : null;

  /** Where the sliders are heading (a running tween, else the armed sweep), if anywhere. */
  function takePendingTarget(): Values | null {
    const pending = tweenTarget.current ?? introTarget.current;
    cancelTween();
    introTarget.current = null;
    return pending;
  }
  const referralsId = `${id}-referrals`;
  const averageOrderId = `${id}-aov`;
  const productsName = `${id}-product`;

  return (
    <div ref={rootRef} className="grid grid-cols-1 gap-8 lg:grid-cols-2">
      <div className="min-w-0 space-y-8 rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm">
        {options.length > 0 ? (
          <fieldset>
            <legend className="text-sm font-semibold text-foreground">{t('affiliates.partners.calculator_products_label')}</legend>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {optionViews.map((option) => (
                <label key={option.key} className={OPTION_CLASS}>
                  <input
                    type="radio"
                    name={productsName}
                    value={option.key}
                    checked={selectedKey === option.key}
                    onChange={() => {
                      touched.current = true;
                      setSelectedKey(option.key);
                      // Keep the sales count the sliders are heading to (not a value mid-sweep, nor
                      // the hidden minimum of an armed sweep).
                      const pending = takePendingTarget();
                      glideTo({ referrals: pending?.referrals ?? latest.current.referrals, averageOrderValue: option.value }, PICK_DURATION_MS);
                    }}
                    className="sr-only"
                  />
                  <span className="flex items-start gap-2">
                    <span aria-hidden="true" className={OPTION_DOT_CLASS}>
                      <span className="h-1.5 w-1.5 rounded-full bg-primary opacity-0 group-has-[:checked]:opacity-100" />
                    </span>
                    <span className="line-clamp-2 text-sm font-semibold text-foreground">{option.title}</span>
                  </span>
                  <span className="mt-1 pl-6 text-sm text-muted-foreground">{option.priceLine}</span>
                  <span className={`mt-auto pl-6 pt-2 text-sm font-semibold ${EARN_TEXT_CLASS}`}>{option.earnLine}</span>
                </label>
              ))}
            </div>
            {productsNote ? <p className="mt-3 text-xs text-muted-foreground">{productsNote}</p> : null}
          </fieldset>
        ) : null}
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <label htmlFor={referralsId} className="text-sm font-semibold text-foreground">
              {t('affiliates.partners.calculator_referrals_label')}
            </label>
            <span aria-hidden="true" className="text-sm font-medium tabular-nums text-foreground">
              {referralsText}
            </span>
          </div>
          <input
            id={referralsId}
            type="range"
            min={referralsRange.min}
            max={referralsRange.max}
            step={referralsRange.step}
            value={snapToStep(referrals, referralsRange)}
            aria-valuetext={referralsText}
            onChange={(event) => {
              touched.current = true;
              // The order value lands where it was heading, not mid-glide or at the hidden minimum.
              const pending = takePendingTarget();
              if (pending) setAverageOrderValue(pending.averageOrderValue);
              setReferrals(clampToRange(Number(event.target.value), referralsRange));
            }}
            className={RANGE_CLASS}
          />
        </div>
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <label htmlFor={averageOrderId} className="text-sm font-semibold text-foreground">
              {t('affiliates.partners.calculator_aov_label')}
            </label>
            <span aria-hidden="true" className="text-sm font-medium tabular-nums text-foreground">
              {averageOrderText}
            </span>
          </div>
          <input
            id={averageOrderId}
            type="range"
            min={averageOrderRange.min}
            max={averageOrderRange.max}
            step={averageOrderRange.step}
            value={snapToStep(averageOrderValue, averageOrderRange)}
            aria-valuetext={averageOrderText}
            onChange={(event) => {
              touched.current = true;
              // The sales count lands where it was heading, not mid-glide or at the hidden minimum.
              const pending = takePendingTarget();
              if (pending) setReferrals(pending.referrals);
              setSelectedKey(null);
              setAverageOrderValue(clampToRange(Number(event.target.value), averageOrderRange));
            }}
            className={RANGE_CLASS}
          />
        </div>
      </div>

      <div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <dl className="rounded-xl border-2 border-primary bg-card p-6 text-card-foreground shadow-sm sm:col-span-2 lg:col-span-1">
            <dt className="text-sm font-semibold text-foreground">
              {t('affiliates.partners.calculator_monthly_label', { rate: props.compareRateLabel })}
            </dt>
            <dd className="mt-2 text-4xl font-bold tracking-tight tabular-nums text-foreground sm:text-5xl">{monthlyText}</dd>
            <dt className="mt-4 text-sm font-semibold text-muted-foreground">
              {t('affiliates.partners.calculator_compare_label', { rate: props.compareRateLabel })}
            </dt>
            <dd className="mt-1 text-2xl font-bold tabular-nums text-foreground">{compareText}</dd>
          </dl>
          {baseText !== null && props.baseRateLabel !== null ? (
            <dl className="rounded-xl border border-border bg-card p-6 text-card-foreground">
              <dt className="text-sm font-semibold text-foreground">
                {t('affiliates.partners.calculator_base_label', { rate: props.baseRateLabel })}
              </dt>
              <dd className="mt-2 text-2xl font-bold tabular-nums text-foreground">{baseText}</dd>
            </dl>
          ) : null}
          {bonusText !== null ? (
            <dl className="rounded-xl border border-emerald-300 bg-emerald-50 p-6 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-50">
              <dt className="text-sm font-semibold">{t('affiliates.partners.calculator_bonus_label_now')}</dt>
              <dd className="mt-2 text-2xl font-bold tabular-nums">{bonusText}</dd>
            </dl>
          ) : null}
        </div>
        <p className="mt-4 text-sm text-muted-foreground">{t('affiliates.partners.calculator_note')}</p>
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
      </div>
    </div>
  );
}
