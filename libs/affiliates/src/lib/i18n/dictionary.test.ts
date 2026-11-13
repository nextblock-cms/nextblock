import { describe, expect, it } from 'vitest';

import {
  AFFILIATE_ACCOUNT_ERROR_COPY_KEYS,
  AFFILIATE_ACCOUNT_STATUS_COPY_KEYS,
  AFFILIATE_COMMISSION_STATUS_COPY_KEYS,
  AFFILIATE_ONBOARDING_STEP_COPY_KEYS,
  AFFILIATE_PAGE_STATUS_COPY_KEYS,
  AFFILIATE_PAYOUT_STATUS_COPY_KEYS,
} from './copy-keys';
import { AFFILIATE_TERMS_VERSION } from '../core/constants';
import { createAffiliatesCopy } from './copy-runtime';
import { AFFILIATES_COMMON_COPY } from './copy/common';
import { AFFILIATES_TERMS_COPY } from './copy/terms';
import {
  AFFILIATES_COPY,
  AFFILIATES_COPY_AREAS,
  AFFILIATES_COPY_BY_AREA,
  AFFILIATES_COPY_KEY_PREFIX,
  affiliatesCopyAreaPrefix,
  affiliatesCopyKeysWithPrefix,
} from './dictionary';

/**
 * Copy rules for EVERY area file (SPEC §3.2, §6): the 02031 migration is generated from these
 * dictionaries, so a broken string ships to the database.
 */
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
}

const entries = AFFILIATES_COPY_AREAS.flatMap((area) =>
  Object.entries(AFFILIATES_COPY_BY_AREA[area]).map(([key, entry]) => ({ area, key, entry }))
);

describe('affiliates copy dictionaries', () => {
  it('cover every area, and the merged dictionary is exactly their union', () => {
    expect(Object.keys(AFFILIATES_COPY_BY_AREA).sort()).toEqual([...AFFILIATES_COPY_AREAS].sort());
    expect(Object.keys(AFFILIATES_COPY).sort()).toEqual(entries.map((e) => e.key).sort());
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
  });

  it('name every key affiliates.<area>.<snake_name>', () => {
    for (const { area, key } of entries) {
      expect(key, key).toMatch(new RegExp(`^affiliates\\.${area}\\.[a-z0-9]+(?:_[a-z0-9]+)*$`));
      expect(key.startsWith(AFFILIATES_COPY_KEY_PREFIX)).toBe(true);
    }
  });

  it('give every key a trimmed, non-empty English and French string', () => {
    for (const { key, entry } of entries) {
      for (const language of ['en', 'fr'] as const) {
        const text = entry[language];
        expect(typeof text, `${key}.${language}`).toBe('string');
        expect(text.trim().length, `${key}.${language} is empty`).toBeGreaterThan(0);
        expect(text, `${key}.${language} has edge whitespace`).toBe(text.trim());
      }
    }
  });

  it('use the same placeholders in both languages, each at most once per string', () => {
    for (const { key, entry } of entries) {
      const en = placeholders(entry.en);
      const fr = placeholders(entry.fr);
      expect(new Set(en).size, `${key}.en repeats a placeholder`).toBe(en.length);
      expect(new Set(fr).size, `${key}.fr repeats a placeholder`).toBe(fr.length);
      expect([...fr].sort(), `${key}: placeholders differ`).toEqual([...en].sort());
    }
  });

  it('use typographic ellipses and no markup', () => {
    for (const { key, entry } of entries) {
      for (const language of ['en', 'fr'] as const) {
        expect(entry[language], `${key}.${language}: use … not ...`).not.toContain('...');
        expect(entry[language], `${key}.${language}: copy is plain text`).not.toMatch(/<\/?[a-z]/i);
      }
    }
  });

  it('write the Québec French space before ":" and "%" as a plain space (the 02031 generator refuses invisible ones)', () => {
    for (const { key, entry } of entries) {
      expect(entry.fr, `${key}.fr: plain space before ":"`).not.toMatch(/[^ ]:(?=\s|$)/);
      expect(entry.fr, `${key}.fr: plain space before "%"`).not.toMatch(/[^ ]%/);
      expect(entry.fr, `${key}.fr: the copy runtime adds the no-break spaces`).not.toMatch(/[\u00a0\u202f]/);
    }
  });

  it('render French with a no-break space before ":", "%" and "»" and after "«", so nothing wraps alone', () => {
    const t = createAffiliatesCopy({ locale: 'fr-CA', dictionary: AFFILIATES_COPY });
    const breakable: string[] = [];
    let punctuated = 0;
    for (const { key, entry } of entries) {
      const values = Object.fromEntries(placeholders(entry.fr).map((name) => [name, '1']));
      const text = t(key, values);
      if (/ [:%»]|« /.test(text)) breakable.push(`${key}: ${text}`);
      if (/ [:%»]|« /.test(entry.fr)) punctuated += 1;
    }
    expect(breakable).toEqual([]);
    expect(punctuated).toBeGreaterThan(10);
  });
});

