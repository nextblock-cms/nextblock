'use client';

import { Check } from 'lucide-react';
import { cn } from '@nextblock-cms/utils';

/**
 * The numbered step chips shared by the post-install welcome flow and the Cortex AI
 * setup wizard, so a flow that spans both reads as one continuous sequence.
 */
export function SetupStepIndicator({
  current,
  steps,
}: {
  /** Zero-based index of the active step. */
  current: number;
  steps: ReadonlyArray<string>;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Setup progress">
      {steps.map((label, index) => {
        const done = index < current;
        const active = index === current;

        return (
          <li key={label} className="flex items-center gap-2">
            <span
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                active && 'border-primary bg-primary text-primary-foreground',
                done && 'border-emerald-500/40 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300',
                !active && !done && 'border-border text-muted-foreground'
              )}
            >
              {done ? <Check className="h-3 w-3" /> : <span className="tabular-nums">{index + 1}</span>}
              {label}
            </span>
            {index < steps.length - 1 && <span className="h-px w-6 bg-border" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}
