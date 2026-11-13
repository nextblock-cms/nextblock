import type { AffiliatesCopyTranslate } from '@nextblock-cms/affiliates';
import { formatPartnersMoney, formatPartnersWholeMoney } from '../../../../components/affiliates/public/partners-money';
import type { PartnersHeroExample, PartnersHeroSale, PartnersLandingModel, PartnersOffer } from './partners-model';

/**
 * The hero's "example month" card: the monthly income the calculator starts from, rolled in like an
 * odometer, six months of growth as bars, and a short example ledger (pending, cleared, paid) built
 * from the store's own products and commissions.
 *
 * Server-rendered and animated with CSS only (tailwindcss-animate's `animate-in`), so it shows its
 * final state with JavaScript off, never flashes on hydration, and costs no client bundle. Every
 * animation sits behind `motion-safe:`: with reduced motion nothing moves and nothing waits on a
 * delay. The figures are an illustration, and the card says so; the amount is also given as text
 * for screen readers (the rolling digits are hidden from them).
 *
 * Tailwind only generates classes it finds verbatim, so every per-digit, per-bar and per-row class
 * below is a literal string.
 */

/**
 * Each digit's reel holds 0–9 twice and stops on the second run, so every digit spins. The reel
 * digits are drawn by CSS (`content: attr(data-digit)`), not written as text: the page's text (what
 * crawlers and the SEO grade read) holds the amount once, never twenty digits per reel.
 */
const REEL_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Final position of a reel showing digit `d` (cell `10 + d`). */
const REEL_STOP_CLASS = [
  '-translate-y-[10em]',
  '-translate-y-[11em]',
  '-translate-y-[12em]',
  '-translate-y-[13em]',
  '-translate-y-[14em]',
  '-translate-y-[15em]',
  '-translate-y-[16em]',
  '-translate-y-[17em]',
  '-translate-y-[18em]',
  '-translate-y-[19em]',
];

/** Where the reel starts: offset back to cell 0. */
const REEL_START_CLASS = [
  'motion-safe:slide-in-from-bottom-[10em]',
  'motion-safe:slide-in-from-bottom-[11em]',
  'motion-safe:slide-in-from-bottom-[12em]',
  'motion-safe:slide-in-from-bottom-[13em]',
  'motion-safe:slide-in-from-bottom-[14em]',
  'motion-safe:slide-in-from-bottom-[15em]',
  'motion-safe:slide-in-from-bottom-[16em]',
  'motion-safe:slide-in-from-bottom-[17em]',
  'motion-safe:slide-in-from-bottom-[18em]',
  'motion-safe:slide-in-from-bottom-[19em]',
];

/** Left to right, each reel lands a little later than the one before. */
const REEL_DELAY_CLASS = [
  'motion-safe:delay-[150ms]',
  'motion-safe:delay-[230ms]',
  'motion-safe:delay-[310ms]',
  'motion-safe:delay-[390ms]',
  'motion-safe:delay-[470ms]',
  'motion-safe:delay-[550ms]',
  'motion-safe:delay-[630ms]',
  'motion-safe:delay-[710ms]',
  'motion-safe:delay-[790ms]',
  'motion-safe:delay-[870ms]',
];

const REEL_MOTION_CLASS =
  'motion-safe:animate-in motion-safe:duration-[1600ms] motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)] motion-safe:fill-mode-both';

/** Six months of growth toward the example month (the last bar). */
const BAR_HEIGHT_CLASS = ['h-[22%]', 'h-[34%]', 'h-[47%]', 'h-[61%]', 'h-[78%]', 'h-full'];

const BAR_DELAY_CLASS = [
  'motion-safe:delay-[200ms]',
  'motion-safe:delay-[300ms]',
  'motion-safe:delay-[400ms]',
  'motion-safe:delay-[500ms]',
  'motion-safe:delay-[600ms]',
  'motion-safe:delay-[700ms]',
];

