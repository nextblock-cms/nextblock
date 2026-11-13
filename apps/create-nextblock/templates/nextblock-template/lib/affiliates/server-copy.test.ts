import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ key: string; translations: unknown }>,
  rowsThrow: false,
  requestLocale: 'en',
  getRequestLocale: vi.fn(),
}));

// The real, pure copy runtime: the override map built here must be the shape it reads. Loaded
// with vi.importActual (an import() would mark the lib lazy-loaded for Nx's boundary rule).
vi.mock('@nextblock-cms/affiliates', () => vi.importActual('../../../../libs/affiliates/src/lib/i18n/copy-runtime'));

// The `affiliates.*` rows only: the root layout's site-wide read never fetches them.
vi.mock('../i18n/cached-translations', () => ({
  getRequestCachedAffiliateTranslations: async () => {
    if (mocks.rowsThrow) throw new Error('fetch failed');
    return mocks.rows;
  },
}));

vi.mock('./request-locale', () => ({
  getRequestLocale: mocks.getRequestLocale,
}));

import { getAffiliateCopyOverrides, getServerAffiliatesCopy } from './server-copy';

const PARTNERS = {
  'affiliates.partners.hero_title': { en: 'Earn with {store}', fr: 'Gagnez avec {store}' },
  'affiliates.partners.cta': { en: 'Join now', fr: 'Joindre maintenant' },
};

beforeEach(() => {
  mocks.rows = [
    // Seeded verbatim by 02031: changes nothing.
    { key: 'affiliates.partners.cta', translations: { en: 'Join now', fr: 'Joindre maintenant' } },
    // An operator edit of the French title.
    { key: 'affiliates.partners.hero_title', translations: { en: 'Earn with {store}', fr: 'Gagnez de l’argent avec {store}', es: 'Gana con {store}' } },
    // Another area, and a key no dictionary has.
    { key: 'affiliates.portal.title', translations: { en: 'Partner portal', fr: 'Portail partenaire (modifié)' } },
    { key: 'affiliates.partners.orphan', translations: { en: 'Orphan' } },
    // Not ours.
    { key: 'cart_title', translations: { en: 'Cart' } },
  ];
  mocks.rowsThrow = false;
  mocks.getRequestLocale.mockReset();
  mocks.getRequestLocale.mockImplementation(async () => mocks.requestLocale);
  mocks.requestLocale = 'en';
});

describe('getAffiliateCopyOverrides', () => {
  it('keeps only real edits for the dictionary’s keys in the visitor locale', async () => {
    await expect(getAffiliateCopyOverrides({ locale: 'fr', dictionary: PARTNERS })).resolves.toEqual({
      'affiliates.partners.hero_title': { fr: 'Gagnez de l’argent avec {store}' },
    });
  });

  it('serves a language the dictionaries do not carry, plus edited English as its fallback', async () => {
    await expect(getAffiliateCopyOverrides({ locale: 'es-MX', dictionary: PARTNERS })).resolves.toEqual({
      'affiliates.partners.hero_title': { es: 'Gana con {store}' },
    });

    mocks.rows.push({ key: 'affiliates.partners.cta', translations: { en: 'Join today' } });
    await expect(getAffiliateCopyOverrides({ locale: 'es', dictionary: PARTNERS })).resolves.toEqual({
      'affiliates.partners.hero_title': { es: 'Gana con {store}' },
      'affiliates.partners.cta': { en: 'Join today' },
    });
    // A French visitor never needs the English edit: the French dictionary string comes first.
    await expect(getAffiliateCopyOverrides({ locale: 'fr', dictionary: PARTNERS })).resolves.toEqual({
      'affiliates.partners.hero_title': { fr: 'Gagnez de l’argent avec {store}' },
    });
  });

  it('loads explicit prefixes without a dictionary', async () => {
    await expect(getAffiliateCopyOverrides({ locale: 'fr', prefixes: ['affiliates.portal.'] })).resolves.toEqual({
      'affiliates.portal.title': { fr: 'Portail partenaire (modifié)' },
    });
  });

  it('never returns keys outside the affiliates namespace, and never throws', async () => {
    const everything = await getAffiliateCopyOverrides({ locale: 'en' });
    expect(Object.keys(everything).every((key) => key.startsWith('affiliates.'))).toBe(true);

    mocks.rowsThrow = true;
    await expect(getAffiliateCopyOverrides({ locale: 'fr', dictionary: PARTNERS })).resolves.toEqual({});
  });
});

describe('getServerAffiliatesCopy', () => {
  it('translates with the override for the locale, then the dictionary, then the key', async () => {
    const t = await getServerAffiliatesCopy({ locale: 'fr-CA', dictionary: PARTNERS });
    expect(t('affiliates.partners.hero_title', { store: 'Érable' })).toBe('Gagnez de l’argent avec Érable');
    expect(t('affiliates.partners.cta')).toBe('Joindre maintenant');
    expect(t('affiliates.partners.missing')).toBe('affiliates.partners.missing');
    expect(mocks.getRequestLocale).not.toHaveBeenCalled();
  });

  it('defaults to the request locale', async () => {
    mocks.requestLocale = 'fr';
    const t = await getServerAffiliatesCopy({ dictionary: PARTNERS });
    expect(mocks.getRequestLocale).toHaveBeenCalledTimes(1);
    expect(t('affiliates.partners.cta')).toBe('Joindre maintenant');
  });

  it('serves English when the locale is English or unknown', async () => {
    const t = await getServerAffiliatesCopy({ locale: 'en', dictionary: PARTNERS });
    expect(t('affiliates.partners.hero_title', { store: 'Maple' })).toBe('Earn with Maple');
    mocks.getRequestLocale.mockRejectedValue(new Error('no request'));
    const fallback = await getServerAffiliatesCopy({ locale: '   ', dictionary: PARTNERS });
    expect(fallback('affiliates.partners.cta')).toBe('Join now');
  });

  it('still translates from the dictionary when the translations table is unreadable', async () => {
    mocks.rowsThrow = true;
    const t = await getServerAffiliatesCopy({ locale: 'fr', dictionary: PARTNERS });
    expect(t('affiliates.partners.hero_title', { store: 'X' })).toBe('Gagnez avec X');
  });
});
