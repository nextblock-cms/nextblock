import 'server-only';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button } from '@nextblock-cms/ui';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

import { updateCouponAction } from './actions';
import { CouponEditorForm } from './CouponEditorForm';
import { normalizeCouponProductOptions } from './product-options';

export async function EditCouponPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = getServiceRoleSupabaseClient();
  const [
    { data: coupon },
    { data: products },
    { data: scopedProducts },
    { data: currencies },
  ] = await Promise.all([
    (supabase as any).from('coupons').select('*').eq('id', id).single(),
    (supabase as any)
      .from('products')
      .select(
        'id, title, sku, payment_provider, freemius_product_id, language:languages(code, name), product_media(sort_order, media(file_path, object_key))'
      )
      .order('title', { ascending: true }),
    (supabase as any)
      .from('coupon_products')
      .select('product_id')
      .eq('coupon_id', id),
    (supabase as any)
      .from('currencies')
      .select('code, is_default')
      .eq('is_active', true),
  ]);

  if (!coupon) {
    notFound();
  }

  const selectedProductIds = (scopedProducts || []).map((row: any) => row.product_id);
  const defaultCurrencyCode =
    currencies?.find((currency: any) => currency.is_default)?.code ||
    currencies?.[0]?.code ||
    'USD';

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Edit Coupon</h1>
          <p className="text-sm text-muted-foreground">
            Changes are resynced to Freemius after saving.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/cms/coupons">Back to coupons</Link>
        </Button>
      </div>

      <CouponEditorForm
        action={updateCouponAction.bind(null, id)}
        products={normalizeCouponProductOptions(products)}
        coupon={coupon}
        selectedProductIds={selectedProductIds}
        submitLabel="Save Coupon"
        currencyCode={defaultCurrencyCode}
      />
    </div>
  );
}
