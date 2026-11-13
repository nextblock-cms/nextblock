import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ lang: 'en', translations: {} as Record<string, string> }));

vi.mock('@nextblock-cms/utils', async () => {
  const actual = await vi.importActual<typeof import('@nextblock-cms/utils')>('@nextblock-cms/utils');
  return {
    ...actual,
    // Unseeded keys answer with the key itself, exactly like the real provider.
    useTranslations: () => ({ lang: state.lang, t: (key: string) => state.translations[key] ?? key }),
  };
});

import { SandboxCredentialsAlert } from './SandboxCredentialsAlert';

/** The demo partner block shows only when the page says the Affiliates package is active. */
function render(showDemoPartner = true) {
  return renderToStaticMarkup(<SandboxCredentialsAlert showDemoPartner={showDemoPartner} />);
}

function count(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

describe('SandboxCredentialsAlert', () => {
  beforeEach(() => {
    state.lang = 'en';
    state.translations = {
      demo_access_title: 'Demo Access',
      demo_access_desc: 'This is a demo site. You may use the following credentials to access the admin section:',
      demo_user_label: 'User:',
      demo_password_label: 'Password:',
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders nothing outside the sandbox', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    expect(render()).toBe('');

    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'false');
    expect(render()).toBe('');
  });

  it('lists only the admin pair unless the demo partner exists (Affiliates active on the sandbox)', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    for (const html of [render(false), renderToStaticMarkup(<SandboxCredentialsAlert />)]) {
      expect(html).toContain('demo@nextblock.dev');
      expect(count(html, '<ul')).toBe(1);
      expect(html).not.toContain('partner@nextblock.dev');
      expect(html).not.toContain('/partners/studio-nova');
      expect(html).not.toContain('demo_partner_access_desc');
      expect(html).not.toMatch(/<a\b/);
    }
  });

  it('shows the admin pair and the partner pair in the sandbox', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const html = render();

    expect(html).toContain('demo@nextblock.dev');
    expect(html).toContain('partner@nextblock.dev');
    expect(count(html, '<ul')).toBe(2);
    expect(count(html, '>password</span>')).toBe(2);
    // Every credential is protected from browser auto-translation.
    expect(count(html, 'translate="no"')).toBe(4);
    expect(html).toContain('To explore the partner portal, sign in with the demo partner account:');
  });

  it("links to the demo partner's storefront with descriptive text", () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const html = render();

    const links = html.match(/<a\b[^>]*>[^<]*<\/a>/g) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('href="/partners/studio-nova"');
    expect(links[0]).toContain('View the demo partner&#x27;s public storefront');
  });

  it('keeps the decorative icon out of the accessibility tree', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    expect(render()).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it('falls back to Québec French when the new keys are not seeded yet', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    state.lang = 'fr-CA';
    const html = render();

    expect(html).toContain('Pour explorer le portail partenaire, connectez-vous avec le compte partenaire de démonstration :');
    expect(html).toContain('Voir la vitrine publique du partenaire de démonstration');
    expect(html).not.toContain('demo_partner_access_desc');
    expect(html).not.toContain('demo_partner_storefront_link');
  });

  it('uses the seeded global translations when they exist', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    state.translations = {
      ...state.translations,
      demo_partner_access_desc: 'Partner portal sign-in:',
      demo_partner_storefront_link: 'Open the partner storefront',
    };
    const html = render();

    expect(html).toContain('Partner portal sign-in:');
    expect(html).toContain('Open the partner storefront');
  });
});
