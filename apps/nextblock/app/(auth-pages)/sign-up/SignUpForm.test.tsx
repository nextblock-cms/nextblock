import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AFFILIATE_GLOBAL_TRANSLATIONS } from '../../../lib/i18n/global-affiliate-keys';

/**
 * Sign-up is turned off on the public sandbox (signUpAction refuses there): the form shows a notice
 * above the demo accounts and disables its button. Off the sandbox it renders exactly as before.
 */

const state = vi.hoisted(() => ({
  lang: 'en',
  translations: {} as Record<string, string>,
  params: new URLSearchParams(),
}));

vi.mock('@nextblock-cms/utils', async () => {
  const actual = await vi.importActual<typeof import('@nextblock-cms/utils')>('@nextblock-cms/utils');
  return {
    ...actual,
    // Unseeded keys answer with the key itself, exactly like the real provider.
    useTranslations: () => ({ lang: state.lang, t: (key: string) => state.translations[key] ?? key }),
  };
});
vi.mock('next/navigation', () => ({ useSearchParams: () => state.params }));
vi.mock('../../actions', () => ({ signUpAction: async () => undefined }));

import SignUpForm from './SignUpForm';

/** The seeded copy; the form's inline fallback must say exactly this. */
const NOTICE = AFFILIATE_GLOBAL_TRANSLATIONS.sandbox_signup_disabled;

function render(query = '') {
  state.params = new URLSearchParams(query);
  return renderToStaticMarkup(
    <SignUpForm botProtection={{ provider: 'none', siteKey: '' }} scriptNonce="nonce-1" showDemoPartner />
  );
}

/** renderToStaticMarkup escapes the apostrophe in "L'inscription". */
function escaped(text: string) {
  return text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
}

function submitButton(html: string) {
  const tag = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0];
  if (!tag) throw new Error('no submit button rendered');
  return tag;
}

function count(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  state.lang = 'en';
  state.translations = {};
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SignUpForm on the sandbox', () => {
  it('shows the notice above the demo accounts and disables the submit button', () => {
    const html = render();

    expect(count(html, NOTICE.en)).toBe(1);
    expect(html.indexOf(NOTICE.en)).toBeLessThan(html.indexOf('demo@nextblock.dev'));
    // A static banner: a note, neither a live region nor the Alert component's default role="alert".
    const notice = html.match(/<div[^>]*id="sandbox-signup-disabled"[^>]*>/)?.[0] ?? '';
    expect(notice).toContain('role="note"');
    expect(notice).not.toContain('role="alert"');
    expect(notice).not.toContain('role="status"');

    const button = submitButton(html);
    expect(button).toMatch(/\sdisabled=""/);
    expect(button).toContain('aria-describedby="sandbox-signup-disabled"');
  });

  it("answers the action's refusal once, without the bare key", () => {
    const html = render('error=sandbox_signup_disabled');

    expect(count(html, NOTICE.en)).toBe(1);
    expect(html).not.toContain('sandbox_signup_disabled');
    expect(html).not.toContain('role="alert"');
  });

  it('still shows any other error under the form', () => {
    state.translations = { 'auth.signup_rate_limit': 'Slow down.' };
    const html = render('error=auth.signup_rate_limit');

    expect(html).toContain('<div role="alert" class="text-destructive border-l-2 border-destructive px-4">Slow down.</div>');
    expect(count(html, NOTICE.en)).toBe(1);
  });

  it('falls back to Québec French before the key is seeded', () => {
    state.lang = 'fr-CA';
    const html = render();

    expect(html).toContain(escaped(NOTICE.fr));
    expect(html).not.toContain(NOTICE.en);
  });

  it('uses the seeded translation when it exists', () => {
    state.translations = { sandbox_signup_disabled: 'Inscriptions fermées ici.' };
    const html = render();

    expect(html).toContain('Inscriptions fermées ici.');
    expect(html).not.toContain(NOTICE.en);
  });
});

describe('SignUpForm off the sandbox', () => {
  it('shows no notice and keeps the submit button enabled', () => {
    for (const value of ['', 'false']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      const html = render();

      expect(html).not.toContain(NOTICE.en);
      expect(html).not.toContain('sandbox-signup-disabled');
      expect(submitButton(html)).not.toMatch(/\sdisabled=|aria-describedby=/);
    }
  });

  it('renders the error parameter the way it always has', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    const html = render('error=sandbox_signup_disabled');

    expect(html).toContain('<div role="alert" class="text-destructive border-l-2 border-destructive px-4">sandbox_signup_disabled</div>');
  });
});
