'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@nextblock-cms/ui/button';
import { Input } from '@nextblock-cms/ui/input';
import { Textarea } from '@nextblock-cms/ui/textarea';
import { useTranslations } from '@nextblock-cms/utils';
import { Loader2, Mail, CheckCircle2 } from 'lucide-react';

import { AuthBotProtection } from './auth/AuthBotProtection';
import {
  submitProductInquiry,
  type ContactSellerState,
} from '../app/actions/contactSellerActions';

/**
 * Shown in place of Add-to-Cart when the store cannot take payment for this product.
 *
 * The visitor never learns why — "online ordering isn't available yet" is true and
 * actionable, whereas "the merchant hasn't configured Stripe" is an internal detail.
 * No seller address appears anywhere in this component or its payload: the form posts
 * a product id, and the server resolves who to notify.
 */

interface ContactSellerSectionProps {
  productId: string;
  botProtectionProvider: 'none' | 'turnstile' | 'recaptcha';
  botProtectionSiteKey: string;
  scriptNonce?: string;
}

const INITIAL_STATE: ContactSellerState = { success: false, messageKey: '' };

// `t()` returns the key itself when a translation row is missing, so every string
// carries the English literal it should fall back to.
const FALLBACKS: Record<string, string> = {
  'ecommerce.contact_seller_heading': 'Interested in this product?',
  'ecommerce.contact_seller_intro':
    "Online ordering isn't available for this item yet. Send the seller a message and they'll get back to you about buying it.",
  'ecommerce.contact_seller_name': 'Your name',
  'ecommerce.contact_seller_email': 'Your email',
  'ecommerce.contact_seller_message': 'Message',
  'ecommerce.contact_seller_send': 'Send message',
  'ecommerce.contact_seller_sending': 'Sending…',
  'ecommerce.contact_seller_sent':
    "Thanks — your message has been sent to the seller. They'll reply to the email address you gave.",
  'ecommerce.contact_seller_error':
    "Sorry, your message couldn't be sent. Please try again in a moment.",
  'ecommerce.contact_seller_throttled':
    "You've sent several messages already. Please wait a few minutes before sending another.",
  'ecommerce.contact_seller_invalid':
    'Please check your name, email address and message, then try again.',
};

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="min-w-[150px]">
      {pending ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {pendingLabel}
        </>
      ) : (
        <>
          <Mail className="mr-2 h-4 w-4" />
          {label}
        </>
      )}
    </Button>
  );
}

export default function ContactSellerSection({
  productId,
  botProtectionProvider,
  botProtectionSiteKey,
  scriptNonce,
}: ContactSellerSectionProps) {
  const { t, lang } = useTranslations();
  const [state, formAction] = useActionState(submitProductInquiry, INITIAL_STATE);
  const successRef = useRef<HTMLDivElement>(null);

  // The confirmation replaces the form, so the focused submit button disappears. Without
  // this, focus falls back to <body> and a screen-reader user loses their place.
  useEffect(() => {
    if (state.success) successRef.current?.focus();
  }, [state.success]);

  // Resolve a key to its translation, falling back to the English literal.
  const label = (key: string): string => {
    const value = t(key);
    return value === key ? (FALLBACKS[key] ?? key) : value;
  };

  if (state.success) {
    return (
      <div
        id="contact-seller"
        ref={successRef}
        tabIndex={-1}
        role="status"
        className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 outline-hidden dark:border-emerald-900/50 dark:bg-emerald-950/30"
      >
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <p className="text-sm text-emerald-900 dark:text-emerald-200">
            {label('ecommerce.contact_seller_sent')}
          </p>
        </div>
      </div>
    );
  }

  // Captcha failures carry provider-specific text; everything else is a keyed message.
  const errorText =
    state.message || (state.messageKey ? label(state.messageKey) : null);

  return (
    <div
      id="contact-seller"
      className="scroll-mt-24 rounded-2xl border border-border/80 bg-card/50 p-6 shadow-sm"
    >
      {/* h2: the only heading above it on a product page is the h1. */}
      <h2 className="text-lg font-semibold text-foreground">
        {label('ecommerce.contact_seller_heading')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {label('ecommerce.contact_seller_intro')}
      </p>

      <form action={formAction} className="mt-5 space-y-4">
        <input type="hidden" name="product_id" value={productId} />
        <input type="hidden" name="locale" value={lang ?? ''} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label
              htmlFor="contact-seller-name"
              className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {label('ecommerce.contact_seller_name')}
            </label>
            <Input
              id="contact-seller-name"
              name="name"
              required
              maxLength={120}
              autoComplete="name"
              defaultValue={state.values?.name}
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="contact-seller-email"
              className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {label('ecommerce.contact_seller_email')}
            </label>
            <Input
              id="contact-seller-email"
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              spellCheck={false}
              defaultValue={state.values?.email}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="contact-seller-message"
            className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {label('ecommerce.contact_seller_message')}
          </label>
          <Textarea
            id="contact-seller-message"
            name="message"
            required
            maxLength={2000}
            className="min-h-[120px]"
            defaultValue={state.values?.message}
          />
        </div>

        <AuthBotProtection
          provider={botProtectionProvider}
          siteKey={botProtectionSiteKey}
          scriptNonce={scriptNonce}
        />

        {errorText && (
          <p role="alert" className="text-sm font-semibold text-destructive">
            {errorText}
          </p>
        )}

        <div className="flex justify-end pt-1">
          <SubmitButton
            label={label('ecommerce.contact_seller_send')}
            pendingLabel={label('ecommerce.contact_seller_sending')}
          />
        </div>
      </form>
    </div>
  );
}
