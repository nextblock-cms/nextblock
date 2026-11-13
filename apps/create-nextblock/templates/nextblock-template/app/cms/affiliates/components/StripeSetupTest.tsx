'use client';

import { useId, useState, useTransition } from 'react';
import { AlertTriangle, CheckCircle2, MinusCircle, PlugZap, XCircle } from 'lucide-react';
import { Button } from '@nextblock-cms/ui';
import { cn } from '@nextblock-cms/utils';
import { testAffiliateStripeSetup, type TestAffiliateStripeSetupResult } from '../actions';

const NETWORK_ERROR = 'The request did not reach the server. Check your connection and try again.';

type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

const STATUS: Record<CheckStatus, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  pass: { label: 'Passed', className: 'text-emerald-700 dark:text-emerald-400', Icon: CheckCircle2 },
  warn: { label: 'Needs attention', className: 'text-amber-700 dark:text-amber-400', Icon: AlertTriangle },
  fail: { label: 'Failed', className: 'text-red-700 dark:text-red-400', Icon: XCircle },
  skip: { label: 'Skipped', className: 'text-muted-foreground', Icon: MinusCircle },
};

/**
 * "Test connection": runs `testAffiliateStripeSetup()` (read-only Stripe calls, nothing charged
 * or transferred) and lists its checks. Every text comes from the server, already worded.
 */
export function StripeSetupTest({ disabledReason }: { disabledReason: string | null }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<TestAffiliateStripeSetupResult | null>(null);
  const reasonId = useId();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={isPending || disabledReason !== null}
          aria-describedby={disabledReason ? reasonId : undefined}
          onClick={() =>
            startTransition(async () => {
              try {
                setResult(await testAffiliateStripeSetup());
              } catch {
                setResult({ ok: false, error: NETWORK_ERROR, reason: 'unknown' });
              }
            })
          }
        >
          <PlugZap className="h-4 w-4" aria-hidden="true" />
          {isPending ? 'Testing…' : 'Test connection'}
        </Button>
        {disabledReason ? (
          <p id={reasonId} className="text-xs text-muted-foreground">
            {disabledReason}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Read-only: nothing is charged or transferred.</p>
        )}
      </div>

      <div role="status" aria-live="polite" className="space-y-3">
        {result === null ? null : result.ok ? (
          <>
            <p className="text-sm font-medium text-foreground">{result.message}</p>
            <ul className="divide-y divide-border rounded-md border border-border">
              {result.checks.map((check) => {
                const status = STATUS[check.status];
                return (
                  <li key={check.id} className="flex items-start gap-3 px-3 py-2.5 text-sm">
                    <status.Icon className={cn('mt-0.5 h-4 w-4 shrink-0', status.className)} aria-hidden="true" />
                    <div className="space-y-0.5">
                      <p className="font-medium text-foreground">
                        {check.title}
                        <span className={cn('ml-2 text-xs font-normal', status.className)}>{status.label}</span>
                      </p>
                      <p className="text-muted-foreground">{check.detail}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted-foreground">{result.note}</p>
          </>
        ) : (
          <p className={cn('text-sm', result.reason === 'sandbox' ? 'text-muted-foreground' : 'text-red-800 dark:text-red-300')}>
            {result.error}
          </p>
        )}
      </div>
    </div>
  );
}
