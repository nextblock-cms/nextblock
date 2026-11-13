import type { ReactNode } from 'react';
import {
  ArrowRight,
  BadgeCheck,
  Banknote,
  CheckCircle2,
  ChevronDown,
  Clock,
  Info,
  Lock,
  ShieldCheck,
  Sparkles,
  Store,
  Target,
} from 'lucide-react';
import type { AffiliatesCopyTranslate } from '@nextblock-cms/affiliates';
import { AffiliateTierBadge } from '../../../../components/affiliates/public/tier-badge';
import {
  PARTNERS_OUTLINE_LINK_CLASS,
  PARTNERS_PRIMARY_LINK_CLASS,
} from '../../../../components/affiliates/public/link-button-classes';
import { PartnersHeroVisual } from './partners-hero-visual';
import {
  buildPartnersFaq,
  buildPartnersOfferMessage,
  type PartnersLadderTier,
  type PartnersLandingModel,
} from './partners-model';

/**
 * The `/partners` landing page body. A pure server component (no hooks, no client directive):
 * every string comes from the affiliates dictionaries through `t`, every number from the model,
 * and the two interactive parts (calculator, signup) arrive as rendered islands. One h1, then h2
 * sections with h3 items, so the outline never skips a level. The hero's example card animates
 * with CSS only (`partners-hero-visual.tsx`), behind `motion-safe:`.
 */
export interface PartnersLandingViewProps {
  t: AffiliatesCopyTranslate;
  model: PartnersLandingModel;
  /** The revenue calculator island, or null when there is nothing to compare. */
  calculator: ReactNode;
  /** The signup island. */
  signup: ReactNode;
  /**
   * The operator's automatic-payouts switch (program settings). Off, the hero says our team sends
   * the payouts instead of "Payouts come to you". Defaults to on, the settings' own default. No
   * payout line on this page names Stripe: since 02036 a store may pay some commissions by hand.
   */
  autoPayouts?: boolean;
}

const SECTION_CLASS = 'mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:px-8';
const H2_CLASS = 'text-3xl font-bold tracking-tight text-foreground sm:text-4xl';
const INTRO_CLASS = 'mt-3 max-w-2xl text-lg leading-8 text-muted-foreground';
const CARD_CLASS = 'rounded-xl border border-border bg-card p-6 text-card-foreground';
const HIGHLIGHT_CARD_CLASS = 'rounded-xl border-2 border-primary bg-card p-6 text-card-foreground shadow-lg';
const ICON_TILE_CLASS = 'flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary';

/** The closing band's button: the inverse of the primary button, on the primary surface. */
const CTA_BAND_LINK_CLASS =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-background px-6 py-2 text-sm font-semibold text-foreground shadow-sm ring-offset-primary transition-colors hover:bg-background/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-background focus-visible:ring-offset-2 motion-reduce:transition-none';

function tierSpotsText(t: AffiliatesCopyTranslate, tier: PartnersLadderTier): string {
  if (tier.soldOut) return t('affiliates.common.tier_sold_out');
  if (tier.spotsRemaining === null) return t('affiliates.common.tier_unlimited_spots');
  if (tier.spotsRemaining === 1) return t('affiliates.common.tier_spots_remaining_one');
  return t('affiliates.common.tier_spots_remaining_other', { count: tier.spotsRemaining });
}

function HeroBadge({ t, model }: { t: AffiliatesCopyTranslate; model: PartnersLandingModel }) {
  // Signups paused (no tier with room): no "now open" claim, just the program's name.
  if (!model.signupOpen) {
    return (
      <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t('affiliates.partners.hero_eyebrow')}</p>
    );
  }
  if (model.offer) {
    return (
      <p className="inline-flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-sm font-semibold text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-50">
        {/* Three pulses, then a still dot: motion that starts by itself stops within 5 s (WCAG 2.2.2). */}
        <span aria-hidden="true" className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-75 motion-safe:[animation:ping_1s_cubic-bezier(0,0,0.2,1)_3]" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
        </span>
        {t('affiliates.partners.offer_eyebrow')}
      </p>
    );
  }
  return (
    // text-foreground on the primary tint (text-primary there drops under 4.5:1 in dark themes).
    <p className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-sm font-semibold text-foreground">
      <Sparkles aria-hidden="true" className="h-4 w-4 text-primary" />
      {t('affiliates.partners.hero_badge_open')}
    </p>
  );
}

