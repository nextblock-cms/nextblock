import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ query: '', lang: 'en' }));

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(state.query) }));
vi.mock('@nextblock-cms/utils', () => ({
  // Unseeded keys answer with the key itself, exactly like the real provider.
  useTranslations: () => ({ lang: state.lang, t: (key: string) => key }),
}));

import UnauthorizedPage from './page';

function render(query: string, lang = 'en') {
  state.query = query;
  state.lang = lang;
  return renderToStaticMarkup(<UnauthorizedPage />);
}

describe('/unauthorized partner reasons', () => {
  beforeEach(() => {
    state.query = '';
    state.lang = 'en';
  });

  it('explains reason=retailer_only (staff opening the partner portal)', () => {
    const html = render('reason=retailer_only');
    expect(html).toContain('The partner portal is for partner accounts only.');
    expect(html).not.toContain('Details:');
    expect(html).not.toContain('retailer_only');
  });

  it('explains reason=retailer_suspended', () => {
    const html = render('reason=retailer_suspended');
    expect(html).toContain('Your partner account is suspended');
    expect(html).not.toContain('retailer_suspended');
    expect(html).not.toContain('contact your administrator');
  });

  it('speaks Québec French when the visitor reads French', () => {
    expect(render('reason=retailer_only', 'fr')).toContain('Le portail partenaire est réservé aux comptes partenaires.');
    expect(render('reason=retailer_suspended', 'fr-CA')).toContain('Votre compte partenaire est suspendu');
  });

  it('keeps the generic page for the other reasons', () => {
    const html = render('reason=custom_code&path=/cms/users&required=ADMIN');
    expect(html).toContain('Details:');
    expect(html).toContain('custom_code');
    expect(html).toContain('/cms/users');
    expect(html).toContain('contact your administrator');
  });

  it('has exactly one h1', () => {
    expect(render('reason=retailer_only').match(/<h1/g)).toHaveLength(1);
  });
});
