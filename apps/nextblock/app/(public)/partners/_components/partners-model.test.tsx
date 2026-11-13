import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AFFILIATES_COMMON_COPY,
  AFFILIATES_PARTNERS_COPY,
  createAffiliatesCopy,
  type AffiliateTierRow,
} from '@nextblock-cms/affiliates';

import { PartnersLandingView } from './partners-landing';
import {
  PARTNERS_CALCULATOR_AVERAGE_ORDER_VALUE,
  buildPartnersLandingModel,
  buildPartnersOfferMessage,
  partnersAverageOrderRange,
  selectPartnersShowcaseProducts,
  type PartnersShowcaseProduct,
} from './partners-model';

/**
 * The `/partners` page advertises only what a signup actually gets. `create_affiliate_account`
 * fills the default tiers highest sort order first, so a second default tier ranked above the
 * launch-offer tier (the CMS gives a new tier the next sort order) takes every signup: the page
 * must then drop the offer instead of promising its rate.
 */

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

/** The four tiers migration 02030 seeds, with one founding spot taken. */
const SEEDED_TIERS: AffiliateTierRow[] = [
  tier({ id: 't1', name: 'Starter Partner', slug: 'starter-partner', commission_percentage: 10, sort_order: 1 }),
  tier({ id: 't2', name: 'Growth Partner', slug: 'growth-partner', commission_percentage: 20, sort_order: 2 }),
  tier({ id: 't3', name: 'Elite Partner', slug: 'elite-partner', commission_percentage: 35, sort_order: 3 }),
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
  }),
];

/** The admin adds a 25% default tier and keeps the form's next sort order (5). */
const PARTNER_PLUS = tier({
  id: 't5',
  name: 'Partner Plus',
  slug: 'partner-plus',
  commission_percentage: 25,
  sort_order: 5,
  is_default_signup_tier: true,
});

const t = createAffiliatesCopy({ locale: 'en', dictionary: { ...AFFILIATES_COMMON_COPY, ...AFFILIATES_PARTNERS_COPY } });

