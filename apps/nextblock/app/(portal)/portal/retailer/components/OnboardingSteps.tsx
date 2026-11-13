import Link from 'next/link';
import { Check } from 'lucide-react';
import { cn } from '@nextblock-cms/utils';
import {
  AFFILIATE_ONBOARDING_STEP_COPY_KEYS,
  AFFILIATE_PORTAL_PAYOUTS_PATH,
  AFFILIATE_PORTAL_STOREFRONT_PATH,
  type AffiliateOnboardingProgress,
  type AffiliateOnboardingStepKey,
} from '@nextblock-cms/affiliates';

import type { PortalCopyKey, PortalTranslate } from './portal-copy';

/** Bar width per completed step (literal classes: Tailwind only generates what it finds verbatim). */
const PROGRESS_WIDTH_CLASSES = ['w-0', 'w-1/4', 'w-1/2', 'w-3/4', 'w-full'] as const;

const STEP_ACTIONS: Partial<Record<AffiliateOnboardingStepKey, { href: string; label: PortalCopyKey }>> = {
  profile: { href: `${AFFILIATE_PORTAL_STOREFRONT_PATH}#profile`, label: 'affiliates.portal.progress_action_profile' },
  payouts: { href: AFFILIATE_PORTAL_PAYOUTS_PATH, label: 'affiliates.portal.progress_action_payouts' },
  storefront: { href: AFFILIATE_PORTAL_STOREFRONT_PATH, label: 'affiliates.portal.progress_action_storefront' },
};

/**
 * The four-step onboarding tracker: an ordered list (the current step is `aria-current="step"`)
 * whose every step states its status in words; the bar above it is decorative.
 */
export function OnboardingSteps({
  progress,
  t,
  headingId = 'portal-onboarding-heading',
}: {
  progress: AffiliateOnboardingProgress;
  t: PortalTranslate;
  headingId?: string;
}) {
  const completed = Math.min(Math.max(progress.completedCount, 0), 4);
  // French counts 0 and 1 as singular ("1 étape sur 4 terminée"); the English strings are the same.
  const progressKey: PortalCopyKey =
    completed <= 1 ? 'affiliates.common.onboarding_progress_one' : 'affiliates.common.onboarding_progress_other';

  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-border bg-card p-6 text-card-foreground">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-lg font-semibold">
          {t('affiliates.portal.progress_title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(progressKey, { completed, total: progress.totalCount })}
        </p>
      </div>
      <div aria-hidden="true" className="mt-4 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn('h-2 rounded-full bg-primary', PROGRESS_WIDTH_CLASSES[completed])} />
      </div>

      <ol className="mt-6 grid gap-4 md:grid-cols-4">
        {progress.steps.map((step, index) => {
          const current = progress.nextStep === step.key;
          const action = step.complete ? undefined : STEP_ACTIONS[step.key];
          return (
            <li
              key={step.key}
              aria-current={current ? 'step' : undefined}
              className={cn(
                'flex gap-3 rounded-md border p-3',
                current ? 'border-primary bg-background' : 'border-border bg-background',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
                  step.complete ? 'bg-primary text-primary-foreground' : 'border border-border bg-card text-foreground',
                )}
              >
                {step.complete ? <Check className="h-4 w-4" /> : index + 1}
              </span>
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium text-foreground">{t(AFFILIATE_ONBOARDING_STEP_COPY_KEYS[step.key])}</p>
                <p className="text-sm text-muted-foreground">
                  {step.complete
                    ? t('affiliates.common.step_done')
                    : current
                      ? t('affiliates.portal.progress_next_step')
                      : t('affiliates.common.step_to_do')}
                </p>
                {action ? (
                  <Link
                    href={action.href}
                    prefetch={false}
                    className="inline-block rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    {t(action.label)}
                  </Link>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
