import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  AFFILIATE_ONBOARDING_STEP_KEYS,
  createAffiliatesCopy,
  type AffiliateLocale,
  type AffiliateOnboardingProgress,
  type AffiliateOnboardingStepKey,
} from '@nextblock-cms/affiliates';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode; prefetch?: boolean }) => <a href={href}>{children}</a>,
}));

import { OnboardingSteps } from './OnboardingSteps';
import { PORTAL_UI_COPY } from './portal-copy';

function progress(done: readonly AffiliateOnboardingStepKey[]): AffiliateOnboardingProgress {
  const steps = AFFILIATE_ONBOARDING_STEP_KEYS.map((key) => ({ key, complete: done.includes(key), completedAt: null }));
  return {
    steps,
    completedCount: steps.filter((step) => step.complete).length,
    totalCount: 4,
    nextStep: steps.find((step) => !step.complete)?.key ?? null,
  };
}

function render(locale: AffiliateLocale, done: readonly AffiliateOnboardingStepKey[]) {
  const t = createAffiliatesCopy({ locale, dictionary: PORTAL_UI_COPY });
  return renderToStaticMarkup(<OnboardingSteps progress={progress(done)} t={t} />);
}

describe('OnboardingSteps progress counter', () => {
  it('reads in the French singular for a new partner (only the account step is done)', () => {
    const html = render('fr', ['account']);
    expect(html).toContain('1 étape sur 4 terminée');
    expect(html).not.toContain('1 étapes');
  });

  it('reads in the French plural from two steps on', () => {
    expect(render('fr', ['account', 'profile'])).toContain('2 étapes sur 4 terminées');
    expect(render('fr', ['account', 'profile', 'payouts', 'storefront'])).toContain('4 étapes sur 4 terminées');
  });

  it('reads the same in English for any count', () => {
    expect(render('en', ['account'])).toContain('1 of 4 steps complete');
    expect(render('en', ['account', 'profile', 'payouts'])).toContain('3 of 4 steps complete');
  });
});
