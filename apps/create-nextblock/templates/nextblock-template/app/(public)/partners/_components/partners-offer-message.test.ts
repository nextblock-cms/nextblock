import { describe, expect, it } from 'vitest';
import {
  AFFILIATES_COMMON_COPY,
  AFFILIATES_PARTNERS_COPY,
  createAffiliatesCopy,
  type AffiliateLocale,
  type AffiliateTierRow,
} from '@nextblock-cms/affiliates';

import { buildPartnersLandingModel, buildPartnersOfferMessage, type PartnersOffer } from './partners-model';

/**
 * The launch-offer line names the promo tier by its current, localized name: admins rename tiers
 * in /cms/affiliates/tiers, and the badge must never advertise a tier that no longer exists.
 */

const NBSP = '\u00a0';
const DICTIONARY = { ...AFFILIATES_COMMON_COPY, ...AFFILIATES_PARTNERS_COPY };

function tier(overrides: Partial<AffiliateTierRow> & Pick<AffiliateTierRow, 'id' | 'name' | 'slug'>): AffiliateTierRow {
  return {
    name_translations: {},
    commission_percentage: 10,
    cookie_duration_days: 30,
    clearance_hold_days: 30,
    is_default_signup_tier: false,
    is_limited_time_promo: false,
    max_ambassadors_cap: null,
    member_count: 0,
    sort_order: 0,
    badge_color: 'violet',
    is_active: true,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function tiers(promo: Partial<AffiliateTierRow>): AffiliateTierRow[] {
  return [
    tier({ id: 't1', name: 'Starter Partner', slug: 'starter-partner', commission_percentage: 10, sort_order: 1, name_translations: { fr: 'Partenaire Départ' } }),
    tier({ id: 't2', name: 'Growth Partner', slug: 'growth-partner', commission_percentage: 20, sort_order: 2, name_translations: { fr: 'Partenaire Croissance' } }),
    tier({ id: 't3', name: 'Elite Partner', slug: 'elite-partner', commission_percentage: 35, sort_order: 3, name_translations: { fr: 'Partenaire Élite' } }),
    tier({
      id: 't4',
      name: 'Founding Ambassador',
      slug: 'founding-ambassador',
      commission_percentage: 50,
      sort_order: 4,
      is_default_signup_tier: true,
      is_limited_time_promo: true,
      max_ambassadors_cap: 50,
      member_count: 1,
      name_translations: { fr: 'Ambassadeur fondateur' },
      ...promo,
    }),
  ];
}

function offerLine(locale: AffiliateLocale, promo: Partial<AffiliateTierRow> = {}) {
  const model = buildPartnersLandingModel({ tiers: tiers(promo), locale, currency: 'USD' });
  return buildPartnersOfferMessage(createAffiliatesCopy({ locale, dictionary: DICTIONARY }), model.offer);
}

describe('buildPartnersOfferMessage', () => {
  it('names the seeded promo tier in both languages', () => {
    expect(offerLine('en')).toBe('Claim 50% Revenue Share (Normally 10%–35%) — Only 49 Founding Ambassador Spots Left!');
    expect(offerLine('fr')).toBe(
      `Obtenez 50${NBSP}% de partage des revenus (normalement de 10${NBSP}% à 35${NBSP}%) — il ne reste que 49 places au niveau Ambassadeur fondateur!`,
    );
  });

  it('follows a renamed promo tier, in English and French', () => {
    const renamed = { name: 'Launch Partner', name_translations: { fr: 'Partenaire de lancement' } };

    const en = offerLine('en', renamed);
    expect(en).toContain('— Only 49 Launch Partner Spots Left!');
    expect(en).not.toMatch(/Founding|Ambassador/);

    const fr = offerLine('fr', renamed);
    expect(fr).toContain('— il ne reste que 49 places au niveau Partenaire de lancement!');
    expect(fr).not.toMatch(/fondateur|ambassadeur/i);
  });

  it('names the tier on the last spot, and inserts the name as written', () => {
    const offer: PartnersOffer = {
      tierName: 'Holiday 40 %: VIP',
      rateLabel: '40',
      minRateLabel: null,
      maxRateLabel: null,
      spotsRemaining: 1,
    };
    const en = buildPartnersOfferMessage(createAffiliatesCopy({ locale: 'en', dictionary: DICTIONARY }), offer);
    expect(en).toBe('Claim 40% Revenue Share — Only 1 Holiday 40 %: VIP Spot Left!');

    const fr = buildPartnersOfferMessage(createAffiliatesCopy({ locale: 'fr', dictionary: DICTIONARY }), offer);
    expect(fr).toBe(`Obtenez 40${NBSP}% de partage des revenus — il ne reste qu'une place au niveau Holiday 40 %: VIP!`);
  });

  it('keeps the unlimited line without a tier name', () => {
    expect(offerLine('en', { max_ambassadors_cap: null })).toBe('Claim 50% Revenue Share (Normally 10%–35%) — For a Limited Time Only!');
  });
});
