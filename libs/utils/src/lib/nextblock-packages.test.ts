import { describe, expect, it } from 'vitest';

import {
  NEXTBLOCK_PACKAGES,
  describePackageOffer,
  formatPackagePrice,
  getPackageByFreemiusId,
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
    expect(getPackageByFreemiusId('1')).toBeUndefined();
  });
});
