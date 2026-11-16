// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 0.23.4 verification (F2, F5): withdrawing consent from the reopened banner rewrote the consent
 * cookie and nothing else. gtag.js, gtm.js and the consented custom scripts kept running for the
 * rest of the visit and the analytics cookies stayed set, while privacy_consent_logs recorded the
 * withdrawal. A withdrawal now tells the Google tags, expires their cookies on every domain level
 * and reloads the page once the decision's log request settles.
 */

const mocks = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock('./reload-page', () => ({ reloadPage: mocks.reloadPage }));

import {
  CONSENT_LOG_WAIT_MS,
  cookieDomainsFor,
  denyGoogleConsent,
  expireGoogleTagCookies,
  isConsentWithdrawal,
  isGoogleTagCookie,
  withdrawConsent,
} from './consent-withdrawal';
import { CONSENT_COOKIE_NAME } from './types';

const DENIED = {
  analytics_storage: 'denied',
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
};

type TagWindow = { gtag?: unknown; dataLayer?: unknown };
const tagWindow = window as unknown as TagWindow;

// Vitest's jsdom environment exposes the JSDOM instance: reconfigure moves the page to another URL,
// and the real cookie jar then applies that host's Domain rules.
const dom = (globalThis as unknown as { jsdom: { reconfigure(settings: { url: string }): void } }).jsdom;
const DEFAULT_URL = window.location.href;

function cookieNames(): string[] {
  return document.cookie
    .split(';')
    .map((entry) => entry.split('=')[0].trim())
    .filter(Boolean)
    .sort();
}

/** Removes every cookie the page can read, host-only and on each listed domain. */
function clearCookies(domains: string[] = []) {
  for (const name of cookieNames()) {
    for (const scope of ['', ...domains.map((domain) => `; Domain=${domain}`)]) {
      document.cookie = `${name}=; Max-Age=0; Path=/${scope}`;
    }
  }
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  delete tagWindow.gtag;
  delete tagWindow.dataLayer;
  clearCookies();
  dom.reconfigure({ url: DEFAULT_URL });
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.reloadPage.mockReset();
});

describe('isConsentWithdrawal', () => {
  const none = { analytics: false, marketing: false };
  const analytics = { analytics: true, marketing: false };
  const marketing = { analytics: false, marketing: true };
  const all = { analytics: true, marketing: true };

  it.each([
    ['a first refusal', null, none, false],
    ['a first acceptance', null, all, false],
    ['the same choice', analytics, analytics, false],
    ['refusing again', none, none, false],
    ['granting analytics', none, analytics, false],
    ['granting marketing', analytics, all, false],
    ['withdrawing analytics', analytics, none, true],
    ['withdrawing marketing, analytics kept', all, analytics, true],
    ['withdrawing both', all, none, true],
    ['trading analytics for marketing', analytics, marketing, true],
  ])('%s → %s', (_case, previous, next, expected) => {
    expect(isConsentWithdrawal(previous, next)).toBe(expected);
  });
});

describe('denyGoogleConsent', () => {
  it('calls gtag() when GA4 defined it, and pushes nothing of its own onto the dataLayer', () => {
    const gtag = vi.fn();
    const dataLayer: unknown[] = [];
    tagWindow.gtag = gtag;
    tagWindow.dataLayer = dataLayer;

    expect(denyGoogleConsent()).toBe(true);

    expect(gtag).toHaveBeenCalledTimes(1);
    expect(gtag).toHaveBeenCalledWith('consent', 'update', DENIED);
    expect(dataLayer).toEqual([]);
  });

  it('pushes the command onto GTM’s dataLayer as an Arguments object, the only form the tags read', () => {
    const dataLayer: unknown[] = [{ 'gtm.start': 1, event: 'gtm.js' }];
    tagWindow.dataLayer = dataLayer;

    expect(denyGoogleConsent()).toBe(true);

    expect(dataLayer).toHaveLength(2);
    const command = dataLayer[1];
    expect(Object.prototype.toString.call(command)).toBe('[object Arguments]');
    expect(Array.from(command as ArrayLike<unknown>)).toEqual(['consent', 'update', DENIED]);
  });

  it('does nothing, and creates neither, when no Google tag is on the page', () => {
    expect(denyGoogleConsent()).toBe(false);

    expect(tagWindow.gtag).toBeUndefined();
    expect(tagWindow.dataLayer).toBeUndefined();
  });
});

