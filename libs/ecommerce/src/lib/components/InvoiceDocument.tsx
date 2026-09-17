import React from 'react';
import Image from 'next/image';

import {
  formatInvoiceCurrency,
  formatInvoiceDate,
  getInvoiceAddressLines,
  type InvoicePresentationData,
} from '../invoice';
import {
  getOrderTaxRateJurisdiction,
  getOrderTaxRateLabel,
  getOrderTaxRatePercentage,
} from '../order-tax-details';

export interface InvoiceDocumentLabels {
  invoice: string;
  invoiceNumber: string;
  orderNumber: string;
  paidOn: string;
  status: string;
  from: string;
  billTo: string;
  shipTo: string;
  item: string;
  details: string;
  quantity: string;
  price: string;
  amount: string;
  subtotal: string;
  discount: string;
  shipping: string;
  tax: string;
  total: string;
  taxBreakdown: string;
  taxRegistrations: string;
}

interface InvoiceDocumentProps {
  data: InvoicePresentationData;
  labels: InvoiceDocumentLabels;
  locale?: string;
  className?: string;
}

export function InvoiceDocument({
  data,
  labels,
  locale = 'en-US',
  className = '',
}: InvoiceDocumentProps) {
  const sellerAddressLines = getInvoiceAddressLines(data.settings.address);
  const billingLines = getInvoiceAddressLines(data.order.customer_details?.billing);
  const shippingLines = getInvoiceAddressLines(data.order.customer_details?.shipping);

  return (
    <section
      className={`rounded-2xl border bg-white text-slate-900 shadow-sm print:rounded-none print:border-0 print:text-[10px] print:shadow-none ${className}`}
    >
      <div className="border-b px-6 py-6 print:px-0">
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-start print:grid-cols-[minmax(0,1fr)_72px_280px] print:items-start print:gap-4">
          <div className="order-2 max-w-md space-y-4 print:order-none print:max-w-none print:space-y-2 md:order-none">
            <div className="space-y-1 text-sm print:text-[10px]">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                {labels.from}
              </p>
              {data.settings.businessName ? (
                <p className="text-base font-semibold">{data.settings.businessName}</p>
              ) : null}
              {sellerAddressLines.map((line, index) => (
                <p key={`seller-${index}-${line}`}>{line}</p>
              ))}
              {data.settings.email ? <p>{data.settings.email}</p> : null}
              {data.settings.phone ? <p>{data.settings.phone}</p> : null}
            </div>

            {data.settings.taxRegistrations.length > 0 ? (
              <div className="rounded-xl border bg-slate-50 px-4 py-3 text-sm print:px-3 print:py-2 print:text-[10px]">
                <p className="mb-2 font-semibold">{labels.taxRegistrations}</p>
                <div className="space-y-1">
                  {data.settings.taxRegistrations.map((registration, index) => (
                    <p key={`${registration.label}-${registration.value}-${index}`}>
                      <span className="font-medium">{registration.label}</span>
                      {registration.label && registration.value ? ': ' : ''}
                      {registration.value}
                    </p>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="order-1 flex justify-center md:order-none md:pt-2 print:order-none print:pt-1">
            {data.logo?.url ? (
              <Image
                src={data.logo.url}
                alt={data.logo.name || data.settings.businessName || 'Logo'}
                className="mx-auto h-24 w-auto object-contain print:h-14"
                width={data.logo.width || 320}
                height={data.logo.height || 120}
              />
            ) : null}
          </div>

          <div className="order-3 flex justify-start md:order-none md:justify-end print:order-none">
            <div className="w-full max-w-[380px] rounded-2xl bg-slate-950 px-5 py-5 text-white print:max-w-none print:border print:border-slate-300 print:bg-white print:px-3 print:py-3 print:text-[10px] print:text-slate-950">
              <p className="text-xs uppercase tracking-[0.2em] text-white/70 print:text-slate-500">
                {labels.invoice}
              </p>
              <div className="mt-4 space-y-3 text-sm print:mt-3 print:space-y-2 print:text-[10px]">
                <MetadataRow
                  label={labels.invoiceNumber}
                  value={data.order.invoice_number || '--'}
                />
                <MetadataRow label={labels.orderNumber} value={data.order.id} />
                <MetadataRow
                  label={labels.paidOn}
                  value={
                    formatInvoiceDate(data.order.paid_at || data.order.created_at, locale) ||
                    '--'
                  }
                />
                <MetadataRow label={labels.status} value={data.order.status} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 border-b px-6 py-6 md:grid-cols-2 print:grid-cols-2 print:gap-3 print:px-0 print:py-3">
        <AddressBlock title={labels.billTo} lines={billingLines} />
        <AddressBlock title={labels.shipTo} lines={shippingLines} />
      </div>

      <div className="px-6 py-6 print:px-0 print:py-3">
        {/* overflow-x-auto: `overflow-hidden` cut the right-hand columns off on a phone. */}
        <div className="overflow-x-auto rounded-2xl border print:overflow-visible">
          <table className="w-full border-collapse text-sm tabular-nums print:table-fixed print:text-[9px]">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3 text-left font-semibold print:w-[22%] print:px-2 print:py-1.5">{labels.item}</th>
                <th className="px-4 py-3 text-left font-semibold print:w-[38%] print:px-2 print:py-1.5">{labels.details}</th>
                <th className="px-4 py-3 text-right font-semibold print:w-[10%] print:px-2 print:py-1.5">{labels.quantity}</th>
                <th className="px-4 py-3 text-right font-semibold print:w-[15%] print:px-2 print:py-1.5">{labels.price}</th>
                <th className="px-4 py-3 text-right font-semibold print:w-[15%] print:px-2 print:py-1.5">{labels.amount}</th>
              </tr>
            </thead>
            <tbody>
              {data.order.items.map((item) => (
                <tr key={item.id} className="border-t">
                  <td className="px-4 py-4 font-medium print:px-2 print:py-1.5">{item.title}</td>
                  <td className="px-4 py-4 text-slate-600 print:px-2 print:py-1.5">{item.description || '--'}</td>
                  <td className="px-4 py-4 text-right print:px-2 print:py-1.5">{item.quantity}</td>
                  <td className="px-4 py-4 text-right print:px-2 print:py-1.5">
                    {formatInvoiceCurrency(item.unit_amount, data.order.currency, locale)}
                  </td>
                  <td className="px-4 py-4 text-right font-medium print:px-2 print:py-1.5">
                    {formatInvoiceCurrency(item.total_amount, data.order.currency, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-6 grid gap-6 md:grid-cols-[minmax(0,1fr)_320px] print:mt-4 print:grid-cols-[minmax(0,1fr)_220px] print:items-start print:gap-4">
          <div>
            {data.order.tax_details?.lines?.length ? (
              <div className="rounded-xl border bg-slate-50 px-5 py-4 print:break-inside-avoid print:px-3 print:py-2.5 print:text-[10px]">
                <p className="mb-3 font-semibold">{labels.taxBreakdown}</p>
                <div className="space-y-3 text-sm print:space-y-2 print:text-[10px]">
                  {data.order.tax_details.lines.map((line, index) => {
                    const percentage = getOrderTaxRatePercentage(line.rate);

                    return (
                      <div
                        key={`${line.rate.display_name}-${line.description || 'tax'}-${index}`}
                        className="flex items-start justify-between gap-4"
                      >
                        <div>
                          <p className="font-medium">
                            {getOrderTaxRateLabel(line.rate)}
                            {typeof percentage === 'number'
                              ? ` - ${percentage.toFixed(4)}%`
                              : ''}
                          </p>
                          {getOrderTaxRateJurisdiction(line.rate) ? (
                            <p className="text-xs text-slate-500 print:text-[9px]">
                              {getOrderTaxRateJurisdiction(line.rate)}
                            </p>
                          ) : null}
                        </div>
                        <span>
                          {formatInvoiceCurrency(line.amount, data.order.currency, locale)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <div className="rounded-xl border bg-slate-950 px-5 py-5 text-sm text-white print:break-inside-avoid print:border-slate-300 print:bg-white print:px-3 print:py-3 print:text-[10px] print:text-slate-950">
            <div className="space-y-3 print:space-y-2">
              <SummaryRow
                label={labels.subtotal}
                value={formatInvoiceCurrency(data.order.subtotal, data.order.currency, locale)}
              />
              {data.order.discount_total > 0 ? (
                <SummaryRow
                  label={
                    data.order.coupon_code
                      ? `${labels.discount} (${data.order.coupon_code})`
                      : labels.discount
                  }
                  value={`-${formatInvoiceCurrency(
                    data.order.discount_total,
                    data.order.currency,
                    locale
                  )}`}
                />
              ) : null}
              <SummaryRow
                label={labels.shipping}
                value={formatInvoiceCurrency(
                  data.order.shipping_total,
                  data.order.currency,
                  locale
                )}
              />
              <SummaryRow
                label={labels.tax}
                value={formatInvoiceCurrency(data.order.tax_total, data.order.currency, locale)}
              />
            </div>
            <div className="mt-4 border-t border-white/15 pt-4 print:mt-3 print:border-slate-300 print:pt-3">
              <SummaryRow
                label={labels.total}
                value={formatInvoiceCurrency(data.order.total, data.order.currency, locale)}
                strong
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function AddressBlock({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="rounded-xl border bg-slate-50 px-5 py-4 print:break-inside-avoid print:px-3 print:py-2.5 print:text-[10px]">
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
        {title}
      </p>
      {lines.length ? (
        <div className="space-y-1 text-sm print:text-[10px]">
          {lines.map((line, index) => (
            <p key={`${title}-${index}-${line}`}>{line}</p>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-500">--</p>
      )}
    </div>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-white/70 print:text-[9px] print:text-slate-500">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span
        className={
          strong
            ? 'text-base font-semibold print:text-sm'
            : 'text-white/75 print:text-[9px] print:text-slate-500'
        }
      >
        {label}
      </span>
      <span className={strong ? 'text-lg font-semibold print:text-base' : 'font-medium'}>
        {value}
      </span>
    </div>
  );
}
