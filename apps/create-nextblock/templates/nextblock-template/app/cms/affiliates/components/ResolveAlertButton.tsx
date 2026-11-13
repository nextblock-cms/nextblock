'use client';

import { Check } from 'lucide-react';
import { Button } from '@nextblock-cms/ui';
import { resolveAffiliateAlert } from '../actions';
import { useAffiliateAdminAction } from './use-admin-action';

/** "Mark as done" for one affiliate notification of the activity feed. */
export function ResolveAlertButton({ alertId, title }: { alertId: string; title: string }) {
  const { run, isPending } = useAffiliateAdminAction();

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-8 shrink-0 px-2 text-xs"
      disabled={isPending}
      aria-label={`Mark as done: ${title}`}
      onClick={() => run(() => resolveAffiliateAlert({ alertIdToResolve: alertId }))}
    >
      <Check className="h-4 w-4" aria-hidden="true" />
      {isPending ? 'Saving…' : 'Done'}
    </Button>
  );
}
