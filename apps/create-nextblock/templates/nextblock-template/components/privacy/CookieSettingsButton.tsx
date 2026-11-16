'use client';

import { useSyncExternalStore } from 'react';
import { useLabel } from '../../lib/i18n/use-label';
import {
  CONSENT_BANNER_ID,
  getConsentBannerState,
  getServerConsentBannerState,
  openConsentBanner,
  subscribeToConsentBanner,
} from './consent-banner-control';
import { CONSENT_SETTINGS_COPY } from './consent-copy';

/**
 * The public footer's "Cookie settings" control. It reopens the Law 25 consent banner on the
 * visitor's current choice, so an answer can be changed or withdrawn later. It opens a dialog and
 * goes nowhere, so it is a button styled like the footer's links. It renders only while the banner
 * is mounted (enabled in CMS → Settings → Privacy), which happens after hydration.
 */
export function CookieSettingsButton() {
  const label = useLabel();
  const state = useSyncExternalStore(subscribeToConsentBanner, getConsentBannerState, getServerConsentBannerState);
  const { key, en, fr } = CONSENT_SETTINGS_COPY.cookieSettings;

  if (state === 'absent') return null;

  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={state === 'open'}
      aria-controls={state === 'open' ? CONSENT_BANNER_ID : undefined}
      onClick={(event) => openConsentBanner(event.currentTarget)}
      className="text-muted-foreground hover:text-foreground hover:underline"
    >
      {label(key, en, fr)}
    </button>
  );
}