/** renderToStaticMarkup's text escaping, so expected copy can be looked up in the markup. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function render(tiers: AffiliateTierRow[]) {
  const model = buildPartnersLandingModel({ tiers, locale: 'en', currency: 'USD' });
  const html = renderToStaticMarkup(<PartnersLandingView t={t} model={model} calculator={null} signup={null} />);
  return { model, html };
}

describe('buildPartnersLandingModel: the offer matches the signup tier', () => {
  it('features the launch offer while it is the tier a signup gets', () => {
    const { model, html } = render(SEEDED_TIERS);
    expect(model.offer).toMatchObject({ tierName: 'Founding Ambassador', rateLabel: '50', spotsRemaining: 49 });
    expect(model.signupTier).toEqual({ name: 'Founding Ambassador', rateLabel: '50' });
    expect(model.headlineRateLabel).toBe('50');
    expect(model.track).toMatchObject({ kind: 'offer', tierName: 'Founding Ambassador' });
    expect(model.calculator).toMatchObject({ compareRate: 50, baseRate: 10 });
    expect(html).toContain(escapeHtml(t('affiliates.partners.offer_claim', { rate: '50' })));
  });

  it('drops the offer while another default tier ranks ahead of the promo tier', () => {
    const { model, html } = render([...SEEDED_TIERS, PARTNER_PLUS]);

    expect(model.signupTier).toEqual({ name: 'Partner Plus', rateLabel: '25' });
    expect(model.offer).toBeNull();
    expect(buildPartnersOfferMessage(t, model.offer)).toBeNull();
    expect(model.tiers.some((ladderTier) => ladderTier.isOffer)).toBe(false);
    // "Earn up to": the best standard rate, never the promo rate nobody gets.
    expect(model.headlineRateLabel).toBe('35');
    expect(model.track).toMatchObject({ kind: 'standard', tierName: 'Partner Plus', rateLabel: '25' });
    expect(model.calculator).toMatchObject({ compareRate: 25, baseRate: 10 });

    expect(html).toContain(escapeHtml(t('affiliates.partners.hero_title', { rate: '35' })));
    expect(html).toContain(escapeHtml(t('affiliates.partners.ladder_track_standard', { tier: 'Partner Plus', rate: '25' })));
    expect(html).not.toContain(escapeHtml(t('affiliates.partners.offer_claim', { rate: '50' })));
    expect(html).not.toContain(escapeHtml(t('affiliates.partners.hero_title', { rate: '50' })));
  });

  it('brings the offer back once the shadowing tier is full', () => {
    const { model } = render([...SEEDED_TIERS, { ...PARTNER_PLUS, max_ambassadors_cap: 5, member_count: 5 }]);
    expect(model.offer).toMatchObject({ tierName: 'Founding Ambassador' });
    expect(model.headlineRateLabel).toBe('50');
  });

  it('counts a promo tier in the headline only when a signup gets it', () => {
    // Every default tier is full, so the walk reaches the non-default promo tier: it is reachable.
    const tiers = [
      tier({ id: 'base', name: 'Base', slug: 'base', commission_percentage: 10, sort_order: 2 }),
      tier({ id: 'promo', name: 'Spring Promo', slug: 'spring-promo', commission_percentage: 40, sort_order: 1, is_limited_time_promo: true }),
      tier({ id: 'full', name: 'Full Default', slug: 'full-default', commission_percentage: 15, sort_order: 3, is_default_signup_tier: true, max_ambassadors_cap: 1, member_count: 1 }),
    ];
    const { model } = render(tiers);
    expect(model.signupTier).toEqual({ name: 'Spring Promo', rateLabel: '40' });
    expect(model.headlineRateLabel).toBe('40');

    // A sold-out promo tier never inflates the headline.
    const soldOut = render(SEEDED_TIERS.map((row) => (row.id === 't4' ? { ...row, member_count: 50 } : row))).model;
    expect(soldOut.offer).toBeNull();
    expect(soldOut.headlineRateLabel).toBe('35');
  });
});

const SHOWCASE: PartnersShowcaseProduct[] = [
  { id: 'cap', title: 'Signal Cap', href: '/product/signal-cap', orderValueMinor: 2_600, monthlyMinor: null, billing: 'once' },
  { id: 'commerce', title: 'Commerce Pro', href: '/product/commerce', orderValueMinor: 25_000, monthlyMinor: 2_500, billing: 'year' },
  { id: 'affiliates', title: 'Affiliates', href: '/product/affiliates', orderValueMinor: 20_000, monthlyMinor: 2_000, billing: 'year' },
  { id: 'cortex', title: 'Cortex AI', href: '/product/cortex', orderValueMinor: 25_000, monthlyMinor: null, billing: 'year' },
  { id: 'free', title: 'Free Sticker', href: '/product/sticker', orderValueMinor: 0, monthlyMinor: null, billing: 'once' },
];

describe('buildPartnersLandingModel: tier goals', () => {
  const goals: Record<string, { goal: string; fr: string }> = {
    'growth-partner': { goal: 'Make 8 confirmed sales, then contact us.', fr: 'Réalisez 8 ventes confirmées, puis contactez-nous.' },
    'founding-ambassador': { goal: 'Join while the founding spots last.', fr: 'Inscrivez-vous tant qu’il reste des places.' },
  };
  const withGoals = SEEDED_TIERS.map((row) => {
    const entry = goals[row.slug];
    return entry ? { ...row, goal: entry.goal, goal_translations: { fr: entry.fr } } : row;
  });

  it('carries each tier goal in the page language and explains how goals are reviewed', () => {
    const { model, html } = render(withGoals);
    expect(model.tiers.map((ladderTier) => ladderTier.goal)).toEqual([
      null,
      'Make 8 confirmed sales, then contact us.',
      null,
      'Join while the founding spots last.',
    ]);
    expect(model.hasTierGoals).toBe(true);
    expect(html).toContain(escapeHtml('Make 8 confirmed sales, then contact us.'));
    expect(html).toContain(escapeHtml(t('affiliates.partners.ladder_goal_label')));
    expect(html).toContain(escapeHtml(t('affiliates.partners.ladder_goal_note')));

    const french = buildPartnersLandingModel({ tiers: withGoals, locale: 'fr', currency: 'USD' });
    expect(french.tiers[1]?.goal).toBe('Réalisez 8 ventes confirmées, puis contactez-nous.');
  });

  it('shows no goal line and no note while no tier has a goal (rows read before 02033 included)', () => {
    const { model, html } = render(SEEDED_TIERS);
    expect(model.tiers.every((ladderTier) => ladderTier.goal === null)).toBe(true);
    expect(model.hasTierGoals).toBe(false);
    expect(html).not.toContain(escapeHtml(t('affiliates.partners.ladder_goal_note')));
  });
});

describe('selectPartnersShowcaseProducts and the order value range', () => {
  it('keeps the three priciest products with a price, priciest first (ties by title)', () => {
    expect(selectPartnersShowcaseProducts(SHOWCASE).map((product) => product.id)).toEqual(['commerce', 'cortex', 'affiliates']);
  });

  it('starts the slider at the priciest product and reaches their sum', () => {
    const range = partnersAverageOrderRange(selectPartnersShowcaseProducts(SHOWCASE));
    // 250 + 250 + 200 = 700.00, already a multiple of 50.00.
    expect(range).toEqual({ min: 1_000, max: 70_000, step: 100, initial: 25_000 });
    expect(partnersAverageOrderRange([])).toEqual(PARTNERS_CALCULATOR_AVERAGE_ORDER_VALUE);
    // A cheap catalog never shrinks the default top.
    const cheap = partnersAverageOrderRange(selectPartnersShowcaseProducts(SHOWCASE.slice(0, 1)));
    expect(cheap).toMatchObject({ max: 50_000, initial: 2_600 });
  });

  it('reaches down to products cheaper than the default floor, so the hero never quotes a price nobody sells', () => {
    const ebooks: PartnersShowcaseProduct[] = [
      { id: 'e1', title: 'Ebook', href: '/product/ebook', orderValueMinor: 500, monthlyMinor: null, billing: 'once' },
      { id: 'e2', title: 'Guide', href: '/product/guide', orderValueMinor: 299, monthlyMinor: null, billing: 'once' },
    ];
    const range = partnersAverageOrderRange(selectPartnersShowcaseProducts(ebooks));
    expect(range).toMatchObject({ min: 200, initial: 500 });
    const model = buildPartnersLandingModel({ tiers: SEEDED_TIERS, locale: 'en', currency: 'USD', products: ebooks });
    // 10 sales of $5.00 at 50% = $25.00 a month.
    expect(model.heroExample).toMatchObject({ orderValueMinor: 500, monthlyMinor: 2_500 });
  });
});

describe('buildPartnersLandingModel: the hero example and the calculator agree', () => {
  it('works out the calculator starting point: 10 sales of the priciest product at the offer rate', () => {
    const model = buildPartnersLandingModel({ tiers: SEEDED_TIERS, locale: 'en', currency: 'USD', products: SHOWCASE });
    expect(model.calculator?.averageOrderValue.initial).toBe(25_000);
    expect(model.calculator?.products.map((product) => product.id)).toEqual(['commerce', 'cortex', 'affiliates']);
    expect(model.heroExample).toMatchObject({
      rateLabel: '50',
      sales: 10,
      orderValueMinor: 25_000,
      // 10 x 250.00 x 50% = 1,250.00 a month.
      monthlyMinor: 125_000,
    });
    expect(model.heroExample?.saleRows).toEqual([
      { title: 'Commerce Pro', commissionMinor: 12_500, status: 'pending_clearance' },
      { title: 'Cortex AI', commissionMinor: 12_500, status: 'cleared' },
      { title: 'Affiliates', commissionMinor: 10_000, status: 'paid' },
    ]);
    expect(model.offer?.spotsTotal).toBe(50);
  });

  it('uses the rate a signup gets, never a promo rate nobody can reach', () => {
    const model = buildPartnersLandingModel({ tiers: [...SEEDED_TIERS, PARTNER_PLUS], locale: 'en', currency: 'USD' });
    expect(model.heroExample).toMatchObject({ rateLabel: '25', orderValueMinor: 6_000, monthlyMinor: 15_000 });
    expect(model.heroExample?.saleRows).toEqual([{ title: null, commissionMinor: 1_500, status: 'pending_clearance' }]);
  });

  it('renders the example card from the model, its amount as text for screen readers', () => {
    const model = buildPartnersLandingModel({ tiers: SEEDED_TIERS, locale: 'en', currency: 'USD', products: SHOWCASE });
    const html = renderToStaticMarkup(<PartnersLandingView t={t} model={model} calculator={null} signup={null} />);
    expect(html).toContain(escapeHtml(t('affiliates.partners.hero_visual_amount', { amount: '$1,250' })));
    expect(html).toContain(escapeHtml(t('affiliates.partners.hero_visual_formula', { sales: 10, price: '$250' })));
    expect(html).toContain(escapeHtml(t('affiliates.partners.hero_spots_taken_one', { taken: 1, cap: 50 })));
    const french = createAffiliatesCopy({ locale: 'fr', dictionary: { ...AFFILIATES_COMMON_COPY, ...AFFILIATES_PARTNERS_COPY } });
    const frenchModel = buildPartnersLandingModel({ tiers: SEEDED_TIERS, locale: 'fr', currency: 'USD', products: SHOWCASE });
    const frenchHtml = renderToStaticMarkup(<PartnersLandingView t={french} model={frenchModel} calculator={null} signup={null} />);
    expect(frenchHtml).toContain('1 place prise sur 50');
    const twelveTaken = SEEDED_TIERS.map((row) => (row.id === 't4' ? { ...row, member_count: 12 } : row));
    const frenchTwelve = buildPartnersLandingModel({ tiers: twelveTaken, locale: 'fr', currency: 'USD' });
    expect(renderToStaticMarkup(<PartnersLandingView t={french} model={frenchTwelve} calculator={null} signup={null} />)).toContain(
      '12 places prises sur 50'
    );
    expect(html).toContain('+$125.00');
    // A figure, not an aside (the page's only aside is the sandbox guide).
    expect(html).toContain('<figure');
    expect(html).not.toContain('<aside');
    // The rolling digits are drawn by CSS, so the page text never holds a reel of digits.
    expect(html).not.toMatch(/0123456789/);
  });

  it('has no example card while no tier pays a rate, and claims nothing is open while signups are paused', () => {
    const model = buildPartnersLandingModel({ tiers: [], locale: 'en', currency: 'USD', products: SHOWCASE });
    expect(model.heroExample).toBeNull();
    expect(model.calculator).toBeNull();
    expect(model.signupOpen).toBe(false);
    const html = renderToStaticMarkup(<PartnersLandingView t={t} model={model} calculator={null} signup={null} />);
    expect(html).not.toContain('<figure');
    expect(html).toContain(escapeHtml(t('affiliates.partners.hero_eyebrow')));
    expect(html).not.toContain(escapeHtml(t('affiliates.partners.hero_badge_open')));
    // No closing band either: there is nothing to join.
    expect(html).not.toContain('partners-cta-title');
  });
});

describe('PartnersLandingView: the closing band and the hero checks say only what is true', () => {
  function html(tiers: AffiliateTierRow[], autoPayouts?: boolean) {
    const model = buildPartnersLandingModel({ tiers, locale: 'en', currency: 'USD' });
    return renderToStaticMarkup(<PartnersLandingView t={t} model={model} calculator={null} signup={null} autoPayouts={autoPayouts} />);
  }

  it('names the launch offer rate a signup gets, with spots while they are capped', () => {
    const page = html(SEEDED_TIERS);
    expect(page).toContain(escapeHtml(t('affiliates.partners.cta_title', { rate: '50' })));
    expect(page).toContain(escapeHtml(t('affiliates.partners.cta_body_offer', { tier: 'Founding Ambassador' })));
    // The hero badge is the launch offer's eyebrow while the offer runs.
    expect(page).toContain(escapeHtml(t('affiliates.partners.offer_eyebrow')));
  });

  it('says "while the offer lasts" for an uncapped launch offer, never "while spots last"', () => {
    const uncapped = SEEDED_TIERS.map((row) => (row.id === 't4' ? { ...row, max_ambassadors_cap: null } : row));
    const page = html(uncapped);
    expect(page).toContain(escapeHtml(t('affiliates.partners.cta_body_offer_unlimited', { tier: 'Founding Ambassador' })));
    expect(page).not.toContain(escapeHtml(t('affiliates.partners.cta_body_offer', { tier: 'Founding Ambassador' })));
  });

  it('says "up to" the best reachable rate once the offer is gone (sold out), as the h1 does', () => {
    const soldOut = SEEDED_TIERS.map((row) => (row.id === 't4' ? { ...row, member_count: 50 } : row));
    const page = html(soldOut);
    expect(page).toContain(escapeHtml(t('affiliates.partners.cta_title_up_to', { rate: '35' })));
    expect(page).not.toContain(escapeHtml(t('affiliates.partners.cta_title', { rate: '35' })));
    expect(page).toContain(escapeHtml(t('affiliates.partners.cta_body')));
  });

  it('promises automatic payouts only while the operator has them on', () => {
    expect(html(SEEDED_TIERS)).toContain(escapeHtml(t('affiliates.partners.benefit_payouts_title')));
    const manual = html(SEEDED_TIERS, false);
    expect(manual).toContain(escapeHtml(t('affiliates.partners.hero_point_payouts_stripe')));
  });

  it('marks an English goal shown on the French page as English', () => {
    const tiers = SEEDED_TIERS.map((row) => (row.id === 't2' ? { ...row, goal: 'Make 8 cleared sales.', goal_translations: {} } : row));
    const french = createAffiliatesCopy({ locale: 'fr', dictionary: { ...AFFILIATES_COMMON_COPY, ...AFFILIATES_PARTNERS_COPY } });
    const model = buildPartnersLandingModel({ tiers, locale: 'fr', currency: 'USD' });
    const page = renderToStaticMarkup(<PartnersLandingView t={french} model={model} calculator={null} signup={null} />);
    expect(page).toMatch(/<p lang="en"[^>]*>Make 8 cleared sales\.<\/p>/);
  });
});