function TierTrack({ model, t }: { model: PartnersLandingModel; t: AffiliatesCopyTranslate }) {
  const track = model.track;
  if (!track) return null;
  const text =
    track.kind === 'offer'
      ? t('affiliates.partners.ladder_track_offer', { tier: track.tierName, rate: track.rateLabel })
      : t('affiliates.partners.ladder_track_standard', { tier: track.tierName, rate: track.rateLabel });

  return (
    <>
      {/* A decorative "slider" locked on the offered tier; the sentence below says the same in text. */}
      <div aria-hidden="true" className="mt-12 hidden px-5 sm:block">
        <div className="flex items-center gap-1.5">
          {model.tiers.map((tier, index) => (
            <div
              key={tier.id}
              className={index <= track.index ? 'relative h-2 flex-1 rounded-full bg-primary' : 'relative h-2 flex-1 rounded-full bg-muted'}
            >
              {index === track.index ? (
                <span className="absolute left-1/2 top-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-primary bg-background text-foreground shadow-md">
                  <Lock className="h-4 w-4" />
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <p className="sr-only">{text}</p>
    </>
  );
}

function TierCard({
  tier,
  t,
  highlighted,
  locale,
}: {
  tier: PartnersLadderTier;
  t: AffiliatesCopyTranslate;
  highlighted: boolean;
  locale: string;
}) {
  return (
    <li className={`flex flex-col ${highlighted ? HIGHLIGHT_CARD_CLASS : CARD_CLASS}`}>
      <h3 className="text-lg font-semibold text-foreground">{tier.name}</h3>
      <p className="mt-2 text-3xl font-bold tracking-tight text-foreground">
        {t('affiliates.common.tier_commission_rate', { rate: tier.rateLabel })}
      </p>
      <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
        <li className="flex items-center gap-2">
          <Clock aria-hidden="true" className="h-4 w-4 shrink-0" />
          {t('affiliates.partners.ladder_cookie', { days: tier.cookieDays })}
        </li>
        <li className="flex items-center gap-2">
          <BadgeCheck aria-hidden="true" className="h-4 w-4 shrink-0" />
          {tierSpotsText(t, tier)}
        </li>
      </ul>
      {tier.isLimitedTimePromo && !tier.soldOut ? (
        <p className="mt-4">
          <AffiliateTierBadge color={tier.badgeColor}>{t('affiliates.common.tier_limited_time')}</AffiliateTierBadge>
        </p>
      ) : null}
      {tier.isSignupTier ? (
        <p className="mt-4 text-sm font-semibold text-foreground">{t('affiliates.partners.ladder_offer_label')}</p>
      ) : null}
      {tier.goal ? (
        <div className="mt-auto pt-5">
          <div className="rounded-lg border border-dashed border-border bg-muted/50 p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground">
              <Target aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              {t('affiliates.partners.ladder_goal_label')}
            </p>
            {/* An English goal shown as the fallback on a French page says so (WCAG 3.1.2). */}
            <p lang={tier.goalLanguage && tier.goalLanguage !== locale ? tier.goalLanguage : undefined} className="mt-1 text-sm leading-6 text-foreground">
              {tier.goal}
            </p>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function PartnersLandingView({ t, model, calculator, signup, autoPayouts = true }: PartnersLandingViewProps) {
  const offerMessage = buildPartnersOfferMessage(t, model.offer);
  const faq = buildPartnersFaq(t, model);
  const headline = model.headlineRateLabel
    ? t('affiliates.partners.hero_title', { rate: model.headlineRateLabel })
    : t('affiliates.partners.hero_title_no_rate');
  const highlightedTierId =
    model.tiers.find((tier) => tier.isOffer)?.id ?? model.tiers.find((tier) => tier.isSignupTier)?.id ?? null;
  const heroExample = model.heroExample;
  const calculatorIntro =
    model.calculator && model.calculator.products.length > 0
      ? t('affiliates.partners.calculator_intro_products')
      : t('affiliates.partners.calculator_intro_monthly');
  // The closing band names a rate only as honestly as the hero does: the launch offer's rate is what
  // a signup gets; without an offer the best reachable rate is an "up to", like the h1.
  const ctaTitle = model.offer
    ? t('affiliates.partners.cta_title', { rate: model.offer.rateLabel })
    : model.headlineRateLabel
      ? t('affiliates.partners.cta_title_up_to', { rate: model.headlineRateLabel })
      : t('affiliates.partners.cta_title_no_rate');
  const ctaBody = model.offer
    ? model.offer.spotsRemaining === null
      ? t('affiliates.partners.cta_body_offer_unlimited', { tier: model.offer.tierName })
      : t('affiliates.partners.cta_body_offer', { tier: model.offer.tierName })
    : t('affiliates.partners.cta_body');

  const heroPoints = [
    t('affiliates.partners.hero_point_free'),
    t('affiliates.partners.hero_point_no_fees'),
    autoPayouts ? t('affiliates.partners.benefit_payouts_title') : t('affiliates.partners.hero_point_payouts_stripe'),
  ];

  const steps = [
    { title: t('affiliates.partners.how_step_account_title'), body: t('affiliates.partners.how_step_account_body') },
    { title: t('affiliates.partners.how_step_profile_title'), body: t('affiliates.partners.how_step_profile_body') },
    { title: t('affiliates.partners.how_step_payouts_title'), body: t('affiliates.partners.how_step_payouts_body') },
    { title: t('affiliates.partners.how_step_storefront_title'), body: t('affiliates.partners.how_step_storefront_body') },
  ];

  const benefits = [
    {
      Icon: Clock,
      title: t('affiliates.partners.benefit_cookie_title', { days: model.cookieDays }),
      body: t('affiliates.partners.benefit_cookie_body', { days: model.cookieDays }),
    },
    {
      Icon: ShieldCheck,
      title: t('affiliates.partners.benefit_refund_title'),
      body: t('affiliates.partners.benefit_refund_body', { days: model.clearanceDays }),
    },
    { Icon: Banknote, title: t('affiliates.partners.benefit_payouts_title'), body: t('affiliates.partners.benefit_payouts_body') },
    { Icon: Store, title: t('affiliates.partners.benefit_storefront_title'), body: t('affiliates.partners.benefit_storefront_body') },
    { Icon: Sparkles, title: t('affiliates.partners.benefit_copilot_title'), body: t('affiliates.partners.benefit_copilot_body') },
    { Icon: BadgeCheck, title: t('affiliates.partners.benefit_approval_title'), body: t('affiliates.partners.benefit_approval_body') },
  ];

  return (
    // The copy's language on the page itself: it can differ from <html lang> (a site language the
    // partner copy does not cover, or a client-side navigation to /partenaires from an English page).
    <div lang={model.locale} className="w-full">
      <section aria-labelledby="partners-hero-title" className="relative isolate overflow-hidden border-b border-border bg-background">
        {/* Decorative backdrop: a dotted grid fading out and a soft primary glow (gradients only). */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_80%_70%_at_50%_0%,black,transparent)]"
        />
        {/* From lg up only: below that it would sit under the subtitle and tint it under 4.5:1. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-40 -top-40 -z-10 hidden h-[40rem] w-[40rem] rounded-full bg-radial from-primary/15 to-transparent to-70% lg:block"
        />
        {/* grid-cols-1 is minmax(0, 1fr): an auto track would grow to the card's longest unbroken line (its truncated product rows) and push the page sideways on a phone. */}
        <div
          className={`mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-12 px-4 py-16 sm:px-6 lg:px-8 lg:py-24 ${heroExample ? 'lg:grid-cols-2' : ''}`}
        >
          <div className="min-w-0">
            <HeroBadge t={t} model={model} />
            <h1
              id="partners-hero-title"
              className="mt-5 max-w-4xl text-4xl font-bold tracking-tight text-foreground sm:text-5xl lg:text-6xl"
            >
              {headline}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">{t('affiliates.partners.hero_subtitle')}</p>
            {offerMessage ? (
              <p className="mt-6 max-w-2xl rounded-xl border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 px-4 py-3 text-base font-semibold text-amber-950 dark:border-amber-800 dark:border-l-amber-500 dark:bg-amber-950 dark:text-amber-50">
                {offerMessage}
              </p>
            ) : null}
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a href="#signup" className={PARTNERS_PRIMARY_LINK_CLASS}>
                {t('affiliates.partners.hero_cta_signup')}
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </a>
              <a href="#how-it-works" className={PARTNERS_OUTLINE_LINK_CLASS}>
                {t('affiliates.partners.hero_cta_how')}
              </a>
            </div>
            <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
              {heroPoints.map((point) => (
                <li key={point} className="flex items-center gap-2">
                  <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  {point}
                </li>
              ))}
            </ul>
          </div>
          {heroExample ? <PartnersHeroVisual t={t} example={heroExample} offer={model.offer} locale={model.locale} /> : null}
        </div>
      </section>

      <section id="tiers" aria-labelledby="partners-tiers-title" className={SECTION_CLASS}>
        <h2 id="partners-tiers-title" className={H2_CLASS}>
          {t('affiliates.partners.ladder_title')}
        </h2>
        <p className={INTRO_CLASS}>{t('affiliates.partners.ladder_intro')}</p>
        {model.tiers.length === 0 ? (
          <p className="mt-8 text-foreground">{t('affiliates.partners.ladder_empty')}</p>
        ) : (
          <>
            <TierTrack model={model} t={t} />
            <ol className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {model.tiers.map((tier) => (
                <TierCard key={tier.id} tier={tier} t={t} highlighted={tier.id === highlightedTierId} locale={model.locale} />
              ))}
            </ol>
            {model.hasTierGoals ? (
              <p className="mt-6 flex max-w-3xl items-start gap-2 text-sm leading-6 text-muted-foreground">
                <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                {t('affiliates.partners.ladder_goal_note')}
              </p>
            ) : null}
          </>
        )}
      </section>

      {calculator ? (
        <section id="calculator" aria-labelledby="partners-calculator-title" className="border-y border-border bg-muted/30">
          <div className={SECTION_CLASS}>
            <h2 id="partners-calculator-title" className={H2_CLASS}>
              {t('affiliates.partners.calculator_title')}
            </h2>
            <p className={INTRO_CLASS}>{calculatorIntro}</p>
            <div className="mt-10">{calculator}</div>
          </div>
        </section>
      ) : null}

      <section id="how-it-works" aria-labelledby="partners-how-title" className={`${SECTION_CLASS} scroll-mt-24`}>
        <h2 id="partners-how-title" className={H2_CLASS}>
          {t('affiliates.partners.how_title')}
        </h2>
        <p className={INTRO_CLASS}>{t('affiliates.partners.how_intro')}</p>
        <ol className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {steps.map((step, index) => (
            <li key={step.title} className={CARD_CLASS}>
              <span
                aria-hidden="true"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-base font-bold text-primary-foreground shadow-sm"
              >
                {index + 1}
              </span>
              <p className="mt-4 text-sm font-semibold text-muted-foreground">
                {t('affiliates.partners.how_step_label', { number: index + 1 })}
              </p>
              <h3 className="mt-1 text-lg font-semibold text-foreground">{step.title}</h3>
              <p className="mt-2 leading-7 text-muted-foreground">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="partners-benefits-title" className="border-y border-border bg-muted/30">
        <div className={SECTION_CLASS}>
          <h2 id="partners-benefits-title" className={H2_CLASS}>
            {t('affiliates.partners.benefits_title')}
          </h2>
          <ul className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {benefits.map(({ Icon, title, body }) => (
              <li key={title} className={CARD_CLASS}>
                <span aria-hidden="true" className={ICON_TILE_CLASS}>
                  <Icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-lg font-semibold text-foreground">{title}</h3>
                <p className="mt-2 leading-7 text-muted-foreground">{body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Only while signups are open: a full program has nothing to join. */}
      {model.signupOpen ? (
        <section aria-labelledby="partners-cta-title" className="px-4 pt-16 sm:px-6 lg:px-8">
          <div className="relative isolate mx-auto w-full max-w-6xl overflow-hidden rounded-3xl bg-primary px-6 py-12 text-primary-foreground shadow-xl sm:px-12 sm:py-14">
            {/* From lg up only, behind the button column: under the body text it lowers contrast. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-24 -top-24 -z-10 hidden h-96 w-96 rounded-full bg-radial from-primary-foreground/20 to-transparent to-70% lg:block"
            />
            <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-3">
              <div className="min-w-0 lg:col-span-2">
                <h2 id="partners-cta-title" className="mt-0 text-3xl font-bold tracking-tight sm:text-4xl">
                  {ctaTitle}
                </h2>
                <p className="mt-3 max-w-2xl text-lg leading-8">{ctaBody}</p>
              </div>
              <div className="lg:justify-self-end">
                <a href="#signup" className={CTA_BAND_LINK_CLASS}>
                  {t('affiliates.partners.hero_cta_signup')}
                  <ArrowRight aria-hidden="true" className="h-4 w-4" />
                </a>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="partners-faq-title" className={SECTION_CLASS}>
        <h2 id="partners-faq-title" className={H2_CLASS}>
          {t('affiliates.partners.faq_title')}
        </h2>
        <div className="mt-8 max-w-3xl space-y-3">
          {faq.map((item) => (
            <details key={item.question} className="group rounded-xl border border-border bg-card p-5 text-card-foreground">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-sm text-base font-semibold text-foreground ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
                <span>{item.question}</span>
                <ChevronDown aria-hidden="true" className="h-5 w-5 shrink-0 group-open:rotate-180 motion-safe:transition-transform" />
              </summary>
              <p className="mt-3 leading-7 text-muted-foreground">{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section id="signup" aria-labelledby="partners-signup-title" className="scroll-mt-24 border-t border-border bg-background">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-5 lg:px-8">
          <div className="lg:col-span-2">
            <h2 id="partners-signup-title" className={H2_CLASS}>
              {t('affiliates.partners.signup_title')}
            </h2>
            <p className={INTRO_CLASS}>{t('affiliates.partners.signup_intro')}</p>
            {model.signupTier ? (
              <p className="mt-4 font-semibold text-foreground">
                {t('affiliates.partners.signup_tier_note', { tier: model.signupTier.name, rate: model.signupTier.rateLabel })}
              </p>
            ) : null}
          </div>
          <div className="lg:col-span-3">{signup}</div>
        </div>
      </section>
    </div>
  );
}
