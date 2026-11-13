import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AFFILIATE_PARTNERS_PATH,
  AFFILIATE_PARTNERS_PATH_FR,
  AFFILIATE_PARTNERS_TERMS_PATH,
  AFFILIATE_PARTNERS_TERMS_PATH_FR,
} from '@nextblock-cms/affiliates';
import {
  PARTNERS_LANDING_PATH,
  PARTNERS_LANDING_PATH_FR,
  PARTNERS_TERMS_PATH,
  PARTNERS_TERMS_PATH_FR,
  buildPartnersLocalePaths,
  buildPartnersTermsLocalePaths,
  frenchPartnersLocale,
  isBuiltInPartnersTermsPath,
  isBuiltInPartnersTermsTarget,
  isFrenchLanguageCode,
  isFrenchPartnersPath,
  partnersHreflangPaths,
  partnersPathForLocale,
  partnersProgramOwnedPaths,
  partnersTermsHref,
  partnersTermsOverrideForLocale,
  partnersTermsPathForLocale,
} from './partners-paths';

/**
 * The partner program's two landing addresses: `/partners` (the visitor's language) and
 * `/partenaires` (always French). proxy.ts pins the French render locale with the mirrors below, so
 * they must stay equal to the library constants, and the module must stay import-free.
 */

describe('partners-paths mirrors', () => {
  it('match the @nextblock-cms/affiliates constants', () => {
    expect(PARTNERS_LANDING_PATH).toBe(AFFILIATE_PARTNERS_PATH);
    expect(PARTNERS_LANDING_PATH_FR).toBe(AFFILIATE_PARTNERS_PATH_FR);
    expect(PARTNERS_TERMS_PATH).toBe(AFFILIATE_PARTNERS_TERMS_PATH);
    expect(PARTNERS_TERMS_PATH_FR).toBe(AFFILIATE_PARTNERS_TERMS_PATH_FR);
  });

  it('imports nothing (the proxy bundles it)', () => {
    const source = readFileSync(fileURLToPath(new URL('./partners-paths.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});

describe('isFrenchLanguageCode', () => {
  it('accepts French and its regional variants only', () => {
    for (const code of ['fr', 'FR', 'fr-CA', 'fr_ca', ' fr ']) expect(isFrenchLanguageCode(code)).toBe(true);
    for (const code of ['en', 'fri', 'f', '', null, 42]) expect(isFrenchLanguageCode(code)).toBe(false);
  });
});

describe('frenchPartnersLocale', () => {
  it('answers the active French code as stored, null without French, and fr when the list is unknown', () => {
    expect(frenchPartnersLocale(['en', 'fr'])).toBe('fr');
    expect(frenchPartnersLocale(['en', 'fr-CA'])).toBe('fr-CA');
    expect(frenchPartnersLocale(['en', 'es'])).toBeNull();
    expect(frenchPartnersLocale([])).toBe('fr');
    expect(frenchPartnersLocale(null)).toBe('fr');
  });
});

describe('buildPartnersLocalePaths', () => {
  it('gives both addresses for English and French', () => {
    expect(buildPartnersLocalePaths(['en', 'fr'])).toEqual({ en: '/partners', fr: '/partenaires', 'x-default': '/partners' });
  });

  it('gives only /partners without French', () => {
    expect(buildPartnersLocalePaths(['en'])).toEqual({ en: '/partners', 'x-default': '/partners' });
  });

  it('gives only /partenaires on a French-only site', () => {
    expect(buildPartnersLocalePaths(['fr'])).toEqual({ fr: '/partenaires', 'x-default': '/partenaires' });
  });

  it('serves every language that is not French at /partners', () => {
    expect(buildPartnersLocalePaths(['en', 'es', 'fr-CA'])).toEqual({ en: '/partners', fr: '/partenaires', 'x-default': '/partners' });
    expect(buildPartnersLocalePaths(['es'])).toEqual({ en: '/partners', 'x-default': '/partners' });
  });

  it('gives both addresses when the language list is unknown', () => {
    expect(buildPartnersLocalePaths([])).toEqual({ en: '/partners', fr: '/partenaires', 'x-default': '/partners' });
    expect(buildPartnersLocalePaths(undefined)).toEqual({ en: '/partners', fr: '/partenaires', 'x-default': '/partners' });
  });
});

describe('partnersHreflangPaths / partnersProgramOwnedPaths / partnersPathForLocale', () => {
  it('cross-links only when both addresses exist', () => {
    expect(partnersHreflangPaths(buildPartnersLocalePaths(['en', 'fr']))).toEqual({
      en: '/partners',
      fr: '/partenaires',
      'x-default': '/partners',
    });
    expect(partnersHreflangPaths(buildPartnersLocalePaths(['en']))).toBeNull();
    expect(partnersHreflangPaths(buildPartnersLocalePaths(['fr']))).toBeNull();
  });

  it('owns /partners always and /partenaires while French is active', () => {
    expect(partnersProgramOwnedPaths(buildPartnersLocalePaths(['en', 'fr']))).toEqual(['/partners', '/partenaires']);
    expect(partnersProgramOwnedPaths(buildPartnersLocalePaths(['en']))).toEqual(['/partners']);
    expect(partnersProgramOwnedPaths(buildPartnersLocalePaths(['fr']))).toEqual(['/partners', '/partenaires']);
  });

  it('links a French visitor to /partenaires and everyone else to /partners', () => {
    expect(partnersPathForLocale('fr')).toBe('/partenaires');
    expect(partnersPathForLocale('fr-CA')).toBe('/partenaires');
    expect(partnersPathForLocale('en')).toBe('/partners');
    expect(partnersPathForLocale('es')).toBe('/partners');
    expect(partnersPathForLocale(undefined)).toBe('/partners');
  });
});

describe('isFrenchPartnersPath (the proxy French pin)', () => {
  it('is true for /partenaires and every path below it', () => {
    for (const path of ['/partenaires', '/partenaires/', '/partenaires/conditions', '/partenaires/x/y']) {
      expect(isFrenchPartnersPath(path), path).toBe(true);
    }
  });

  it('is false for everything else, look-alikes included', () => {
    for (const path of ['/partners', '/partners/terms', '/partenairesx', '/partenaires-x', '/Partenaires', '/fr/partenaires', '', null, 42]) {
      expect(isFrenchPartnersPath(path), String(path)).toBe(false);
    }
  });
});

describe('the built-in terms addresses', () => {
  it('follow the landing page: both addresses for English and French, one without French or on a French-only site', () => {
    expect(buildPartnersTermsLocalePaths(['en', 'fr'])).toEqual({
      en: '/partners/terms',
      fr: '/partenaires/conditions',
      'x-default': '/partners/terms',
    });
    expect(buildPartnersTermsLocalePaths(['en', 'es'])).toEqual({ en: '/partners/terms', 'x-default': '/partners/terms' });
    expect(buildPartnersTermsLocalePaths(['fr-CA'])).toEqual({ fr: '/partenaires/conditions', 'x-default': '/partenaires/conditions' });
    expect(buildPartnersTermsLocalePaths(null)).toEqual({
      en: '/partners/terms',
      fr: '/partenaires/conditions',
      'x-default': '/partners/terms',
    });
    expect(partnersHreflangPaths(buildPartnersTermsLocalePaths(['en', 'fr']))).toEqual({
      en: '/partners/terms',
      fr: '/partenaires/conditions',
      'x-default': '/partners/terms',
    });
  });

  it('send a French visitor to /partenaires/conditions and everyone else to /partners/terms', () => {
    expect(partnersTermsPathForLocale('fr')).toBe('/partenaires/conditions');
    expect(partnersTermsPathForLocale('fr-CA')).toBe('/partenaires/conditions');
    expect(partnersTermsPathForLocale('en')).toBe('/partners/terms');
    expect(partnersTermsPathForLocale('es')).toBe('/partners/terms');
    expect(partnersTermsPathForLocale(undefined)).toBe('/partners/terms');
  });
});

describe("the operator's own terms page", () => {
  const both = { termsUrlEn: '/legal/partners', termsUrlFr: 'https://legal.example.com/partenaires' };

  it('is read per copy language, French falling back to the English page', () => {
    expect(partnersTermsOverrideForLocale('en', both)).toBe('/legal/partners');
    expect(partnersTermsOverrideForLocale('es', both)).toBe('/legal/partners');
    expect(partnersTermsOverrideForLocale('fr', both)).toBe('https://legal.example.com/partenaires');
    expect(partnersTermsOverrideForLocale('fr-CA', { termsUrlEn: '/legal/partners', termsUrlFr: '' })).toBe('/legal/partners');
    expect(partnersTermsOverrideForLocale('en', { termsUrlEn: '', termsUrlFr: '/legal/fr' })).toBe('');
    expect(partnersTermsOverrideForLocale('fr', null)).toBe('');
  });

  it('never hands out a value that is not a site path or an https URL', () => {
    for (const termsUrlEn of ['//evil.example', '/\\evil.example', 'http://legal.example.com', 'javascript:alert(1)', '/a b', 'legal']) {
      expect(partnersTermsOverrideForLocale('en', { termsUrlEn }), termsUrlEn).toBe('');
    }
    expect(partnersTermsOverrideForLocale('en', { termsUrlEn: 'HTTPS://Legal.example.com/x' })).toBe('HTTPS://Legal.example.com/x');
  });

  it('hands out printable ASCII only: a raw character above U+00FF in a Location header is a 500', () => {
    for (const termsUrlEn of ['/conditions’partenaires', '/café', 'https://legal.example.com/conditions’', `/${'a'.repeat(2048)}`]) {
      expect(partnersTermsOverrideForLocale('en', { termsUrlEn }), termsUrlEn).toBe('');
    }
    // The stored (percent-encoded) form of the same pages passes.
    expect(partnersTermsOverrideForLocale('en', { termsUrlEn: '/conditions%E2%80%99partenaires' })).toBe('/conditions%E2%80%99partenaires');
    expect(partnersTermsOverrideForLocale('fr', { termsUrlFr: '/caf%C3%A9' })).toBe('/caf%C3%A9');
  });

  it('decides where a terms link points: the operator page, else the built-in address of the language', () => {
    expect(partnersTermsHref('en', both)).toBe('/legal/partners');
    expect(partnersTermsHref('fr', both)).toBe('https://legal.example.com/partenaires');
    expect(partnersTermsHref('en', { termsUrlEn: '', termsUrlFr: '' })).toBe('/partners/terms');
    expect(partnersTermsHref('fr', { termsUrlEn: '', termsUrlFr: '' })).toBe('/partenaires/conditions');
    expect(partnersTermsHref('fr', undefined)).toBe('/partenaires/conditions');
  });
});

describe('the self-redirect guard (an override that leads back to the built-in terms)', () => {
  it('recognises a built-in terms address however it is spelled, since browsers and Next resolve each form back to it', () => {
    for (const path of [
      '/partners/terms',
      '/partenaires/conditions',
      '/Partenaires/Conditions?x=1',
      '/partners/terms/',
      '/partners/terms#payouts',
      // Next answers `//` with a 308 to the collapsed path.
      '/partners//terms',
      '//partners/terms',
      // Browsers resolve dot segments in a Location header.
      '/partners/./terms',
      '/partners/terms/.',
      '/partners/x/../terms',
      '/partenaires/../partners/terms',
      '/partenaires/./conditions',
      '/partners/%2e/terms',
      // Percent-escapes, double encoding included, and backslashes read as slashes.
      '/partners/%74erms',
      '/partners/%252e/terms',
      '/partners\\terms',
      '\\partners/terms',
    ]) {
      expect(isBuiltInPartnersTermsPath(path), path).toBe(true);
    }
  });

  it('leaves every other path alone', () => {
    for (const path of [
      '/partners/terms-and-more',
      '/partners/termsx',
      '/partners/terms%3Fx',
      '/legal/partner-terms',
      '/partners',
      '/partners/jane',
      '/partenaires',
      'partners/terms',
      '',
      null,
      42,
    ]) {
      expect(isBuiltInPartnersTermsPath(path), String(path)).toBe(false);
    }
  });

  it("refuses an absolute URL on one of the site's hosts (www. ignored) whose path is a built-in address", () => {
    const hosts = ['shop.example.com', 'shop-preview.vercel.app'];
    for (const url of [
      'https://shop.example.com/partners/terms',
      'https://SHOP.example.com/partners//terms',
      'https://www.shop.example.com/partenaires/conditions?x=1',
      'https://shop.example.com./partners/terms/',
      'https://shop-preview.vercel.app/partners/%74erms',
      '/partners/./terms',
    ]) {
      expect(isBuiltInPartnersTermsTarget(url, hosts), url).toBe(true);
    }
    for (const url of [
      'https://other.example.org/partners/terms',
      'https://shop.example.com/legal/partner-terms',
      'https://shop.example.com.evil.example/partners/terms',
      '/legal/partner-terms',
      '',
    ]) {
      expect(isBuiltInPartnersTermsTarget(url, hosts), url).toBe(false);
    }
    // No known host: only a site path can be judged.
    expect(isBuiltInPartnersTermsTarget('https://shop.example.com/partners/terms', [null, undefined, ''])).toBe(false);
    expect(isBuiltInPartnersTermsTarget('not a url', hosts)).toBe(true);
  });
});