const BAR_MOTION_CLASS =
  'motion-safe:animate-in motion-safe:slide-in-from-bottom-full motion-safe:duration-700 motion-safe:ease-out motion-safe:fill-mode-both';

const ROW_DELAY_CLASS = ['motion-safe:delay-[1000ms]', 'motion-safe:delay-[1250ms]', 'motion-safe:delay-[1500ms]'];

const ROW_MOTION_CLASS =
  'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4 motion-safe:duration-500 motion-safe:ease-out motion-safe:fill-mode-both';

const CARD_MOTION_CLASS =
  'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-700 motion-safe:ease-out motion-safe:fill-mode-both';

/** 900-on-100 / 100-on-950 pairs, as the tier badges: well above 4.5:1 in both themes. */
const STATUS_CLASS: Readonly<Record<PartnersHeroSale['status'], string>> = {
  pending_clearance: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
  cleared: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-100',
  paid: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
};

const STATUS_KEY: Readonly<Record<PartnersHeroSale['status'], string>> = {
  pending_clearance: 'affiliates.common.commission_status_pending_clearance',
  cleared: 'affiliates.common.commission_status_cleared',
  paid: 'affiliates.common.commission_status_paid',
};

/**
 * The amount as rolling digit reels; separators and the currency sign stay put (as text). Hidden
 * from assistive technology: the amount is also given as text next to it.
 */
