import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { auditSeo, buildSeoDocument } from '@nextblock-cms/utils/seo';
import {
  AFFILIATES_COMMON_COPY,
  AFFILIATES_PARTNERS_COPY,
  AffiliatesCopyProvider,
  createAffiliatesCopy,
  type AffiliateLocale,
  type AffiliateTierRow,
} from '@nextblock-cms/affiliates';

/**
 * The `/partners` landing page must score 100 on the SEO engine the CMS grades pages with
 * (libs/utils/src/lib/seo): one H1, no skipped heading level, at least 300 words, Flesch Reading
 * Ease of 50 or more with short sentences, a meta title of at most 60 characters and a description
 * of 70 to 160 — in English AND in Québec French. The page body is rendered for real (server
 * sections plus both client islands), so a copy or markup change that breaks the grade fails here.
 */

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { PartnerRevenueCalculator } from '../../../components/affiliates/public/PartnerRevenueCalculator';
import { PartnerSignupForm } from '../../../components/affiliates/public/PartnerSignupForm';
import { PartnersLandingView } from './_components/partners-landing';
import { buildPartnersLandingModel, buildPartnersMetaCopy } from './_components/partners-model';

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
  tier({ id: 't1', name: 'Starter Partner', slug: 'starter-partner', commission_percentage: 10, sort_order: 1, badge_color: 'slate', name_translations: { fr: 'Partenaire Départ' } }),
  tier({ id: 't2', name: 'Growth Partner', slug: 'growth-partner', commission_percentage: 20, sort_order: 2, badge_color: 'sky', name_translations: { fr: 'Partenaire Croissance' } }),
  tier({ id: 't3', name: 'Elite Partner', slug: 'elite-partner', commission_percentage: 35, sort_order: 3, badge_color: 'violet', name_translations: { fr: 'Partenaire Élite' } }),
  tier({
    id: 't4',
    name: 'Founding Ambassador',
    slug: 'founding-ambassador',
    commission_percentage: 50,
    sort_order: 4,
    badge_color: 'amber',
    is_default_signup_tier: true,
    is_limited_time_promo: true,
    max_ambassadors_cap: 50,
    member_count: 1,
    name_translations: { fr: 'Ambassadeur fondateur' },
  }),
];

const SOLD_OUT_TIERS = SEEDED_TIERS.map((row) => (row.id === 't4' ? { ...row, member_count: 50 } : row));

const DICTIONARY = { ...AFFILIATES_COMMON_COPY, ...AFFILIATES_PARTNERS_COPY };

function renderLanding(locale: AffiliateLocale, tiers: AffiliateTierRow[]) {
  const t = createAffiliatesCopy({ locale, dictionary: DICTIONARY });
  const model = buildPartnersLandingModel({ tiers, locale, currency: 'USD' });
  const html = renderToStaticMarkup(
    <AffiliatesCopyProvider locale={locale}>
      <PartnersLandingView
        t={t}
        model={model}
        calculator={model.calculator ? <PartnerRevenueCalculator {...model.calculator} /> : null}
        signup={
          <PartnerSignupForm
            viewer={{ kind: 'anonymous' }}
            signupAction={async (state) => state}
            checkHandleAction={async () => ({ ok: true, status: 'available' })}
            storefrontPrefix="shop.example.com/partners/"
            botProtection={{ provider: 'none', siteKey: '' }}
            signupOpen={model.signupOpen}
            signInHref="/sign-in?redirect=%2Fpartners"
            twoFactorHref="/two-factor?redirect_to=%2Fpartners"
            portalHref="/portal/retailer"
            termsHref={locale === 'fr' ? '/partenaires/conditions' : '/partners/terms'}
          />
        }
      />
    </AffiliatesCopyProvider>,
  );
  return { html, model, meta: buildPartnersMetaCopy(t, model) };
}