describe('dictionary helpers', () => {
  it('build area prefixes and list keys under a prefix', () => {
    expect(affiliatesCopyAreaPrefix('portal')).toBe('affiliates.portal.');
    const commonKeys = affiliatesCopyKeysWithPrefix('affiliates.common.');
    expect(commonKeys).toEqual(Object.keys(AFFILIATES_COMMON_COPY).sort());
    expect(affiliatesCopyKeysWithPrefix('affiliates.common.step_', AFFILIATES_COMMON_COPY)).toEqual([
      'affiliates.common.step_account',
      'affiliates.common.step_done',
      'affiliates.common.step_payouts',
      'affiliates.common.step_profile',
      'affiliates.common.step_storefront',
      'affiliates.common.step_to_do',
    ]);
  });

  it('map every status, step and error code to a common key that exists', () => {
    const maps = [
      AFFILIATE_PAGE_STATUS_COPY_KEYS,
      AFFILIATE_COMMISSION_STATUS_COPY_KEYS,
      AFFILIATE_PAYOUT_STATUS_COPY_KEYS,
      AFFILIATE_ACCOUNT_STATUS_COPY_KEYS,
      AFFILIATE_ONBOARDING_STEP_COPY_KEYS,
      AFFILIATE_ACCOUNT_ERROR_COPY_KEYS,
    ];
    for (const map of maps) {
      for (const key of Object.values(map)) {
        expect(Object.prototype.hasOwnProperty.call(AFFILIATES_COMMON_COPY, key), key).toBe(true);
      }
    }
  });

  it('carries the seeded tier names the 02030 seed uses', () => {
    expect(AFFILIATES_COMMON_COPY['affiliates.common.tier_name_founding_ambassador']).toEqual({
      en: 'Founding Ambassador',
      fr: 'Ambassadeur fondateur',
    });
    expect(AFFILIATES_COMMON_COPY['affiliates.common.tier_name_starter_partner'].fr).toBe('Partenaire Départ');
    expect(AFFILIATES_COMMON_COPY['affiliates.common.tier_name_growth_partner'].fr).toBe('Partenaire Croissance');
    expect(AFFILIATES_COMMON_COPY['affiliates.common.tier_name_elite_partner'].fr).toBe('Partenaire Élite');
  });
});

describe('the partner terms (affiliates.terms.*)', () => {
  const termsEntries = entries.filter((entry) => entry.area === 'terms');

  it('are an area of their own, merged like the others', () => {
    expect(AFFILIATES_COPY_AREAS).toContain('terms');
    expect(AFFILIATES_COPY_BY_AREA.terms).toBe(AFFILIATES_TERMS_COPY);
    expect(termsEntries.length).toBeGreaterThan(40);
  });

  it('carry no numbers: rates, windows, holds and the minimum come from the live Program details table', () => {
    for (const { key, entry } of termsEntries) {
      for (const language of ['en', 'fr'] as const) {
        expect(entry[language], `${key}.${language}`).not.toMatch(/\d/);
      }
    }
  });

  it('use only the placeholders the terms page fills in', () => {
    const allowed = new Set(['company', 'email', 'date', 'rate', 'count']);
    for (const { key, entry } of termsEntries) {
      for (const name of placeholders(entry.en)) expect(allowed.has(name), `${key}: {${name}}`).toBe(true);
    }
    expect(placeholders(AFFILIATES_TERMS_COPY['affiliates.terms.contact_body'].en)).toEqual(['email']);
    expect(placeholders(AFFILIATES_TERMS_COPY['affiliates.terms.law_body'].fr)).toEqual(['company']);
  });

  it('are versioned with an ISO date (shown as "Last updated")', () => {
    expect(AFFILIATE_TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(`${AFFILIATE_TERMS_VERSION}T00:00:00Z`))).toBe(false);
  });
});

describe('French counts and wording', () => {
  const fr = createAffiliatesCopy({ locale: 'fr', dictionary: AFFILIATES_COPY });

  it('agree with a count of one', () => {
    // Every new partner has exactly one onboarding step done (the account).
    expect(fr('affiliates.common.onboarding_progress_one', { completed: 1, total: 4 })).toBe('1 étape sur 4 terminée');
    expect(fr('affiliates.common.onboarding_progress_other', { completed: 2, total: 4 })).toBe('2 étapes sur 4 terminées');
    // The counter under a text field reads right from the first character typed.
    expect(fr('affiliates.portal.character_count', { count: 1, max: 120 })).toBe('1 sur 120 caractères');
  });

  it('call referral traffic visits that came through the partner’s links', () => {
    expect(fr('affiliates.portal.stats_clicks')).toBe('Visites issues de vos liens');
  });
});
