import { describe, expect, it } from 'vitest';

import {
  affiliatesCopyOverridesFromRows,
  applyAffiliatesFrenchTypography,
  createAffiliatesCopy,
  interpolateAffiliatesCopy,
  resolveAffiliatesLocale,
  splitAffiliatesCopyAtPlaceholder,
} from './copy-runtime';
import { AFFILIATES_COMMON_COPY } from './copy/common';
import type { AffiliatesCopyDictionary } from './types';

const NBSP = '\u00a0';

const DICTIONARY = {
  'affiliates.test.greeting': { en: 'Hello {name}', fr: 'Bonjour {name}' },
  'affiliates.test.spots': { en: '{count} spots left', fr: '{count} places restantes' },
  'affiliates.test.english_only_override': { en: 'Stock English', fr: 'Français d’origine' },
  'affiliates.test.reason': { en: 'Reason: {reason}', fr: 'Motif : {reason}' },
  'affiliates.test.quote': { en: '“{title}”', fr: '« {title} »' },
} satisfies AffiliatesCopyDictionary;

describe('resolveAffiliatesLocale', () => {
  it('maps any fr* locale to fr and everything else to en', () => {
    expect(resolveAffiliatesLocale('fr')).toBe('fr');
    expect(resolveAffiliatesLocale(' FR-ca ')).toBe('fr');
    expect(resolveAffiliatesLocale('en')).toBe('en');
    expect(resolveAffiliatesLocale('es')).toBe('en');
    expect(resolveAffiliatesLocale(undefined)).toBe('en');
    expect(resolveAffiliatesLocale(42)).toBe('en');
  });
});

describe('interpolateAffiliatesCopy', () => {
  it('replaces every occurrence of a placeholder', () => {
    expect(interpolateAffiliatesCopy('{a} and {a} and {b}', { a: 'x', b: 2 })).toBe('x and x and 2');
  });

  it('keeps unknown placeholders and renders null/undefined as empty', () => {
    expect(interpolateAffiliatesCopy('Hi {name}, {missing}', { name: null })).toBe('Hi , {missing}');
    expect(interpolateAffiliatesCopy('Hi {name}', { name: undefined })).toBe('Hi ');
    expect(interpolateAffiliatesCopy('Hi {name}')).toBe('Hi {name}');
  });

  it('inserts values literally: no $-patterns, no second pass, no prototype lookups', () => {
    expect(interpolateAffiliatesCopy('Paid {amount}', { amount: '$& $1 $$' })).toBe('Paid $& $1 $$');
    expect(interpolateAffiliatesCopy('{a} {b}', { a: '{b}', b: 'B' })).toBe('{b} B');
    expect(interpolateAffiliatesCopy('{constructor} {toString}', {})).toBe('{constructor} {toString}');
  });
});

