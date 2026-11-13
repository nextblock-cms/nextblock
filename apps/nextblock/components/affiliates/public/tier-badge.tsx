import type { ReactNode } from 'react';
import type { AffiliateBadgeColor } from '@nextblock-cms/affiliates';

/**
 * A partner tier badge. Pure (no hooks, no client directive): renders in server components and
 * client islands alike. One literal class string per `affiliate_tiers.badge_color` value (Tailwind
 * only generates utilities it finds verbatim in the source), each a 900-on-100 / 100-on-950 pair so
 * the label stays well above 4.5:1 in light and dark themes.
 */
export const AFFILIATE_TIER_BADGE_CLASSES: Readonly<Record<AffiliateBadgeColor, string>> = {
  violet: 'border-violet-200 bg-violet-100 text-violet-900 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-100',
  indigo: 'border-indigo-200 bg-indigo-100 text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-100',
  blue: 'border-blue-200 bg-blue-100 text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100',
  sky: 'border-sky-200 bg-sky-100 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100',
  emerald: 'border-emerald-200 bg-emerald-100 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100',
  amber: 'border-amber-200 bg-amber-100 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100',
  orange: 'border-orange-200 bg-orange-100 text-orange-900 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-100',
  rose: 'border-rose-200 bg-rose-100 text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100',
  slate: 'border-slate-200 bg-slate-100 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100',
};

const BADGE_BASE_CLASS = 'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold';

export interface AffiliateTierBadgeProps {
  color: AffiliateBadgeColor;
  children: ReactNode;
  /** A visually hidden prefix for screen readers ("Partner tier"). */
  srLabel?: string;
}

export function AffiliateTierBadge({ color, children, srLabel }: AffiliateTierBadgeProps) {
  const colorClass = AFFILIATE_TIER_BADGE_CLASSES[color] ?? AFFILIATE_TIER_BADGE_CLASSES.violet;
  return (
    <span className={`${BADGE_BASE_CLASS} ${colorClass}`}>
      {srLabel ? <span className="sr-only">{`${srLabel}: `}</span> : null}
      {children}
    </span>
  );
}
