'use server';

import 'server-only';

import { createClient, getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';
import { majorUnitAmountToMinor, normalizeCurrencyCode } from '@nextblock-cms/utils';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { normalizeCouponCode } from '../../../coupons';
import {
  deleteCouponFromFreemius,
  syncCouponToFreemius,
} from '../../../freemius-coupons';

async function getAdminClient() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error('Unauthorized');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'ADMIN') {
    throw new Error('Forbidden');
  }

  return getServiceRoleSupabaseClient();
}

function cleanString(value: FormDataEntryValue | null) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function parseDate(value: FormDataEntryValue | null) {
  const text = cleanString(value);

  if (!text) {
    return null;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseDiscountAmount(input: {
  value: FormDataEntryValue | null;
  discountType: string;
  currencyCode: string;
}) {
  const raw = cleanString(input.value);
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Discount amount must be greater than zero.');
  }

  if (input.discountType === 'fixed') {
    return majorUnitAmountToMinor(parsed, input.currencyCode);
  }

  return Math.round(parsed);
}

function parseCheckbox(formData: FormData, name: string) {
  return formData.getAll(name).some((value) => value === 'true');
}

function parseCouponPayload(formData: FormData) {
  const code = normalizeCouponCode(cleanString(formData.get('code')));
  const name = cleanString(formData.get('name'));
  const providerScope = cleanString(formData.get('provider_scope')) || 'all';
  const discountType = cleanString(formData.get('discount_type')) || 'percent';
  const currencyCode = normalizeCurrencyCode(cleanString(formData.get('currency_code')));
  const discountAmount = parseDiscountAmount({
    value: formData.get('discount_amount'),
    discountType,
    currencyCode,
  });
  const redemptionLimitRaw = cleanString(formData.get('redemption_limit'));

  if (!code) {
    throw new Error('Coupon code is required.');
  }

  if (!name) {
    throw new Error('Coupon name is required.');
  }

  if (discountType === 'percent' && discountAmount > 100) {
    throw new Error('Percent discounts cannot exceed 100.');
  }

  return {
    coupon: {
      code,
      name,
      internal_note: cleanString(formData.get('internal_note')),
      provider_scope: providerScope,
      discount_type: discountType,
      discount_amount: discountAmount,
      is_active: parseCheckbox(formData, 'is_active'),
      starts_at: parseDate(formData.get('starts_at')),
      ends_at: parseDate(formData.get('ends_at')),
      redemption_limit: redemptionLimitRaw ? Number.parseInt(redemptionLimitRaw, 10) : null,
      freemius_sync_status:
        providerScope === 'stripe' ? 'not_required' : 'pending',
      freemius_sync_error: null,
    },
    productIds: formData
      .getAll('product_ids')
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean),
  };
}

async function replaceCouponProducts(input: {
  client: ReturnType<typeof getServiceRoleSupabaseClient>;
  couponId: string;
  productIds: string[];
}) {
  await (input.client as any)
    .from('coupon_products')
    .delete()
    .eq('coupon_id', input.couponId);

  if (input.productIds.length === 0) {
    return;
  }

  const { error } = await (input.client as any)
    .from('coupon_products')
    .insert(
      input.productIds.map((productId) => ({
        coupon_id: input.couponId,
        product_id: productId,
      }))
    );

  if (error) {
    throw new Error(error.message);
  }
}

export async function createCouponAction(formData: FormData) {
  const client = await getAdminClient();
  const payload = parseCouponPayload(formData);
  const { data, error } = await (client as any)
    .from('coupons')
    .insert(payload.coupon)
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'Failed to create coupon.');
  }

  await replaceCouponProducts({
    client,
    couponId: data.id,
    productIds: payload.productIds,
  });
  await syncCouponToFreemius({ couponId: data.id, client: client as any });

  revalidatePath('/cms/coupons');
  redirect('/cms/coupons');
}

export async function updateCouponAction(couponId: string, formData: FormData) {
  const client = await getAdminClient();
  const payload = parseCouponPayload(formData);
  const { error } = await (client as any)
    .from('coupons')
    .update(payload.coupon)
    .eq('id', couponId);

  if (error) {
    throw new Error(error.message);
  }

  await replaceCouponProducts({
    client,
    couponId,
    productIds: payload.productIds,
  });
  if (payload.coupon.provider_scope === 'stripe') {
    await deleteCouponFromFreemius({ couponId, client: client as any });
  } else {
    await syncCouponToFreemius({ couponId, client: client as any });
  }

  revalidatePath('/cms/coupons');
  revalidatePath(`/cms/coupons/${couponId}/edit`);
  redirect('/cms/coupons');
}

export async function toggleCouponActiveAction(couponId: string, isActive: boolean) {
  const client = await getAdminClient();
  const { error } = await (client as any)
    .from('coupons')
    .update({
      is_active: isActive,
      freemius_sync_status: 'pending',
      updated_at: new Date().toISOString(),
    })
    .eq('id', couponId);

  if (error) {
    throw new Error(error.message);
  }

  await syncCouponToFreemius({ couponId, client: client as any });
  revalidatePath('/cms/coupons');
}

export async function syncCouponAction(couponId: string) {
  const client = await getAdminClient();
  await syncCouponToFreemius({ couponId, client: client as any });
  revalidatePath('/cms/coupons');
  revalidatePath(`/cms/coupons/${couponId}/edit`);
}

export async function deleteCouponAction(couponId: string) {
  const client = await getAdminClient();
  await deleteCouponFromFreemius({ couponId, client: client as any });
  const { error } = await (client as any).from('coupons').delete().eq('id', couponId);

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath('/cms/coupons');
}