describe('createAffiliatesCopy', () => {
  it('reads the dictionary in the locale language and interpolates', () => {
    expect(createAffiliatesCopy({ locale: 'fr', dictionary: DICTIONARY })('affiliates.test.greeting', { name: 'Jane' })).toBe(
      'Bonjour Jane'
    );
    expect(createAffiliatesCopy({ locale: 'en', dictionary: DICTIONARY })('affiliates.test.greeting', { name: 'Jane' })).toBe(
      'Hello Jane'
    );
    expect(createAffiliatesCopy({ locale: 'fr-CA', dictionary: DICTIONARY })('affiliates.test.spots', { count: 3 })).toBe(
      '3 places restantes'
    );
  });

  it('lets an operator override for the locale win over the dictionary', () => {
    const t = createAffiliatesCopy({
      locale: 'fr',
      dictionary: DICTIONARY,
      overrides: { 'affiliates.test.greeting': { fr: 'Salut {name}', en: 'Hey {name}' } },
    });
    expect(t('affiliates.test.greeting', { name: 'Jane' })).toBe('Salut Jane');
  });

  it('prefers the stock French over an English-only override, and an English override over stock English', () => {
    const overrides = { 'affiliates.test.english_only_override': { en: 'Operator English' } };
    expect(createAffiliatesCopy({ locale: 'fr', dictionary: DICTIONARY, overrides })('affiliates.test.english_only_override')).toBe(
      'Français d’origine'
    );
    expect(createAffiliatesCopy({ locale: 'en', dictionary: DICTIONARY, overrides })('affiliates.test.english_only_override')).toBe(
      'Operator English'
    );
    expect(createAffiliatesCopy({ locale: 'es', dictionary: DICTIONARY, overrides })('affiliates.test.english_only_override')).toBe(
      'Operator English'
    );
  });

  it('uses an override in a locale the dictionary does not have', () => {
    const t = createAffiliatesCopy({
      locale: 'es',
      dictionary: DICTIONARY,
      overrides: { 'affiliates.test.greeting': { es: 'Hola {name}' } },
    });
    expect(t('affiliates.test.greeting', { name: 'Jane' })).toBe('Hola Jane');
    expect(t('affiliates.test.spots', { count: 2 })).toBe('2 spots left');
  });

  it('ignores blank overrides and falls back to the key for unknown or prototype keys', () => {
    const t = createAffiliatesCopy({
      locale: 'en',
      dictionary: DICTIONARY,
      overrides: { 'affiliates.test.greeting': { en: '   ' } },
    });
    expect(t('affiliates.test.greeting', { name: 'Jane' })).toBe('Hello Jane');
    expect(t('affiliates.test.unknown')).toBe('affiliates.test.unknown');
    expect(t('constructor')).toBe('constructor');
    expect(t('__proto__')).toBe('__proto__');
  });

  it('treats a missing locale as English', () => {
    expect(createAffiliatesCopy({ locale: null, dictionary: DICTIONARY })('affiliates.test.greeting', { name: 'A' })).toBe('Hello A');
  });
});

describe('French typography', () => {
  it('keeps a French rate on one line: a no-break space before "%"', () => {
    const t = createAffiliatesCopy({ locale: 'fr-CA', dictionary: AFFILIATES_COMMON_COPY });
    expect(t('affiliates.common.tier_commission_rate', { rate: '50' })).toBe(`Commission de 50${NBSP}%`);
  });

  it('uses no-break spaces before ":" and "»" and after "«", and leaves English alone', () => {
    const fr = createAffiliatesCopy({ locale: 'fr', dictionary: DICTIONARY });
    expect(fr('affiliates.test.reason', { reason: 'doublon' })).toBe(`Motif${NBSP}: doublon`);
    expect(fr('affiliates.test.quote', { title: 'Ma vitrine' })).toBe(`«${NBSP}Ma vitrine${NBSP}»`);

    const en = createAffiliatesCopy({ locale: 'en', dictionary: AFFILIATES_COMMON_COPY });
    expect(en('affiliates.common.tier_commission_rate', { rate: '50' })).toBe('50% commission');
    const enOverride = createAffiliatesCopy({
      locale: 'en',
      dictionary: DICTIONARY,
      overrides: { 'affiliates.test.reason': { en: 'Reason : {reason} %' } },
    });
    expect(enOverride('affiliates.test.reason', { reason: 'x' })).toBe('Reason : x %');
  });

  it('applies to an operator override typed with plain spaces', () => {
    const t = createAffiliatesCopy({
      locale: 'fr',
      dictionary: DICTIONARY,
      overrides: { 'affiliates.test.reason': { fr: 'Taux : {reason} %' } },
    });
    expect(t('affiliates.test.reason', { reason: '12' })).toBe(`Taux${NBSP}: 12${NBSP}%`);
  });

  it('never rewrites an interpolated value', () => {
    const t = createAffiliatesCopy({ locale: 'fr', dictionary: DICTIONARY });
    expect(t('affiliates.test.reason', { reason: 'voir : « ceci » à 5 %' })).toBe(`Motif${NBSP}: voir : « ceci » à 5 %`);
  });

  it('is idempotent and touches nothing but those spaces', () => {
    const once = applyAffiliatesFrenchTypography('« Taux » : 50 % (https://exemple.ca)');
    expect(once).toBe(`«${NBSP}Taux${NBSP}»${NBSP}: 50${NBSP}% (https://exemple.ca)`);
    expect(applyAffiliatesFrenchTypography(once)).toBe(once);
    expect(applyAffiliatesFrenchTypography('Bonjour, Jane!')).toBe('Bonjour, Jane!');
  });
});

