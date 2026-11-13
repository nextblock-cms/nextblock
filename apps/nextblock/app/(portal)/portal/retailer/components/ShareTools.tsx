'use client';

import { useId, useMemo, useState } from 'react';
import { Input, Label } from '@nextblock-cms/ui';

import { CopyField } from './CopyField';
import type { PortalCopyKey } from './portal-copy';
import { buildPortalReferralLink } from './referral-link';
import { usePortalCopy } from './use-portal-copy';

const REFERRAL_ERROR_KEYS: Readonly<Record<'empty' | 'invalid' | 'other_site' | 'excluded_path', PortalCopyKey>> = {
  empty: 'affiliates.portal.share_ref_error_invalid',
  invalid: 'affiliates.portal.share_ref_error_invalid',
  other_site: 'affiliates.portal.share_ref_error_other_site',
  excluded_path: 'affiliates.portal.share_ref_error_excluded',
};

export interface ShareToolsProps {
  handle: string;
  siteOrigin: string;
  storefrontUrl: string;
  /** The storefront is public (approved at least once, partner active). */
  isLive: boolean;
  /** Links earn commissions (the first approval happened). */
  isApproved: boolean;
}

/** The storefront link and a `?ref=` link builder for any page of the store, with copy buttons. */
export function ShareTools({ handle, siteOrigin, storefrontUrl, isLive, isApproved }: ShareToolsProps) {
  const { t } = usePortalCopy();
  const id = useId();
  const headingId = `${id}-heading`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const [path, setPath] = useState('');

  const result = useMemo(() => buildPortalReferralLink({ input: path, siteOrigin, handle }), [path, siteOrigin, handle]);
  const error = result.ok ? null : REFERRAL_ERROR_KEYS[result.error];

  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-border bg-card p-6 text-card-foreground">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('affiliates.portal.share_title')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {isApproved ? t('affiliates.portal.share_description') : t('affiliates.portal.share_description_not_approved')}
      </p>

      <div className="mt-5 space-y-6">
        <CopyField
          label={t('affiliates.portal.share_storefront_label')}
          value={storefrontUrl}
          description={isLive ? undefined : t('affiliates.portal.share_storefront_not_live')}
        />

        <div className="space-y-1.5">
          <Label htmlFor={`${id}-path`}>{t('affiliates.portal.share_ref_label')}</Label>
          <p id={hintId} className="text-sm text-muted-foreground">
            {t('affiliates.portal.share_ref_hint')}
          </p>
          <Input
            id={`${id}-path`}
            value={path}
            maxLength={2000}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('affiliates.portal.share_ref_placeholder')}
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setPath(event.target.value)}
          />
          <p id={errorId} role="status" aria-live="polite" className="min-h-5 text-sm text-destructive">
            {error ? t(error) : ''}
          </p>
        </div>

        {result.ok ? <CopyField label={t('affiliates.portal.share_ref_result_label')} value={result.url} /> : null}
      </div>
    </section>
  );
}
