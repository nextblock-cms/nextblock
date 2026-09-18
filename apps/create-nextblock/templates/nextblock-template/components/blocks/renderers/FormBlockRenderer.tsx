"use client";

import React, { useActionState, useState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import Script from 'next/script';
import { handleFormSubmission } from '../../../app/actions/formActions';
import type { FormBlockContent, FormField } from '../../../lib/blocks/blockRegistry';
import { Button } from '@nextblock-cms/ui';
import { Checkbox } from '@nextblock-cms/ui';
import { Input } from '@nextblock-cms/ui';
import { Label } from '@nextblock-cms/ui';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@nextblock-cms/ui';
import { Textarea } from '@nextblock-cms/ui';
import { useTranslations } from '@nextblock-cms/utils';
import { HONEYPOT_FIELD } from '../../../lib/botProtection/fields';
import { useLabel } from '../../../lib/i18n/use-label';
import type { VisualEditAttributes } from '../../../lib/visual-editing/types';

interface FormBlockRendererProps {
  content: FormBlockContent;
  languageId: number;
  visualEditAttributes?: VisualEditAttributes;
  botProtectionPublic?: BotProtectionPublicSettings;
  scriptNonce?: string;
}

type BotProtectionProvider = 'none' | 'turnstile' | 'recaptcha';

type BotProtectionPublicSettings = {
  provider: BotProtectionProvider;
  siteKey: string;
};

type VerificationError = '' | 'failed' | 'timeout' | 'start' | 'load';

type Label = ReturnType<typeof useLabel>;

function SubmitButton({ text, verifying }: { text: string; verifying?: boolean }) {
  const { pending } = useFormStatus();
  const label = useLabel();
  const isDisabled = pending || verifying;
  return (
    <Button type="submit" disabled={isDisabled}>
      {verifying
        ? label('forms.verifying', 'Verifying…', 'Vérification…')
        : pending
          ? label('forms.submitting', 'Submitting…', 'Envoi en cours…')
          : text}
    </Button>
  );
}

function verificationErrorText(label: Label, error: Exclude<VerificationError, ''>) {
  switch (error) {
    case 'timeout':
      return label(
        'forms.verification_timeout',
        'Security verification timed out. Please try again.',
        'La vérification de sécurité a expiré. Veuillez réessayer.'
      );
    case 'start':
      return label(
        'forms.verification_start_failed',
        'Security verification could not be started. Please try again.',
        "La vérification de sécurité n'a pas pu démarrer. Veuillez réessayer."
      );
    case 'load':
      return label(
        'forms.verification_load_failed',
        'Security verification could not be loaded. Please refresh and try again.',
        "La vérification de sécurité n'a pas pu être chargée. Veuillez actualiser la page et réessayer."
      );
    default:
      return label(
        'forms.verification_failed',
        'Security verification could not be completed. Please try again.',
        "La vérification de sécurité n'a pas pu être complétée. Veuillez réessayer."
      );
  }
}

/** Server failures carry a `code`; anything else (captcha text) is shown as sent. */
function submissionErrorText(label: Label, code: string | undefined, message: string) {
  switch (code) {
    case 'empty':
      return label(
        'forms.error_empty',
        'Please fill in the form before submitting.',
        "Veuillez remplir le formulaire avant de l'envoyer."
      );
    case 'throttled':
      return label(
        'forms.error_throttled',
        "You've sent several messages already. Please wait a few minutes before sending another.",
        "Vous avez déjà envoyé plusieurs messages. Veuillez patienter quelques minutes avant d'en envoyer un autre."
      );
    case 'error':
      return label(
        'forms.error_generic',
        'Sorry, there was an error sending your message. Please try again later.',
        "Désolé, une erreur s'est produite lors de l'envoi de votre message. Veuillez réessayer plus tard."
      );
    default:
      return message;
  }
}

function resolveBotProtection(
  content: FormBlockContent,
  botProtectionPublic?: BotProtectionPublicSettings
) {
  const blockProvider = content.botProtectionProvider;
  const provider: BotProtectionProvider =
    blockProvider === 'turnstile' || blockProvider === 'recaptcha'
      ? blockProvider
      : botProtectionPublic?.provider || 'none';
  const fallbackSiteKey =
    provider === 'turnstile'
      ? process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
      : provider === 'recaptcha'
        ? process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY
        : '';
  const publicSiteKey =
    provider === botProtectionPublic?.provider ? botProtectionPublic?.siteKey || '' : '';
  const siteKey = content.botProtectionSiteKey?.trim() ||
    publicSiteKey ||
    fallbackSiteKey ||
    '';

  return { provider, siteKey };
}

const FormBlockRenderer: React.FC<FormBlockRendererProps> = ({ content, visualEditAttributes, botProtectionPublic, scriptNonce }) => {
  const { provider, siteKey } = resolveBotProtection(content, botProtectionPublic);
  // Only the opaque key travels to the client. The address it resolves to is read
  // server-side, so it is neither disclosed here nor forgeable in the request.
  const [state, formAction] = useActionState(handleFormSubmission.bind(null, {
    formKey: content.form_key,
    botProtectionProvider: provider,
  }), {
    success: false,
    message: '',
  } as Awaited<ReturnType<typeof handleFormSubmission>>);
  const label = useLabel();
  const { lang } = useTranslations();
  const successRef = useRef<HTMLDivElement>(null);
  // Bumped on every failed submission so the fields remount with the values the server
  // echoed back (React 19 resets an uncontrolled form once its action settles).
  const [fieldsVersion, setFieldsVersion] = useState(0);

  const [recaptchaToken, setRecaptchaToken] = useState<string>('');
  const turnstileRef = useRef<HTMLDivElement>(null);
  const turnstileWidgetIdRef = useRef<string | null>(null);
  const pendingTurnstileFormRef = useRef<HTMLFormElement | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string>('');
  const [verificationError, setVerificationError] = useState<VerificationError>('');
  const [isVerifyingTurnstile, setIsVerifyingTurnstile] = useState(false);

  useEffect(() => {
    if (provider === 'turnstile' && siteKey && typeof window !== 'undefined') {
      let widgetId: string | null = null;

      const renderWidget = () => {
        if ((window as any).turnstile && turnstileRef.current) {
          // Clear any stale children
          turnstileRef.current.innerHTML = '';
          try {
            widgetId = (window as any).turnstile.render(turnstileRef.current, {
              sitekey: siteKey,
              // The site theme, not the OS preference: buildThemeCss sets `color-scheme` on
              // <html> for whichever theme the visitor picked.
              theme: getComputedStyle(document.documentElement).colorScheme.includes('dark') ? 'dark' : 'light',
              execution: 'execute',
              'response-field': false,
              callback: (token: string) => {
                setTurnstileToken(token);
                setVerificationError('');
                setIsVerifyingTurnstile(false);

                const form = pendingTurnstileFormRef.current;
                if (form) {
                  pendingTurnstileFormRef.current = null;
                  const input = form.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
                  if (input) {
                    input.value = token;
                  }
                  form.requestSubmit();
                }
              },
              'expired-callback': () => {
                setTurnstileToken('');
              },
              'error-callback': () => {
                setTurnstileToken('');
                pendingTurnstileFormRef.current = null;
                setIsVerifyingTurnstile(false);
                setVerificationError('failed');
              },
              'timeout-callback': () => {
                setTurnstileToken('');
                pendingTurnstileFormRef.current = null;
                setIsVerifyingTurnstile(false);
                setVerificationError('timeout');
              },
            });
            turnstileWidgetIdRef.current = widgetId;

            if (widgetId && pendingTurnstileFormRef.current) {
              try {
                (window as any).turnstile.execute(widgetId);
              } catch (err) {
                console.error("Turnstile execute error:", err);
                pendingTurnstileFormRef.current = null;
                setIsVerifyingTurnstile(false);
                setVerificationError('start');
              }
            }
          } catch (err) {
            console.error("Turnstile render error:", err);
            pendingTurnstileFormRef.current = null;
            setIsVerifyingTurnstile(false);
            setVerificationError('load');
          }
        }
      };

      if ((window as any).turnstile) {
        renderWidget();
      } else {
        const interval = setInterval(() => {
          if ((window as any).turnstile) {
            clearInterval(interval);
            renderWidget();
          }
        }, 100);
        return () => clearInterval(interval);
      }

      return () => {
        if (widgetId && (window as any).turnstile) {
          try {
            (window as any).turnstile.remove(widgetId);
          } catch {
            // Ignore
          }
        }
        turnstileWidgetIdRef.current = null;
      };
    }
  }, [provider, siteKey]);

  useEffect(() => {
    if (state.success) {
      // The panel replaces the form, so the focused submit button is gone; without this,
      // focus falls back to <body> and a screen-reader user loses their place.
      successRef.current?.focus();
      return;
    }

    if (state.message) setFieldsVersion((version) => version + 1);
  }, [state]);

  useEffect(() => {
    if (!state.success && state.message) {
      setRecaptchaToken('');

      if (provider === 'turnstile') {
        setTurnstileToken('');
        pendingTurnstileFormRef.current = null;
        setIsVerifyingTurnstile(false);
        const widgetId = turnstileWidgetIdRef.current;
        if (widgetId && typeof window !== 'undefined' && (window as any).turnstile) {
          try {
            (window as any).turnstile.reset(widgetId);
          } catch {
            // Ignore reset failures; the next render can still create a fresh token.
          }
        }
      }
    }
  }, [provider, state.message, state.success]);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    if (provider === 'turnstile' && siteKey) {
      const widgetId = turnstileWidgetIdRef.current;
      const turnstile = typeof window !== 'undefined' ? (window as any).turnstile : undefined;
      const token = widgetId && turnstile
        ? turnstile.getResponse(widgetId)
        : turnstileToken;

      const input = e.currentTarget.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
      if (token && input) {
        input.value = token;
        return;
      }

      e.preventDefault();

      if (!widgetId || !turnstile) {
        pendingTurnstileFormRef.current = e.currentTarget;
        setVerificationError('');
        setIsVerifyingTurnstile(true);
        return;
      }

      pendingTurnstileFormRef.current = e.currentTarget;
      setVerificationError('');
      setIsVerifyingTurnstile(true);

      try {
        turnstile.execute(widgetId);
      } catch (err) {
        console.error("Turnstile execute error:", err);
        pendingTurnstileFormRef.current = null;
        setIsVerifyingTurnstile(false);
        setVerificationError('start');
      }
      return;
    }

    if (provider === 'recaptcha' && siteKey && !recaptchaToken) {
      e.preventDefault();
      const form = e.currentTarget;
      const grecaptcha = typeof window !== 'undefined' ? (window as any).grecaptcha : undefined;

      // A blocked or still-loading script used to swallow the submit without a word.
      if (!grecaptcha) {
        setVerificationError('load');
        return;
      }

      setVerificationError('');
      grecaptcha.ready(() => {
        grecaptcha
          .execute(siteKey, { action: 'submit' })
          .then((token: string) => {
            setRecaptchaToken(token);
            const input = form.querySelector('input[name="g-recaptcha-response"]') as HTMLInputElement;
            if (input) {
              input.value = token;
            }
            form.requestSubmit();
          })
          .catch(() => setVerificationError('failed'));
      });
    }
  };

  if (state.success) {
    return (
      <div
        ref={successRef}
        tabIndex={-1}
        role="status"
        className="p-4 rounded-md bg-green-100 text-green-800 text-center outline-hidden"
        {...visualEditAttributes}
      >
        {content.success_message}
      </div>
    );
  }

  return (
    <>
      {provider === 'recaptcha' && siteKey && (
        <Script
          strategy="lazyOnload"
          src={`https://www.google.com/recaptcha/api.js?render=${siteKey}`}
          nonce={scriptNonce}
        />
      )}
      {provider === 'turnstile' && siteKey && (
        <Script
          strategy="afterInteractive"
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          nonce={scriptNonce}
          onError={() => {
            pendingTurnstileFormRef.current = null;
            setIsVerifyingTurnstile(false);
            setVerificationError('load');
          }}
        />
      )}

      <form
        action={formAction}
        onSubmit={handleSubmit}
        className="space-y-4 my-6 container mx-auto"
        {...visualEditAttributes}
      >
        {/* Invisible honeypot. `aria-hidden` and the neutral field name keep assistive tech
            and browser autofill away from it (see lib/botProtection/fields.ts). */}
        <div
          aria-hidden="true"
          className="absolute opacity-0 w-0 h-0 overflow-hidden pointer-events-none select-none"
          style={{ opacity: 0, width: 0, height: 0, zIndex: -1 }}
        >
          <label htmlFor={`${HONEYPOT_FIELD}-${content.form_key ?? 'form'}`}>Do not fill this field</label>
          <input
            id={`${HONEYPOT_FIELD}-${content.form_key ?? 'form'}`}
            type="text"
            name={HONEYPOT_FIELD}
            tabIndex={-1}
            autoComplete="off"
          />
        </div>
        <input type="hidden" name="locale" value={lang} />

        <div key={fieldsVersion} className="space-y-4">
          {content.fields.map((field: FormField) => {
            const requiredMark = field.is_required && (
              <span aria-hidden="true" className="text-red-500">*</span>
            );

            // A radio group is labelled by a legend: a <label for> has no single control to
            // point at, so the question used to be announced for none of the options.
            if (field.field_type === 'radio') {
              return (
                <fieldset key={field.temp_id} className="space-y-2">
                  <legend className="text-sm font-medium leading-none">
                    {field.label} {requiredMark}
                  </legend>
                  {renderField(field, { label, values: state.values })}
                </fieldset>
              );
            }

            return (
              <div key={field.temp_id} className="space-y-2">
                <Label htmlFor={field.temp_id}>
                  {field.label} {requiredMark}
                </Label>
                {renderField(field, { label, values: state.values })}
              </div>
            );
          })}
        </div>

        {provider === 'recaptcha' && (
          <input type="hidden" name="g-recaptcha-response" value={recaptchaToken} readOnly />
        )}

        {provider === 'turnstile' && siteKey && (
          <div className="my-4 flex justify-start">
            <input type="hidden" name="cf-turnstile-response" value={turnstileToken} readOnly />
            <div ref={turnstileRef}></div>
          </div>
        )}

        {verificationError && (
          <p role="alert" className="text-sm text-red-600">{verificationErrorText(label, verificationError)}</p>
        )}

        {state.message && !state.success && (
            <p role="alert" className="text-sm text-red-600">{submissionErrorText(label, state.code, state.message)}</p>
        )}
        <SubmitButton text={content.submit_button_text} verifying={isVerifyingTurnstile} />
      </form>
    </>
  );
};

