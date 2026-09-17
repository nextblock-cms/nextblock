'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from '@nextblock-cms/utils';
import { logConsentDecision } from '../../app/actions/consent';
import { readConsent, writeConsent } from '../../lib/privacy/consent-client';

/**
 * Minimal floating consent pill, bottom-right. Renders nothing once a decision
 * exists (the nb_consent_preference cookie). Decisions persist client-side and
 * are mirrored to privacy_consent_logs for accountability.
 */
export function ConsentBanner() {
  const { lang, t } = useTranslations();
  const [visible, setVisible] = useState(false);
  const [managing, setManaging] = useState(false);
  const [analytics, setAnalytics] = useState(true);
  const [marketing, setMarketing] = useState(false);
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

  const decide = (choice: { analytics: boolean; marketing: boolean }) => {
    const pref = writeConsent(choice);
    void logConsentDecision({
      token: pref.token,
      analytics: choice.analytics,
      marketing: choice.marketing,
    });
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label={translate('privacy.consent.aria_label', 'Privacy consent')}
      className="fixed bottom-4 right-4 z-[70] w-[min(92vw,360px)] animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <div className="rounded-2xl border border-slate-200/70 bg-white/95 p-4 shadow-[0_8px_30px_rgba(15,23,42,0.12)] backdrop-blur-md dark:border-slate-700/60 dark:bg-slate-900/95 dark:shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
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
