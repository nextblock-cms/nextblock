import { describe, expect, it } from 'vitest';

import {
  affiliateTierDisplayGoal,
  affiliateTierDisplayGoalWithLanguage,
  affiliateTierDisplayName,
  affiliateTierHasCapacity,
  affiliateTierSpotsRemaining,
  compareAffiliateTierEarnings,
  projectAffiliateEarnings,
  selectAffiliateBaseTier,
  selectAffiliatePromoTier,
  selectAffiliateSignupTier,
  type AffiliateTierLike,
} from './tiers';

function tier(overrides: Partial<AffiliateTierLike> & Pick<AffiliateTierLike, 'id' | 'slug'>): AffiliateTierLike {
  return {
    name: overrides.slug,
    name_translations: {},
    sort_order: 0,
    is_active: true,
    is_default_signup_tier: false,
    is_limited_time_promo: false,
    max_ambassadors_cap: null,
    member_count: 0,
    created_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

/** The four tiers migration 02030 seeds. */
function seededTiers(): AffiliateTierLike[] {
  return [
    tier({ id: 't-starter', slug: 'starter-partner', name: 'Starter Partner', sort_order: 1, name_translations: { fr: 'Partenaire Départ' } }),
    tier({ id: 't-growth', slug: 'growth-partner', name: 'Growth Partner', sort_order: 2 }),
    tier({ id: 't-elite', slug: 'elite-partner', name: 'Elite Partner', sort_order: 3 }),
    tier({
      id: 't-founding',
      slug: 'founding-ambassador',
      name: 'Founding Ambassador',
      sort_order: 4,
      is_default_signup_tier: true,
      is_limited_time_promo: true,
      max_ambassadors_cap: 50,
      member_count: 12,
    }),
  ];
}

describe('capacity', () => {
  it('counts the spots left and never goes below zero', () => {
    expect(affiliateTierSpotsRemaining({ max_ambassadors_cap: 50, member_count: 12 })).toBe(38);
    expect(affiliateTierSpotsRemaining({ max_ambassadors_cap: 50, member_count: 60 })).toBe(0);
    expect(affiliateTierSpotsRemaining({ max_ambassadors_cap: null, member_count: 999 })).toBeNull();
  });

  it('mirrors `max_ambassadors_cap IS NULL OR member_count < max_ambassadors_cap`', () => {
    expect(affiliateTierHasCapacity({ max_ambassadors_cap: null, member_count: 5 })).toBe(true);
    expect(affiliateTierHasCapacity({ max_ambassadors_cap: 50, member_count: 49 })).toBe(true);
    expect(affiliateTierHasCapacity({ max_ambassadors_cap: 50, member_count: 50 })).toBe(false);
    expect(affiliateTierHasCapacity({ max_ambassadors_cap: 0, member_count: 0 })).toBe(false);
  });
});

describe('selectAffiliateSignupTier (mirror of create_affiliate_account)', () => {
  it('gives a new signup the founding tier while it has spots', () => {
    expect(selectAffiliateSignupTier(seededTiers())?.id).toBe('t-founding');
  });

  it('falls back to the lowest non-default tier once the founding tier is full', () => {
    const tiers = seededTiers().map((t) => (t.id === 't-founding' ? { ...t, member_count: 50 } : t));
    expect(selectAffiliateSignupTier(tiers)?.id).toBe('t-starter');
  });

  it('skips inactive tiers and answers null when no tier has a spot', () => {
    const inactiveFounding = seededTiers().map((t) => (t.id === 't-founding' ? { ...t, is_active: false } : t));
    expect(selectAffiliateSignupTier(inactiveFounding)?.id).toBe('t-starter');

    const full = seededTiers().map((t) => ({ ...t, max_ambassadors_cap: 1, member_count: 1 }));
    expect(selectAffiliateSignupTier(full)).toBeNull();
    expect(selectAffiliateSignupTier([])).toBeNull();
  });

  it('orders default tiers by sort_order descending, the rest ascending, then created_at', () => {
    const tiers = [
      tier({ id: 'b', slug: 'b', sort_order: 1 }),
      tier({ id: 'd4', slug: 'd4', sort_order: 4, is_default_signup_tier: true }),
      tier({ id: 'd5', slug: 'd5', sort_order: 5, is_default_signup_tier: true }),
      tier({ id: 'a', slug: 'a', sort_order: 1, created_at: '2026-09-01T00:00:00Z' }),
    ];
    expect(selectAffiliateSignupTier(tiers)?.id).toBe('d5');
    expect(selectAffiliateSignupTier(tiers.filter((t) => !t.is_default_signup_tier))?.id).toBe('a');
  });

  it('does not reorder the caller array', () => {
    const tiers = seededTiers();
    const before = tiers.map((t) => t.id);
    selectAffiliateSignupTier(tiers);
    expect(tiers.map((t) => t.id)).toEqual(before);
  });
});

describe('selectAffiliateBaseTier / selectAffiliatePromoTier', () => {
  it('picks the lowest active sort order as the standard tier', () => {
    expect(selectAffiliateBaseTier(seededTiers())?.id).toBe('t-starter');
    const noStarter = seededTiers().map((t) => (t.id === 't-starter' ? { ...t, is_active: false } : t));
    expect(selectAffiliateBaseTier(noStarter)?.id).toBe('t-growth');
  });

  it('features the founding promo only while it has spots', () => {
    expect(selectAffiliatePromoTier(seededTiers())?.id).toBe('t-founding');
    const full = seededTiers().map((t) => (t.id === 't-founding' ? { ...t, member_count: 50 } : t));
    expect(selectAffiliatePromoTier(full)).toBeNull();
    const notPromo = seededTiers().map((t) => (t.id === 't-founding' ? { ...t, is_limited_time_promo: false } : t));
    expect(selectAffiliatePromoTier(notPromo)).toBeNull();
  });

  it('features the promo only while it is the tier a signup gets', () => {
    // A second default tier with a higher sort order (the CMS default for a new tier) takes every signup.
    const partnerPlus = tier({ id: 't-plus', slug: 'partner-plus', name: 'Partner Plus', sort_order: 5, is_default_signup_tier: true });
    expect(selectAffiliateSignupTier([...seededTiers(), partnerPlus])?.id).toBe('t-plus');
    expect(selectAffiliatePromoTier([...seededTiers(), partnerPlus])).toBeNull();

    // Once that tier is full, signups reach the founding tier again, and so does the offer.
    const fullPlus = { ...partnerPlus, max_ambassadors_cap: 10, member_count: 10 };
    expect(selectAffiliatePromoTier([...seededTiers(), fullPlus])?.id).toBe('t-founding');
    // A lower-ranked default tier is only the fallback: the promo stays featured.
    const fallback = { ...partnerPlus, sort_order: 0 };
    expect(selectAffiliatePromoTier([...seededTiers(), fallback])?.id).toBe('t-founding');
  });

  it('never features a promo tier that is not a default signup tier', () => {
    const tiers = [
      tier({ id: 'promo', slug: 'promo', sort_order: 1, is_limited_time_promo: true }),
      tier({ id: 'full-default', slug: 'full-default', sort_order: 2, is_default_signup_tier: true, max_ambassadors_cap: 1, member_count: 1 }),
    ];
    expect(selectAffiliateSignupTier(tiers)?.id).toBe('promo');
    expect(selectAffiliatePromoTier(tiers)).toBeNull();
  });
});

describe('affiliateTierDisplayGoal', () => {
  it('uses goal_translations for the locale, then the English goal', () => {
    const tierGoal = { goal: 'Make 8 confirmed sales.', goal_translations: { fr: 'Réalisez 8 ventes confirmées.' } };
    expect(affiliateTierDisplayGoal(tierGoal, 'fr')).toBe('Réalisez 8 ventes confirmées.');
    expect(affiliateTierDisplayGoal(tierGoal, 'fr-CA')).toBe('Réalisez 8 ventes confirmées.');
    expect(affiliateTierDisplayGoal(tierGoal, 'en')).toBe('Make 8 confirmed sales.');
    expect(affiliateTierDisplayGoal({ goal: 'Make 8 confirmed sales.', goal_translations: { fr: '  ' } }, 'fr')).toBe(
      'Make 8 confirmed sales.'
    );
  });

  it('says which language the goal is in, so an English fallback can be marked on a French page', () => {
    const tierGoal = { goal: 'Make 8 sales.', goal_translations: { fr: 'Réalisez 8 ventes.' } };
    expect(affiliateTierDisplayGoalWithLanguage(tierGoal, 'fr-CA')).toEqual({ text: 'Réalisez 8 ventes.', language: 'fr' });
    expect(affiliateTierDisplayGoalWithLanguage({ goal: 'Make 8 sales.', goal_translations: {} }, 'fr')).toEqual({
      text: 'Make 8 sales.',
      language: 'en',
    });
    expect(affiliateTierDisplayGoalWithLanguage({ goal: null, goal_translations: {} }, 'fr')).toBeNull();
  });

  it('gives a French goal its no-break spaces, and leaves an English fallback alone', () => {
    const tierGoal = { goal: 'Goal: 30 sales (50 %)', goal_translations: { fr: 'Objectif : 30 ventes (50 %)' } };
    expect(affiliateTierDisplayGoal(tierGoal, 'fr')).toBe('Objectif : 30 ventes (50 %)');
    expect(affiliateTierDisplayGoal({ goal: 'Goal: 30 sales', goal_translations: {} }, 'fr')).toBe('Goal: 30 sales');
  });

  it('is null when the tier has no goal (or predates migration 02034)', () => {
    expect(affiliateTierDisplayGoal({ goal: null, goal_translations: {} }, 'en')).toBeNull();
    expect(affiliateTierDisplayGoal({ goal: '   ', goal_translations: {} }, 'fr')).toBeNull();
    expect(affiliateTierDisplayGoal({}, 'en')).toBeNull();
    expect(
      affiliateTierDisplayGoal({ goal: undefined, goal_translations: ['x'] as unknown as Record<string, string> }, 'fr')
    ).toBeNull();
  });
});

describe('affiliateTierDisplayName', () => {
  const [starter, growth, , founding] = seededTiers();

  it('uses name_translations for the locale', () => {
    expect(affiliateTierDisplayName(starter, 'fr')).toBe('Partenaire Départ');
    expect(affiliateTierDisplayName({ ...growth, name_translations: { fr: 'Croissance Plus' } }, 'fr-CA')).toBe('Croissance Plus');
  });

  it('falls back to the seeded French name for an untouched seeded tier', () => {
    expect(affiliateTierDisplayName(founding, 'fr')).toBe('Ambassadeur fondateur');
    expect(affiliateTierDisplayName(growth, 'FR')).toBe('Partenaire Croissance');
  });

  it('shows a renamed tier by its own name rather than the seeded translation', () => {
    expect(affiliateTierDisplayName({ ...founding, name: 'Founding Creator' }, 'fr')).toBe('Founding Creator');
  });

  it('uses the English name for English and unknown languages', () => {
    expect(affiliateTierDisplayName(founding, 'en')).toBe('Founding Ambassador');
    expect(affiliateTierDisplayName(founding, 'es')).toBe('Founding Ambassador');
    expect(affiliateTierDisplayName({ ...founding, name_translations: { es: 'Embajador fundador' } }, 'es')).toBe('Embajador fundador');
  });

  it('never returns an empty string', () => {
    expect(affiliateTierDisplayName({ name: '  ', name_translations: {} }, 'en')).toBe('Partner tier');
    expect(affiliateTierDisplayName({ name: '', name_translations: {} }, 'fr')).toBe('Niveau partenaire');
  });
});

describe('earnings projections', () => {
  it('projects monthly and annual commission in minor units', () => {
    expect(projectAffiliateEarnings({ monthlyReferrals: 10, averageOrderValueMinor: 8000, ratePercent: 50 })).toEqual({
      monthlyMinor: 40000,
      annualMinor: 480000,
    });
  });

  it('rounds once per month, so annual is always 12 × monthly', () => {
    const projection = projectAffiliateEarnings({ monthlyReferrals: 3, averageOrderValueMinor: 3333, ratePercent: 35 });
    expect(projection.monthlyMinor).toBe(3500);
    expect(projection.annualMinor).toBe(projection.monthlyMinor * 12);
  });

  it('treats nonsense inputs as zero and caps the rate at 100%', () => {
    expect(projectAffiliateEarnings({ monthlyReferrals: -5, averageOrderValueMinor: 8000, ratePercent: 50 }).annualMinor).toBe(0);
    expect(projectAffiliateEarnings({ monthlyReferrals: Number.NaN, averageOrderValueMinor: 8000, ratePercent: 50 }).annualMinor).toBe(0);
    expect(projectAffiliateEarnings({ monthlyReferrals: 1, averageOrderValueMinor: 1000, ratePercent: 250 }).monthlyMinor).toBe(1000);
  });

  it('compares the promo rate with the standard rate', () => {
    expect(
      compareAffiliateTierEarnings({ monthlyReferrals: 20, averageOrderValueMinor: 5000, promoRatePercent: 50, baseRatePercent: 10 })
    ).toEqual({ promoAnnualMinor: 600000, baseAnnualMinor: 120000, bonusAnnualMinor: 480000 });
    expect(
      compareAffiliateTierEarnings({ monthlyReferrals: 20, averageOrderValueMinor: 5000, promoRatePercent: 10, baseRatePercent: 50 })
        .bonusAnnualMinor
    ).toBe(0);
  });
});
