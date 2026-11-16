'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { useTranslations } from '@nextblock-cms/utils/translations-context';
import { logConsentDecision } from '../../app/actions/consent';
import { useLabel } from '../../lib/i18n/use-label';
import { readConsent, writeConsent } from '../../lib/privacy/consent-client';
import { isConsentWithdrawal, withdrawConsent } from '../../lib/privacy/consent-withdrawal';
import { CONSENT_BANNER_ID, registerConsentBanner, setConsentBannerOnScreen } from './consent-banner-control';
import { CONSENT_SETTINGS_COPY } from './consent-copy';

/**
 * Minimal floating consent pill, bottom-right. Shown until a decision exists (the
 * nb_consent_preference cookie). Decisions persist client-side and are mirrored to
 * privacy_consent_logs for accountability.
 *
 * The footer's "Cookie settings" control (CookieSettingsButton) reopens it, so a visitor can change
 * or withdraw a choice: the options open with the stored choice checked and focus moves into the
 * banner. Close and Escape keep the stored choice; Save choices and the two buttons record a new
 * one. Either way focus returns to the control. A first visit is unchanged: the banner appears
 * without taking focus and closes only on a decision.
 *
 * Refusing a category the stored choice granted withdraws consent (lib/privacy/consent-withdrawal):
 * the Google tags are told consent is denied, their cookies are expired, and the page reloads once
 * the decision's log request settles, so nothing that consent loaded keeps running.
 */
