// @vitest-environment jsdom
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AffiliatesCopyProvider } from '@nextblock-cms/affiliates';
import { TranslationsProvider } from '@nextblock-cms/utils';

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import type { PartnerHandleCheckResult, PartnerSignupState } from '../../../app/(public)/partners/actions';
import type { PartnerSignupViewer } from '../../../lib/affiliates/signup';
import { PartnerSignupForm, type PartnerSignupFormProps } from './PartnerSignupForm';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
  document.body.innerHTML = '';
  vi.unstubAllEnvs();
});

function props(overrides: Partial<PartnerSignupFormProps> = {}): PartnerSignupFormProps {
  return {
    viewer: { kind: 'anonymous' },
    signupAction: async (state: PartnerSignupState) => state,
    checkHandleAction: async (): Promise<PartnerHandleCheckResult> => ({ ok: true, status: 'available' }),
    storefrontPrefix: 'shop.example.com/partners/',
    botProtection: { provider: 'none', siteKey: '' },
    signupOpen: true,
    signInHref: '/sign-in?redirect=%2Fpartners',
    twoFactorHref: '/two-factor?redirect_to=%2Fpartners',
    portalHref: '/portal/retailer',
    termsHref: '/partners/terms',
    ...overrides,
  };
}

/** The page's providers: the site translations (the sandbox credentials banner) and the affiliates copy. */
function withCopy(ui: ReactElement, locale = 'en') {
  return (
    <TranslationsProvider translations={[]} lang={locale}>
      <AffiliatesCopyProvider locale={locale}>{ui}</AffiliatesCopyProvider>
    </TranslationsProvider>
  );
}

function staticMarkup(overrides: Partial<PartnerSignupFormProps> = {}, locale = 'en'): string {
  return renderToStaticMarkup(withCopy(<PartnerSignupForm {...props(overrides)} />, locale));
}

async function render(ui: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(ui);
  });
  return container;
}

async function settle(ms = 20) {
  await act(async () => {
    await sleep(ms);
  });
}

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function field(container: HTMLElement, name: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!input) throw new Error(`no ${name} field`);
  return input;
}

/** Submit the form as it stands (native validation off: the action decides in these tests). */
async function submitForm(container: HTMLElement) {
  const form = container.querySelector('form');
  if (!form) throw new Error('no form');
  form.noValidate = true;
  await act(async () => {
    form.requestSubmit();
  });
  await settle(50);
}

describe('PartnerSignupForm panels', () => {
  it('gives an anonymous visitor the full form, with a sign-in link and bot protection', () => {
    const html = staticMarkup();
    for (const name of ['displayName', 'handle', 'email', 'password', 'terms', 'nb_form_ref']) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain('href="/sign-in?redirect=%2Fpartners"');
    expect(html).toContain('Create my partner account');
    expect(html).toContain('shop.example.com/partners/');
  });

  it('gives a signed-in customer the upgrade form, without email or password', () => {
    const viewer: PartnerSignupViewer = { kind: 'customer', email: 'casey@example.com', fullName: 'Casey Customer', pendingHandle: null };
    const html = staticMarkup({ viewer });
    expect(html).toContain('You are signed in as casey@example.com.');
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain('name="password"');
    expect(html).toContain('value="Casey Customer"');
    // The handle is suggested from the profile name.
    expect(html).toContain('value="casey-customer"');
    expect(html).toContain('Become a partner');
  });

  it('prefills the handle a confirmed signup chose instead of the name suggestion', () => {
    const viewer: PartnerSignupViewer = { kind: 'customer', email: 'casey@example.com', fullName: 'Casey Customer', pendingHandle: 'jane-picks' };
    const html = staticMarkup({ viewer });
    expect(html).toContain('value="jane-picks"');
    expect(html).not.toContain('value="casey-customer"');
    expect(html).toContain('shop.example.com/partners/jane-picks');
  });

  it('sends a partner to the portal, refuses staff and asks for the second factor', () => {
    expect(staticMarkup({ viewer: { kind: 'partner' } })).toContain('href="/portal/retailer"');
    expect(staticMarkup({ viewer: { kind: 'partner' } })).not.toContain('<form');
    expect(staticMarkup({ viewer: { kind: 'staff' } })).toContain('Staff accounts cannot join');
    expect(staticMarkup({ viewer: { kind: 'factor_pending' } })).toContain('href="/two-factor?redirect_to=%2Fpartners"');
  });

  it('explains paused sign-ups instead of showing a form', () => {
    const html = staticMarkup({ signupOpen: false });
    expect(html).toContain('Sign-ups are paused');
    expect(html).not.toContain('<form');
  });

  it('speaks Québec French', () => {
    const html = staticMarkup({}, 'fr');
    expect(html).toContain('Courriel');
    expect(html).toContain('Créer mon compte partenaire');
    expect(html).not.toContain('Password');
  });
});