const renderField = (
    field: FormField,
    { label, values }: { label: Label; values?: Record<string, string> }
) => {
    const commonProps = {
        id: field.temp_id,
        // Keyed on the stable temp_id, not the label: renaming a field's label used to
        // silently change its FormData key and orphan the value.
        name: `f_${field.temp_id}`,
        placeholder: field.placeholder || '',
        required: field.is_required,
    };
    // What the visitor typed before a failed submission (see `fieldsVersion`).
    const previous = values?.[commonProps.name];

    switch (field.field_type) {
        case 'textarea':
            return <Textarea {...commonProps} defaultValue={previous} />;
        case 'select':
            return (
                <Select name={commonProps.name} required={field.is_required} defaultValue={previous || undefined}>
                    <SelectTrigger id={commonProps.id}>
                        <SelectValue placeholder={field.placeholder || label('select_an_option', 'Select an option', 'Sélectionnez une option')} />
                    </SelectTrigger>
                    <SelectContent>
                        {field.options?.map(opt => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
                    </SelectContent>
                </Select>
            );
        case 'radio':
            return (
                <div className="space-y-1">
                    {field.options?.map(opt => (
                        // The label wraps the input, so the gap between them is clickable too.
                        <label key={opt.value} className="flex items-center gap-2 py-1 text-sm font-medium leading-none">
                            <input
                              type="radio"
                              name={commonProps.name}
                              value={opt.value}
                              required={field.is_required}
                              defaultChecked={previous === opt.value}
                              className="h-4 w-4"
                            />
                            {opt.label}
                        </label>
                    ))}
                </div>
            );
        case 'checkbox':
             return (
                <label className="flex items-center gap-2 py-1 text-sm leading-none">
                    <Checkbox
                      id={commonProps.id}
                      name={commonProps.name}
                      required={field.is_required}
                      defaultChecked={previous === 'on'}
                    />
                    {field.placeholder || label('forms.checkbox_default', 'I agree', "J'accepte")}
                </label>
             );
        case 'email':
            return <Input type="email" autoComplete="email" spellCheck={false} {...commonProps} defaultValue={previous} />;
        case 'tel':
            return <Input type="tel" inputMode="tel" autoComplete="tel" {...commonProps} defaultValue={previous} />;
        case 'url':
            return <Input type="url" inputMode="url" autoComplete="url" spellCheck={false} {...commonProps} defaultValue={previous} />;
        case 'number':
            return <Input type="number" inputMode="decimal" {...commonProps} defaultValue={previous} />;
        case 'text':
        default:
            return <Input type="text" {...commonProps} defaultValue={previous} />;
    }
};

export default FormBlockRenderer;
