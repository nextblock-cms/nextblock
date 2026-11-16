'use client';

import type { FreemiusOrderLicense, InvoicePresentationData } from '@nextblock-cms/ecommerce';
import { FreemiusLicensePanel } from '@nextblock-cms/ecommerce/components/FreemiusLicensePanel';
import { InvoiceViewerShell } from '@nextblock-cms/ecommerce/components/InvoiceViewerShell';
import {
  buildInvoiceDocumentLabels,
  getInvoiceLocale,
  localizeInvoicePresentationData,
  translateOrFallback,
} from '@nextblock-cms/ecommerce/invoice-ui';
import { useTranslations } from '@nextblock-cms/utils/translations-context';

import type { ProfileAccountSummary, ProfileAccountUser } from '../../account-types';
import { ProfileAccountSidebar } from '../../ProfileAccountSidebar';

interface CustomerOrderDetailPageClientProps {
  order: {
    id: string;
    invoice_number: string | null;
  };
  invoice: InvoicePresentationData | null;
  license: FreemiusOrderLicense | null;
  profile: ProfileAccountSummary;
  user: ProfileAccountUser;
}

export function CustomerOrderDetailPageClient({
  order,
  invoice,
  license,
  profile,
  user,
}: CustomerOrderDetailPageClientProps) {
  const { t, lang } = useTranslations();
  const localizedInvoice = localizeInvoicePresentationData(invoice, t);

  return (
    <div className="grid gap-6 md:grid-cols-12">
      <div className="md:col-span-4">
        <ProfileAccountSidebar profile={profile} user={user} />
      </div>

      <div className="md:col-span-8">
        <InvoiceViewerShell
          invoice={localizedInvoice}
          labels={buildInvoiceDocumentLabels(t)}
          locale={getInvoiceLocale(lang)}
          title={
            order.invoice_number ||
            translateOrFallback(t, 'profile_order_detail_title', 'Order invoice')
          }
          description={translateOrFallback(
            t,
            'profile_order_detail_description',
            'Review and print your finalized invoice.'
          )}
          printLabel={translateOrFallback(
            t,
            'print_invoice',
            'Print / Save as PDF'
          )}
          beforeInvoice={<FreemiusLicensePanel license={license} />}
          action={{
            href: '/profile/orders',
            label: translateOrFallback(
              t,
              'back_to_orders',
              'Back to orders'
            ),
            variant: 'default',
          }}
          emptyMessage={translateOrFallback(
            t,
            'profile_order_invoice_pending',
            'The printable invoice will appear here once this order has been finalized.'
          )}
          className="max-w-none px-0 py-0"
        />
      </div>
    </div>
  );
}