export function ConsentBanner() {
  const { lang, t } = useTranslations();
  const label = useLabel();
  const [visible, setVisible] = useState(false);
  const [managing, setManaging] = useState(false);
  const [analytics, setAnalytics] = useState(true);
  const [marketing, setMarketing] = useState(false);
  // Reopened on a stored decision: it may close without a new one, and says the choice is shown.
  const [reopened, setReopened] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const isFrench = lang.toLowerCase().startsWith('fr');

  const translate = (key: string, fallback: string) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
  };

  const privacyPolicyHref = translate(
    'privacy.consent.privacy_policy_href',
    isFrench ? '/politique-de-confidentialite' : '/privacy-policy',
  );

  useEffect(() => {
    if (!readConsent()) setVisible(true);
  }, []);

  // The footer control reopens the banner on the stored choice, options open.
  useEffect(
    () =>
      registerConsentBanner((returnFocusTo) => {
        const stored = readConsent();
        if (stored) {
          setAnalytics(stored.analytics);
          setMarketing(stored.marketing);
        }
        setReopened(stored !== null);
        setManaging(true);
        returnFocusRef.current = returnFocusTo;
        setVisible(true);
        setFocusRequest((count) => count + 1);
      }),
    [],
  );

  useEffect(() => {
    setConsentBannerOnScreen(visible);
  }, [visible]);

  // Only a reopen moves focus: a first visit never takes it from the page.
  useEffect(() => {
    if (focusRequest > 0) dialogRef.current?.focus();
  }, [focusRequest]);

  const close = () => {
    setVisible(false);
    const opener = returnFocusRef.current;
    returnFocusRef.current = null;
    if (opener?.isConnected) opener.focus();
  };

  const decide = (choice: { analytics: boolean; marketing: boolean }) => {
    const previous = readConsent();
    const pref = writeConsent(choice);
    const logged = logConsentDecision({
      token: pref.token,
      analytics: choice.analytics,
      marketing: choice.marketing,
    });
    close();
    if (isConsentWithdrawal(previous, choice)) void withdrawConsent(logged);
  };

  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !reopened) return;
    event.stopPropagation();
    close();
  };

  if (!visible) return null;

  const closeLabel = label(CONSENT_SETTINGS_COPY.close.key, CONSENT_SETTINGS_COPY.close.en, CONSENT_SETTINGS_COPY.close.fr);

  return (
    <div
      ref={dialogRef}
      id={CONSENT_BANNER_ID}
      role="dialog"
      aria-label={translate('privacy.consent.aria_label', 'Privacy consent')}
      tabIndex={-1}
      onKeyDown={closeOnEscape}
      className="fixed bottom-4 right-4 z-[70] w-[min(92vw,360px)] rounded-2xl outline-hidden animate-in fade-in slide-in-from-bottom-2 duration-300 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="relative rounded-2xl border border-slate-200/70 bg-white/95 p-4 shadow-[0_8px_30px_rgba(15,23,42,0.12)] backdrop-blur-md dark:border-slate-700/60 dark:bg-slate-900/95 dark:shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
        {reopened && (
          <button
            type="button"
            onClick={close}
            aria-label={closeLabel}
            title={closeLabel}
            className="absolute right-2 top-2 rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        <p className={`text-sm font-medium text-slate-900 dark:text-slate-100${reopened ? ' pr-8' : ''}`}>
          {translate('privacy.consent.title', 'We value your privacy')}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {translate(
            'privacy.consent.description_before_policy_link',
            'We use only essential cookies by default. With your consent we also use analytics to improve the site. See our',
          )}{' '}
          <Link
            href={privacyPolicyHref}
            className="underline underline-offset-2 hover:text-slate-700 dark:hover:text-slate-200"
          >
            {translate('privacy.consent.privacy_policy_link', 'Privacy Policy')}
          </Link>
          {translate('privacy.consent.description_after_policy_link', '.')}
        </p>
        {reopened && (
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
            {label(
              CONSENT_SETTINGS_COPY.currentChoice.key,
              CONSENT_SETTINGS_COPY.currentChoice.en,
              CONSENT_SETTINGS_COPY.currentChoice.fr,
            )}
          </p>
        )}

        {managing && (
          <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
            <label className="flex items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-300">
              <span>
                <span className="font-medium text-slate-800 dark:text-slate-200">
                  {translate('privacy.consent.necessary_label', 'Necessary')}
                </span>
                <span className="block text-[11px] text-slate-400">
                  {translate('privacy.consent.necessary_help', 'Always on')}
                </span>
              </span>
              <input
                type="checkbox"
                checked
                disabled
                className="h-4 w-4 accent-slate-400"
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-300">
              <span>
                <span className="font-medium text-slate-800 dark:text-slate-200">
                  {translate('privacy.consent.analytics_label', 'Analytics')}
                </span>
                <span className="block text-[11px] text-slate-400">
                  {translate(
                    'privacy.consent.analytics_help',
                    'Usage insights',
                  )}
                </span>
              </span>
              <input
                type="checkbox"
                checked={analytics}
                onChange={(e) => setAnalytics(e.target.checked)}
                className="h-4 w-4 accent-slate-900 dark:accent-slate-100"
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-300">
              <span>
                <span className="font-medium text-slate-800 dark:text-slate-200">
                  {translate('privacy.consent.marketing_label', 'Marketing')}
                </span>
                <span className="block text-[11px] text-slate-400">
                  {translate(
                    'privacy.consent.marketing_help',
                    'Personalized content',
                  )}
                </span>
              </span>
              <input
                type="checkbox"
                checked={marketing}
                onChange={(e) => setMarketing(e.target.checked)}
                className="h-4 w-4 accent-slate-900 dark:accent-slate-100"
              />
            </label>
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          {managing ? (
            <button
              type="button"
              onClick={() => decide({ analytics, marketing })}
              className="flex-1 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
            >
              {translate('privacy.consent.save_choices', 'Save choices')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => decide({ analytics: true, marketing: true })}
              className="flex-1 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
            >
              {translate('privacy.consent.accept_all', 'Accept all')}
            </button>
          )}
          <button
            type="button"
            onClick={() => decide({ analytics: false, marketing: false })}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {translate('privacy.consent.reject_all', 'Reject all')}
          </button>
        </div>

        <button
          type="button"
          onClick={() => setManaging((prev) => !prev)}
          className="mt-2 w-full text-center text-[11px] text-slate-800 underline underline-offset-2 transition-colors hover:text-slate-600 dark:text-slate-300 dark:hover:text-slate-100"
        >
          {managing
            ? translate('privacy.consent.hide_options', 'Hide options')
            : translate('privacy.consent.manage_options', 'Manage options')}
        </button>
      </div>
    </div>
  );
}