describe('isGoogleTagCookie', () => {
  it.each([
    '_ga',
    '_ga_ABC123XYZ',
    '_gid',
    '_gat',
    '_gat_UA-12345-1',
    '_gat_gtag_UA_12345_1',
    '_gac_UA-12345-1',
    '_dc_gtm_UA-12345-1',
    '_gcl_au',
    '_gcl_aw',
  ])('%s is one', (name) => {
    expect(isGoogleTagCookie(name)).toBe(true);
  });

  it.each([CONSENT_COOKIE_NAME, 'nb_affiliate_ref', '_gax', '_gate_session', '_ga_', '_gcl', 'ga', '__ga', 'sb-ref-auth-token'])(
    '%s is not',
    (name) => {
      expect(isGoogleTagCookie(name)).toBe(false);
    }
  );
});

describe('cookieDomainsFor', () => {
  it.each([
    ['www.shop.example.com', ['www.shop.example.com', 'shop.example.com', 'example.com']],
    ['example.com', ['example.com']],
    ['shop.example.co.uk', ['shop.example.co.uk', 'example.co.uk', 'co.uk']],
    ['WWW.Example.COM.', ['www.example.com', 'example.com']],
    ['localhost', []],
    ['127.0.0.1', []],
    ['[::1]', []],
  ])('%s → %j', (hostname, expected) => {
    expect(cookieDomainsFor(hostname)).toEqual(expected);
  });
});

