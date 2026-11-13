'use client';

import { usePortalCopy } from './use-portal-copy';

const PORTAL_LOADING_STATS = [0, 1, 2, 3] as const;

/**
 * The content-area skeleton `retailer/loading.tsx` shows while a portal page renders: a title,
 * four stat cards and a panel, the shape every portal page opens with. The layout above it (header,
 * nav, the copy provider) stays on screen. One status line is read out; the blocks are hidden from
 * assistive technology and only pulse when the visitor allows motion.
 */
export function PortalLoading() {
  const { t } = usePortalCopy();

  return (
    <div role="status" className="space-y-8">
      <span className="sr-only">{t('affiliates.common.loading')}</span>
      <div aria-hidden="true" className="space-y-8 motion-safe:animate-pulse">
        <div className="space-y-3">
          <div className="h-9 w-2/3 max-w-sm rounded-md bg-muted" />
          <div className="h-4 w-full max-w-md rounded bg-muted" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PORTAL_LOADING_STATS.map((index) => (
            <div key={index} className="h-24 rounded-lg border border-border bg-muted/60" />
          ))}
        </div>
        <div className="h-48 rounded-lg border border-border bg-muted/40" />
      </div>
    </div>
  );
}
