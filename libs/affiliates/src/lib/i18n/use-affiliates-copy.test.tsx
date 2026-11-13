import { TranslationsProvider } from '@nextblock-cms/utils';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AffiliatesCopyProvider } from './affiliates-copy-provider';
import type { AffiliatesCopyDictionary } from './types';
import { useAffiliatesCopy, useAffiliatesLocale } from './use-affiliates-copy';

const DICTIONARY = {
  'affiliates.test.title': { en: 'Partner portal', fr: 'Portail partenaire' },
  'affiliates.test.welcome': { en: 'Welcome, {name}', fr: 'Bienvenue, {name}' },
} satisfies AffiliatesCopyDictionary;

function Probe() {
  const { t, locale } = useAffiliatesCopy(DICTIONARY);
  const hookLocale = useAffiliatesLocale();
  return (
    <p data-locale={locale} data-hook-locale={hookLocale}>
      {t('affiliates.test.title')} | {t('affiliates.test.welcome', { name: 'Jane' })} | {t('affiliates.test.missing')}
    </p>
  );
}

describe('useAffiliatesCopy', () => {
  it('reads the provider locale and its overrides', () => {
    const html = renderToStaticMarkup(
      <AffiliatesCopyProvider locale="fr" overrides={{ 'affiliates.test.title': { fr: 'Mon espace partenaire' } }}>
        <Probe />
      </AffiliatesCopyProvider>
    );

    expect(html).toContain('data-locale="fr"');
    expect(html).toContain('data-hook-locale="fr"');
    expect(html).toContain('Mon espace partenaire | Bienvenue, Jane | affiliates.test.missing');
  });

  it('uses the dictionary when the provider has no override for the key', () => {
    const html = renderToStaticMarkup(
      <AffiliatesCopyProvider locale="en" overrides={null}>
        <Probe />
      </AffiliatesCopyProvider>
    );
    expect(html).toContain('Partner portal | Welcome, Jane');
  });

  it("falls back to the site's TranslationsProvider language outside an affiliates provider", () => {
    const html = renderToStaticMarkup(
      <TranslationsProvider lang="fr" translations={[{ key: 'affiliates.test.title', translations: { fr: 'Ignoré' } }]}>
        <Probe />
      </TranslationsProvider>
    );

    expect(html).toContain('data-locale="fr"');
    // The global payload is never read for affiliates keys (the root layout filters them out).
    expect(html).toContain('Portail partenaire | Bienvenue, Jane');
  });

  it('defaults to English with no provider at all', () => {
    const html = renderToStaticMarkup(<Probe />);
    expect(html).toContain('data-locale="en"');
    expect(html).toContain('Partner portal | Welcome, Jane');
  });

  it('the nearest provider wins', () => {
    const html = renderToStaticMarkup(
      <AffiliatesCopyProvider locale="en">
        <AffiliatesCopyProvider locale="fr-CA">
          <Probe />
        </AffiliatesCopyProvider>
      </AffiliatesCopyProvider>
    );
    expect(html).toContain('Portail partenaire');
  });
});
