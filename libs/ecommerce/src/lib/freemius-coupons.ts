import type { SupabaseClient } from '@supabase/supabase-js';
import { minorUnitAmountToMajor } from '@nextblock-cms/utils';

import type { CouponDiscountType, CouponProviderScope } from './coupons';
import { computeFreemiusSaleDiscountPercent } from './freemius-pricing';
import {
  readFreemiusEnvValue,
  resolveFreemiusCheckoutCredentials,
} from './providers/freemius';
import { hydrateFreemiusEnvFromDb } from './payment-config';

type SupabaseLikeClient = SupabaseClient<any>;

type CouponRow = {
  id: string;
  code: string;
  name: string;
  internal_note?: string | null;
  provider_scope: CouponProviderScope;
  discount_type: CouponDiscountType;
  discount_amount: number;
  is_active: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
  redemption_limit?: number | null;
};

type FreemiusTarget = {
  freemiusProductId: string;
  productId: string | null;
  planIds: string[];
};

type FreemiusProductRow = {
  id: string;
  freemius_product_id?: string | number | null;
  freemius_plan_id?: string | number | null;
};

function formatFreemiusDate(value?: string | null) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function mapDiscountType(type: CouponDiscountType) {
  return type === 'percent' ? 'percentage' : 'dollar';
}

function getFreemiusApiKey(productId: string) {
  return (
    resolveFreemiusCheckoutCredentials(productId).apiKey ||
    readFreemiusEnvValue('FREEMIUS_API_KEY')
  );
}

async function freemiusCouponRequest(input: {
  productId: string;
  method: 'POST' | 'PUT' | 'DELETE';
  couponId?: string | null;
  body?: Record<string, unknown>;
}) {
  // Overlay any CMS-configured Freemius credentials (DB-first) before the sync env reads.
  await hydrateFreemiusEnvFromDb();
  const apiKey = getFreemiusApiKey(input.productId);

  if (!apiKey) {
    throw new Error(
      `Missing Freemius API bearer token for product ${input.productId}. Set FREEMIUS_API_KEY or FREEMIUS_CHECKOUT_PRODUCTS_JSON[${input.productId}].apiKey.`
    );
  }

  const couponPath = input.couponId ? `/${input.couponId}` : '';
  const response = await fetch(
    `https://api.freemius.com/v1/products/${input.productId}/coupons${couponPath}.json`,
    {
      method: input.method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: input.method === 'DELETE' ? undefined : JSON.stringify(input.body || {}),
    }
  );

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(
      payload?.message ||
        payload?.error?.message ||
        `Freemius coupon request failed with ${response.status}`
    );
  }

  return payload;
}

function buildFreemiusCouponPayload(coupon: CouponRow, target: FreemiusTarget) {
  return {
    code: coupon.code,
    discount:
      coupon.discount_type === 'fixed'
        ? minorUnitAmountToMajor(coupon.discount_amount, 'USD')
        : coupon.discount_amount,
    discount_type: mapDiscountType(coupon.discount_type),
    plans: target.planIds.length > 0 ? target.planIds.join(',') : null,
    licenses: null,
    billing_cycles: null,
    start_date: formatFreemiusDate(coupon.starts_at),
    end_date: formatFreemiusDate(coupon.ends_at),
    redemptions_limit: coupon.redemption_limit ?? null,
    has_renewals_discount: false,
    has_addons_discount: false,
    is_one_per_user: false,
    is_active: coupon.is_active,
    user_type: 'all',
  };
}

