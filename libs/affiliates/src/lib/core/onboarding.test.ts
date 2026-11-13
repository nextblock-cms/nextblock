import { describe, expect, it } from 'vitest';

import {
  AFFILIATE_ONBOARDING_STEP_KEYS,
  AFFILIATE_PROFILE_MIN_BIO_LENGTH,
  computeAffiliateOnboardingProgress,
  isAffiliateProfileComplete,
  type AffiliateOnboardingProgressInput,
} from './onboarding';

const BIO = 'I review sustainable kitchen gear and share what really lasts.';

function profile(overrides: Partial<AffiliateOnboardingProgressInput['profile']> = {}): AffiliateOnboardingProgressInput['profile'] {
  return {
    created_at: '2026-10-01T10:00:00Z',
    display_name: 'Jane',
    bio: null,
    profile_completed_at: null,
    payout_configured_at: null,
    stripe_connect_onboarding_complete: false,
    first_published_at: null,
    ...overrides,
  };
}

describe('isAffiliateProfileComplete', () => {
  it('needs a display name and a bio of at least 40 characters after trimming', () => {
    expect(AFFILIATE_PROFILE_MIN_BIO_LENGTH).toBe(40);
    expect(isAffiliateProfileComplete({ display_name: 'Jane', bio: 'x'.repeat(40) })).toBe(true);
    expect(isAffiliateProfileComplete({ display_name: 'Jane', bio: `  ${'x'.repeat(39)}  ` })).toBe(false);
    expect(isAffiliateProfileComplete({ display_name: '   ', bio: BIO })).toBe(false);
    expect(isAffiliateProfileComplete({ display_name: 'Jane', bio: null })).toBe(false);
    expect(isAffiliateProfileComplete({ display_name: null, bio: BIO })).toBe(false);
  });
});

describe('computeAffiliateOnboardingProgress', () => {
  it('starts with the account step done and points at the profile', () => {
    const progress = computeAffiliateOnboardingProgress({ profile: profile(), page: null });

    expect(progress.steps.map((step) => step.key)).toEqual([...AFFILIATE_ONBOARDING_STEP_KEYS]);
    expect(progress.steps[0]).toEqual({ key: 'account', complete: true, completedAt: '2026-10-01T10:00:00Z' });
    expect(progress.completedCount).toBe(1);
    expect(progress.totalCount).toBe(4);
    expect(progress.nextStep).toBe('profile');
  });

  it('reads the lifecycle timestamps, and the live state while a timestamp is pending', () => {
    const progress = computeAffiliateOnboardingProgress({
      profile: profile({ bio: BIO, stripe_connect_onboarding_complete: true }),
      page: { published_at: null },
    });

    expect(progress.steps.find((step) => step.key === 'profile')).toEqual({ key: 'profile', complete: true, completedAt: null });
    expect(progress.steps.find((step) => step.key === 'payouts')).toEqual({ key: 'payouts', complete: true, completedAt: null });
    expect(progress.nextStep).toBe('storefront');
    expect(progress.completedCount).toBe(3);
  });

  it('keeps a completed milestone complete even if the bio is later shortened', () => {
    const progress = computeAffiliateOnboardingProgress({
      profile: profile({ bio: 'short', profile_completed_at: '2026-10-02T00:00:00Z' }),
    });
    expect(progress.steps[1]).toEqual({ key: 'profile', complete: true, completedAt: '2026-10-02T00:00:00Z' });
  });

  it('finishes with the first approval of the storefront', () => {
    const progress = computeAffiliateOnboardingProgress({
      profile: profile({
        bio: BIO,
        profile_completed_at: '2026-10-02T00:00:00Z',
        payout_configured_at: '2026-10-03T00:00:00Z',
        first_published_at: '2026-10-05T00:00:00Z',
      }),
      page: { published_at: '2026-10-09T00:00:00Z' },
    });

    expect(progress.completedCount).toBe(4);
    expect(progress.nextStep).toBeNull();
    expect(progress.steps[3]).toEqual({ key: 'storefront', complete: true, completedAt: '2026-10-05T00:00:00Z' });
  });

  it('falls back to the page publish date when the profile timestamp is missing', () => {
    const progress = computeAffiliateOnboardingProgress({ profile: profile(), page: { published_at: '2026-10-09T00:00:00Z' } });
    expect(progress.steps[3]).toEqual({ key: 'storefront', complete: true, completedAt: '2026-10-09T00:00:00Z' });
  });
});

