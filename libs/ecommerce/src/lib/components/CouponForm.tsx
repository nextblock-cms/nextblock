'use client';

import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Badge } from '@nextblock-cms/ui/badge';
import { Button } from '@nextblock-cms/ui/button';
import { Input } from '@nextblock-cms/ui/input';
import { Label } from '@nextblock-cms/ui/label';
import { Tag, X } from 'lucide-react';
import { useTranslations } from '@nextblock-cms/utils';
import { usePriceFormatter } from '../use-price-formatter';

import type { CouponQuote } from '../coupons';
import { normalizeCouponCode } from '../coupons';
import type { CartItem } from '../types';
import { useCart } from '../use-cart';
import { getCouponQuoteAction } from '../server-actions/coupon-actions';

export function CouponForm({
  items,
  currencyCode,
  onQuoteChange,
  compact = false,
}: {
  items: CartItem[];
  currencyCode: string;
  onQuoteChange?: (quote: CouponQuote | null) => void;
  compact?: boolean;
}) {
  const appliedCoupon = useCart((state) => state.appliedCoupon);
  const setAppliedCoupon = useCart((state) => state.setAppliedCoupon);
  const clearAppliedCoupon = useCart((state) => state.removeCoupon);
  const { t } = useTranslations();
  // Locale-aware: see use-price-formatter.ts.
  const formatPrice = usePriceFormatter();
  const [codeInput, setCodeInput] = useState('');
  const [quote, setQuote] = useState<CouponQuote | null>(null);
  const [error, setError] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const lastValidationKeyRef = useRef<string | null>(null);
  const cartSignature = useMemo(
    () =>
      items
        .map((item) => `${item.product_id}:${item.variant_id || 'base'}:${item.quantity}`)
        .sort()
        .join('|'),
    [items]
  );
  const translateOrFallback = useCallback((key: string, fallback: string) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
  }, [t]);
  const getValidationKey = useCallback(
    (code: string) => `${normalizeCouponCode(code)}:${currencyCode}:${cartSignature}`,
    [cartSignature, currencyCode]
  );

  const applyCode = useCallback(async (nextCode: string, options?: { silent?: boolean }) => {
    const normalizedCode = normalizeCouponCode(nextCode);

    if (!normalizedCode) {
      setError(translateOrFallback('ecommerce.coupon_code_required', 'Enter a coupon code.'));
      return;
    }

    setIsApplying(true);
    setError('');

    try {
      const result = await getCouponQuoteAction({
        code: normalizedCode,
        items,
        currencyCode,
      });

      if (!result.success) {
        setQuote(null);
        onQuoteChange?.(null);
        clearAppliedCoupon?.();
        setError(result.errorKey ? translateOrFallback(result.errorKey, result.error) : result.error);
        return;
      }

      lastValidationKeyRef.current = getValidationKey(result.quote.code);
      setQuote(result.quote);
      onQuoteChange?.(result.quote);
      if (!options?.silent) {
        setAppliedCoupon?.({
          code: result.quote.code,
          couponId: result.quote.couponId,
        });
        setCodeInput('');
      }

      if (!options?.silent) {
        setError('');
      }
    } catch (validationError) {
      console.error('Failed to validate coupon:', validationError);
      // Forget the key, or the effect below never retries: the coupon stayed applied in the
      // store (checkout still sends it, so the server discounts) while this form showed an
      // undiscounted total for the rest of the visit.
      lastValidationKeyRef.current = null;
      setQuote(null);
      onQuoteChange?.(null);
      setError(
        translateOrFallback('ecommerce.coupon_validation_failed', 'Failed to validate coupon.')
      );
    } finally {
      setIsApplying(false);
    }
  }, [
    clearAppliedCoupon,
    currencyCode,
    getValidationKey,
    items,
    onQuoteChange,
    setAppliedCoupon,
    translateOrFallback,
  ]);

  useEffect(() => {
    if (!setAppliedCoupon || !clearAppliedCoupon) {
      return;
    }

    if (!appliedCoupon || items.length === 0) {
      lastValidationKeyRef.current = null;
      setQuote(null);
      onQuoteChange?.(null);
      return;
    }

    const validationKey = getValidationKey(appliedCoupon.code);

    if (lastValidationKeyRef.current === validationKey) {
      return;
    }

    lastValidationKeyRef.current = validationKey;
    void applyCode(appliedCoupon.code, { silent: true });
  }, [
    appliedCoupon?.code,
    applyCode,
    clearAppliedCoupon,
    getValidationKey,
    items.length,
    onQuoteChange,
    setAppliedCoupon,
  ]);

  if (!setAppliedCoupon || !clearAppliedCoupon) {
    return null;
  }

  const removeCoupon = () => {
    clearAppliedCoupon();
    setQuote(null);
    onQuoteChange?.(null);
    setError('');
  };

  return (
    <div className={compact ? 'space-y-2' : 'rounded-lg border bg-muted/10 p-4 space-y-3'}>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={compact ? 'coupon-code-compact' : 'coupon-code'} className="flex items-center gap-2 text-sm font-medium">
          <Tag className="h-4 w-4" />
          {translateOrFallback('ecommerce.coupon', 'Coupon')}
        </Label>
        {quote ? (
          <Badge variant="secondary" className="gap-1">
            {quote.code}
            <button
              type="button"
              onClick={removeCoupon}
              aria-label={translateOrFallback('ecommerce.remove_coupon', 'Remove coupon {code}').replace('{code}', quote.code)}
              className="-mr-1 inline-flex h-6 w-6 items-center justify-center rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ) : null}
      </div>

      {!quote ? (
        <div className="flex gap-2">
          <Input
            id={compact ? 'coupon-code-compact' : 'coupon-code'}
            name="coupon"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? (compact ? 'coupon-error-compact' : 'coupon-error') : undefined}
            value={codeInput}
            // No `.toUpperCase()` here: rewriting a controlled value moves the caret to the
            // end on every mid-string edit. The `uppercase` class shows capitals and
            // `normalizeCouponCode` uppercases what is actually sent.
            onChange={(event: ChangeEvent<HTMLInputElement>) => setCodeInput(event.target.value)}
            placeholder={translateOrFallback('ecommerce.coupon_placeholder', 'SAVE10…')}
            className="uppercase"
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              // Enter used to skip the `isApplying` guard the button has, so two requests
              // could race and the slower response won.
              if (event.key === 'Enter' && !isApplying) {
                event.preventDefault();
                void applyCode(codeInput);
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={isApplying || items.length === 0}
            onClick={() => void applyCode(codeInput)}
          >
            {isApplying
              ? translateOrFallback('ecommerce.applying', 'Applying…')
              : translateOrFallback('ecommerce.apply', 'Apply')}
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0 truncate text-muted-foreground">
            {quote.name}
          </span>
          {/* A negative amount, so the locale decides where the minus sign goes. */}
          <span className="shrink-0 font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
            {formatPrice(-quote.discountTotal, currencyCode)}
          </span>
        </div>
      )}

      {error ? (
        <p id={compact ? 'coupon-error-compact' : 'coupon-error'} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
