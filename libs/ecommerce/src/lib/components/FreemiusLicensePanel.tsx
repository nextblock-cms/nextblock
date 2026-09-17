'use client';

import { useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';

import { Button } from '@nextblock-cms/ui/button';
import { useTranslations } from '@nextblock-cms/utils';

import { getInvoiceLocale, translateOrFallback } from '../invoice-ui';
import { formatInvoiceDate } from '../invoice';
import type { FreemiusOrderLicense } from '../freemius-license-types';

interface FreemiusLicensePanelProps {
  license?: FreemiusOrderLicense | null;
}

export function FreemiusLicensePanel({ license }: FreemiusLicensePanelProps) {
  const { t, lang } = useTranslations();
  const [copied, setCopied] = useState(false);

  if (!license) {
    return null;
  }

  const locale = getInvoiceLocale(lang);
  const expiryDate = license.expiration ?? license.trialEndsAt;
  const formattedExpiry = expiryDate ? formatInvoiceDate(expiryDate, locale) : null;

  const handleCopy = async () => {
    if (!license.licenseKey || typeof navigator === 'undefined' || !navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(license.licenseKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (permissions / insecure context); the key stays
      // visible for manual copy, so no further handling is needed.
    }
  };

  return (
    <div className="mb-6 rounded-2xl border border-primary/30 bg-primary/5 p-5 print:hidden">
      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">
          {translateOrFallback(t, 'ecommerce.license_panel_title', 'Your license')}
        </h2>
      </div>

      {license.licenseKey ? (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            {translateOrFallback(
              t,
              'ecommerce.license_panel_help',
              'Activate this key in your NextBlock install under Settings → Packages.'
            )}
          </p>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            {/* translate="no": a browser's auto-translate must never rewrite a license key. */}
            <code translate="no" className="flex-1 select-all overflow-x-auto rounded-lg border bg-background px-3 py-2 font-mono text-sm">
              {license.licenseKey}
            </code>
            <Button
              type="button"
              variant="default"
              onClick={handleCopy}
              className="shrink-0"
            >
              {copied ? (
                <Check className="mr-2 h-4 w-4" />
              ) : (
                <Copy className="mr-2 h-4 w-4" />
              )}
              {copied
                ? translateOrFallback(t, 'ecommerce.license_copied', 'Copied')
                : translateOrFallback(t, 'ecommerce.license_copy', 'Copy key')}
            </Button>
          </div>
        </>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">
          {translateOrFallback(
            t,
            'ecommerce.license_panel_email_fallback',
            'Your license key was sent to your email. It will also appear here once your purchase is confirmed.'
          )}
        </p>
      )}

      <dl className="mt-4 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
        <div className="flex justify-between gap-3 sm:block">
          <dt className="font-medium">
            {translateOrFallback(t, 'ecommerce.license_number', 'License #')}
          </dt>
          <dd className="font-mono">{license.licenseId}</dd>
        </div>
        {formattedExpiry ? (
          <div className="flex justify-between gap-3 sm:block">
            <dt className="font-medium">
              {license.isCancelled
                ? translateOrFallback(t, 'ecommerce.license_expires', 'Expires')
                : license.trialEndsAt
                  ? translateOrFallback(t, 'ecommerce.license_trial_ends', 'Trial ends')
                  : translateOrFallback(t, 'ecommerce.license_renews', 'Renews / expires')}
            </dt>
            <dd>{formattedExpiry}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
