/**
 * What withdrawing consent does in the browser (Law 25 / GDPR). Saving a choice rewrites the consent
 * cookie, and ConsentGatedAnalytics then stops rendering its tags, but a script that already ran
 * stays loaded: gtag.js and gtm.js keep sending page views on every client-side navigation, the
 * consented custom scripts keep running and the analytics cookies stay on the device. So when a
 * category the visitor had granted is refused (ConsentBanner's decide):
 *
 *  1. the Google tags are told that consent is denied (Consent Mode v2);
 *  2. their first-party cookies are expired, on the host and on each parent domain;
 *  3. the decision's privacy_consent_logs request (a server action, possibly still queued) gets up
 *     to CONSENT_LOG_WAIT_MS to finish before the reload; past that it is best effort;
 *  4. the page reloads, so no script that consent loaded survives.
 *
 * A first decision, the same choice again or granting more does none of this. Nothing here runs at
 * import, so a server render may import the module.
 */
import { reloadPage } from './reload-page';
import type { ConsentCategories } from './types';

type ConsentChoice = Pick<ConsentCategories, 'analytics' | 'marketing'>;

/** True when a category the previous choice granted is refused now. A first decision never is. */
export function isConsentWithdrawal(previous: ConsentChoice | null, next: ConsentChoice): boolean {
  if (!previous) return false;
  return (previous.analytics && !next.analytics) || (previous.marketing && !next.marketing);
}

/** Consent Mode v2 with every storage the Google tags use denied. */
export const GOOGLE_CONSENT_DENIED = Object.freeze({
  analytics_storage: 'denied',
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
} as const);

/**
 * A command in the form gtag() pushes it. gtag.js and GTM read a command such as
 * ('consent', 'update', …) only from an Arguments object; the same values pushed as an array are
 * ignored.
 */
const gtagCommand: (...command: unknown[]) => IArguments = function () {
  // eslint-disable-next-line prefer-rest-params -- the tag libraries need this exact object
  return arguments;
};

type TagWindow = { gtag?: (...command: unknown[]) => void; dataLayer?: unknown };

/**
 * Tells the Google tags on the page that consent is denied: through gtag() when GA4's snippet
 * defined it (it pushes onto the dataLayer GTM reads too), else straight onto GTM's dataLayer.
 * False when neither is on the page.
 */
export function denyGoogleConsent(win: Window = window): boolean {
  const tags = win as unknown as TagWindow;
  const update = { ...GOOGLE_CONSENT_DENIED };
  if (typeof tags.gtag === 'function') {
    tags.gtag('consent', 'update', update);
    return true;
  }
  if (Array.isArray(tags.dataLayer)) {
    tags.dataLayer.push(gtagCommand('consent', 'update', update));
    return true;
  }
  return false;
}

/**
 * The first-party cookies Google's tags set: GA4 (`_ga`, `_ga_<container>`), Universal Analytics
 * (`_gid`, `_gat`, `_gat_<property>`, `_gac_<property>`), GTM (`_dc_gtm_<property>`) and the Ads
 * conversion linker (`_gcl_au`, `_gcl_aw`, …).
 */
const GOOGLE_TAG_COOKIE = /^(?:_ga|_ga_.+|_gid|_gat|_gat_.+|_gac_.+|_dc_gtm_.+|_gcl_.+)$/;

export function isGoogleTagCookie(name: string): boolean {
  return GOOGLE_TAG_COOKIE.test(name);
}

/**
 * The Domain values a script on `hostname` can have scoped a cookie to: the host and each parent
 * domain. GA's default cookie_domain ('auto') writes to the highest one the browser accepts, such as
 * example.com for www.example.com. An IP address or a single-label host (localhost) has none. The
 * list can end on a public suffix (co.uk); browsers refuse that Domain, so writing to it changes
 * nothing.
 */
export function cookieDomainsFor(hostname: string): string[] {
  const host = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (!host.includes('.') || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host)) return [];
  const labels = host.split('.');
  return labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'));
}

const EXPIRED = 'Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';

/**
 * Expires every Google tag cookie the page can read, host-only and on each parent domain, at Path=/
 * where the tags write them. Other cookies, the consent cookie included, are left alone. Returns the
 * names it expired.
 */
export function expireGoogleTagCookies(doc: Document = document): string[] {
  const names = new Set<string>();
  for (const entry of doc.cookie.split(';')) {
    const name = entry.split('=', 1)[0]?.trim() ?? '';
    if (isGoogleTagCookie(name)) names.add(name);
  }
  if (names.size === 0) return [];

  const scopes = ['', ...cookieDomainsFor(doc.location?.hostname ?? '').map((domain) => `; Domain=${domain}`)];
  for (const name of names) {
    for (const scope of scopes) {
      doc.cookie = `${name}=; ${EXPIRED}; Path=/${scope}`;
    }
  }
  return [...names];
}

/**
 * How long a withdrawal waits for its privacy_consent_logs request before reloading anyway, so a
 * stalled network cannot leave the withdrawn tags loaded. Past the cap the record is best effort:
 * the request is a server action, which Next queues behind any pending router action and sends
 * without keepalive, so one not sent within these 4 s is lost to the reload.
 */
export const CONSENT_LOG_WAIT_MS = 4000;

function settledWithin(promise: PromiseLike<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    Promise.resolve(promise).then(done, done);
  });
}

/** One teardown step: a step that throws (a broken gtag) must not stop the reload. */
function attempt(step: () => unknown): void {
  try {
    step();
  } catch (error) {
    console.error('Consent withdrawal step failed:', error);
  }
}

/**
 * Stops what a withdrawn consent loaded. `logged` is the decision's privacy_consent_logs request (a
 * server action, possibly still queued): the page reloads once it settles, or after
 * CONSENT_LOG_WAIT_MS, whichever is first.
 */
export async function withdrawConsent(logged: PromiseLike<unknown>): Promise<void> {
  attempt(() => denyGoogleConsent());
  attempt(() => expireGoogleTagCookies());
  await settledWithin(logged, CONSENT_LOG_WAIT_MS);
  // The tags run until the page goes: drop any cookie they wrote while the record was sent.
  attempt(() => expireGoogleTagCookies());
  reloadPage();
}
