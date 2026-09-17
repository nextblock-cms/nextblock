'use client';

import type { ReactNode } from 'react';

import Link from 'next/link';
import { Printer } from 'lucide-react';

import { Button } from '@nextblock-cms/ui/button';

import {
  InvoiceDocument,
  type InvoiceDocumentLabels,
} from './InvoiceDocument';
import type { InvoicePresentationData } from '../invoice';

interface InvoiceViewerAction {
  href: string;
  label: string;
  variant?: 'default' | 'outline';
}

interface InvoiceViewerShellProps {
  invoice?: InvoicePresentationData | null;
  labels: InvoiceDocumentLabels;
  locale: string;
  title: string;
  description?: string;
  printLabel: string;
  headerVisual?: ReactNode;
  action?: InvoiceViewerAction;
  loading?: boolean;
  loadingMessage?: string;
  error?: string | null;
  /** With `retryLabel`, shows a retry button beside the error. */
  onRetry?: () => void;
  retryLabel?: string;
  emptyMessage?: string;
  className?: string;
  showHeader?: boolean;
  /** Optional content rendered above the invoice (and hidden when printing). */
  beforeInvoice?: ReactNode;
}

export function InvoiceViewerShell({
  invoice,
  labels,
  locale,
  title,
  description,
  printLabel,
  headerVisual,
  action,
  loading = false,
  loadingMessage,
  error,
  onRetry,
  retryLabel,
  emptyMessage,
  className = '',
  showHeader = true,
  beforeInvoice,
}: InvoiceViewerShellProps) {
  return (
    <>
      <style>{`
        @media print {
          @page {
            size: portrait;
            margin: 12mm;
          }

          body {
            background: white !important;
          }

          body * {
            visibility: hidden;
          }

          [data-print-invoice-root],
          [data-print-invoice-root] * {
            visibility: visible;
          }

          [data-print-invoice-root] {
            position: absolute;
            inset: 0;
            width: 100%;
            margin: 0;
            padding: 0;
          }
        }
      `}</style>

      <div
        className={`mx-auto max-w-6xl px-4 py-10 md:px-6 print:max-w-none print:px-0 print:py-0 ${className}`}
      >
        {showHeader ? (
          <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between print:hidden">
            <div className="flex items-center gap-4">
              {headerVisual ? <div className="shrink-0">{headerVisual}</div> : null}
              <div>
                <h1 className="text-3xl font-bold">{title}</h1>
                {description ? (
                  <p className="text-sm text-muted-foreground">{description}</p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => window.print()}
                disabled={!invoice}
              >
                <Printer className="mr-2 h-4 w-4" />
                {printLabel}
              </Button>

              {action ? (
                <Button asChild variant={action.variant || 'default'}>
                  <Link href={action.href}>{action.label}</Link>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {loading ? (
          <div role="status" className="mb-6 flex items-center justify-center gap-3 rounded-2xl border bg-background px-5 py-4 text-sm text-muted-foreground print:hidden">
            {loadingMessage}
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800 print:hidden dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <span>{error}</span>
            {onRetry && retryLabel ? (
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                {retryLabel}
              </Button>
            ) : null}
          </div>
        ) : null}

        {beforeInvoice}

        {invoice ? (
          <div data-print-invoice-root>
            <InvoiceDocument
              data={invoice}
              labels={labels}
              locale={locale}
            />
          </div>
        ) : !loading && !error ? (
          <div className="rounded-2xl border bg-background px-6 py-12 text-center text-muted-foreground print:hidden">
            {emptyMessage}
          </div>
        ) : null}
      </div>
    </>
  );
}
