'use client';

import { formatInvoiceCurrency, formatInvoiceDate, translateOrderStatus, translateOrFallback, getInvoiceLocale } from '@nextblock-cms/ecommerce';
import { useTranslations } from '@nextblock-cms/utils';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@nextblock-cms/ui';
import Link from 'next/link';

import type { ProfileAccountSummary, ProfileAccountUser } from '../account-types';
import { ProfileAccountSidebar } from '../ProfileAccountSidebar';

interface CustomerOrdersPageClientProps {
  orders: Array<{
    id: string;
    invoice_number: string | null;
    paid_at: string | null;
    created_at: string | null;
    currency: string | null;
    status: string;
    total: number;
  }>;
  profile: ProfileAccountSummary;
  user: ProfileAccountUser;
}

export function CustomerOrdersPageClient({
  orders,
  profile,
  user,
}: CustomerOrdersPageClientProps) {
  const { t, lang } = useTranslations();
  const locale = getInvoiceLocale(lang);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 md:px-6">
      <div className="grid gap-6 md:grid-cols-12">
        <div className="md:col-span-4">
          <ProfileAccountSidebar profile={profile} user={user} />
        </div>

        <Card className="md:col-span-8">
          <CardHeader>
            <CardTitle role="heading" aria-level={1}>
              {translateOrFallback(t, 'profile_orders_title', 'My orders')}
            </CardTitle>
            <CardDescription>
              {translateOrFallback(
                t,
                'profile_orders_description',
                'Review your recent purchases and open printable invoices.'
              )}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {orders.length ? (
              orders.map((order) => (
                <div
                  key={order.id}
                  className="flex flex-col gap-4 rounded-xl border px-4 py-4 md:flex-row md:items-center md:justify-between"
                >
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">
                        {translateOrFallback(t, 'order_number', 'Order #')} {order.id}
                      </p>
                      <Badge variant="secondary" className="capitalize">
                        {translateOrderStatus(order.status, t)}
                      </Badge>
                    </div>

                    <div className="space-y-1 text-sm text-muted-foreground">
                      <p>
                        {translateOrFallback(t, 'invoice_number', 'Invoice #')}:{' '}
                        {order.invoice_number || '--'}
                      </p>
                      <p>
                        {translateOrFallback(t, 'order_date', 'Date')}:{' '}
                        {formatInvoiceDate(order.created_at, locale) || '--'}
                      </p>
                      <p>
                        {translateOrFallback(t, 'ecommerce.total', 'Total')}:{' '}
                        {formatInvoiceCurrency(
                          order.total,
                          order.currency || 'usd',
                          locale
                        )}
                      </p>
                    </div>
                  </div>

                  <Button asChild>
                    <Link href={`/profile/orders/${order.id}`}>
                      {translateOrFallback(
                        t,
                        'ecommerce.view_details',
                        'View Details'
                      )}
                    </Link>
                  </Button>
                </div>
              ))
            ) : (
              <div className="rounded-xl border border-dashed px-6 py-12 text-center text-muted-foreground">
                {translateOrFallback(
                  t,
                  'profile_orders_empty',
                  'You do not have any orders yet.'
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
