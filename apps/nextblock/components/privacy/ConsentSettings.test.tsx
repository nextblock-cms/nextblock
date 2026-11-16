// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 0.23 production review: once a visitor answered the Law 25 consent banner they could not change
 * their choice. The public footer now has a "Cookie settings" control (a button: it opens a dialog
 * and goes nowhere) that reopens the banner on the stored choice. Focus moves into the reopened
 * banner and returns to the control when it closes; Escape and Close keep the stored choice; a
 * first visit still never takes focus. Its copy is read with useLabel (EN + FR fallbacks) and
 * seeded by migration 02042.
 *
 * 0.23.4 verification (F2, F5): a withdrawal through that control only rewrote the cookie, so
 * gtag.js, gtm.js and the consented custom scripts kept running and the analytics cookies stayed.
 * Refusing a category the stored choice granted now tells the Google tags consent is denied,
 * expires their cookies and reloads the page once the decision's log request settles. Granting
 * more, the same choice and a first decision never reload.
 */

const mocks = vi.hoisted(() => ({
  lang: 'en',
  seeded: {} as Record<string, string>,
  logConsentDecision: vi.fn(async (_decision: { token: string; analytics: boolean; marketing: boolean }) => undefined),
  reloadPage: vi.fn(),
}));

vi.mock('@nextblock-cms/utils/translations-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nextblock-cms/utils/translations-context')>()),
  // `t()` answers an unseeded key with the key itself, as the real provider does.
  useTranslations: () => ({ lang: mocks.lang, t: (key: string) => mocks.seeded[key] ?? key }),
}));
vi.mock('../../app/actions/consent', () => ({ logConsentDecision: mocks.logConsentDecision }));
// jsdom cannot navigate: the withdrawal's reload is observed here instead.
vi.mock('../../lib/privacy/reload-page', () => ({ reloadPage: mocks.reloadPage }));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// AppShell's neighbours, which these tests do not exercise.
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('../Header', () => ({ default: () => null }));
vi.mock('../theme-switcher', () => ({ ThemeSwitcher: () => null }));
vi.mock('../SandboxBanner', () => ({ SandboxBanner: () => null }));
vi.mock('../env-var-warning', () => ({ EnvVarWarning: () => null }));

import { CONSENT_COOKIE_NAME } from '../../lib/privacy/types';
import { readConsent } from '../../lib/privacy/consent-client';
import { AppShell } from '../AppShell';
import { ConsentBanner } from './ConsentBanner';
import { CONSENT_BANNER_ID } from './consent-banner-control';
import { CONSENT_SETTINGS_COPY, CONSENT_SETTINGS_SEEDED_BY_02042 } from './consent-copy';
import { CookieSettingsButton } from './CookieSettingsButton';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}

function mount(ui: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(ui));
  return container;
}

/** A public page: the footer control, and the banner the root layout mounts while it is enabled. */
function renderPage({ banner = true }: { banner?: boolean } = {}) {
  const container = mount(
    <>
      <main>
        <p>Page content</p>
      </main>
      <footer>
        <CookieSettingsButton />
      </footer>
      {banner && <ConsentBanner />}
    </>
  );
  const queryDialog = () => container.querySelector<HTMLElement>('[role="dialog"]');
  const queryButton = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent === name || button.getAttribute('aria-label') === name
    );

  return {
    container,
    queryControl: () => container.querySelector<HTMLButtonElement>('footer button'),
    control: () => required(container.querySelector<HTMLButtonElement>('footer button'), 'the Cookie settings control'),
    queryDialog,
    dialog: () => required(queryDialog(), 'the consent banner'),
    queryButton,
    button: (name: string) => required(queryButton(name), `the "${name}" button`),
    checkbox: (name: 'Analytics' | 'Marketing') =>
      required(
        [...container.querySelectorAll('[role="dialog"] label')]
          .find((labelElement) => labelElement.textContent?.startsWith(name))
          ?.querySelector<HTMLInputElement>('input[type="checkbox"]'),
        `the ${name} checkbox`
      ),
  };
}