describe('computeAffiliateOnboardingProgress: the payouts step with manual payouts (02036)', () => {
  const payoutsStep = (input: AffiliateOnboardingProgressInput) =>
    computeAffiliateOnboardingProgress(input).steps.find((step) => step.key === 'payouts');
  const MANUAL_FREEMIUS = { stripeSales: 'stripe_connect', freemiusSales: 'manual' } as const;
  const ALL_MANUAL = { stripeSales: 'manual', freemiusSales: 'manual' } as const;
  const ALL_STRIPE = { stripeSales: 'stripe_connect', freemiusSales: 'stripe_connect' } as const;

  it('is done by a payout email while some gateway is paid by hand, without a timestamp', () => {
    for (const payoutMethods of [MANUAL_FREEMIUS, ALL_MANUAL]) {
      expect(payoutsStep({ profile: profile({ payout_email: 'jane@paypal.example' }), payoutMethods })).toEqual({
        key: 'payouts',
        complete: true,
        completedAt: null,
      });
    }
  });

  it('needs Stripe Connect while every gateway is paid through Stripe, payout email or not', () => {
    for (const payoutMethods of [ALL_STRIPE, null, undefined]) {
      expect(payoutsStep({ profile: profile({ payout_email: 'jane@paypal.example' }), payoutMethods })?.complete).toBe(false);
    }
    expect(payoutsStep({ profile: profile({ stripe_connect_onboarding_complete: true }), payoutMethods: ALL_STRIPE })?.complete).toBe(true);
  });

  it('stays to do on a manual program until a non-blank payout email is saved', () => {
    for (const payout_email of [null, undefined, '', '   ']) {
      expect(payoutsStep({ profile: profile({ payout_email }), payoutMethods: ALL_MANUAL })?.complete).toBe(false);
    }
  });

  it('still counts a finished Stripe Connect setup on a manual program', () => {
    expect(
      payoutsStep({ profile: profile({ payout_configured_at: '2026-10-03T00:00:00Z' }), payoutMethods: ALL_MANUAL }),
    ).toEqual({ key: 'payouts', complete: true, completedAt: '2026-10-03T00:00:00Z' });
    expect(payoutsStep({ profile: profile({ stripe_connect_onboarding_complete: true }), payoutMethods: MANUAL_FREEMIUS })?.complete).toBe(
      true,
    );
  });
});

describe('computeAffiliateOnboardingProgress: the payouts step with PayPal Payouts (02037)', () => {
  const payoutsStep = (input: AffiliateOnboardingProgressInput) =>
    computeAffiliateOnboardingProgress(input).steps.find((step) => step.key === 'payouts');
  const PAYPAL_FREEMIUS = { stripeSales: 'stripe_connect', freemiusSales: 'paypal' } as const;
  const ALL_PAYPAL = { stripeSales: 'paypal', freemiusSales: 'paypal' } as const;
  const PAYPAL_AND_MANUAL = { stripeSales: 'manual', freemiusSales: 'paypal' } as const;

  // A PayPal account or an Interac e-Transfer address alike: the store pays an Interac partner by hand,
  // so what the address is for (payout_email_kind) is not even part of the input.
  it('is done by a payout email while some gateway is paid with PayPal, without a timestamp', () => {
    for (const payoutMethods of [PAYPAL_FREEMIUS, ALL_PAYPAL, PAYPAL_AND_MANUAL]) {
      expect(payoutsStep({ profile: profile({ payout_email: 'jane@example.com' }), payoutMethods })).toEqual({
        key: 'payouts',
        complete: true,
        completedAt: null,
      });
    }
  });

  it('stays to do on a PayPal program until a non-blank payout email is saved', () => {
    for (const payout_email of [null, undefined, '', '   ']) {
      expect(payoutsStep({ profile: profile({ payout_email }), payoutMethods: ALL_PAYPAL })?.complete).toBe(false);
      expect(payoutsStep({ profile: profile({ payout_email }), payoutMethods: PAYPAL_FREEMIUS })?.complete).toBe(false);
    }
  });

  it('is done by Stripe Connect alone too, payout email or not', () => {
    expect(payoutsStep({ profile: profile({ stripe_connect_onboarding_complete: true }), payoutMethods: PAYPAL_FREEMIUS })?.complete).toBe(true);
    expect(
      payoutsStep({ profile: profile({ payout_configured_at: '2026-10-03T00:00:00Z' }), payoutMethods: ALL_PAYPAL }),
    ).toEqual({ key: 'payouts', complete: true, completedAt: '2026-10-03T00:00:00Z' });
  });
});
