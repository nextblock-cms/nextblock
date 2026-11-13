import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

/** A headline number of the affiliates overview (server component: no hooks, no client code). */
export function AffiliateMetricTile({
  label,
  value,
  hint,
  icon,
  footer,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <span className="text-muted-foreground" aria-hidden="true">
          {icon}
        </span>
      </div>
      <p className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {footer}
    </div>
  );
}

/** Shown instead of a screen whose reads failed (for example before migration 02030 is applied). */
export function AffiliateLoadErrorCard({ what }: { what: string }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-red-300 bg-red-50 p-4 text-red-900 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="space-y-1 text-sm">
        <p className="font-medium">The {what} could not be loaded.</p>
        <p>
          Reload the page in a moment. If it keeps failing, check that the affiliates migrations (02029 and 02030) are applied
          to this database and that the server logs show no Supabase errors.
        </p>
      </div>
    </div>
  );
}

/** Page heading of an affiliates screen (the CMS header already holds the page's h1). */
export function AffiliatePageHeading({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