function storeConsent(choice: { analytics: boolean; marketing: boolean }) {
  const value = { necessary: true, ...choice, token: 'stored-token', ts: 1 };
  document.cookie = `${CONSENT_COOKIE_NAME}=${encodeURIComponent(JSON.stringify(value))}; Path=/`;
}

function pressEscape(target: Element | null) {
  act(() => {
    (target ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

/** What Consent Mode v2 must hear on a withdrawal. */
const CONSENT_DENIED = {
  analytics_storage: 'denied',
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
};

/** First-party cookies GA4, Universal Analytics and the Ads conversion linker set. */
const GOOGLE_COOKIES = ['_ga', '_ga_ABC123', '_gid', '_gat_gtag_UA_1_1', '_gcl_au'];

type TagWindow = { gtag?: (...command: unknown[]) => void; dataLayer?: unknown[] };
const tagWindow = window as unknown as TagWindow;

/** GA4's snippet, as a spy: it defines a global gtag(). */
function installGtag() {
  const gtag = vi.fn();
  tagWindow.gtag = gtag;
  return gtag;
}

function setGoogleCookies() {
  for (const name of GOOGLE_COOKIES) document.cookie = `${name}=GA1.1.42; Path=/`;
}

function googleCookiesLeft() {
  const names = document.cookie.split(';').map((entry) => entry.split('=')[0].trim());
  return GOOGLE_COOKIES.filter((name) => names.includes(name));
}

function deferredLog() {
  let resolve!: () => void;
  const promise = new Promise<undefined>((settle) => {
    resolve = () => settle(undefined);
  });
  return { promise, resolve };
}

/** Lets every pending promise callback run (the withdrawal waits on the log request). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  mocks.lang = 'en';
  mocks.seeded = {};
  mocks.logConsentDecision.mockReset();
  mocks.reloadPage.mockReset();
  document.cookie = `${CONSENT_COOKIE_NAME}=; Max-Age=0; Path=/`;
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  document.cookie = `${CONSENT_COOKIE_NAME}=; Max-Age=0; Path=/`;
  for (const name of GOOGLE_COOKIES) document.cookie = `${name}=; Max-Age=0; Path=/`;
  delete tagWindow.gtag;
  delete tagWindow.dataLayer;
});

describe('Cookie settings control', () => {
  it('renders nothing while no consent banner is mounted (banner disabled in Privacy settings)', () => {
    const page = renderPage({ banner: false });

    expect(page.queryControl()).toBeNull();
  });

  it('is a button, not a link, named in the visitor’s language', () => {
    storeConsent({ analytics: false, marketing: false });
    const page = renderPage();
    const control = page.control();

    expect(control.tagName).toBe('BUTTON');
    expect(control.type).toBe('button');
    expect(control.textContent).toBe('Cookie settings');
    expect(control.getAttribute('aria-haspopup')).toBe('dialog');
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(control.hasAttribute('aria-controls')).toBe(false);
    expect(page.container.querySelector('footer a')).toBeNull();
  });

  it('on a first visit leaves focus alone and the banner closes only on a decision', () => {
    const page = renderPage();

    expect(document.activeElement).toBe(document.body);
    expect(page.queryButton(CONSENT_SETTINGS_COPY.close.en)).toBeUndefined();
    expect(page.control().getAttribute('aria-expanded')).toBe('true');

    pressEscape(page.dialog());
    expect(page.queryDialog()).not.toBeNull();

    act(() => page.button('Reject all').click());
    expect(page.queryDialog()).toBeNull();
    expect(readConsent()).toMatchObject({ analytics: false, marketing: false });
    expect(mocks.logConsentDecision).toHaveBeenCalledWith(expect.objectContaining({ analytics: false, marketing: false }));
    expect(page.control().getAttribute('aria-expanded')).toBe('false');
  });

  it('reopens the banner on the stored choice and moves focus into it', () => {
    storeConsent({ analytics: true, marketing: false });
    const page = renderPage();
    expect(page.queryDialog()).toBeNull();

    act(() => page.control().click());

    const dialog = page.dialog();
    expect(dialog.id).toBe(CONSENT_BANNER_ID);
    expect(document.activeElement).toBe(dialog);
    expect(page.control().getAttribute('aria-expanded')).toBe('true');
    expect(page.control().getAttribute('aria-controls')).toBe(CONSENT_BANNER_ID);
    // The options are open on what the visitor chose.
    expect(page.checkbox('Analytics').checked).toBe(true);
    expect(page.checkbox('Marketing').checked).toBe(false);
    expect(dialog.textContent).toContain(CONSENT_SETTINGS_COPY.currentChoice.en);
    expect(page.queryButton('Save choices')).toBeDefined();
    expect(page.queryButton(CONSENT_SETTINGS_COPY.close.en)).toBeDefined();
  });

  it('saves a changed choice, records it once, closes and returns focus to the control', () => {
    storeConsent({ analytics: false, marketing: false });
    const page = renderPage();
    act(() => page.control().click());

    act(() => page.checkbox('Analytics').click());
    act(() => page.button('Save choices').click());

    expect(page.queryDialog()).toBeNull();
    expect(readConsent()).toMatchObject({ analytics: true, marketing: false });
    expect(mocks.logConsentDecision).toHaveBeenCalledTimes(1);
    expect(mocks.logConsentDecision).toHaveBeenCalledWith(expect.objectContaining({ analytics: true, marketing: false }));
    expect(document.activeElement).toBe(page.control());
    expect(page.control().getAttribute('aria-expanded')).toBe('false');

    // Reopened again, it shows the choice just saved.
    act(() => page.control().click());
    expect(page.checkbox('Analytics').checked).toBe(true);
    expect(page.checkbox('Marketing').checked).toBe(false);
  });

  it('withdraws consent with Reject all from the reopened banner, and stops what that consent loaded', async () => {
    storeConsent({ analytics: true, marketing: true });
    const gtag = installGtag();
    setGoogleCookies();
    const log = deferredLog();
    mocks.logConsentDecision.mockImplementationOnce(() => log.promise);
    const page = renderPage();
    act(() => page.control().click());

    act(() => page.button('Reject all').click());

    expect(readConsent()).toMatchObject({ analytics: false, marketing: false });
    expect(document.activeElement).toBe(page.control());
    // Recorded, the Google tags told, their cookies gone, the consent cookie kept.
    expect(mocks.logConsentDecision).toHaveBeenCalledTimes(1);
    expect(mocks.logConsentDecision).toHaveBeenCalledWith(expect.objectContaining({ analytics: false, marketing: false }));
    expect(gtag).toHaveBeenCalledTimes(1);
    expect(gtag).toHaveBeenCalledWith('consent', 'update', CONSENT_DENIED);
    expect(googleCookiesLeft()).toEqual([]);
    expect(readConsent()).not.toBeNull();

    // The page reloads once the log request settles, not before, and once.
    await settle();
    expect(mocks.reloadPage).not.toHaveBeenCalled();
    log.resolve();
    await settle();
    expect(mocks.reloadPage).toHaveBeenCalledTimes(1);
    expect(mocks.logConsentDecision.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reloadPage.mock.invocationCallOrder[0]
    );
  });

  it.each(['Escape', 'Close'] as const)('%s keeps the stored choice, records nothing and returns focus', (how) => {
    storeConsent({ analytics: true, marketing: false });
    const before = document.cookie;
    const page = renderPage();
    act(() => page.control().click());
    act(() => page.checkbox('Marketing').click());

    if (how === 'Escape') pressEscape(document.activeElement);
    else act(() => page.button(CONSENT_SETTINGS_COPY.close.en).click());

    expect(page.queryDialog()).toBeNull();
    expect(document.cookie).toBe(before);
    expect(readConsent()).toMatchObject({ analytics: true, marketing: false, token: 'stored-token' });
    expect(mocks.logConsentDecision).not.toHaveBeenCalled();
    expect(mocks.reloadPage).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(page.control());
  });

  it('opens the options of a banner already on screen without a decision, and keeps it open on Escape', () => {
    const page = renderPage();
    act(() => page.control().click());

    expect(document.activeElement).toBe(page.dialog());
    expect(page.checkbox('Analytics').checked).toBe(true);
    expect(page.queryButton(CONSENT_SETTINGS_COPY.close.en)).toBeUndefined();
    pressEscape(page.dialog());
    expect(page.queryDialog()).not.toBeNull();
  });
});

describe('Withdrawing consent', () => {
  type Page = ReturnType<typeof renderPage>;
  type Choice = { analytics: boolean; marketing: boolean };

  it('Save choices without Analytics withdraws it: GTM’s dataLayer hears the denial, the cookies go, the page reloads', async () => {
    storeConsent({ analytics: true, marketing: false });
    const dataLayer: unknown[] = [{ 'gtm.start': 1, event: 'gtm.js' }];
    tagWindow.dataLayer = dataLayer;
    setGoogleCookies();
    const page = renderPage();
    act(() => page.control().click());

    act(() => page.checkbox('Analytics').click());
    act(() => page.button('Save choices').click());

    expect(readConsent()).toMatchObject({ analytics: false, marketing: false });
    expect(mocks.logConsentDecision).toHaveBeenCalledWith(expect.objectContaining({ analytics: false, marketing: false }));
    // gtag()'s own form: GTM reads a command only from an Arguments object.
    const command = dataLayer.at(-1);
    expect(Object.prototype.toString.call(command)).toBe('[object Arguments]');
    expect(Array.from(command as ArrayLike<unknown>)).toEqual(['consent', 'update', CONSENT_DENIED]);
    expect(googleCookiesLeft()).toEqual([]);
    await settle();
    expect(mocks.reloadPage).toHaveBeenCalledTimes(1);
  });

  it('Save choices without Marketing withdraws it while Analytics stays granted', async () => {
    storeConsent({ analytics: true, marketing: true });
    const gtag = installGtag();
    setGoogleCookies();
    const page = renderPage();
    act(() => page.control().click());

    act(() => page.checkbox('Marketing').click());
    act(() => page.button('Save choices').click());

    expect(readConsent()).toMatchObject({ analytics: true, marketing: false });
    expect(gtag).toHaveBeenCalledWith('consent', 'update', CONSENT_DENIED);
    expect(googleCookiesLeft()).toEqual([]);
    await settle();
    expect(mocks.reloadPage).toHaveBeenCalledTimes(1);
  });

  const reopen = (page: Page) => act(() => page.control().click());
  const press = (page: Page, name: string) => act(() => page.button(name).click());
  const toggle = (page: Page, name: 'Analytics' | 'Marketing') => act(() => page.checkbox(name).click());

  it.each<[string, Choice | null, (page: Page) => void]>([
    ['a first Accept all', null, (page) => press(page, 'Accept all')],
    ['a first Reject all', null, (page) => press(page, 'Reject all')],
    [
      'a first Save choices',
      null,
      (page) => {
        press(page, 'Manage options');
        press(page, 'Save choices');
      },
    ],
    [
      'the same choice saved again',
      { analytics: true, marketing: false },
      (page) => {
        reopen(page);
        press(page, 'Save choices');
      },
    ],
    [
      'Reject all when nothing was granted',
      { analytics: false, marketing: false },
      (page) => {
        reopen(page);
        press(page, 'Reject all');
      },
    ],
    [
      'granting Analytics',
      { analytics: false, marketing: false },
      (page) => {
        reopen(page);
        toggle(page, 'Analytics');
        press(page, 'Save choices');
      },
    ],
    [
      'granting Marketing',
      { analytics: true, marketing: false },
      (page) => {
        reopen(page);
        toggle(page, 'Marketing');
        press(page, 'Save choices');
      },
    ],
  ])('%s is recorded without touching the tags, their cookies or the page', async (_case, stored, decide) => {
    if (stored) storeConsent(stored);
    const gtag = installGtag();
    setGoogleCookies();
    const page = renderPage();

    decide(page);
    await settle();

    expect(page.queryDialog()).toBeNull();
    expect(mocks.logConsentDecision).toHaveBeenCalledTimes(1);
    expect(gtag).not.toHaveBeenCalled();
    expect(googleCookiesLeft()).toEqual(GOOGLE_COOKIES);
    expect(mocks.reloadPage).not.toHaveBeenCalled();
  });
});

describe('Cookie settings copy in both languages', () => {
  it('reads French from its inline fallbacks before 02042 runs', () => {
    mocks.lang = 'fr';
    storeConsent({ analytics: false, marketing: false });
    const page = renderPage();

    expect(page.control().textContent).toBe('Paramètres des témoins');
    act(() => page.control().click());
    expect(page.dialog().textContent).toContain(
      'Votre choix actuel est indiqué ci-dessous. Vous pouvez le modifier en tout temps.'
    );
    expect(page.queryButton('Fermer')).toBeDefined();
  });

  it('reads the seeded translations once they exist', () => {
    mocks.lang = 'fr';
    mocks.seeded = {
      'privacy.consent.cookie_settings': 'Préférences de témoins',
      'privacy.consent.current_choice': 'Choix actuel ci-dessous.',
      close: 'Fermer la fenêtre',
    };
    storeConsent({ analytics: false, marketing: false });
    const page = renderPage();

    expect(page.control().textContent).toBe('Préférences de témoins');
    act(() => page.control().click());
    expect(page.dialog().textContent).toContain('Choix actuel ci-dessous.');
    expect(page.queryButton('Fermer la fenêtre')).toBeDefined();
  });
});

describe('Public footer', () => {
  function renderShell() {
    return mount(
      <>
        <AppShell
          canAccessCms={false}
          copyrightText="© 2026 Example"
          footerNavItems={[]}
          hasSupabaseEnv
          headerNavItems={[]}
          isDraftModeEnabled={false}
          isEcommerceActive={false}
          logo={null}
          siteTitle="Example"
        >
          <p>Page</p>
        </AppShell>
        <ConsentBanner />
      </>
    );
  }

  it('carries the Cookie settings control beside the copyright, which reopens the banner', () => {
    storeConsent({ analytics: false, marketing: true });
    const container = renderShell();
    const control = required(container.querySelector<HTMLButtonElement>('footer button'), 'the footer control');

    expect(control.textContent).toBe('Cookie settings');
    expect(control.parentElement?.textContent).toContain('© 2026 Example');
    act(() => control.click());
    const dialog = required(container.querySelector('[role="dialog"]'), 'the consent banner');
    expect(document.activeElement).toBe(dialog);
  });
});

describe('migration 02042', () => {
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../libs/db/src/supabase/migrations');
  const file = readdirSync(migrationsDir).find((name) => name.startsWith('02042_'));
  const sql = file ? readFileSync(path.join(migrationsDir, file), 'utf8') : '';

  it('seeds every new key in English and French exactly as the components fall back', () => {
    expect(file).toBe('02042_consent_cookie_settings_copy.sql');
    const rows = [...sql.matchAll(/\('([a-z_.]+)', '(\{.*?\})'::jsonb, now\(\), now\(\)\)/g)].map(([, key, json]) => ({
      key,
      ...(JSON.parse(json.replace(/''/g, "'")) as { en: string; fr: string }),
    }));

    expect(rows).toEqual(CONSENT_SETTINGS_SEEDED_BY_02042.map(({ key, en, fr }) => ({ key, en, fr })));
  });

  it('inserts idempotently and creates nothing that would need a grant', () => {
    expect(sql).toMatch(/INSERT INTO public\.translations \(key, translations, created_at, updated_at\)/);
    expect(sql.trim().endsWith('ON CONFLICT (key) DO NOTHING;')).toBe(true);
    const statements = sql.replace(/--.*$/gm, '');
    expect(statements).not.toMatch(/\b(CREATE|GRANT|REVOKE|UPDATE|DELETE|DROP|ALTER)\b/i);
  });

  it('leaves `close` to 02015, which already seeds it', () => {
    const seed02015 = readFileSync(path.join(migrationsDir, '02015_public_copy_typography_and_a11y_keys.sql'), 'utf8');
    const { key, en, fr } = CONSENT_SETTINGS_COPY.close;

    expect(seed02015).toContain(`('${key}', '{"en":"${en}","fr":"${fr}"}'::jsonb, now(), now())`);
    expect(sql).not.toContain(`('${key}',`);
  });
});
