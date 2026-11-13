import { describe, expect, it } from 'vitest';

import {
  NEXTBLOCK_PACKAGES,
  describePackageOffer,
  formatPackagePrice,
  getPackageByFreemiusId,
  getPackageById,
  hasPackageCheckout,
  missingPackageRequirements,
} from './nextblock-packages';

describe('NextBlock package offers', () => {
  it('quotes Cortex AI as a free 30-day trial with no card, then $250 a year', () => {
    const offer = describePackageOffer(NEXTBLOCK_PACKAGES['cortex-ai']);

    expect(offer).toEqual({
      badge: '30-day free trial',
      priceLine: '$250/year',
      summary: 'Free 30-day trial, no credit card required, then $250/year.',
      trialLine: 'Free 30-day trial, no credit card required',
    });
  });

  it('quotes Commerce Pro with the same free trial and both billing cycles', () => {
    const offer = describePackageOffer(NEXTBLOCK_PACKAGES.ecommerce);

    expect(offer.trialLine).toBe('Free 30-day trial, no credit card required');
    expect(offer.badge).toBe('30-day free trial');
    expect(offer.priceLine).toBe('$250/year or $25/month');
    expect(offer.summary).toBe('Free 30-day trial, no credit card required, then $250/year or $25/month.');
  });

  it('describes a package without a trial as a paid license', () => {
    const offer = describePackageOffer({ pricing: { annual: 250, currency: 'USD', monthly: 25 }, trial: null });

    expect(offer.trialLine).toBeNull();
    expect(offer.badge).toBe('Paid license');
    expect(offer.summary).toBe('$250/year or $25/month.');
  });

  it('describes a trial that needs a payment method without the no-card promise', () => {
    const offer = describePackageOffer({
      pricing: { annual: 99, currency: 'USD' },
      trial: { days: 14, requiresPaymentMethod: true },
    });

    expect(offer.trialLine).toBe('Free 14-day trial');
    expect(offer.summary).toBe('Free 14-day trial, then $99/year.');
  });

  it('formats whole-dollar and fractional prices', () => {
    expect(formatPackagePrice(250)).toBe('$250');
    expect(formatPackagePrice(24.5)).toBe('$24.50');
  });

  it('resolves a package from its Freemius product id', () => {
    expect(getPackageByFreemiusId(28609)?.id).toBe('cortex-ai');
    expect(getPackageByFreemiusId('24851')?.id).toBe('ecommerce');
    expect(getPackageByFreemiusId(43273)?.id).toBe('affiliates');
    expect(getPackageByFreemiusId('1')).toBeUndefined();
  });

  it('never resolves an empty product id (a package not on sale yet has fm_product_id "")', () => {
    expect(getPackageByFreemiusId('')).toBeUndefined();
    expect(getPackageByFreemiusId('  ')).toBeUndefined();
  });
});

describe('NextBlock Affiliates & Creator Storefronts', () => {
  const affiliates = NEXTBLOCK_PACKAGES.affiliates;

  it('is registered under the package id the gates check (verifyPackageOnline("affiliates"))', () => {
    expect(affiliates.id).toBe('affiliates');
    expect(getPackageById('affiliates')).toBe(affiliates);
    expect(affiliates.name).toBe('NextBlock Affiliates & Creator Storefronts');
    expect(affiliates.purchase_url).toBe(
      'https://nextblock.dev/product/nextblock-affiliates-creator-storefronts-affiliates-license'
    );
  });

  // 2026-10-29: the Freemius product and plan exist, so the dashboard sells and trials it.
  it('is sold through Freemius product 43273, plan 75655', () => {
    expect(affiliates.fm_product_id).toBe('43273');
    expect(affiliates.fm_plan_id).toBe('75655');
    expect(hasPackageCheckout(affiliates)).toBe(true);
    expect(hasPackageCheckout(NEXTBLOCK_PACKAGES.ecommerce)).toBe(true);
    expect(hasPackageCheckout(NEXTBLOCK_PACKAGES['cortex-ai'])).toBe(true);
    expect(hasPackageCheckout({ fm_product_id: '', fm_plan_id: '' })).toBe(false);
    expect(hasPackageCheckout({ fm_product_id: '123', fm_plan_id: ' ' })).toBe(false);
  });

  it('is priced as a Commerce Pro add-on: $200 a year or $20 a month, $450 a year together', () => {
    expect(describePackageOffer(affiliates)).toEqual({
      badge: '30-day free trial',
      priceLine: '$200/year or $20/month',
      summary: 'Free 30-day trial, no credit card required, then $200/year or $20/month.',
      trialLine: 'Free 30-day trial, no credit card required',
    });
    expect(affiliates.pricing.annual + NEXTBLOCK_PACKAGES.ecommerce.pricing.annual).toBe(450);
  });

  // 2026-10-29: partners earn a share of store sales, so the program cannot run without Commerce.
  it('requires Commerce Pro, and reports it missing until Commerce is active', () => {
    expect(affiliates.requires).toEqual(['ecommerce']);
    expect(missingPackageRequirements(affiliates, () => false)).toEqual([NEXTBLOCK_PACKAGES.ecommerce]);
    expect(missingPackageRequirements(affiliates, (id) => id === 'ecommerce')).toEqual([]);
    expect(missingPackageRequirements(NEXTBLOCK_PACKAGES.ecommerce, () => false)).toEqual([]);
    expect(missingPackageRequirements(NEXTBLOCK_PACKAGES['cortex-ai'], () => false)).toEqual([]);
  });

  it('only requires registered packages, never itself, and never in a cycle', () => {
    const visit = (id: string, trail: string[]): void => {
      const pkg = getPackageById(id);
      expect(pkg, `${trail.join(' -> ')} requires an unknown package ${id}`).toBeDefined();
      for (const required of pkg?.requires ?? []) {
        expect(trail.includes(required), `cycle: ${[...trail, id, required].join(' -> ')}`).toBe(false);
        visit(required, [...trail, id]);
      }
    };
    for (const id of Object.keys(NEXTBLOCK_PACKAGES)) visit(id, []);
  });

  it('keeps every registry entry keyed by its own id', () => {
    for (const [key, pkg] of Object.entries(NEXTBLOCK_PACKAGES)) {
      expect(pkg.id, key).toBe(key);
    }
    expect(Object.keys(NEXTBLOCK_PACKAGES).sort()).toEqual(['affiliates', 'cortex-ai', 'ecommerce']);
  });
});
