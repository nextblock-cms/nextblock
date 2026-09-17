"use client";

import React, { useEffect, useRef, useState } from 'react';
import Script from 'next/script';

// Field names shared with the server verifier (lib/botProtection/verify.ts).
import {
  HONEYPOT_FIELD,
  RECAPTCHA_TOKEN_FIELD,
  TURNSTILE_TOKEN_FIELD,
} from '../../lib/botProtection/fields';

type BotProtectionProvider = 'none' | 'turnstile' | 'recaptcha';

interface AuthBotProtectionProps {
  provider: BotProtectionProvider;
  siteKey: string;
  scriptNonce?: string;
}

/**
 * Drop-in bot protection for auth forms. Renders inside a <form> and contributes:
 *  - an always-on honeypot field (catches naive bots with zero UX cost), and
 *  - the site-configured Turnstile / reCAPTCHA widget, writing its token into a
 *    hidden input so it submits with the surrounding form.
 *
 * It never intercepts submit: auth actions redirect on every outcome, so a failed
 * attempt reloads the page and remounts a fresh widget — no stale single-use tokens.
 */
export function AuthBotProtection({ provider, siteKey, scriptNonce }: AuthBotProtectionProps) {
  const turnstileRef = useRef<HTMLDivElement>(null);
  const turnstileWidgetIdRef = useRef<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [recaptchaToken, setRecaptchaToken] = useState('');

  const showTurnstile = provider === 'turnstile' && !!siteKey;
  const showRecaptcha = provider === 'recaptcha' && !!siteKey;

  // Turnstile: explicit managed render. The callback fires once the challenge is
  // solved (usually automatically) and we stash the token in a hidden input.
  useEffect(() => {
    if (!showTurnstile || typeof window === 'undefined') return;

    let widgetId: string | null = null;

    const renderWidget = () => {
      const turnstile = (window as any).turnstile;
      if (!turnstile || !turnstileRef.current) return;
      turnstileRef.current.innerHTML = '';
      try {
        widgetId = turnstile.render(turnstileRef.current, {
          sitekey: siteKey,
          theme: 'auto',
          'response-field': false,
          callback: (token: string) => setTurnstileToken(token),
          'expired-callback': () => setTurnstileToken(''),
          'error-callback': () => setTurnstileToken(''),
          'timeout-callback': () => setTurnstileToken(''),
        });
        turnstileWidgetIdRef.current = widgetId;
      } catch (err) {
        console.error('Turnstile render error:', err);
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
      const turnstile = (window as any).turnstile;
      if (widgetId && turnstile) {
        try {
          turnstile.remove(widgetId);
        } catch {
          // ignore
        }
      }
      turnstileWidgetIdRef.current = null;
    };
  }, [showTurnstile, siteKey]);

  // reCAPTCHA v3: invisible + score-based. Fetch a token on load and refresh it
  // before the ~2min expiry so a token is always waiting when the user submits.
  useEffect(() => {
    if (!showRecaptcha || typeof window === 'undefined') return;

    let cancelled = false;

    const execute = () => {
      const grecaptcha = (window as any).grecaptcha;
      if (!grecaptcha?.execute) return;
      grecaptcha.ready(() => {
        grecaptcha
          .execute(siteKey, { action: 'signup' })
          .then((token: string) => {
            if (!cancelled) setRecaptchaToken(token);
          })
          .catch(() => {
            /* transient; the next refresh retries */
          });
      });
    };

    let readyPoll: ReturnType<typeof setInterval> | null = null;
    if ((window as any).grecaptcha?.execute) {
      execute();
    } else {
      readyPoll = setInterval(() => {
        if ((window as any).grecaptcha?.execute) {
          if (readyPoll) clearInterval(readyPoll);
          readyPoll = null;
          execute();
        }
      }, 200);
    }

    const refresh = setInterval(execute, 100_000);

    return () => {
      cancelled = true;
      if (readyPoll) clearInterval(readyPoll);
      clearInterval(refresh);
    };
  }, [showRecaptcha, siteKey]);

  return (
    <>
      {showRecaptcha && (
        <Script
          strategy="lazyOnload"
          src={`https://www.google.com/recaptcha/api.js?render=${siteKey}`}
          nonce={scriptNonce}
        />
      )}
      {showTurnstile && (
        <Script
          strategy="afterInteractive"
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          nonce={scriptNonce}
        />
      )}

      {/* Invisible honeypot: a real user never sees or fills this; bots do. */}
      <div
        aria-hidden="true"
        className="absolute w-0 h-0 overflow-hidden"
        style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden', opacity: 0, zIndex: -1 }}
      >
        <label htmlFor={HONEYPOT_FIELD} className="sr-only">
          Do not fill this field
        </label>
        <input
          id={HONEYPOT_FIELD}
          type="text"
          name={HONEYPOT_FIELD}
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      {showTurnstile && (
        <div className="my-2 flex justify-start">
          <input type="hidden" name={TURNSTILE_TOKEN_FIELD} value={turnstileToken} readOnly />
          <div ref={turnstileRef} />
        </div>
      )}

      {showRecaptcha && (
        <input type="hidden" name={RECAPTCHA_TOKEN_FIELD} value={recaptchaToken} readOnly />
      )}
    </>
  );
}

export default AuthBotProtection;