describe('affiliatesCopyOverridesFromRows', () => {
  const rows = [
    { key: 'affiliates.portal.title', translations: { en: 'Partner portal', fr: 'Portail', es: '' } },
    { key: 'affiliates.partners.hero', translations: { en: 'Join', fr: 'Rejoignez' } },
    { key: 'cart.title', translations: { en: 'Cart', fr: 'Panier' } },
    { key: 'affiliates.portal.bad', translations: ['not', 'an', 'object'] },
    { key: 'affiliates.portal.numbers', translations: { en: 5, fr: null } },
    { key: 42, translations: { en: 'x' } },
    null,
  ] as unknown as Parameters<typeof affiliatesCopyOverridesFromRows>[0];

  it('keeps only affiliates keys with non-empty string values', () => {
    expect(affiliatesCopyOverridesFromRows(rows)).toEqual({
      'affiliates.portal.title': { en: 'Partner portal', fr: 'Portail' },
      'affiliates.partners.hero': { en: 'Join', fr: 'Rejoignez' },
    });
  });

  it('narrows to areas and locales', () => {
    expect(affiliatesCopyOverridesFromRows(rows, { areas: ['portal'], locales: ['FR'] })).toEqual({
      'affiliates.portal.title': { fr: 'Portail' },
    });
    expect(affiliatesCopyOverridesFromRows(rows, { areas: ['storefront'] })).toEqual({});
    expect(affiliatesCopyOverridesFromRows(null)).toEqual({});
  });
});

describe('splitAffiliatesCopyAtPlaceholder', () => {
  it('splits a template around its placeholder', () => {
    expect(splitAffiliatesCopyAtPlaceholder('I accept the {terms}. I will disclose.', 'terms')).toEqual({
      before: 'I accept the ',
      after: '. I will disclose.',
      found: true,
    });
    expect(splitAffiliatesCopyAtPlaceholder('{terms}', 'terms')).toEqual({ before: '', after: '', found: true });
    expect(splitAffiliatesCopyAtPlaceholder('Read the {terms}', 'terms')).toEqual({ before: 'Read the ', after: '', found: true });
  });

  it('splits what t() returns without values: French typography applied, placeholders intact', () => {
    const t = createAffiliatesCopy({
      locale: 'fr',
      dictionary: { 'affiliates.test.terms': { en: 'Accept the {terms}: now', fr: "J'accepte les {terms} : maintenant" } },
    });
    expect(splitAffiliatesCopyAtPlaceholder(t('affiliates.test.terms'), 'terms')).toEqual({
      before: "J'accepte les ",
      after: `${NBSP}: maintenant`,
      found: true,
    });
  });

  it('returns the whole template in before when the placeholder is absent (an override that dropped it)', () => {
    expect(splitAffiliatesCopyAtPlaceholder('I accept the partner terms.', 'terms')).toEqual({
      before: 'I accept the partner terms.',
      after: '',
      found: false,
    });
    expect(splitAffiliatesCopyAtPlaceholder('I accept the {term}.', 'terms').found).toBe(false);
    expect(splitAffiliatesCopyAtPlaceholder('I accept the {Terms}.', 'terms').found).toBe(false);
  });

  it('splits at the first occurrence and keeps a second one as written', () => {
    expect(splitAffiliatesCopyAtPlaceholder('{terms} and {terms}', 'terms')).toEqual({
      before: '',
      after: ' and {terms}',
      found: true,
    });
  });

  it('never finds a name that is not a placeholder name, and survives non-string input', () => {
    expect(splitAffiliatesCopyAtPlaceholder('a {.*} b', '.*')).toEqual({ before: 'a {.*} b', after: '', found: false });
    expect(splitAffiliatesCopyAtPlaceholder('a {} b', '')).toEqual({ before: 'a {} b', after: '', found: false });
    expect(splitAffiliatesCopyAtPlaceholder(undefined as unknown as string, 'terms')).toEqual({ before: '', after: '', found: false });
    expect(splitAffiliatesCopyAtPlaceholder('x {terms}', 42 as unknown as string).found).toBe(false);
  });
});
