import { describe, expect, it } from 'vitest';
import {
  AFFILIATE_TRANSLATION_KEY_PREFIX,
  excludeAffiliateTranslationRows,
  isAffiliateTranslationKey,
  selectAffiliateTranslationOverrides,
} from './affiliate-translation-rows';
import { compactTranslationsForLocale } from './slim-translations';

const rows = [
  { key: 'account_navigation', translations: { en: 'Account', fr: 'Compte' }, updated_at: 'x' },
  { key: 'affiliates.partners.hero_title', translations: { en: 'Earn with us', fr: 'Gagnez avec nous', de: 'Verdienen' } },
  { key: 'affiliates.partners.blank', translations: { en: '', fr: '   ' } },
  { key: 'affiliates.portal.nav_storefront', translations: { en: 'Storefront', fr: 'Vitrine' } },
  { key: 'affiliates.common.tier_fallback', translations: { en: 'Partner', fr: 'Partenaire' } },
  { key: 'affiliates.storefront.malformed', translations: 'not an object' },
  { key: 'affiliates.storefront.array', translations: ['en'] },
  { key: 'affiliatesish_key', translations: { en: 'Not ours' } },
  { key: 'cart_title', translations: { en: 'Cart', fr: 'Panier' } },
];

describe('isAffiliateTranslationKey', () => {
  it('matches the affiliates. namespace only', () => {
    expect(AFFILIATE_TRANSLATION_KEY_PREFIX).toBe('affiliates.');
    expect(isAffiliateTranslationKey('affiliates.partners.hero_title')).toBe(true);
    expect(isAffiliateTranslationKey('affiliatesish_key')).toBe(false);
    expect(isAffiliateTranslationKey('cart_title')).toBe(false);
    expect(isAffiliateTranslationKey(null)).toBe(false);
    expect(isAffiliateTranslationKey(42)).toBe(false);
  });
});

describe('excludeAffiliateTranslationRows', () => {
  it('drops every affiliates. row and keeps the rest untouched, in order', () => {
    const kept = excludeAffiliateTranslationRows(rows);
    expect(kept.map((row) => row.key)).toEqual(['account_navigation', 'affiliatesish_key', 'cart_title']);
    // Same objects: the layout keeps passing its own row shape to compactTranslationsForLocale.
    expect(kept[0]).toBe(rows[0]);
  });

  it('drops rows without a string key', () => {
    const malformed = [{ key: 'ok', translations: {} }, { key: 7 as unknown as string, translations: {} }, null];
    expect(excludeAffiliateTranslationRows(malformed as Array<{ key: string; translations: unknown }>)).toEqual([
      { key: 'ok', translations: {} },
    ]);
  });

  it('keeps affiliates strings out of the root layout payload', () => {
    // What app/layout.tsx does before handing the strings to the client provider.
    const compact = compactTranslationsForLocale(excludeAffiliateTranslationRows(rows), 'fr');
    const keys = [...compact.entries, ...compact.fallbackEntries].map(([key]) => key);
    expect(keys).toContain('account_navigation');
    expect(keys).toContain('cart_title');
    expect(keys.some((key) => key.startsWith('affiliates.'))).toBe(false);
  });
});

describe('selectAffiliateTranslationOverrides', () => {
  it('returns only the requested areas as a key -> locale -> string map', () => {
    expect(selectAffiliateTranslationOverrides(rows, ['affiliates.partners.', 'affiliates.common.'])).toEqual({
      'affiliates.partners.hero_title': { en: 'Earn with us', fr: 'Gagnez avec nous', de: 'Verdienen' },
      'affiliates.common.tier_fallback': { en: 'Partner', fr: 'Partenaire' },
    });
  });

  it('restricts locales when asked (the visitor locale only)', () => {
    expect(selectAffiliateTranslationOverrides(rows, ['affiliates.partners.'], { locales: ['fr'] })).toEqual({
      'affiliates.partners.hero_title': { fr: 'Gagnez avec nous' },
    });
  });

  it('skips blank values and malformed rows so the dictionary fallback applies', () => {
    const overrides = selectAffiliateTranslationOverrides(rows, ['affiliates.']);
    expect(overrides['affiliates.partners.blank']).toBeUndefined();
    expect(overrides['affiliates.storefront.malformed']).toBeUndefined();
    expect(overrides['affiliates.storefront.array']).toBeUndefined();
    expect(Object.keys(overrides).sort()).toEqual([
      'affiliates.common.tier_fallback',
      'affiliates.partners.hero_title',
      'affiliates.portal.nav_storefront',
    ]);
  });

  it('never selects keys outside the affiliates namespace, whatever prefix is passed', () => {
    expect(selectAffiliateTranslationOverrides(rows, ['', 'cart', 'account_', 'affiliatesish'])).toEqual({});
    expect(selectAffiliateTranslationOverrides(rows, [])).toEqual({});
  });

  it('applies an extra key filter', () => {
    const overrides = selectAffiliateTranslationOverrides(rows, ['affiliates.'], {
      includeKey: (key) => key === 'affiliates.portal.nav_storefront',
    });
    expect(overrides).toEqual({ 'affiliates.portal.nav_storefront': { en: 'Storefront', fr: 'Vitrine' } });
  });

  it('lowercases locale codes, as the copy runtime looks them up', () => {
    const mixed = [{ key: 'affiliates.portal.title', translations: { 'pt-BR': 'Vitrine', FR: 'Vitrine FR' } }];
    expect(selectAffiliateTranslationOverrides(mixed, ['affiliates.portal.'])).toEqual({
      'affiliates.portal.title': { 'pt-br': 'Vitrine', fr: 'Vitrine FR' },
    });
    expect(selectAffiliateTranslationOverrides(mixed, ['affiliates.portal.'], { locales: ['PT-br'] })).toEqual({
      'affiliates.portal.title': { 'pt-br': 'Vitrine' },
    });
  });

  it('drops overrides that only repeat the built-in dictionary (the seeded rows)', () => {
    const dictionary = {
      'affiliates.partners.hero_title': { en: 'Earn with us', fr: 'Gagnez avec nous' },
      'affiliates.common.tier_fallback': { en: 'Partner', fr: 'Partenaire (modifié)' },
    };
    expect(selectAffiliateTranslationOverrides(rows, ['affiliates.partners.', 'affiliates.common.'], { dictionary })).toEqual({
      // `de` has no dictionary language, so it is a real override.
      'affiliates.partners.hero_title': { de: 'Verdienen' },
      // The operator's French differs from the shipped string: kept. English repeats it: dropped.
      'affiliates.common.tier_fallback': { fr: 'Partenaire' },
    });
  });

  it('tolerates a non-array input', () => {
    expect(selectAffiliateTranslationOverrides(null as never, ['affiliates.'])).toEqual({});
  });
});