describe('expireGoogleTagCookies', () => {
  const SHOP_DOMAINS = ['www.shop.example.com', 'shop.example.com', 'example.com'];

  afterEach(() => clearCookies(SHOP_DOMAINS));

  it('removes the Google cookies GA set on the registrable domain, on each subdomain and host-only, and keeps every other cookie', () => {
    dom.reconfigure({ url: 'https://www.shop.example.com/fr/page' });
    // Where the tags put them: GA's cookie_domain 'auto' picks example.com.
    document.cookie = '_ga=GA1.1.111.222; Path=/; Domain=example.com';
    document.cookie = '_ga_ABC123=GS1.1.333; Path=/; Domain=.example.com';
    document.cookie = '_gid=GA1.1.444; Path=/; Domain=shop.example.com';
    document.cookie = '_gcl_au=1.1.555; Path=/; Domain=www.shop.example.com';
    document.cookie = '_gat_gtag_UA_1_1=1; Path=/';
    document.cookie = '_ga=GA1.1.666.777; Path=/'; // a second, host-only _ga
    // What must survive.
    document.cookie = `${CONSENT_COOKIE_NAME}=%7B%7D; Path=/`;
    document.cookie = 'nb_affiliate_ref=partner; Path=/; Domain=example.com';
    document.cookie = '_gax=keep; Path=/';
    expect(document.cookie.match(/(?:^|; )_ga=/g)).toHaveLength(2);

    const expired = expireGoogleTagCookies();

    expect(expired.sort()).toEqual(['_ga', '_ga_ABC123', '_gat_gtag_UA_1_1', '_gcl_au', '_gid']);
    expect(cookieNames()).toEqual(['_gax', 'nb_affiliate_ref', CONSENT_COOKIE_NAME].sort());
  });

  it('removes host-only cookies on localhost, where no Domain applies', () => {
    document.cookie = '_ga=GA1.1.1.1; Path=/';
    document.cookie = '_gcl_au=1.1.2; Path=/';
    document.cookie = 'theme=dark; Path=/';

    expect(expireGoogleTagCookies().sort()).toEqual(['_ga', '_gcl_au']);
    expect(cookieNames()).toEqual(['theme']);
  });

  it('writes an expired copy at Path=/ for the host and each parent domain, and nothing without a Google cookie', () => {
    const writes: string[] = [];
    let jar = '_ga=GA1.1.1.1; theme=dark; _gcl_au=1.1.2';
    const fakeDocument = {
      get cookie() {
        return jar;
      },
      set cookie(value: string) {
        writes.push(value);
      },
      location: { hostname: 'www.example.com' },
    } as unknown as Document;

    expireGoogleTagCookies(fakeDocument);

    const expired = 'Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/';
    expect(writes).toEqual([
      `_ga=; ${expired}`,
      `_ga=; ${expired}; Domain=www.example.com`,
      `_ga=; ${expired}; Domain=example.com`,
      `_gcl_au=; ${expired}`,
      `_gcl_au=; ${expired}; Domain=www.example.com`,
      `_gcl_au=; ${expired}; Domain=example.com`,
    ]);

    writes.length = 0;
    jar = `theme=dark; ${CONSENT_COOKIE_NAME}=%7B%7D`;
    expect(expireGoogleTagCookies(fakeDocument)).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe('withdrawConsent', () => {
  it('denies consent and expires the cookies at once, then reloads once the log request settles', async () => {
    const gtag = vi.fn();
    tagWindow.gtag = gtag;
    document.cookie = '_ga=GA1.1.1.1; Path=/';
    document.cookie = '_gid=GA1.1.2; Path=/';
    const log = deferred();

    const done = withdrawConsent(log.promise);

    expect(gtag).toHaveBeenCalledWith('consent', 'update', DENIED);
    expect(cookieNames()).toEqual([]);
    await flush();
    expect(mocks.reloadPage).not.toHaveBeenCalled();

    log.resolve({ ok: true });
    await done;

    expect(mocks.reloadPage).toHaveBeenCalledTimes(1);
    expect(gtag.mock.invocationCallOrder[0]).toBeLessThan(mocks.reloadPage.mock.invocationCallOrder[0]);
  });

  it('expires again, right before the reload, a cookie a tag wrote while the record was on its way', async () => {
    let cookiesAtReload = '';
    mocks.reloadPage.mockImplementation(() => {
      cookiesAtReload = document.cookie;
    });
    document.cookie = '_ga=GA1.1.1.1; Path=/';
    const log = deferred();

    const done = withdrawConsent(log.promise);
    document.cookie = '_ga=GA1.1.9.9; Path=/'; // a tag still running
    log.resolve({ ok: true });
    await done;

    expect(mocks.reloadPage).toHaveBeenCalledTimes(1);
    expect(cookiesAtReload).toBe('');
  });

  it('still reloads when the log request fails', async () => {
    const log = deferred();
    const done = withdrawConsent(log.promise);

    log.reject(new Error('network down'));
    await done;

    expect(mocks.reloadPage).toHaveBeenCalledTimes(1);
  });

  it(`reloads after ${CONSENT_LOG_WAIT_MS} ms when the log request never settles, and not before`, async () => {
    vi.useFakeTimers();
    const done = withdrawConsent(new Promise(() => undefined));

    await vi.advanceTimersByTimeAsync(CONSENT_LOG_WAIT_MS - 1);
    expect(mocks.reloadPage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(mocks.reloadPage).toHaveBeenCalledTimes(1);
  });

  it('a broken gtag stops neither the cookie expiry nor the reload', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tagWindow.gtag = vi.fn(() => {
      throw new Error('broken tag');
    });
    document.cookie = '_ga=GA1.1.1.1; Path=/';

    await withdrawConsent(Promise.resolve({ ok: true }));

    expect(cookieNames()).toEqual([]);
    expect(mocks.reloadPage).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('Consent withdrawal step failed:', expect.any(Error));
  });
});