async function getCouponTargets(client: SupabaseLikeClient, coupon: CouponRow) {
  if (coupon.provider_scope === 'stripe') {
    return [];
  }

  const { data: scopedProducts, error: scopedProductsError } = await (client as any)
    .from('coupon_products')
    .select('product_id')
    .eq('coupon_id', coupon.id);

  if (scopedProductsError) {
    throw new Error(scopedProductsError.message);
  }

  const scopedProductIds = (scopedProducts || []).map((row: { product_id: string }) => row.product_id);
  let query = (client as any)
    .from('products')
    .select('id, freemius_product_id, freemius_plan_id')
    .eq('payment_provider', 'freemius')
    .not('freemius_product_id', 'is', null);

  if (scopedProductIds.length > 0) {
    query = query.in('id', scopedProductIds);
  }

  const { data: products, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  const targets = new Map<string, FreemiusTarget>();

  for (const product of ((products || []) as FreemiusProductRow[])) {
    const freemiusProductId = String(product.freemius_product_id || '').trim();

    if (!freemiusProductId) {
      continue;
    }

    const current =
      targets.get(freemiusProductId) ??
      ({
        freemiusProductId,
        productId: product.id,
        planIds: [] as string[],
      } satisfies FreemiusTarget);

    if (scopedProductIds.length > 0 && product.freemius_plan_id) {
      current.planIds.push(String(product.freemius_plan_id));
    }

    targets.set(freemiusProductId, current);
  }

  return [...targets.values()].map((target) => ({
    ...target,
    planIds: [...new Set(target.planIds)],
  }));
}

async function updateCouponAggregateSyncStatus(client: SupabaseLikeClient, couponId: string) {
  const { data } = await (client as any)
    .from('coupon_freemius_mappings')
    .select('sync_status, sync_error')
    .eq('coupon_id', couponId);
  const mappings = data || [];

  if (mappings.length === 0) {
    await (client as any)
      .from('coupons')
      .update({
        freemius_sync_status: 'not_required',
        freemius_sync_error: null,
      })
      .eq('id', couponId);
    return;
  }

  const failed = mappings.find((mapping: any) => mapping.sync_status === 'failed');
  await (client as any)
    .from('coupons')
    .update({
      freemius_sync_status: failed ? 'failed' : 'synced',
      freemius_sync_error: failed?.sync_error ?? null,
    })
    .eq('id', couponId);
}

export async function syncCouponToFreemius(input: {
  couponId: string;
  client: SupabaseLikeClient;
}) {
  const { data: coupon, error } = await (input.client as any)
    .from('coupons')
    .select(
      'id, code, name, internal_note, provider_scope, discount_type, discount_amount, is_active, starts_at, ends_at, redemption_limit'
    )
    .eq('id', input.couponId)
    .single();

  if (error || !coupon) {
    return {
      success: false,
      error: error?.message || 'Coupon not found',
    };
  }

  const couponRow = coupon as CouponRow;
  const targets = await getCouponTargets(input.client, couponRow);

  await (input.client as any)
    .from('coupons')
    .update({
      freemius_sync_status: targets.length > 0 ? 'pending' : 'not_required',
      freemius_sync_error: null,
    })
    .eq('id', couponRow.id);

  for (const target of targets) {
    const { data: existing } = await (input.client as any)
      .from('coupon_freemius_mappings')
      .select('id, freemius_coupon_id')
      .eq('coupon_id', couponRow.id)
      .eq('freemius_product_id', target.freemiusProductId)
      .maybeSingle();
    const payload = buildFreemiusCouponPayload(couponRow, target);

    try {
      const remotePayload = await freemiusCouponRequest({
        productId: target.freemiusProductId,
        method: existing?.freemius_coupon_id ? 'PUT' : 'POST',
        couponId: existing?.freemius_coupon_id ?? null,
        body: payload,
      });
      const remoteCoupon = remotePayload?.coupon ?? remotePayload;

      await (input.client as any)
        .from('coupon_freemius_mappings')
        .upsert(
          {
            id: existing?.id,
            coupon_id: couponRow.id,
            product_id: target.productId,
            freemius_product_id: target.freemiusProductId,
            freemius_coupon_id: remoteCoupon?.id ? String(remoteCoupon.id) : existing?.freemius_coupon_id ?? null,
            freemius_coupon_code: couponRow.code,
            sync_status: 'synced',
            sync_error: null,
            remote_payload: remotePayload,
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: 'coupon_id,freemius_product_id' }
        );
    } catch (syncError: any) {
      await (input.client as any)
        .from('coupon_freemius_mappings')
        .upsert(
          {
            id: existing?.id,
            coupon_id: couponRow.id,
            product_id: target.productId,
            freemius_product_id: target.freemiusProductId,
            freemius_coupon_id: existing?.freemius_coupon_id ?? null,
            freemius_coupon_code: couponRow.code,
            sync_status: 'failed',
            sync_error: syncError.message || 'Freemius sync failed',
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: 'coupon_id,freemius_product_id' }
        );
    }
  }

  await updateCouponAggregateSyncStatus(input.client, couponRow.id);
  return {
    success: true,
    targetCount: targets.length,
  };
}

type ProductSaleRow = {
  id: string;
  sku: string | null;
  price: number | null;
  sale_price: number | null;
  sale_start_at: string | null;
  sale_end_at: string | null;
  payment_provider: string | null;
  freemius_product_id: string | number | null;
  freemius_plan_id: string | number | null;
};

function buildSaleCouponCode(input: { sku?: string | null; productId: string }) {
  const fromSku = (input.sku || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (fromSku) {
    return `SALE${fromSku}`.slice(0, 32);
  }
  const fromId = input.productId.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return `SALE${fromId}`.slice(0, 32);
}

/**
 * Reconciles the auto-generated, time-bounded Freemius sale coupon for a single
 * product with the product's current scheduled-sale configuration. Creating the
 * coupon with the sale window's start/end dates lets Freemius enforce the window
 * natively at its hosted checkout. Safe to call repeatedly (idempotent upsert
 * keyed by product_id). Never throws — failures are recorded on the mapping row.
 */
export async function syncProductSaleCouponToFreemius(input: {
  productId: string;
  client: SupabaseLikeClient;
}) {
  const { data: product, error } = await (input.client as any)
    .from('products')
    .select(
      'id, sku, price, sale_price, sale_start_at, sale_end_at, payment_provider, freemius_product_id, freemius_plan_id'
    )
    .eq('id', input.productId)
    .maybeSingle();

  if (error || !product) {
    return { success: false, error: error?.message || 'Product not found' };
  }

  const row = product as ProductSaleRow;
  const freemiusProductId = String(row.freemius_product_id || '').trim();

  if (row.payment_provider !== 'freemius' || !freemiusProductId) {
    return { success: true, skipped: true, reason: 'not_a_freemius_product' };
  }

  const discountPercent = computeFreemiusSaleDiscountPercent(row.price, row.sale_price);
  const saleConfigured = discountPercent !== null;

  const { data: existing } = await (input.client as any)
    .from('product_freemius_sale_coupons')
    .select('id, freemius_coupon_id, freemius_coupon_code, discount_percent, is_active')
    .eq('product_id', row.id)
    .maybeSingle();

  // No sale and no remote coupon ever created → nothing to push to Freemius.
  if (!saleConfigured && !existing?.freemius_coupon_id) {
    if (existing?.id) {
      await (input.client as any)
        .from('product_freemius_sale_coupons')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    }
    return { success: true, active: false };
  }

  const couponCode =
    existing?.freemius_coupon_code ||
    buildSaleCouponCode({ sku: row.sku, productId: row.id });
  const planIds = row.freemius_plan_id ? [String(row.freemius_plan_id)] : [];
  // When deactivating, keep a valid discount value so Freemius accepts the PUT.
  const payloadDiscount = discountPercent ?? existing?.discount_percent ?? 1;

  const couponRow: CouponRow = {
    id: row.id,
    code: couponCode,
    name: `Scheduled sale ${row.sku || row.id}`,
    provider_scope: 'freemius',
    discount_type: 'percent',
    discount_amount: payloadDiscount,
    is_active: saleConfigured,
    starts_at: row.sale_start_at,
    ends_at: row.sale_end_at,
    redemption_limit: null,
  };
  const target: FreemiusTarget = {
    freemiusProductId,
    productId: row.id,
    planIds,
  };
  const payload = buildFreemiusCouponPayload(couponRow, target);

  try {
    const remotePayload = await freemiusCouponRequest({
      productId: freemiusProductId,
      method: existing?.freemius_coupon_id ? 'PUT' : 'POST',
      couponId: existing?.freemius_coupon_id ?? null,
      body: payload,
    });
    const remoteCoupon = remotePayload?.coupon ?? remotePayload;

    await (input.client as any)
      .from('product_freemius_sale_coupons')
      .upsert(
        {
          id: existing?.id,
          product_id: row.id,
          freemius_product_id: freemiusProductId,
          freemius_plan_id: row.freemius_plan_id ? String(row.freemius_plan_id) : null,
          freemius_coupon_id: remoteCoupon?.id
            ? String(remoteCoupon.id)
            : existing?.freemius_coupon_id ?? null,
          freemius_coupon_code: couponCode,
          discount_percent: discountPercent,
          starts_at: row.sale_start_at,
          ends_at: row.sale_end_at,
          is_active: saleConfigured,
          sync_status: 'synced',
          sync_error: null,
          remote_payload: remotePayload,
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: 'product_id' }
      );

    return { success: true, active: saleConfigured, code: couponCode };
  } catch (syncError: any) {
    await (input.client as any)
      .from('product_freemius_sale_coupons')
      .upsert(
        {
          id: existing?.id,
          product_id: row.id,
          freemius_product_id: freemiusProductId,
          freemius_plan_id: row.freemius_plan_id ? String(row.freemius_plan_id) : null,
          freemius_coupon_id: existing?.freemius_coupon_id ?? null,
          freemius_coupon_code: couponCode,
          discount_percent: discountPercent,
          starts_at: row.sale_start_at,
          ends_at: row.sale_end_at,
          is_active: saleConfigured,
          sync_status: 'failed',
          sync_error: syncError.message || 'Freemius sale coupon sync failed',
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: 'product_id' }
      );
    return {
      success: false,
      error: syncError.message || 'Freemius sale coupon sync failed',
    };
  }
}

export async function deleteCouponFromFreemius(input: {
  couponId: string;
  client: SupabaseLikeClient;
}) {
  const { data: mappings } = await (input.client as any)
    .from('coupon_freemius_mappings')
    .select('id, freemius_product_id, freemius_coupon_id')
    .eq('coupon_id', input.couponId)
    .not('freemius_coupon_id', 'is', null);

  for (const mapping of mappings || []) {
    try {
      await freemiusCouponRequest({
        productId: mapping.freemius_product_id,
        couponId: mapping.freemius_coupon_id,
        method: 'DELETE',
      });
      await (input.client as any)
        .from('coupon_freemius_mappings')
        .update({
          sync_status: 'deleted',
          sync_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', mapping.id);
    } catch (error: any) {
      await (input.client as any)
        .from('coupon_freemius_mappings')
        .update({
          sync_status: 'failed',
          sync_error: error.message || 'Freemius delete failed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', mapping.id);
    }
  }
}
