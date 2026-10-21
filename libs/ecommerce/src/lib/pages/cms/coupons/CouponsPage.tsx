import 'server-only';

import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@nextblock-cms/ui';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { RefreshCw, Trash2 } from 'lucide-react';

import { formatPrice } from '@nextblock-cms/utils';
import {
  createCouponAction,
  deleteCouponAction,
  syncCouponAction,
  toggleCouponActiveAction,
} from './actions';
import { CreateCouponDialog } from './CreateCouponDialog';
import { normalizeCouponProductOptions } from './product-options';

type SearchParams = {
  status?: string;
  q?: string;
};

function formatDiscount(coupon: {
  discount_type: string;
  discount_amount: number;
}, currencyCode: string) {
  return coupon.discount_type === 'percent'
    ? `${coupon.discount_amount}%`
    : formatPrice(coupon.discount_amount, currencyCode);
}

function statusVariant(status: string, isActive: boolean) {
  if (!isActive) {
    return 'outline' as const;
  }

  return status === 'synced' || status === 'not_required' ? 'default' : 'secondary';
}

function getScopedSkuCount(
  couponProducts: Array<{ product_id?: string | null }> | null | undefined,
  productSkuById: Map<string, string>
) {
  const scopedKeys = new Set<string>();

  for (const couponProduct of couponProducts || []) {
    const productId = couponProduct.product_id;

    if (!productId) {
      continue;
    }

    scopedKeys.add(productSkuById.get(productId) || productId);
  }

  return scopedKeys.size;
}

function formatProductScope(
  couponProducts: Array<{ product_id?: string | null }> | null | undefined,
  productSkuById: Map<string, string>
) {
  const scopedSkuCount = getScopedSkuCount(couponProducts, productSkuById);

  if (scopedSkuCount === 0) {
    return 'All eligible products';
  }

  return `${scopedSkuCount} scoped SKU${scopedSkuCount === 1 ? '' : 's'}`;
}

export async function CouponsPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const supabase = getServiceRoleSupabaseClient();
  let query = (supabase as any)
    .from('coupons')
    .select(
      `
      *,
      coupon_products(product_id),
      coupon_freemius_mappings(sync_status, sync_error)
    `
    )
    .order('created_at', { ascending: false });

  if (searchParams?.q) {
    query = query.or(`code.ilike.%${searchParams.q}%,name.ilike.%${searchParams.q}%`);
  }

  if (searchParams?.status === 'active') {
    query = query.eq('is_active', true);
  } else if (searchParams?.status === 'inactive') {
    query = query.eq('is_active', false);
  }

  const [{ data: coupons }, { data: products }, { data: currencies }] = await Promise.all([
    query,
    (supabase as any)
      .from('products')
      .select(
        'id, title, sku, payment_provider, freemius_product_id, language:languages(code, name), product_media(sort_order, media(file_path, object_key))'
      )
      .order('title', { ascending: true }),
    (supabase as any)
      .from('currencies')
      .select('code, is_default')
      .eq('is_active', true),
  ]);
  const defaultCurrencyCode =
    currencies?.find((currency: any) => currency.is_default)?.code ||
    currencies?.[0]?.code ||
    'USD';
  const productSkuById = new Map<string, string>(
    (products || []).map((product: any) => [
      product.id,
      product.sku?.trim().toUpperCase() || product.id,
    ])
  );

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-6 py-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Coupons</h1>
          <p className="text-sm text-muted-foreground">
            Create provider-aware discounts for Stripe checkout and Freemius licenses.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <form className="flex gap-2" action="/cms/coupons">
            <input
              name="q"
              placeholder="Search coupons"
              defaultValue={searchParams?.q || ''}
              className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <select
              name="status"
              defaultValue={searchParams?.status || 'all'}
              className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            <Button type="submit" variant="outline">Filter</Button>
          </form>
          <CreateCouponDialog
            action={createCouponAction}
            products={normalizeCouponProductOptions(products)}
            currencyCode={defaultCurrencyCode}
          />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Coupons</CardTitle>
          <CardDescription>
            Freemius sync runs when a coupon is created, updated, toggled, or manually resynced.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Scope</th>
                  <th className="px-4 py-3">Discount</th>
                  <th className="px-4 py-3">Usage</th>
                  <th className="px-4 py-3">Sync</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {!coupons?.length ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                      No coupons yet.
                    </td>
                  </tr>
                ) : (
                  coupons.map((coupon: any) => (
                    <tr key={coupon.id} className="align-top">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold">{coupon.code}</span>
                          <Badge variant={coupon.is_active ? 'default' : 'outline'}>
                            {coupon.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{coupon.name}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className="capitalize">{coupon.provider_scope}</span>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatProductScope(coupon.coupon_products, productSkuById)}
                        </p>
                      </td>
                      <td className="px-4 py-3 font-medium">
                        {formatDiscount(coupon, defaultCurrencyCode)}
                      </td>
                      <td className="px-4 py-3">
                        {coupon.redemptions_count || 0}
                        {coupon.redemption_limit ? ` / ${coupon.redemption_limit}` : ''}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={statusVariant(coupon.freemius_sync_status, coupon.is_active)}>
                          {coupon.freemius_sync_status}
                        </Badge>
                        {coupon.freemius_sync_error ? (
                          <p className="mt-1 max-w-[220px] text-xs text-destructive">
                            {coupon.freemius_sync_error}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <Button asChild variant="outline" size="sm">
                            <Link href={`/cms/coupons/${coupon.id}/edit`}>Edit</Link>
                          </Button>
                          <form action={async () => {
                            'use server';
                            await toggleCouponActiveAction(coupon.id, !coupon.is_active);
                          }}>
                            <Button type="submit" variant="outline" size="sm">
                              {coupon.is_active ? 'Disable' : 'Enable'}
                            </Button>
                          </form>
                          <form action={async () => {
                            'use server';
                            await syncCouponAction(coupon.id);
                          }}>
                            <Button
                              type="submit"
                              variant="ghost"
                              size="icon"
                              title="Resync Freemius"
                              aria-label={`Resync Freemius coupon ${coupon.code}`}
                            >
                              <RefreshCw className="h-4 w-4" />
                            </Button>
                          </form>
                          <form action={async () => {
                            'use server';
                            await deleteCouponAction(coupon.id);
                          }}>
                            <Button
                              type="submit"
                              variant="ghost"
                              size="icon"
                              className="text-destructive"
                              aria-label={`Delete coupon ${coupon.code}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
