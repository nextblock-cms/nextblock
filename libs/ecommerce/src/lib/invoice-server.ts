import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleSupabaseClient } from '@nextblock-cms/db/server';

import { normalizeOrderCustomerDetails } from './customer';
import type { InvoiceLogo, InvoiceOrder, InvoicePresentationData } from './invoice';
import {
  DEFAULT_INVOICE_SETTINGS,
  INVOICE_SETTINGS_KEY,
  normalizeInvoiceSettings,
} from './invoice';
import { normalizeOrderTaxDetails } from './order-tax-details';

type SupabaseLikeClient = SupabaseClient<any>;

function resolveMediaUrl(filePath?: string | null) {
  if (!filePath) {
    return null;
  }

  if (filePath.startsWith('http')) {
    return filePath;
  }

  if (filePath.startsWith('/')) {
    return filePath;
  }

  if (process.env.NEXT_PUBLIC_R2_BASE_URL) {
    return `${process.env.NEXT_PUBLIC_R2_BASE_URL}/${filePath}`;
  }

  if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/media/${filePath}`;
  }

  return filePath;
}

function getSupabaseClient(client?: SupabaseLikeClient) {
  return client ?? (getServiceRoleSupabaseClient() as SupabaseLikeClient);
}

function mapLogo(row: any): InvoiceLogo | null {
  if (!row) {
    return null;
  }

  const objectKey = row.media?.object_key ?? row.media?.file_path ?? null;

  return {
    id: row.id,
    name: row.name ?? null,
    url: resolveMediaUrl(objectKey),
    width: row.media?.width ?? null,
    height: row.media?.height ?? null,
  };
}

// Mirrors apps/nextblock/lib/logos/active-logo.ts (this published lib can't import the app):
// the operator-pinned active logo (site_settings.active_logo_id), else the newest logo.
const ACTIVE_LOGO_SETTING_KEY = 'active_logo_id';
const INVOICE_LOGO_SELECT = `
        id,
        name,
        media:media_id (
          object_key,
          file_path,
          width,
          height
        )
      `;

async function fetchActiveLogoRow(supabase: SupabaseLikeClient) {
  const { data: activeSetting } = await supabase
    .from('site_settings')
    .select('value')
    .eq('key', ACTIVE_LOGO_SETTING_KEY)
    .maybeSingle();
  const activeValue = activeSetting?.value;
  const activeId =
    typeof activeValue === 'string' && activeValue.length > 0 ? activeValue : null;

  if (activeId) {
    const { data } = await supabase
      .from('logos')
      .select(INVOICE_LOGO_SELECT)
      .eq('id', activeId)
      .maybeSingle();
    if (data) return data;
  }

  const { data } = await supabase
    .from('logos')
    .select(INVOICE_LOGO_SELECT)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export async function getInvoiceBrandingData(client?: SupabaseLikeClient) {
  const supabase = getSupabaseClient(client);
  const [settingsResponse, logoRow] = await Promise.all([
    supabase
      .from('site_settings')
      .select('value')
      .eq('key', INVOICE_SETTINGS_KEY)
      .maybeSingle(),
    fetchActiveLogoRow(supabase),
  ]);

  return {
    settings: normalizeInvoiceSettings(settingsResponse.data?.value ?? DEFAULT_INVOICE_SETTINGS),
    logo: mapLogo(logoRow),
  };
}

export async function assignInvoiceMetadata(input: {
  orderId: string;
  paidAt?: string | null;
  client?: SupabaseLikeClient;
}) {
  const supabase = getSupabaseClient(input.client);
  const { data, error } = await (supabase as any)
    .rpc('assign_order_invoice_metadata', {
      p_order_id: input.orderId,
      p_paid_at: input.paidAt ?? null,
    })
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return {
    invoiceNumber: data?.invoice_number ?? null,
    paidAt: data?.paid_at ?? null,
  };
}

export async function getInvoiceOrder(orderId: string, client?: SupabaseLikeClient) {
  const supabase = getSupabaseClient(client);
  const { data: orderRow, error: orderError } = await supabase
    .from('orders')
    .select(
      `
      id,
      invoice_number,
      paid_at,
      created_at,
      currency,
      status,
      provider,
      subtotal,
      shipping_total,
      discount_total,
      coupon_code,
      tax_total,
      total,
      customer_details,
      tax_details,
      order_items (
        id,
        product_id,
        variant_id,
        quantity,
        price_at_purchase
      )
    `
    )
    .eq('id', orderId)
    .single();

  if (orderError || !orderRow) {
    throw new Error(orderError?.message || 'Order not found');
  }

  const productIds = (orderRow.order_items || [])
    .map((item: any) => item.product_id)
    .filter(Boolean);
  const variantIds = (orderRow.order_items || [])
    .map((item: any) => item.variant_id)
    .filter(Boolean);

  // The order itself was read with the caller's client, so ownership is already settled.
  // The catalog rows are looked up with the service role: a product archived, unpublished
  // or rescheduled after the purchase is hidden from the customer by RLS (migration 02021),
  // but their invoice must still name what they bought.
  const catalog = getServiceRoleSupabaseClient() as SupabaseLikeClient;
  const [productsResponse, variantsResponse] = await Promise.all([
    productIds.length
      ? catalog
          .from('products')
          .select('id, title, sku')
          .in('id', productIds)
      : Promise.resolve({ data: [], error: null }),
    variantIds.length
      ? catalog
          .from('product_variants')
          .select('id, sku')
          .in('id', variantIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const productMap = new Map(
    (productsResponse.data || []).map((product: any) => [product.id, product])
  );
  const variantMap = new Map(
    (variantsResponse.data || []).map((variant: any) => [variant.id, variant])
  );

  const items = (orderRow.order_items || []).map((item: any) => {
    const product = item.product_id ? productMap.get(item.product_id) : null;
    const variant = item.variant_id ? variantMap.get(item.variant_id) : null;
    const title = product?.title || 'Product';
    const description = variant?.sku
      ? `SKU: ${variant.sku}`
      : product?.sku
        ? `SKU: ${product.sku}`
        : null;

    return {
      id: item.id,
      product_id: item.product_id ?? null,
      variant_id: item.variant_id ?? null,
      title,
      description,
      quantity: item.quantity,
      unit_amount: item.price_at_purchase,
      total_amount: item.price_at_purchase * item.quantity,
      sku: variant?.sku ?? product?.sku ?? null,
    };
  });

  const order: InvoiceOrder = {
    id: orderRow.id,
    invoice_number: orderRow.invoice_number ?? null,
    paid_at: orderRow.paid_at ?? null,
    created_at: orderRow.created_at ?? null,
    currency: orderRow.currency || 'usd',
    status: orderRow.status,
    provider: orderRow.provider ?? null,
    subtotal:
      typeof orderRow.subtotal === 'number'
        ? orderRow.subtotal
        : items.reduce((sum, item) => sum + item.total_amount, 0),
    shipping_total:
      typeof orderRow.shipping_total === 'number' ? orderRow.shipping_total : 0,
    discount_total:
      typeof orderRow.discount_total === 'number' ? orderRow.discount_total : 0,
    coupon_code: orderRow.coupon_code ?? null,
    tax_total: typeof orderRow.tax_total === 'number' ? orderRow.tax_total : 0,
    total: orderRow.total,
    customer_details: normalizeOrderCustomerDetails(orderRow.customer_details ?? {}),
    tax_details: normalizeOrderTaxDetails(orderRow.tax_details),
    items,
  };

  return order;
}

export async function getInvoicePresentationData(
  orderId: string,
  client?: SupabaseLikeClient
): Promise<InvoicePresentationData> {
  const supabase = getSupabaseClient(client);
  const [order, branding] = await Promise.all([
    getInvoiceOrder(orderId, supabase),
    getInvoiceBrandingData(supabase),
  ]);

  return {
    order,
    settings: branding.settings,
    logo: branding.logo,
  };
}