function RollingAmount({ text }: { text: string }) {
  let digitIndex = 0;
  return (
    <span aria-hidden="true" className="inline-flex items-start whitespace-pre leading-none">
      {Array.from(text).map((character, index) => {
        if (!/^[0-9]$/.test(character)) {
          return (
            <span key={index} className="inline-block leading-none">
              {character}
            </span>
          );
        }
        const digit = Number(character);
        const delay = REEL_DELAY_CLASS[Math.min(digitIndex, REEL_DELAY_CLASS.length - 1)];
        digitIndex += 1;
        return (
          <span key={index} className="relative inline-block h-[1em] overflow-hidden leading-none">
            <span className={`flex flex-col ${REEL_STOP_CLASS[digit]} ${REEL_MOTION_CLASS} ${REEL_START_CLASS[digit]} ${delay}`}>
              {REEL_DIGITS.map((reelDigit, cell) => (
                <span key={cell} data-digit={reelDigit} className="block h-[1em] text-center leading-none before:content-[attr(data-digit)]" />
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function SpotsMeter({ t, offer }: { t: AffiliatesCopyTranslate; offer: PartnersOffer }) {
  if (offer.spotsTotal === null || offer.spotsTotal <= 0 || offer.spotsRemaining === null) return null;
  const taken = Math.min(offer.spotsTotal, Math.max(0, offer.spotsTotal - offer.spotsRemaining));
  const label = t(taken <= 1 ? 'affiliates.partners.hero_spots_taken_one' : 'affiliates.partners.hero_spots_taken', {
    taken,
    cap: offer.spotsTotal,
  });
  return (
    <div className="mt-5 border-t border-border pt-4">
      {/* Seen, not read: the progress element below carries the same words as its name. */}
      <div aria-hidden="true" className="flex items-center justify-between gap-3 text-xs font-medium">
        <span className="text-foreground">{offer.tierName}</span>
        <span className="tabular-nums text-muted-foreground">{label}</span>
      </div>
      {/* A native meter: no inline style, and the label is its accessible name. */}
      <progress
        value={taken}
        max={offer.spotsTotal}
        aria-label={`${offer.tierName}: ${label}`}
        className="mt-2 block h-2 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-amber-500 [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-amber-500"
      />
    </div>
  );
}

export interface PartnersHeroVisualProps {
  t: AffiliatesCopyTranslate;
  example: PartnersHeroExample;
  offer: PartnersLandingModel['offer'];
  locale: PartnersLandingModel['locale'];
}

export function PartnersHeroVisual({ t, example, offer, locale }: PartnersHeroVisualProps) {
  const monthlyText = formatPartnersWholeMoney(example.monthlyMinor, example.currency, locale);
  const priceText = formatPartnersWholeMoney(example.orderValueMinor, example.currency, locale);
  const lastIndex = BAR_HEIGHT_CLASS.length - 1;

  return (
    // A figure (an illustration with its caption), not an aside: the page's only aside is the
    // sandbox guide card (partners-route.test.tsx).
    <figure aria-labelledby="partners-hero-example-title" className="relative m-0 min-w-0">
      {/* A soft glow behind the card: a gradient, no blur filter (hero compositing cost, docs/05).
          From lg up only, where nothing but the card covers it. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-10 -z-10 hidden rounded-full bg-radial from-primary/20 via-primary/5 to-transparent to-70% lg:block"
      />
      <div
        className={`relative rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl ring-1 ring-foreground/5 sm:p-8 ${CARD_MOTION_CLASS}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* The figure's name (aria-labelledby): a figcaption must be the figure's first or last child. */}
          <p id="partners-hero-example-title" className="text-sm font-semibold text-foreground">
            {t('affiliates.partners.hero_visual_title')}
          </p>
          {/* text-foreground on the primary tint: text-primary there drops under 4.5:1 in dark themes. */}
          <p className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-foreground">
            {t('affiliates.partners.hero_visual_rate', { rate: example.rateLabel })}
          </p>
        </div>

        <p className="mt-5 flex flex-wrap items-baseline gap-x-2 text-foreground">
          <span className="text-5xl font-bold tracking-tight tabular-nums sm:text-6xl">
            <RollingAmount text={monthlyText} />
          </span>
          <span aria-hidden="true" className="text-base font-medium text-muted-foreground">
            {t('affiliates.partners.hero_visual_per_month')}
          </span>
          <span className="sr-only">{t('affiliates.partners.hero_visual_amount', { amount: monthlyText })}</span>
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('affiliates.partners.hero_visual_formula', { sales: example.sales, price: priceText })}
        </p>

        <div aria-hidden="true" className="mt-6">
          <div className="flex h-28 items-end gap-2 sm:gap-3">
            {BAR_HEIGHT_CLASS.map((height, index) => (
              <div key={height} className="flex h-full flex-1 items-end overflow-hidden rounded-t-md">
                <div
                  className={`w-full rounded-t-md ${height} ${index === lastIndex ? 'bg-primary' : 'bg-primary/25'} ${BAR_MOTION_CLASS} ${BAR_DELAY_CLASS[index]}`}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>{t('affiliates.partners.hero_visual_chart')}</span>
            <span className="font-semibold tabular-nums text-foreground">{monthlyText}</span>
          </div>
        </div>

        <ul aria-hidden="true" className="mt-6 space-y-2">
          {example.saleRows.map((row, index) => (
            <li
              key={`${row.status}-${index}`}
              // Stacked on phones (the French status chips are long), one line from sm up.
              className={`flex flex-col items-start gap-1 rounded-lg border border-border bg-background px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3 ${ROW_MOTION_CLASS} ${ROW_DELAY_CLASS[index] ?? ''}`}
            >
              <span className="w-full min-w-0 truncate text-sm font-medium text-foreground sm:w-auto">
                {row.title ?? t('affiliates.partners.hero_visual_sale_generic')}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-sm font-semibold tabular-nums text-emerald-700 dark:text-emerald-400 [.vibrant_&]:text-emerald-400">
                  {`+${formatPartnersMoney(row.commissionMinor, example.currency, locale)}`}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_CLASS[row.status]}`}>
                  {t(STATUS_KEY[row.status])}
                </span>
              </span>
            </li>
          ))}
        </ul>

        {offer ? <SpotsMeter t={t} offer={offer} /> : null}

        <p className="mt-4 text-xs text-muted-foreground">{t('affiliates.partners.hero_visual_note')}</p>
      </div>
    </figure>
  );
}
