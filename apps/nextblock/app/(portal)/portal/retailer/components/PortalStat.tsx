import type { ReactNode } from 'react';

/** One figure of a stats `<dl>` (label, value, optional hint). */
export function PortalStat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-card-foreground">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</dd>
      {hint ? <dd className="mt-1 text-xs text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}
