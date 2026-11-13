'use client';

import { AFFILIATES_COMMON_COPY, useAffiliatesCopy } from '@nextblock-cms/affiliates';
import { Button } from '@nextblock-cms/ui';

/**
 * Error boundary of the partner portal. It lives one segment above `retailer/` because an
 * `error.tsx` never wraps the layout of its own segment: from here it also catches a failure in
 * the retailer layout (the partner lookup throws when the database cannot answer), not only in a
 * page. That layout mounts the portal's `AffiliatesCopyProvider`, so the copy comes from the
 * dictionary in the site language (the root `TranslationsProvider`).
 *
 * Never shows the error's message or digest. `retry()` fetches and renders the portal again.
 */
export default function PartnerPortalError({ retry }: { error: unknown; retry: () => void }) {
  const { t } = useAffiliatesCopy(AFFILIATES_COMMON_COPY);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-16 md:px-6">
      <div role="alert" className="mx-auto max-w-xl space-y-4 rounded-lg border border-border bg-card p-6 text-center text-card-foreground shadow-sm">
        <h1 className="text-xl font-semibold text-foreground">{t('affiliates.common.error_generic')}</h1>
        <Button type="button" onClick={() => retry()}>
          {t('affiliates.common.retry')}
        </Button>
      </div>
    </div>
  );
}
