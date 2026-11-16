/**
 * How the public footer's "Cookie settings" control (CookieSettingsButton) reaches the Law 25 consent
 * banner (ConsentBanner). The root layout mounts the banner only while it is enabled
 * (privacy_settings.banner_enabled); on mount it registers how to reopen itself, and the control
 * renders only while a banner is registered, so a site without the banner shows no control that
 * does nothing. Browser state only: effects never run during a server render, so nothing registers
 * there and every server render reads `absent`.
 */

/** No banner mounted, a banner off screen, or a banner on screen (the control's aria-expanded). */
export type ConsentBannerState = 'absent' | 'closed' | 'open';

/** Reopens the banner on the stored choice; focus returns to `returnFocusTo` once it closes. */
type ConsentBannerOpener = (returnFocusTo: HTMLElement | null) => void;

/** The banner's element id, for the control's aria-controls. */
export const CONSENT_BANNER_ID = 'nb-consent-banner';

let opener: ConsentBannerOpener | null = null;
let onScreen = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** The mounted banner hands over how to reopen it. The returned function withdraws it (unmount). */
export function registerConsentBanner(open: ConsentBannerOpener): () => void {
  opener = open;
  notify();

  return () => {
    if (opener !== open) return;
    opener = null;
    onScreen = false;
    notify();
  };
}

/** The banner reports whether it is on screen. */
export function setConsentBannerOnScreen(next: boolean): void {
  if (onScreen === next) return;
  onScreen = next;
  notify();
}

export function subscribeToConsentBanner(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getConsentBannerState(): ConsentBannerState {
  if (!opener) return 'absent';
  return onScreen ? 'open' : 'closed';
}

/** The server render (and the hydration pass that must match it): no banner has registered. */
export function getServerConsentBannerState(): ConsentBannerState {
  return 'absent';
}

/** Reopens the banner, if one is mounted. False when there is none. */
export function openConsentBanner(returnFocusTo: HTMLElement | null = null): boolean {
  if (!opener) return false;
  opener(returnFocusTo);
  return true;
}
