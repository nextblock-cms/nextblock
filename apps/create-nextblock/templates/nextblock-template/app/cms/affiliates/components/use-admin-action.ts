'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import { toast } from 'sonner';

export type AffiliateAdminClientResult = { ok: true; message: string } | { ok: false; error: string };

export interface RunAffiliateAdminActionOptions {
  onSuccess?: () => void;
  /** Re-render the server components after a success (default true). */
  refresh?: boolean;
}

const NETWORK_ERROR = 'The request did not reach the server. Check your connection and try again.';

/**
 * Run an affiliates server action with a pending state: a toast for the outcome (the actions
 * return readable sentences as data) and a router refresh so the server-rendered tables update.
 */
export function useAffiliateAdminAction() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const run = useCallback(
    (action: () => Promise<AffiliateAdminClientResult>, options: RunAffiliateAdminActionOptions = {}) => {
      startTransition(async () => {
        let result: AffiliateAdminClientResult;
        try {
          result = await action();
        } catch {
          result = { ok: false, error: NETWORK_ERROR };
        }
        if (result.ok) {
          toast.success(result.message);
          options.onSuccess?.();
          if (options.refresh !== false) router.refresh();
        } else {
          toast.error(result.error);
        }
      });
    },
    [router]
  );

  return { run, isPending };
}