/**
 * Every finding that costs points. Info-level notes are advisory and never scored: without a focus
 * keyphrase the engine says so (`keyword-missing`) and leaves the keyphrase rows out of the total.
 */
function blockingIssues(result: ReturnType<typeof auditSeo>): string[] {
  return result.issues
    .filter((issue) => issue.severity !== 'info')
    .map((issue) => `${issue.id}: ${issue.detail ?? issue.message}`);
}

function grade(locale: AffiliateLocale, tiers: AffiliateTierRow[]) {
  const { html, meta, model } = renderLanding(locale, tiers);
  const document = buildSeoDocument(html);
  const result = auditSeo({ document, metaTitle: meta.title, metaDescription: meta.description });
  return { html, meta, model, document, result };
}

describe('/partners SEO grade', () => {
  for (const locale of ['en', 'fr'] as const) {
    it(`scores 100 in ${locale === 'en' ? 'English' : 'French'} with the launch offer`, () => {
      const { result, document, meta } = grade(locale, SEEDED_TIERS);

      expect(blockingIssues(result)).toEqual([]);
      expect(result.checks.filter((check) => !check.passed)).toEqual([]);
      expect(result.score).toBe(100);
      expect(document.headings.filter((heading) => heading.level === 1)).toHaveLength(1);
      expect(document.words.length).toBeGreaterThanOrEqual(300);
      expect(result.readability.fleschReadingEase).toBeGreaterThanOrEqual(50);
      expect(meta.title.length).toBeLessThanOrEqual(60);
      expect(meta.description.length).toBeGreaterThanOrEqual(70);
      expect(meta.description.length).toBeLessThanOrEqual(160);
    });

    it(`scores 100 in ${locale === 'en' ? 'English' : 'French'} once the founding spots are gone`, () => {
      const { result, html, model } = grade(locale, SOLD_OUT_TIERS);

      expect(blockingIssues(result)).toEqual([]);
      expect(result.score).toBe(100);
      expect(model.offer).toBeNull();
      expect(html).not.toContain(locale === 'en' ? 'Spots Left!' : 'places au niveau');
    });
  }

  it('renders the launch offer with the remaining spots and the standard range', () => {
    const en = renderLanding('en', SEEDED_TIERS).html;
    expect(en).toContain('Earn up to 50% on every sale you refer');
    expect(en).toContain('Claim 50% Revenue Share (Normally 10%–35%) — Only 49 Founding Ambassador Spots Left!');

    // French: a no-break space keeps each "%" on its rate's line.
    const fr = renderLanding('fr', SEEDED_TIERS).html;
    expect(fr).toContain('Gagnez jusqu&#x27;à 50\u00a0% sur chaque vente que vous recommandez');
    expect(fr).toContain(
      'Obtenez 50\u00a0% de partage des revenus (normalement de 10\u00a0% à 35\u00a0%) — il ne reste que 49 places au niveau Ambassadeur fondateur!',
    );
  });

  it('keeps the decorative slider out of the accessibility tree and says the same in text', () => {
    const { html } = renderLanding('en', SEEDED_TIERS);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('The launch offer is locked on the Founding Ambassador tier at 50%.');
  });

  it('links the partner terms from the signup checkbox, in each language, inside the graded page', () => {
    expect(renderLanding('en', SEEDED_TIERS).html).toMatch(/<a href="\/partners\/terms" target="_blank" rel="noopener"[^>]*>partner terms/);
    expect(renderLanding('fr', SEEDED_TIERS).html).toMatch(
      /<a href="\/partenaires\/conditions" target="_blank" rel="noopener"[^>]*>conditions du programme partenaires/,
    );
  });

  it('never ships English on the French page', () => {
    const { html } = renderLanding('fr', SEEDED_TIERS);
    for (const english of ['How it works', 'Claim your storefront', 'Display name', 'Frequently asked questions', 'Password']) {
      expect(html).not.toContain(english);
    }
  });
});