describe('PartnerSignupForm terms checkbox', () => {
  /** The terms checkbox's label, as markup. */
  function termsLabel(html: string): string {
    return /<label for="[^"]*-terms"[^>]*>([\s\S]*?)<\/label>/.exec(html)?.[1] ?? '';
  }

  it('links the built-in terms inside the label, in a new tab, with the icon hidden and the notice for screen readers', () => {
    const label = termsLabel(staticMarkup());
    expect(label).toMatch(/^I accept the <a href="\/partners\/terms" target="_blank" rel="noopener" class="[^"]*underline[^"]*">partner terms<svg/);
    expect(label).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(label).toContain('<span class="sr-only"> (opens in a new tab)</span></a>');
    expect(label).toMatch(/<\/a>\. I will tell my audience that I earn a commission, and I won&#x27;t buy through my own links\.$/);
    // No raw placeholder left behind.
    expect(label).not.toContain('{terms}');
  });

  it('reads in Québec French with the French terms address', () => {
    const label = termsLabel(staticMarkup({ termsHref: '/partenaires/conditions' }, 'fr'));
    expect(label).toMatch(/^J&#x27;accepte les <a href="\/partenaires\/conditions"[^>]*>conditions du programme partenaires<svg/);
    expect(label).toContain('<span class="sr-only"> (s&#x27;ouvre dans un nouvel onglet)</span></a>');
    expect(label).toContain('</a>. Je dirai à mon public que je touche une commission');
  });

  it("opens the operator's own https page with a plain anchor (noopener noreferrer)", () => {
    const label = termsLabel(staticMarkup({ termsHref: 'https://legal.example.com/partner-terms' }));
    expect(label).toContain('<a href="https://legal.example.com/partner-terms" target="_blank" rel="noopener noreferrer"');
  });

  it('puts the link after the text when an operator override dropped the {terms} placeholder', () => {
    const html = renderToStaticMarkup(
      <TranslationsProvider translations={[]} lang="en">
        <AffiliatesCopyProvider locale="en" overrides={{ 'affiliates.partners.signup_terms_accept': { en: 'I accept the program rules.' } }}>
          <PartnerSignupForm {...props()} />
        </AffiliatesCopyProvider>
      </TranslationsProvider>,
    );
    expect(termsLabel(html)).toMatch(/^I accept the program rules\. <a href="\/partners\/terms"[^>]*>partner terms<svg/);
  });

  it('ignores a stale signup_terms_label row (an earlier 02031 seeded it without {terms}; the label moved to a new key)', () => {
    const html = renderToStaticMarkup(
      <TranslationsProvider translations={[]} lang="en">
        <AffiliatesCopyProvider
          locale="en"
          overrides={{
            'affiliates.partners.signup_terms_label': {
              en: "I accept the partner terms. I will tell my audience that I earn a commission, and I won't buy through my own links.",
            },
          }}
        >
          <PartnerSignupForm {...props()} />
        </AffiliatesCopyProvider>
      </TranslationsProvider>,
    );
    const label = termsLabel(html);
    expect(label).toMatch(/^I accept the <a href="\/partners\/terms"[^>]*>partner terms<svg/);
    // The phrase once, as the link: never the old sentence with the link dangling after it.
    expect(label.match(/partner terms/g)).toHaveLength(1);
  });

  it('never renders a link for an href that is neither a site path nor https', () => {
    for (const termsHref of ['javascript:alert(1)', '//evil.example/terms', 'http://legal.example.com']) {
      const label = termsLabel(staticMarkup({ termsHref }));
      expect(label, termsHref).not.toContain('<a');
      expect(label, termsHref).toContain('partner terms');
    }
  });
});

describe('PartnerSignupForm interactions', () => {
  it('suggests a handle from the display name and checks it after a pause', async () => {
    const checkHandleAction = vi.fn(async (): Promise<PartnerHandleCheckResult> => ({ ok: true, status: 'available' }));
    const container = await render(withCopy(<PartnerSignupForm {...props({ checkHandleAction })} />));

    await act(async () => typeInto(field(container, 'displayName'), 'Émilie Côté'));
    expect(field(container, 'handle').value).toBe('emilie-cote');
    expect(checkHandleAction).not.toHaveBeenCalled();

    await settle(600);
    expect(checkHandleAction).toHaveBeenCalledWith({ handle: 'emilie-cote' });
    expect(container.textContent).toContain('Good news: this handle is available.');
    expect(container.textContent).toContain('shop.example.com/partners/emilie-cote');
  });

  it('stops suggesting once the visitor edits the handle, and answers reserved handles locally', async () => {
    const checkHandleAction = vi.fn(async (): Promise<PartnerHandleCheckResult> => ({ ok: true, status: 'taken' }));
    const container = await render(withCopy(<PartnerSignupForm {...props({ checkHandleAction })} />));

    await act(async () => typeInto(field(container, 'handle'), 'Partners'));
    expect(field(container, 'handle').value).toBe('partners');
    await settle(600);
    expect(checkHandleAction).not.toHaveBeenCalled();
    expect(container.textContent).toContain('This handle is reserved.');
    expect(field(container, 'handle').getAttribute('aria-invalid')).toBe('true');

    await act(async () => typeInto(field(container, 'displayName'), 'Someone Else'));
    expect(field(container, 'handle').value).toBe('partners');

    await act(async () => typeInto(field(container, 'handle'), 'jane picks'));
    await settle(600);
    expect(checkHandleAction).toHaveBeenCalledWith({ handle: 'jane-picks' });
    expect(container.textContent).toContain('This handle is already taken.');
  });

  it('keeps a prefilled pending handle when the name changes, and re-checks it on mount', async () => {
    const checkHandleAction = vi.fn(async (): Promise<PartnerHandleCheckResult> => ({ ok: true, status: 'taken' }));
    const viewer: PartnerSignupViewer = { kind: 'customer', email: 'jane@example.com', fullName: 'Jane Doe', pendingHandle: 'jane-picks' };
    const container = await render(withCopy(<PartnerSignupForm {...props({ viewer, checkHandleAction })} />));

    await act(async () => typeInto(field(container, 'displayName'), 'Jane D'));
    expect(field(container, 'handle').value).toBe('jane-picks');
    await settle(600);
    // Not held between signup and confirmation: someone may have claimed it meanwhile.
    expect(checkHandleAction).toHaveBeenCalledWith({ handle: 'jane-picks' });
    expect(container.textContent).toContain('This handle is already taken.');
  });

  it('echoes the typed values after a refusal and focuses the field it names', async () => {
    const signupAction = vi.fn(async (state: PartnerSignupState, formData: FormData): Promise<PartnerSignupState> => ({
      ok: false,
      error: 'handle_taken',
      message: 'That handle is already taken. Try another one.',
      field: 'handle',
      values: {
        handle: String(formData.get('handle')),
        displayName: String(formData.get('displayName')),
        email: String(formData.get('email')),
        terms: formData.get('terms') === 'on',
      },
      attempt: state.attempt + 1,
    }));
    const container = await render(withCopy(<PartnerSignupForm {...props({ signupAction })} />));

    await act(async () => typeInto(field(container, 'displayName'), 'Jane Doe'));
    await act(async () => typeInto(field(container, 'email'), 'jane@example.com'));
    await act(async () => typeInto(field(container, 'password'), 'correct horse battery'));
    field(container, 'terms').checked = true;

    const form = container.querySelector('form');
    if (!form) throw new Error('no form');
    await act(async () => {
      form.requestSubmit();
    });
    await settle(50);

    expect(signupAction).toHaveBeenCalledTimes(1);
    const submitted = signupAction.mock.calls[0]?.[1] as FormData;
    expect(submitted.get('handle')).toBe('jane-doe');
    expect(submitted.get('terms')).toBe('on');

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('That handle is already taken.');
    expect(field(container, 'email').value).toBe('jane@example.com');
    expect(field(container, 'terms').checked).toBe(true);
    expect(field(container, 'password').value).toBe('');
    expect(document.activeElement).toBe(field(container, 'handle'));
  });

  it('replaces the form with a focused confirmation', async () => {
    const signupAction = vi.fn(async (state: PartnerSignupState): Promise<PartnerSignupState> => ({
      ok: true,
      status: 'confirm_email',
      attempt: state.attempt + 1,
    }));
    const container = await render(withCopy(<PartnerSignupForm {...props({ signupAction })} />));
    const form = container.querySelector('form');
    if (!form) throw new Error('no form');
    // Native validation would block an empty form; the action decides in this test.
    form.noValidate = true;
    await act(async () => {
      form.requestSubmit();
    });
    await settle(50);

    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain('Check your email');
    expect(document.activeElement).toBe(status);
    expect(container.querySelector('form')).toBeNull();
  });
});

describe('PartnerSignupForm on the public sandbox (NEXT_PUBLIC_IS_SANDBOX=true)', () => {
  const NOTICE_EN = 'Demo mode: this form runs the real sign-up checks but creates no partner account and sends no email.';
  const NOTICE_FR =
    "Mode démo : ce formulaire effectue les vraies vérifications d'inscription, mais il ne crée aucun compte partenaire et n'envoie aucun courriel.";
  const customer: PartnerSignupViewer = { kind: 'customer', email: 'casey@example.com', fullName: 'Casey Customer', pendingHandle: null };

  const demoSignup = vi.fn(async (state: PartnerSignupState): Promise<PartnerSignupState> => ({
    ok: true,
    status: 'sandbox_demo',
    handle: 'jane-picks',
    attempt: state.attempt + 1,
  }));

  it('opens the form with the demo notice, for a visitor and a signed-in customer, in both languages', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const firstInForm = (container: HTMLElement) => container.querySelector('form')?.firstElementChild?.textContent;

    expect(firstInForm(await render(withCopy(<PartnerSignupForm {...props()} />)))).toBe(NOTICE_EN);
    expect(firstInForm(await render(withCopy(<PartnerSignupForm {...props({ viewer: customer })} />)))).toBe(NOTICE_EN);
    expect(firstInForm(await render(withCopy(<PartnerSignupForm {...props()} />, 'fr')))).toBe(NOTICE_FR);
    // The decorative icon stays out of the accessibility tree.
    expect(staticMarkup()).toMatch(/<svg(?=[^>]*lucide-info)(?=[^>]*aria-hidden="true")[^>]*>/);
  });

  it('describes the submit button with the demo notice, for a visitor and a signed-in customer', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    for (const overrides of [{}, { viewer: customer }]) {
      const container = await render(withCopy(<PartnerSignupForm {...props(overrides)} />));
      const noticeId = container.querySelector('button[type="submit"]')?.getAttribute('aria-describedby') ?? '';

      expect(noticeId).toMatch(/-sandbox-notice$/);
      const notice = container.querySelector(`[id="${noticeId}"]`);
      expect(notice).toBe(container.querySelector('form')?.firstElementChild);
      expect(notice?.textContent).toBe(NOTICE_EN);
    }
  });

  it('shows no notice off the sandbox: the form still opens with its sign-in line', async () => {
    for (const value of ['', 'false', '1']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      const container = await render(withCopy(<PartnerSignupForm {...props()} />));
      expect(container.textContent).not.toContain('Demo mode');
      expect(container.querySelector('form')?.firstElementChild?.textContent).toBe('Already have an account? Sign in first');
      // Nor a description on the submit button.
      expect(container.querySelector('button[type="submit"]')?.hasAttribute('aria-describedby'), value).toBe(false);
      expect(container.querySelector('[id$="-sandbox-notice"]'), value).toBeNull();
    }
  });

  it('replaces the form with a focused demo panel, then offers the demo partner sign-in', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const container = await render(withCopy(<PartnerSignupForm {...props({ signupAction: demoSignup })} />));
    await submitForm(container);

    const status = container.querySelector('[role="status"]');
    expect(status?.querySelector('h3')?.textContent).toBe('Demo sign-up complete');
    expect(status?.textContent).toContain(
      'On a real store, this step creates your partner account and a starter storefront at shop.example.com/partners/jane-picks, after an email confirmation when the store requires one. Nothing was saved here.',
    );
    expect(document.activeElement).toBe(status);
    expect(container.querySelector('form')).toBeNull();

    // SandboxCredentialsAlert with the demo partner, after the announced result (not inside it).
    expect(container.textContent).toContain('partner@nextblock.dev');
    expect(container.querySelector('a[href="/partners/studio-nova"]')).not.toBeNull();
    expect(status?.textContent).not.toContain('partner@nextblock.dev');
  });

  it('writes the demo panel in Québec French', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const container = await render(withCopy(<PartnerSignupForm {...props({ signupAction: demoSignup })} />, 'fr'));
    await submitForm(container);

    const status = container.querySelector('[role="status"]');
    expect(status?.querySelector('h3')?.textContent).toBe('Inscription de démonstration terminée');
    expect(status?.textContent).toContain(
      "Dans une vraie boutique, cette étape crée votre compte partenaire et une vitrine de départ à l'adresse shop.example.com/partners/jane-picks, après une confirmation par courriel si la boutique l'exige. Rien n'a été enregistré ici.",
    );
    expect(container.textContent).toContain('Pour explorer le portail partenaire, connectez-vous avec le compte partenaire de démonstration');
  });
});
